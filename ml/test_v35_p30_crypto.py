from __future__ import annotations

import json
import os
import base64
import subprocess
import tempfile
import unittest
from pathlib import Path

from v35_p30_crypto import (
    atomic_write_exclusive,
    executable_sha256,
    sign_payload,
    venv_python_entrypoint,
    verify_signed_payload,
)


class P30CryptoTests(unittest.TestCase):
    def test_venv_entrypoint_preserves_required_runtime_packages(self) -> None:
        repo = Path(__file__).resolve().parents[1]
        entrypoint = venv_python_entrypoint(repo)
        self.assertEqual(entrypoint, repo / "ml/.venv/bin/python")
        self.assertEqual(executable_sha256(entrypoint), executable_sha256(entrypoint.resolve()))
        completed = subprocess.run(
            [
                str(entrypoint),
                "-c",
                (
                    "import cryptography,numpy,torch,sys;"
                    "assert sys.prefix != sys.base_prefix;"
                    "print(sys.prefix)"
                ),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn(".venv", completed.stdout)

    def test_sign_verify_tamper_and_exclusive_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            private = root / "private.pem"
            public = root / "public.pem"
            subprocess.run(
                ["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(private)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "openssl",
                    "pkey",
                    "-in",
                    str(private),
                    "-pubout",
                    "-out",
                    str(public),
                ],
                check=True,
                capture_output=True,
            )
            descriptor = os.open(private, os.O_RDONLY)
            try:
                payload = {
                    "schemaVersion": "arc-v35-p30-execution-authorization-v1",
                    "kind": "preflight",
                    "tokenId": "abc",
                    "count": 3,
                }
                signed = {**payload, "signature": sign_payload(
                    payload, role="issuer", private_key_fd=descriptor, public_key_path=public
                )}
            finally:
                os.close(descriptor)
            self.assertEqual(
                verify_signed_payload(
                    signed, expected_role="issuer", public_key_path=public
                ),
                payload,
            )
            with self.assertRaisesRegex(ValueError, "key identity"):
                verify_signed_payload(
                    signed, expected_role="executor", public_key_path=public
                )
            altered = json.loads(json.dumps(signed))
            altered["count"] = 4
            with self.assertRaisesRegex(ValueError, "payload hash"):
                verify_signed_payload(
                    altered, expected_role="issuer", public_key_path=public
                )
            noncanonical = json.loads(json.dumps(signed))
            encoded = noncanonical["signature"]["valueBase64"]
            alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            index = alphabet.index(encoded[-3])
            noncanonical["signature"]["valueBase64"] = (
                encoded[:-3] + alphabet[index + 1] + "=="
            )
            self.assertEqual(
                base64.b64decode(encoded, validate=True),
                base64.b64decode(noncanonical["signature"]["valueBase64"], validate=True),
            )
            with self.assertRaisesRegex(ValueError, "canonical"):
                verify_signed_payload(
                    noncanonical, expected_role="issuer", public_key_path=public
                )
            destination = root / "signed.json"
            atomic_write_exclusive(destination, b"{}\n")
            with self.assertRaises(FileExistsError):
                atomic_write_exclusive(destination, b"{}\n")

    def test_rejects_symlink_public_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_text("not-a-key")
            link = root / "link"
            link.symlink_to(target)
            signature = {
                "schemaVersion": "arc-v35-p30-ed25519-signature-v2",
                "algorithm": "Ed25519",
                "role": "issuer",
                "keyId": "x",
                "publicKeyDerSha256": "0" * 64,
                "payloadSha256": "0" * 64,
                "valueBase64": "AA==",
            }
            with self.assertRaises(OSError):
                verify_signed_payload(
                    {"signature": signature},
                    expected_role="issuer",
                    public_key_path=link,
                )


if __name__ == "__main__":
    unittest.main()

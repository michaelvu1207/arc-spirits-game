from __future__ import annotations

import copy
import datetime as dt
import json
import os
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from v35_p30_crypto import canonical_json, sha256_bytes, sha256_file, sign_payload
from v35_p30_recovery import (
    ACTIONS,
    EXECUTION_DRAFT_SCHEMA,
    GUARDIAN_INCIDENT_SCHEMA,
    PRE_CHILD,
    RECEIPT_ONLY,
    RECOVERY_LINK_SCHEMA,
    persist_pre_child_recovery_draft,
    persist_receipt_only_recovery_draft,
    protected_bindings_sha256,
    validate_execution_draft,
    validate_guardian_incident,
    validate_recovery_link,
)


def utc(value: dt.datetime) -> str:
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


class RecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.guardian_private = self.root / "guardian-private.pem"
        self.guardian_public = self.root / "guardian-public.pem"
        key = Ed25519PrivateKey.generate()
        self.guardian_private.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        self.guardian_private.chmod(0o600)
        self.guardian_public.write_bytes(
            key.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        self.token = "a" * 64
        self.recovery_token = "b" * 64
        self.started = dt.datetime.now(dt.timezone.utc).replace(microsecond=123456)
        self.output = self.root / self.token
        self.output.mkdir()
        self.authorization_path = self.root / "authorization.json"
        self.consumed_path = self.root / "consumed.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_analysis_and_preflight_cannot_create_any_recovery_draft(self) -> None:
        for kind in ("analysis", "preflight"):
            with self.subTest(kind=kind):
                authorization = self.authorization()
                authorization["kind"] = kind
                with self.assertRaisesRegex(RuntimeError, "no recovery path"):
                    persist_pre_child_recovery_draft(
                        authorization_path=self.authorization_path,
                        authorization=authorization,
                        consumed_path=self.consumed_path,
                        diagnostic_code="OUTPUT_OPEN_FAILED",
                        started_at_utc=utc(self.started),
                        finished_at_utc=utc(self.started),
                        gpu_empty_after=True,
                        lease_released=True,
                    )
                with self.assertRaisesRegex(RuntimeError, "no recovery path"):
                    persist_receipt_only_recovery_draft(
                        authorization_path=self.authorization_path,
                        authorization=authorization,
                        consumed_path=self.consumed_path,
                        unsigned_receipt_path=self.root / "unsigned.json",
                        unsigned_receipt={},
                        normal_seal_attempt_path=self.root / "attempt.json",
                        diagnostic_code="RECEIPT_SIGNATURE_FAILED",
                    )

    def authorization(self, *, token: str | None = None) -> dict:
        token = token or self.token
        output = self.root / token
        output.mkdir(exist_ok=True)
        return {
            "schemaVersion": "arc-v35-p30-execution-authorization-v1",
            "authorized": True,
            "immutable": True,
            "promotionEligible": False,
            "kind": "generation",
            "tokenId": token,
            "campaignId": "p30-test",
            "issuedAtUtc": utc(self.started - dt.timedelta(minutes=1)),
            "notBeforeUtc": utc(self.started - dt.timedelta(minutes=1)),
            "expiresAtUtc": utc(self.started + dt.timedelta(hours=1)),
            "protocol": {"path": "/frozen/protocol", "sha256": "1" * 64},
            "sourceContract": {"path": "/frozen/source", "sha256": "2" * 64},
            "subject": {
                "root": "/league/a-control",
                "generation": 1,
                "configSha256": "3" * 64,
                "inputCheckpointSha256": "4" * 64,
            },
            "command": {
                "argv": ["/usr/bin/true", "--attempt-token", token],
                "cwd": "/repo",
                "env": {"ARC_V35_P30_AUTH_TOKEN": token},
                "executableSha256": "5" * 64,
            },
            "isolation": {
                "backend": "bubblewrap",
                "writablePaths": [str(output)],
                "gpuMode": "exclusive-gpu7",
            },
            "outputs": {
                "checkpoint": {
                    "path": str(output / "checkpoint"),
                    "required": True,
                    "mustBeAbsentAtStart": True,
                },
                "exitCode": {
                    "path": str(output / "exit"),
                    "required": True,
                    "mustBeAbsentAtStart": True,
                },
                "stderr": {
                    "path": str(output / "stderr"),
                    "required": True,
                    "mustBeAbsentAtStart": True,
                },
                "stdout": {
                    "path": str(output / "stdout"),
                    "required": True,
                    "mustBeAbsentAtStart": True,
                },
            },
            "ledger": {
                "root": "/ledger/instance",
                "consumedPath": f"/ledger/instance/{token}.consumed.json",
                "receiptPath": f"/ledger/instance/{token}.receipt.json",
                "leasePath": "/lease/gpu7",
            },
            "predecessor": None,
        }

    def write_authorization_and_consumed(self, authorization: dict) -> None:
        self.authorization_path.write_bytes(canonical_json(authorization) + b"\n")
        marker = {
            "schemaVersion": "arc-v35-p30-consumed-token-v1",
            "tokenId": authorization["tokenId"],
            "authorizationPath": str(self.authorization_path),
            "authorizationSha256": sha256_file(self.authorization_path),
            "consumedAtUtc": utc(self.started),
            "consumerPid": 1234,
            "host": "test-host",
            "bootId": "test-boot",
        }
        self.consumed_path.write_bytes(canonical_json(marker) + b"\n")

    @staticmethod
    def artifact(path: Path) -> dict:
        return {"path": str(path), "sha256": sha256_file(path), "bytes": path.stat().st_size}

    def draft(self, authorization: dict, recovery_class: str) -> dict:
        outputs = authorization["outputs"]
        if recovery_class == PRE_CHILD:
            process = {
                "spawnCallEntered": False,
                "childStarted": False,
                "pid": None,
                "exitCode": 125,
                "noSupervisorChildRemaining": True,
                "seedConsumed": False,
            }
            diagnostic = "OUTPUT_OPEN_FAILED"
            unsigned_receipt = None
            normal_seal_attempt = None
        else:
            Path(outputs["stdout"]["path"]).write_bytes(b"sealed candidate log\n")
            Path(outputs["stderr"]["path"]).write_bytes(b"")
            Path(outputs["exitCode"]["path"]).write_bytes(b"0\n")
            Path(outputs["checkpoint"]["path"]).write_bytes(b"checkpoint")
            process = {
                "spawnCallEntered": True,
                "childStarted": True,
                "pid": 5678,
                "exitCode": 0,
                "noSupervisorChildRemaining": True,
                "seedConsumed": True,
            }
            diagnostic = "RECEIPT_SIGNATURE_FAILED"
            unsigned_path = self.root / "unsigned-receipt.json"
            seal_attempt_path = self.root / "normal-seal-attempt.json"
            unsigned_path.write_bytes(b"{}\n")
            seal_attempt_path.write_bytes(b"{}\n")
            unsigned_receipt = {
                "path": str(unsigned_path),
                "sha256": sha256_file(unsigned_path),
            }
            normal_seal_attempt = {
                "path": str(seal_attempt_path),
                "sha256": sha256_file(seal_attempt_path),
            }
        artifacts = {
            label: self.artifact(Path(output["path"]))
            for label, output in outputs.items()
            if Path(output["path"]).is_file()
        }
        missing = sorted(
            label
            for label, output in outputs.items()
            if output["required"] and not Path(output["path"]).is_file()
        )
        return {
            "schemaVersion": EXECUTION_DRAFT_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "outcomesExposed": False,
            "recoveryClass": recovery_class,
            "diagnosticCode": diagnostic,
            "kind": authorization["kind"],
            "tokenId": authorization["tokenId"],
            "campaignId": authorization["campaignId"],
            "authorization": {
                "path": str(self.authorization_path),
                "sha256": sha256_file(self.authorization_path),
            },
            "consumedMarker": {
                "path": str(self.consumed_path),
                "sha256": sha256_file(self.consumed_path),
            },
            "unsignedReceipt": unsigned_receipt,
            "normalSealAttempt": normal_seal_attempt,
            "startedAtUtc": utc(self.started),
            "finishedAtUtc": utc(self.started + dt.timedelta(seconds=2)),
            "subjectSha256": sha256_bytes(canonical_json(authorization["subject"])),
            "commandSha256": sha256_bytes(canonical_json(authorization["command"])),
            "isolationSha256": sha256_bytes(canonical_json(authorization["isolation"])),
            "process": process,
            "gpu": {
                "mode": authorization["isolation"]["gpuMode"],
                "emptyAfter": True,
                "leaseReleased": True,
            },
            "missingRequiredOutputs": missing,
            "artifacts": artifacts,
        }

    def incident(self, draft: dict, authorization: dict) -> dict:
        is_pre_child = draft["recoveryClass"] == PRE_CHILD
        payload = {
            "schemaVersion": GUARDIAN_INCIDENT_SCHEMA,
            "immutable": True,
            "outcomeBlind": True,
            "promotionEligible": False,
            "recoveryPermitted": True,
            "campaignId": draft["campaignId"],
            "kind": draft["kind"],
            "originalTokenId": draft["tokenId"],
            "recoveryClass": draft["recoveryClass"],
            "diagnosticCode": draft["diagnosticCode"],
            "classifiedAtUtc": utc(self.started + dt.timedelta(seconds=3)),
            "attemptOrdinal": 1,
            "action": ACTIONS[draft["recoveryClass"]],
            "executionDraftSha256": sha256_bytes(canonical_json(draft)),
            "authorizationSha256": draft["authorization"]["sha256"],
            "consumedMarkerSha256": draft["consumedMarker"]["sha256"],
            "protectedBindingsSha256": protected_bindings_sha256(authorization),
            "candidateCodeMayRun": is_pre_child,
            "seedMayBeReused": is_pre_child,
            "secondRecoveryForbidden": True,
        }
        descriptor = os.open(self.guardian_private, os.O_RDONLY)
        try:
            payload["signature"] = sign_payload(
                payload,
                role="guardian",
                private_key_fd=descriptor,
                public_key_path=self.guardian_public,
            )
        finally:
            os.close(descriptor)
        return payload

    def link(
        self,
        incident_payload: dict,
        authorization: dict,
        replacement: dict | None,
    ) -> dict:
        incident = {key: value for key, value in incident_payload.items() if key != "signature"}
        return {
            "schemaVersion": RECOVERY_LINK_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "campaignId": authorization["campaignId"],
            "kind": authorization["kind"],
            "recoveryClass": incident["recoveryClass"],
            "action": incident["action"],
            "attemptOrdinal": 1,
            "originalTokenId": authorization["tokenId"],
            "recoveryTokenId": self.recovery_token,
            "guardianIncidentPayloadSha256": sha256_bytes(canonical_json(incident)),
            "originalAuthorizationSha256": incident["authorizationSha256"],
            "replacementAuthorizationPayloadSha256": (
                sha256_bytes(canonical_json(replacement)) if replacement is not None else None
            ),
            "protectedBindingsSha256": protected_bindings_sha256(authorization),
            "candidateCodeMayRun": incident["recoveryClass"] == PRE_CHILD,
            "secondRecoveryForbidden": True,
        }

    def prepare(self, recovery_class: str) -> tuple[dict, dict, dict, dict]:
        authorization = self.authorization()
        self.write_authorization_and_consumed(authorization)
        draft = self.draft(authorization, recovery_class)
        signed_incident = self.incident(draft, authorization)
        incident = validate_guardian_incident(
            signed_incident,
            guardian_public_key_path=self.guardian_public,
            execution_draft=draft,
            authorization=authorization,
        )
        return authorization, draft, signed_incident, incident

    def test_pre_child_accepts_one_identical_token_normalized_rerun(self) -> None:
        authorization, draft, _, incident = self.prepare(PRE_CHILD)
        self.assertEqual(validate_execution_draft(draft, authorization=authorization), draft)
        replacement = self.authorization(token=self.recovery_token)
        link = self.link(incident, authorization, replacement)
        self.assertEqual(
            validate_recovery_link(
                link,
                guardian_incident=incident,
                original_authorization=authorization,
                replacement_authorization=replacement,
            ),
            link,
        )

    def test_pre_child_persistence_requires_no_authorized_output(self) -> None:
        authorization = self.authorization()
        ledger = self.root / "ledger" / authorization["tokenId"]
        authorization["ledger"]["root"] = str(ledger)
        authorization["ledger"]["consumedPath"] = str(
            ledger / f"{authorization['tokenId']}.consumed.json"
        )
        authorization["ledger"]["receiptPath"] = str(
            ledger / f"{authorization['tokenId']}.receipt.json"
        )
        self.write_authorization_and_consumed(authorization)
        path = persist_pre_child_recovery_draft(
            authorization_path=self.authorization_path,
            authorization=authorization,
            consumed_path=self.consumed_path,
            diagnostic_code="OUTPUT_OPEN_FAILED",
            started_at_utc=utc(self.started),
            finished_at_utc=utc(self.started + dt.timedelta(seconds=1)),
            gpu_empty_after=True,
            lease_released=True,
        )
        persisted = json.loads(path.read_text())
        self.assertFalse(persisted["process"]["spawnCallEntered"])
        self.assertFalse(persisted["process"]["childStarted"])
        self.assertEqual(persisted["artifacts"], {})
        Path(authorization["outputs"]["stdout"]["path"]).write_bytes(b"")
        path.unlink()
        with self.assertRaisesRegex(RuntimeError, "authorized output exists"):
            persist_pre_child_recovery_draft(
                authorization_path=self.authorization_path,
                authorization=authorization,
                consumed_path=self.consumed_path,
                diagnostic_code="OUTPUT_OPEN_FAILED",
                started_at_utc=utc(self.started),
                finished_at_utc=utc(self.started + dt.timedelta(seconds=1)),
                gpu_empty_after=True,
                lease_released=True,
            )

    def test_pre_child_rejects_child_seed_output_and_nonempty_diagnostics(self) -> None:
        authorization = self.authorization()
        self.write_authorization_and_consumed(authorization)
        draft = self.draft(authorization, PRE_CHILD)
        for mutation in (
            "spawn-call",
            "child",
            "seed",
            "candidate-output",
            "diagnostic-output",
        ):
            altered = copy.deepcopy(draft)
            if mutation == "spawn-call":
                altered["process"]["spawnCallEntered"] = True
            elif mutation == "child":
                altered["process"].update(
                    {"spawnCallEntered": True, "childStarted": True, "pid": 77}
                )
            elif mutation == "seed":
                altered["process"]["seedConsumed"] = True
            elif mutation == "candidate-output":
                path = Path(authorization["outputs"]["checkpoint"]["path"])
                path.write_bytes(b"partial")
                altered["artifacts"]["checkpoint"] = self.artifact(path)
                altered["missingRequiredOutputs"].remove("checkpoint")
            else:
                path = Path(authorization["outputs"]["stdout"]["path"])
                path.write_bytes(b"metric=99")
                altered["artifacts"]["stdout"] = self.artifact(path)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_execution_draft(altered, authorization=authorization)
            if mutation == "candidate-output":
                Path(authorization["outputs"]["checkpoint"]["path"]).unlink()
            elif mutation == "diagnostic-output":
                path.unlink()

    def test_receipt_only_requires_all_artifacts_and_never_reruns_candidate(self) -> None:
        authorization, draft, _, incident = self.prepare(RECEIPT_ONLY)
        self.assertEqual(validate_execution_draft(draft, authorization=authorization), draft)
        link = self.link(incident, authorization, None)
        self.assertEqual(
            validate_recovery_link(
                link,
                guardian_incident=incident,
                original_authorization=authorization,
                replacement_authorization=None,
            ),
            link,
        )
        replacement = self.authorization(token=self.recovery_token)
        with self.assertRaisesRegex(ValueError, "may not authorize"):
            validate_recovery_link(
                link,
                guardian_incident=incident,
                original_authorization=authorization,
                replacement_authorization=replacement,
            )
        Path(authorization["outputs"]["checkpoint"]["path"]).unlink()
        with self.assertRaises(ValueError):
            validate_execution_draft(draft, authorization=authorization)

    def test_unknown_codes_extra_outcome_fields_and_tampering_fail_closed(self) -> None:
        authorization = self.authorization()
        self.write_authorization_and_consumed(authorization)
        draft = self.draft(authorization, PRE_CHILD)
        unknown = copy.deepcopy(draft)
        unknown["diagnosticCode"] = "CUSTOM metric=1.0"
        with self.assertRaises(ValueError):
            validate_execution_draft(unknown, authorization=authorization)
        leaked = copy.deepcopy(draft)
        leaked["winningArm"] = "late-scheduled"
        with self.assertRaisesRegex(ValueError, "keys changed"):
            validate_execution_draft(leaked, authorization=authorization)
        signed = self.incident(draft, authorization)
        signed["diagnosticCode"] = "GPU7_PRECHECK_FAILED"
        with self.assertRaisesRegex(ValueError, "payload hash"):
            validate_guardian_incident(
                signed,
                guardian_public_key_path=self.guardian_public,
                execution_draft=draft,
                authorization=authorization,
            )

    def test_incident_rejects_second_recovery_wrong_action_and_stale_binding(self) -> None:
        authorization = self.authorization()
        self.write_authorization_and_consumed(authorization)
        draft = self.draft(authorization, PRE_CHILD)
        for mutation in ("second", "action", "binding"):
            signed = self.incident(draft, authorization)
            unsigned = {key: value for key, value in signed.items() if key != "signature"}
            if mutation == "second":
                unsigned["attemptOrdinal"] = 2
            elif mutation == "action":
                unsigned["action"] = ACTIONS[RECEIPT_ONLY]
            else:
                unsigned["protectedBindingsSha256"] = "0" * 64
            descriptor = os.open(self.guardian_private, os.O_RDONLY)
            try:
                unsigned["signature"] = sign_payload(
                    unsigned,
                    role="guardian",
                    private_key_fd=descriptor,
                    public_key_path=self.guardian_public,
                )
            finally:
                os.close(descriptor)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_guardian_incident(
                    unsigned,
                    guardian_public_key_path=self.guardian_public,
                    execution_draft=draft,
                    authorization=authorization,
                )

    def test_link_rejects_token_reuse_and_any_protected_change(self) -> None:
        authorization, _, _, incident = self.prepare(PRE_CHILD)
        replacement = self.authorization(token=self.recovery_token)
        link = self.link(incident, authorization, replacement)
        reused = copy.deepcopy(link)
        reused["recoveryTokenId"] = self.token
        with self.assertRaises(ValueError):
            validate_recovery_link(
                reused,
                guardian_incident=incident,
                original_authorization=authorization,
                replacement_authorization=replacement,
            )
        changed = copy.deepcopy(replacement)
        changed["subject"]["configSha256"] = "9" * 64
        changed_link = self.link(incident, authorization, changed)
        with self.assertRaisesRegex(ValueError, "protected bindings"):
            validate_recovery_link(
                changed_link,
                guardian_incident=incident,
                original_authorization=authorization,
                replacement_authorization=changed,
            )
        for field in ("predecessor", "ledger"):
            changed = copy.deepcopy(replacement)
            if field == "predecessor":
                changed["predecessor"] = {
                    "receiptPath": "/ledger/instance/unrelated.receipt.json",
                    "sha256": "7" * 64,
                }
            else:
                changed["ledger"]["root"] = "/different/ledger/root"
            changed_link = self.link(incident, authorization, changed)
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, "protected bindings"
            ):
                validate_recovery_link(
                    changed_link,
                    guardian_incident=incident,
                    original_authorization=authorization,
                    replacement_authorization=changed,
                )

    def test_link_does_not_accept_an_unvalidated_incident_shape(self) -> None:
        authorization, _, _, incident = self.prepare(PRE_CHILD)
        replacement = self.authorization(token=self.recovery_token)
        link = self.link(incident, authorization, replacement)
        forged = copy.deepcopy(incident)
        forged["recoveryPermitted"] = False
        with self.assertRaisesRegex(ValueError, "invalid guardian incident"):
            validate_recovery_link(
                link,
                guardian_incident=forged,
                original_authorization=authorization,
                replacement_authorization=replacement,
            )


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from run_v35_p30_local_custody import load_config
from v35_p30_analysis_review import APPROVED_REVIEW_RUNTIME
from v35_p30_crypto import validate_role_trust


class P30KeyCustodyTests(unittest.TestCase):
    def test_local_config_requires_mode_0600_and_all_michaelagents_refs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "custody.json"
            value = {
                "schemaVersion": "arc-v35-p30-local-custody-v1",
                "roleSecretReferences": {
                    role: f"op://MichaelAgents/{role}/private-key"
                    for role in (
                        "issuer",
                        "executor",
                        "guardian",
                        "analysis-authorizer",
                        "review-attester",
                    )
                },
            }
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            self.assertEqual(set(load_config(path)), set(value["roleSecretReferences"]))
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                load_config(path)

    def test_proposed_role_trust_rejects_partial_materialization(self) -> None:
        # Materialized-key duplicate rejection is covered end to end by the
        # authorized-execution fixture. This check protects proposed contracts
        # from partial role materialization before any file access occurs.
        roles = {}
        policies = {
            "issuer": (["arc-v35-p30-execution-authorization-v1"], ["generation", "evaluation-primary", "evaluation-replay", "preflight"]),
            "executor": (["arc-v35-p30-authorized-execution-receipt-v1", "arc-v35-p30-executor-launch-permit-v1"], ["generation", "evaluation-primary", "evaluation-replay", "preflight", "analysis"]),
            "guardian": (["arc-v35-p30-outcome-blind-preflight-v1", "arc-v35-p30-final-generation-completeness-v1", "arc-v35-p30-evaluation-pair-integrity-v1", "arc-v35-p30-analysis-manifest-v1", "arc-v35-p30-phase0-readiness-v1", "arc-v35-p30-full-campaign-authorization-v1", "arc-v35-p30-recovery-incident-v1", "arc-v35-p30-logical-completion-v1"], []),
            "analysis-authorizer": (["arc-v35-p30-execution-authorization-v1"], ["analysis"]),
            "review-attester": (["arc-v35-p30-analysis-authorization-review-receipt-v3", "arc-v35-p30-gate-review-receipt-v2"], []),
        }
        for role, (schemas, kinds) in policies.items():
            roles[role] = {
                "publicKeyPath": None,
                "publicKeyPemSha256": None,
                "publicKeyDerSha256": None,
                "keyId": None,
                "allowedArtifactSchemas": schemas,
                "allowedKinds": kinds,
            }
        trust = {
            "schemaVersion": "arc-v35-p30-role-trust-v3",
            "algorithm": "Ed25519",
            "campaignInstanceId": None,
            "roles": roles,
            "custody": {
                "provider": "1Password",
                "vault": "MichaelAgents",
                "secretGranularity": "one-item-per-role",
                "delivery": "encrypted-ssh-after-ready-to-sealed-memfd-cloexec",
                "schedulerPrivateKeyAccess": False,
                "maximumConcurrentPrivateKeyRoles": 1,
                "requirePrSetDumpableZero": True,
                "localOnlyRoles": ["review-attester"],
                "remoteDeliveryRoles": [
                    "issuer",
                    "executor",
                    "guardian",
                    "analysis-authorizer",
                ],
            },
            "ledgerRoot": "/tmp/ledger",
            "leasePath": "/tmp/lease",
            "bubblewrapPath": "/usr/bin/bwrap",
            "bubblewrapSha256": None,
            "reviewRuntime": APPROVED_REVIEW_RUNTIME,
        }
        self.assertEqual(set(validate_role_trust(trust, require_materialized=False)), set(roles))
        trust["roles"]["issuer"]["publicKeyPath"] = "/tmp/partial.pem"
        with self.assertRaisesRegex(ValueError, "partially materialized"):
            validate_role_trust(trust, require_materialized=False)


if __name__ == "__main__":
    unittest.main()

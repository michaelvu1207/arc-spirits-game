#!/usr/bin/env python3
"""Fail-closed subprocess sandbox for future V35 candidate/researcher code.

The declarative configuration pilot does not execute candidate code. This runner is for the later
small-code pilot and its adversarial preflight. On macOS it requires Seatbelt (`sandbox-exec`). On
Linux it requires an explicitly supplied rootless container command; silently running unsandboxed is
not supported.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


@dataclass(frozen=True)
class SandboxResult:
    return_code: int
    timed_out: bool
    stdout_sha256: str
    stderr_sha256: str
    wall_seconds: float


def _escape_profile_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace('"', '\\"')


class CandidateSandbox:
    def __init__(
        self,
        *,
        readable_roots: Sequence[Path],
        forbidden_roots: Sequence[Path],
        timeout_seconds: float = 10.0,
        max_output_bytes: int = 64 * 1024,
        linux_container_prefix: Sequence[str] | None = None,
    ):
        self.readable_roots = tuple(path.resolve(strict=True) for path in readable_roots)
        self.forbidden_roots = tuple(path.expanduser().resolve() for path in forbidden_roots)
        self.timeout_seconds = timeout_seconds
        self.max_output_bytes = max_output_bytes
        self.linux_container_prefix = tuple(linux_container_prefix or ())
        if timeout_seconds <= 0 or max_output_bytes < 1024:
            raise ValueError("invalid sandbox limits")
        for allowed in self.readable_roots:
            for forbidden in self.forbidden_roots:
                if allowed == forbidden or forbidden in allowed.parents:
                    raise ValueError("a readable root overlaps a forbidden root")

    def _macos_command(self, command: Sequence[str], writable: Path) -> list[str]:
        sandbox_exec = shutil.which("sandbox-exec")
        if not sandbox_exec:
            raise RuntimeError("candidate_sandbox_failed: sandbox-exec is unavailable")
        rules = [
            "(version 1)",
            # Current macOS Python aborts under a global deny-default profile before user
            # code starts. Keep system/runtime reads available, then explicitly deny every
            # trusted/controller root supplied by the caller and all network access.
            "(allow default)",
        ]
        for root in self.forbidden_roots:
            rules.append(f'(deny file-read* (subpath "{_escape_profile_path(root)}"))')
            rules.append(f'(deny file-write* (subpath "{_escape_profile_path(root)}"))')
        rules.append("(deny network*)")
        return [sandbox_exec, "-p", "".join(rules), *command]

    def run(self, command: Sequence[str], *, cwd: Path, environment: Mapping[str, str] | None = None) -> SandboxResult:
        if not command:
            raise ValueError("sandbox command is empty")
        cwd = cwd.resolve(strict=True)
        if not any(cwd == root or root in cwd.parents for root in self.readable_roots):
            raise ValueError("sandbox cwd is outside readable roots")
        with tempfile.TemporaryDirectory(prefix="arc-v35-candidate-") as temp:
            writable = Path(temp)
            system = platform.system()
            if system == "Darwin":
                argv = self._macos_command(command, writable)
            elif system == "Linux" and self.linux_container_prefix:
                argv = [*self.linux_container_prefix, *command]
            else:
                raise RuntimeError("candidate_sandbox_failed: required OS isolation is unavailable")
            clean_environment = {
                "HOME": str(writable),
                "TMPDIR": str(writable),
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                **(dict(environment) if environment else {}),
            }
            if any(key.upper().endswith(("TOKEN", "KEY", "SECRET", "PASSWORD")) for key in clean_environment):
                raise ValueError("candidate environment contains a secret-like variable")
            started = time.monotonic()
            timed_out = False
            try:
                completed = subprocess.run(
                    argv,
                    cwd=cwd,
                    env=clean_environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=self.timeout_seconds,
                    check=False,
                )
                return_code = completed.returncode
                stdout = completed.stdout[: self.max_output_bytes]
                stderr = completed.stderr[: self.max_output_bytes]
            except subprocess.TimeoutExpired as error:
                timed_out = True
                return_code = 124
                stdout = (error.stdout or b"")[: self.max_output_bytes]
                stderr = (error.stderr or b"")[: self.max_output_bytes]
            return SandboxResult(
                return_code=return_code,
                timed_out=timed_out,
                stdout_sha256=hashlib.sha256(stdout).hexdigest(),
                stderr_sha256=hashlib.sha256(stderr).hexdigest(),
                wall_seconds=time.monotonic() - started,
            )

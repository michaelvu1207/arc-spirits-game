#!/usr/bin/env python3
"""Linux-only, non-persistent private-key ingress for P30 role processes."""

from __future__ import annotations

import contextlib
import ctypes
import fcntl
import json
import os
import platform
import stat
from functools import wraps
from collections.abc import Iterator
from pathlib import Path


MAXIMUM_KEY_BYTES = 1024 * 1024
MAXIMUM_PERMIT_BYTES = 65536
PR_SET_DUMPABLE = 4
GLOBAL_LOCK_PATH = Path("/dev/shm/arc-v35-p30-key-custody.lock")
GLOBAL_ACTION_LOCK_PATH = Path("/dev/shm/arc-v35-p30-role-action.lock")


@contextlib.contextmanager
def exclusive_role_action() -> Iterator[None]:
    """Serialize the exact scheduler action from recomputation through commit."""

    descriptor = os.open(
        GLOBAL_ACTION_LOCK_PATH,
        os.O_RDWR
        | os.O_CREAT
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.fchmod(descriptor, 0o600)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
            or metadata.st_mode & 0o077
        ):
            raise ValueError("P30 role-action lock file contract failed")
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def serialized_role_action(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with exclusive_role_action():
            return function(*args, **kwargs)

    return wrapped


def _disable_dumpability() -> None:
    if platform.system() != "Linux":
        raise RuntimeError("P30 private-key custody is Linux-only")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def receive_signed_launch_permit(*, input_fd: int = 0) -> dict:
    """Read exactly one non-secret canonical JSON permit line from custody."""

    metadata = os.fstat(input_fd)
    if os.isatty(input_fd) or not (
        stat.S_ISFIFO(metadata.st_mode) or stat.S_ISSOCK(metadata.st_mode)
    ):
        raise ValueError("P30 launch-permit input must be a pipe or socket")
    value = bytearray()
    while len(value) <= MAXIMUM_PERMIT_BYTES:
        chunk = os.read(input_fd, 1)
        if not chunk:
            raise ValueError("P30 launch-permit input ended before newline")
        if chunk == b"\n":
            break
        value.extend(chunk)
    if not value or len(value) > MAXIMUM_PERMIT_BYTES:
        raise ValueError("P30 launch permit is empty or oversized")
    permit = json.loads(value)
    if not isinstance(permit, dict):
        raise ValueError("P30 launch permit must be an object")
    from v35_p30_crypto import canonical_json

    if canonical_json(permit) != bytes(value):
        raise ValueError("P30 launch permit must be canonical JSON")
    return permit


@contextlib.contextmanager
def receive_private_key(*, input_fd: int = 0) -> Iterator[int]:
    """Read one bounded key from a pipe into a sealed, unnamed CLOEXEC memfd."""

    input_metadata = os.fstat(input_fd)
    if os.isatty(input_fd) or not (
        stat.S_ISFIFO(input_metadata.st_mode) or stat.S_ISSOCK(input_metadata.st_mode)
    ):
        raise ValueError("P30 role key input must be a pipe or socket")
    _disable_dumpability()
    lock_fd = os.open(
        GLOBAL_LOCK_PATH,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    key_fd: int | None = None
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.fchmod(lock_fd, 0o600)
        lock_metadata = os.fstat(lock_fd)
        if (
            not stat.S_ISREG(lock_metadata.st_mode)
            or lock_metadata.st_uid != os.getuid()
            or lock_metadata.st_nlink != 1
            or lock_metadata.st_mode & 0o077
        ):
            raise ValueError("P30 custody lock file contract failed")
        if not hasattr(os, "memfd_create"):
            raise RuntimeError("kernel/Python lacks memfd_create support")
        key_fd = os.memfd_create(
            "arc-v35-p30-role-key",
            getattr(os, "MFD_CLOEXEC", 0) | getattr(os, "MFD_ALLOW_SEALING", 0),
        )
        payload = bytearray()
        while len(payload) <= MAXIMUM_KEY_BYTES:
            chunk = os.read(input_fd, min(65536, MAXIMUM_KEY_BYTES + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        if not payload or len(payload) > MAXIMUM_KEY_BYTES:
            raise ValueError("P30 role key input is empty or oversized")
        offset = 0
        while offset < len(payload):
            offset += os.write(key_fd, payload[offset:])
        payload[:] = b"\0" * len(payload)
        os.fchmod(key_fd, 0o600)
        seals = (
            getattr(fcntl, "F_SEAL_SEAL", 0)
            | getattr(fcntl, "F_SEAL_SHRINK", 0)
            | getattr(fcntl, "F_SEAL_GROW", 0)
            | getattr(fcntl, "F_SEAL_WRITE", 0)
        )
        if not seals or not hasattr(fcntl, "F_ADD_SEALS"):
            raise RuntimeError("kernel/Python lacks memfd sealing support")
        fcntl.fcntl(key_fd, fcntl.F_ADD_SEALS, seals)
        os.lseek(key_fd, 0, os.SEEK_SET)
        metadata = os.fstat(key_fd)
        descriptor_flags = fcntl.fcntl(key_fd, fcntl.F_GETFD)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 0
            or metadata.st_mode & 0o077
            or not descriptor_flags & fcntl.FD_CLOEXEC
        ):
            raise ValueError("P30 unnamed private-key FD contract failed")
        yield key_fd
    finally:
        if key_fd is not None:
            os.close(key_fd)
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)

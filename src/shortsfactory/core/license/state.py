"""Process-wide license state holder.

The state is set at startup by ``bootstrap_license_state`` and updated when
the user activates/deactivates via the API. It is read by middleware,
routes, worker hooks, and feature-gating helpers.

Intentionally a plain module-level variable guarded by a lock rather than
FastAPI ``app.state``, because the worker process (no FastAPI app) needs
access to the same concept.
"""

from __future__ import annotations

import enum
import threading
from dataclasses import dataclass

from shortsfactory.core.license.claims import LicenseClaims


class LicenseStatus(str, enum.Enum):
    """Runtime license status.

    - ``UNACTIVATED``: no license on file; user must paste a key.
    - ``ACTIVE``: valid license, within the paid period.
    - ``GRACE``: past ``period_end`` but within the 7-day offline grace (app
      still works, UI shows a renewal banner).
    - ``EXPIRED``: past the grace window or explicitly revoked.
    - ``INVALID``: signature verification failed (tampered/wrong key).
    """

    UNACTIVATED = "unactivated"
    ACTIVE = "active"
    GRACE = "grace"
    EXPIRED = "expired"
    INVALID = "invalid"


@dataclass(frozen=True)
class LicenseState:
    status: LicenseStatus
    claims: LicenseClaims | None = None
    error: str | None = None

    @property
    def is_usable(self) -> bool:
        """Whether protected API routes should be served.

        ``GRACE`` is still usable; the banner is advisory.
        """
        return self.status in (LicenseStatus.ACTIVE, LicenseStatus.GRACE)


_lock = threading.Lock()
_state: LicenseState = LicenseState(status=LicenseStatus.UNACTIVATED)
# Local snapshot of the Redis ``license:state_version`` counter. When the
# Redis counter is ahead of the local snapshot, this worker's state is
# stale (another process activated/deactivated) and must be rebootstrapped.
_local_version: int = 0


def get_state() -> LicenseState:
    with _lock:
        return _state


def set_state(new: LicenseState) -> None:
    global _state
    with _lock:
        _state = new


def get_local_version() -> int:
    with _lock:
        return _local_version


def set_local_version(v: int) -> None:
    global _local_version
    with _lock:
        _local_version = v

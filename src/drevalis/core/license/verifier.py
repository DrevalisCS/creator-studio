"""JWT verification and startup bootstrap for the license subsystem."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import jwt
import structlog

from drevalis.core.license.claims import LicenseClaims
from drevalis.core.license.keys import get_public_keys
from drevalis.core.license.state import (
    LicenseState as LicenseState,
)
from drevalis.core.license.state import (
    LicenseStatus as LicenseStatus,
)
from drevalis.core.license.state import (
    get_local_version,
    set_local_version,
    set_state,
)

if TYPE_CHECKING:
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import async_sessionmaker

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

_EXPECTED_ISS = "drevalis-license-server"

# Redis key used to invalidate the in-process license state across uvicorn
# workers. Incremented on activate/deactivate. Middleware consults this on
# every request; a cheap GET/INCR keeps workers in sync within one request.
REDIS_STATE_VERSION_KEY = "license:state_version"


async def bump_state_version(redis: Redis) -> int:
    """Increment the cross-process state version. Call after any mutation."""
    try:
        return int(await redis.incr(REDIS_STATE_VERSION_KEY))
    except Exception:
        return 0


async def get_remote_version(redis: Redis) -> int:
    try:
        raw = await redis.get(REDIS_STATE_VERSION_KEY)
        return int(raw) if raw else 0
    except Exception:
        return 0


async def refresh_if_stale(
    session_factory: async_sessionmaker,  # type: ignore[type-arg]
    redis: Redis,
    *,
    public_key_override_pem: str | None = None,
) -> None:
    """Rebootstrap local state if another process has changed the license.

    Called by the license-gate middleware before deciding to return 402, so
    an activation performed in any uvicorn worker is picked up by all
    workers on the next request.
    """
    remote = await get_remote_version(redis)
    if remote <= get_local_version():
        return
    try:
        await bootstrap_license_state(
            session_factory,
            public_key_override_pem=public_key_override_pem,
        )
        set_local_version(remote)
    except Exception:
        logger.debug("license_refresh_failed", exc_info=True)


class LicenseVerificationError(Exception):
    """Raised when a JWT cannot be cryptographically verified."""


def verify_jwt(token: str, *, public_key_override_pem: str | None = None) -> LicenseClaims:
    """Verify the JWT signature and decode claims.

    Tries each configured public key in order — rotation support. Raises
    ``LicenseVerificationError`` if no key validates the signature.

    Also validates ``exp``/``nbf``/``iss``. Callers that need to distinguish
    ACTIVE vs GRACE vs EXPIRED should inspect the returned claims rather
    than relying on ``exp`` alone.
    """
    public_keys = get_public_keys(public_key_override_pem)

    last_err: Exception | None = None
    for key in public_keys:
        try:
            payload = jwt.decode(
                token,
                key=key,
                algorithms=["EdDSA"],
                issuer=_EXPECTED_ISS,
                options={"require": ["iss", "sub", "exp", "nbf", "iat", "jti"]},
            )
            return LicenseClaims.model_validate(payload)
        except jwt.InvalidSignatureError as exc:
            last_err = exc
            continue
        except jwt.PyJWTError as exc:
            # Non-signature problem (exp, iss, malformed) — don't try other keys.
            raise LicenseVerificationError(str(exc)) from exc

    raise LicenseVerificationError(
        f"signature did not verify against any configured public key: {last_err!s}"
    )


def _classify(claims: LicenseClaims, *, now_unix: int) -> LicenseStatus:
    if now_unix < claims.nbf:
        return LicenseStatus.INVALID
    # Lifetime licenses skip the period_end/exp classification — they are
    # always ACTIVE once signature-verified. The JWT still carries a 100y
    # ``exp`` as a defense-in-depth guardrail, which ``verify_jwt`` will
    # reject if tampered; we just don't treat ``period_end`` as a paid-
    # through date for this license type.
    if claims.is_lifetime:
        return LicenseStatus.ACTIVE
    if now_unix >= claims.exp:
        return LicenseStatus.EXPIRED
    if now_unix >= claims.period_end:
        return LicenseStatus.GRACE
    return LicenseStatus.ACTIVE


async def bootstrap_license_state(
    session_factory: async_sessionmaker,  # type: ignore[type-arg]
    *,
    public_key_override_pem: str | None = None,
) -> LicenseState:
    """Read the stored JWT from ``license_state`` and populate module state.

    Called once at FastAPI lifespan startup and once at arq worker startup.
    Never raises — a missing/invalid license yields UNACTIVATED/INVALID, not
    a server crash. Startup proceeds so the frontend can render the
    activation wizard.
    """
    from drevalis.repositories.license_state import LicenseStateRepository

    async with session_factory() as session:
        repo = LicenseStateRepository(session)
        try:
            plaintext_jwt = await repo.get_plaintext_jwt()
        except ValueError as exc:
            state = LicenseState(status=LicenseStatus.INVALID, error=str(exc))
            set_state(state)
            logger.error("license_bootstrap_decrypt_failed", error=str(exc)[:200])
            return state

    if not plaintext_jwt:
        state = LicenseState(status=LicenseStatus.UNACTIVATED)
        set_state(state)
        logger.info("license_bootstrap", status=state.status.value)
        return state

    try:
        claims = verify_jwt(plaintext_jwt, public_key_override_pem=public_key_override_pem)
    except LicenseVerificationError as exc:
        state = LicenseState(status=LicenseStatus.INVALID, error=str(exc))
        set_state(state)
        logger.warning("license_bootstrap", status=state.status.value, error=str(exc)[:120])
        return state

    now = int(datetime.now(tz=UTC).timestamp())
    status = _classify(claims, now_unix=now)
    state = LicenseState(status=status, claims=claims)
    set_state(state)
    logger.info(
        "license_bootstrap",
        status=state.status.value,
        tier=claims.tier,
        exp=claims.exp_datetime().isoformat(),
    )
    return state

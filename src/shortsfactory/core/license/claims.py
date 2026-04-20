"""Pydantic model for decoded license JWT claims."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field


class LicenseClaims(BaseModel):
    """Decoded & verified license JWT payload.

    The JWT itself is signed by the license server with Ed25519. Signature
    verification happens in ``verifier.verify_jwt``; this model only shapes
    the payload for downstream use.
    """

    model_config = ConfigDict(extra="ignore")

    iss: str
    sub: str
    jti: str
    tier: str  # "solo" | "pro" | "studio" | "trial"
    features: list[str] = Field(default_factory=list)
    machines: int = 1

    iat: int
    nbf: int
    exp: int  # period_end + 7-day grace
    period_end: int  # actual paid-through date (unix)

    def exp_datetime(self) -> datetime:
        return datetime.fromtimestamp(self.exp, tz=timezone.utc)

    def period_end_datetime(self) -> datetime:
        return datetime.fromtimestamp(self.period_end, tz=timezone.utc)

    def is_in_grace(self, now_unix: int) -> bool:
        """True if we're past ``period_end`` but still before ``exp``."""
        return self.period_end <= now_unix < self.exp

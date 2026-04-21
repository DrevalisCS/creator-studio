"""Tier / feature gating helpers used by routes and worker tasks."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException, status

from drevalis.core.license.state import get_state

# Canonical tier → feature map. The license server SHOULD put the same
# features list into the JWT's ``features`` claim; this map is the local
# fallback used when the claim is empty (e.g. for legacy licenses) and also
# doubles as documentation of what each tier buys.
TIER_FEATURES: dict[str, frozenset[str]] = {
    "trial": frozenset({"basic_generation"}),
    "solo": frozenset({"basic_generation"}),
    "pro": frozenset({"basic_generation", "runpod", "audiobooks"}),
    "studio": frozenset(
        {
            "basic_generation",
            "runpod",
            "audiobooks",
            "multichannel",
            "social_platforms",
            "api_access",
        }
    ),
}

# Machine seat cap per tier (enforced server-side at activation; this is the
# client-side mirror for UI display).
TIER_MACHINE_CAP: dict[str, int] = {
    "trial": 1,
    "solo": 1,
    "pro": 3,
    "studio": 5,
}

# Daily episode quota per tier; ``None`` means unlimited. Enforced in
# ``quota.check_episode_quota``.
TIER_DAILY_EPISODE_QUOTA: dict[str, int | None] = {
    "trial": 3,
    "solo": 5,
    "pro": None,
    "studio": None,
}

# Max YouTube channels per tier.
TIER_CHANNEL_CAP: dict[str, int] = {
    "trial": 1,
    "solo": 1,
    "pro": 3,
    "studio": 1_000,
}


def _current_feature_set() -> frozenset[str]:
    state = get_state()
    if not state.is_usable or state.claims is None:
        return frozenset()
    tier = state.claims.tier
    # Prefer explicit features claim; fall back to tier default.
    if state.claims.features:
        return frozenset(state.claims.features)
    return TIER_FEATURES.get(tier, frozenset())


def has_feature(feature: str) -> bool:
    return feature in _current_feature_set()


def require_feature(feature: str) -> None:
    """FastAPI dependency: raise 402 if the current license lacks ``feature``.

    Use as ``Depends(lambda: require_feature("runpod"))`` or wrap in a small
    ``Depends`` factory — see ``fastapi_dep`` below.
    """
    state = get_state()
    if not state.is_usable:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={"error": "license_required", "state": state.status.value},
        )
    if feature not in _current_feature_set():
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "feature_not_in_tier",
                "feature": feature,
                "tier": state.claims.tier if state.claims else None,
            },
        )


def require_tier(minimum: str) -> None:
    """Raise 402 unless the current tier is ``>=`` the minimum.

    Ordering: trial < solo < pro < studio.
    """
    order = {"trial": 0, "solo": 1, "pro": 2, "studio": 3}
    state = get_state()
    if not state.is_usable or state.claims is None:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={"error": "license_required", "state": state.status.value},
        )
    current_rank = order.get(state.claims.tier, -1)
    required_rank = order.get(minimum, 999)
    if current_rank < required_rank:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "tier_too_low",
                "required": minimum,
                "current": state.claims.tier,
            },
        )


def fastapi_dep_require_feature(feature: str) -> Callable[[], None]:
    """Factory that returns a FastAPI dependency for ``require_feature``.

    Usage:
        @router.post("/...", dependencies=[Depends(fastapi_dep_require_feature("runpod"))])
    """

    def _dep() -> None:
        require_feature(feature)

    return _dep


def fastapi_dep_require_tier(minimum: str) -> Callable[[], None]:
    def _dep() -> None:
        require_tier(minimum)

    return _dep

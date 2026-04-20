"""License subsystem: JWT verification, state, middleware, feature gating.

Public API re-exports. Internal callers should import from this package, not
from the submodules directly.
"""

from shortsfactory.core.license.claims import LicenseClaims
from shortsfactory.core.license.features import (
    TIER_FEATURES,
    TIER_MACHINE_CAP,
    has_feature,
    require_feature,
    require_tier,
)
from shortsfactory.core.license.machine import stable_machine_id
from shortsfactory.core.license.state import (
    LicenseState,
    LicenseStatus,
    get_local_version,
    get_state,
    set_local_version,
    set_state,
)
from shortsfactory.core.license.verifier import (
    LicenseVerificationError,
    bootstrap_license_state,
    verify_jwt,
)

__all__ = [
    "LicenseClaims",
    "LicenseState",
    "LicenseStatus",
    "LicenseVerificationError",
    "TIER_FEATURES",
    "TIER_MACHINE_CAP",
    "bootstrap_license_state",
    "get_state",
    "has_feature",
    "require_feature",
    "require_tier",
    "set_state",
    "stable_machine_id",
    "verify_jwt",
]

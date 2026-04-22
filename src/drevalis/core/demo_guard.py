"""Demo-mode route guard middleware.

In ``DEMO_MODE=true`` we want users to poke around the real UI without
breaking things or hitting real third-party APIs. Three strategies per
route, in order of preference:

1. **Already simulated** — route has its own demo branch that returns
   a fake success (login bootstrap, YouTube upload, episode generation,
   license status). These pass straight through.
2. **Safe to let through** — read-only routes, CRUD on demo-scoped
   tables, editor + asset uploads (writes land in the demo pg + fs
   and get wiped by the nightly reset).
3. **Block with a friendly message** — routes that would hit real
   external services (RunPod / Vast / Lambda launch, TikTok /
   Instagram / X OAuth start, voice cloning actual IVC call, license
   server activate / deactivate). This middleware returns
   ``403 {"detail": {"error": "disabled_in_demo", ...}}`` the
   frontend surfaces via the existing error toast.

Patterns below match path prefixes + HTTP methods. Kept declarative
so adding a new block takes one line.
"""

from __future__ import annotations

import re

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


# ( method, path_regex, reason ) — ANY match → 403.
#
# These are intentionally strict: every entry reaches an external paid
# API or writes something operators need to reconcile offline. Read
# endpoints (GET) for the same resources stay open.
_BLOCKED: list[tuple[str, re.Pattern[str], str]] = [
    # Cloud GPU — real API calls cost money.
    (
        "POST",
        re.compile(r"^/api/v1/cloud-gpu/[^/]+/launch$"),
        "Cloud GPU launch is disabled in the demo.",
    ),
    ("POST", re.compile(r"^/api/v1/runpod/pods$"), "Pod creation is disabled in the demo."),
    ("DELETE", re.compile(r"^/api/v1/runpod/pods/[^/]+$"), "Pod deletion is disabled in the demo."),
    (
        "POST",
        re.compile(r"^/api/v1/runpod/pods/[^/]+/(start|stop)$"),
        "Pod lifecycle actions are disabled in the demo.",
    ),
    # Social OAuth — real redirect would drop demo users on a broken
    # callback the demo's NPM can't accept.
    (
        "GET",
        re.compile(r"^/api/v1/social/[^/]+/oauth"),
        "Connecting a real social account is disabled in the demo.",
    ),
    (
        "POST",
        re.compile(r"^/api/v1/social/[^/]+/oauth"),
        "Connecting a real social account is disabled in the demo.",
    ),
    (
        "GET",
        re.compile(r"^/api/v1/youtube/oauth"),
        "Connecting a real YouTube channel is disabled in the demo.",
    ),
    # License activate / deactivate — demo is license-free.
    ("POST", re.compile(r"^/api/v1/license/activate$"), "The demo has no license to activate."),
    ("POST", re.compile(r"^/api/v1/license/deactivate"), "The demo has no license to deactivate."),
    (
        "POST",
        re.compile(r"^/api/v1/license/portal$"),
        "Stripe billing portal is disabled in the demo.",
    ),
    # Voice test — would send real audio to ElevenLabs.
    (
        "POST",
        re.compile(r"^/api/v1/voice-profiles/[^/]+/test$"),
        "Voice synthesis is disabled in the demo.",
    ),
    (
        "POST",
        re.compile(r"^/api/v1/voice-profiles/generate-previews$"),
        "Voice previews are disabled in the demo.",
    ),
    # Backups — the demo's postgres gets wiped nightly; restoring from
    # a real install's tarball would fail on schema drift.
    (
        "POST",
        re.compile(r"^/api/v1/backup/restore"),
        "Restoring from a backup is disabled in the demo.",
    ),
    ("POST", re.compile(r"^/api/v1/backup$"), "Creating backup archives is disabled in the demo."),
    (
        "DELETE",
        re.compile(r"^/api/v1/backup/"),
        "Deleting backup archives is disabled in the demo.",
    ),
    # Updates — won't work against the demo image anyway.
    ("POST", re.compile(r"^/api/v1/updates/"), "In-app updates are disabled in the demo."),
]


class DemoGuardMiddleware(BaseHTTPMiddleware):
    """Returns 403 with a friendly detail when a route on the block list
    is hit while ``settings.demo_mode`` is True. No-op otherwise.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        from drevalis.core.deps import get_settings

        try:
            demo_mode = get_settings().demo_mode
        except Exception:
            demo_mode = False

        if not demo_mode:
            return await call_next(request)

        path = request.url.path
        method = request.method.upper()
        for blocked_method, pat, reason in _BLOCKED:
            if blocked_method == method and pat.match(path):
                logger.info("demo_guard_blocked", method=method, path=path, reason=reason)
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": {
                            "error": "disabled_in_demo",
                            "message": reason,
                        }
                    },
                )
        return await call_next(request)


__all__ = ["DemoGuardMiddleware"]

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

import json
import re

import structlog
from starlette.types import ASGIApp, Receive, Scope, Send

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
    # Asset uploads — prevent random visitors from filling the demo VPS
    # disk with anything they like. Reading + listing assets stays open.
    (
        "POST",
        re.compile(r"^/api/v1/assets$"),
        "Uploading assets is disabled in the demo.",
    ),
    (
        "PATCH",
        re.compile(r"^/api/v1/assets/[^/]+$"),
        "Editing assets is disabled in the demo.",
    ),
    (
        "DELETE",
        re.compile(r"^/api/v1/assets/[^/]+$"),
        "Deleting assets is disabled in the demo.",
    ),
    # Video ingest uploads a whole video file — same security concern.
    (
        "POST",
        re.compile(r"^/api/v1/video-ingest$"),
        "Video uploads are disabled in the demo.",
    ),
]


class DemoGuardMiddleware:
    """Pure-ASGI demo guard. Returns 403 with a friendly detail when a
    request matches the block list in demo_mode; otherwise no-op.

    Written as raw ASGI (not ``BaseHTTPMiddleware``) so it doesn't
    interfere with the SQLAlchemy asyncpg connection pool's task-scope
    lifecycle — ``BaseHTTPMiddleware`` wraps the inner app in an
    ``anyio`` task group that has been known to close DB connections
    mid-query.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        try:
            from drevalis.core.deps import get_settings

            demo_mode = get_settings().demo_mode
        except Exception:
            demo_mode = False

        if not demo_mode:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = (scope.get("method") or "").upper()
        for blocked_method, pat, reason in _BLOCKED:
            if blocked_method == method and pat.match(path):
                logger.info("demo_guard_blocked", method=method, path=path, reason=reason)
                body = json.dumps(
                    {"detail": {"error": "disabled_in_demo", "message": reason}}
                ).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 403,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return

        await self.app(scope, receive, send)


__all__ = ["DemoGuardMiddleware"]

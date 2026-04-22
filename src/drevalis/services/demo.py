"""Demo-mode helpers.

When ``settings.demo_mode`` is True, parts of the app change behaviour to
make the install safe as a public playground:

* Destructive routes are blocked (delete, reset, restore, regenerate).
* ``generate_episode`` runs a fake state machine instead of the real
  pipeline — see ``workers/jobs/demo_pipeline.py``.
* The licence check is bypassed so visitors never hit the activation
  wizard.
* Upload endpoints return a simulated success instead of calling
  YouTube / TikTok APIs.

All of this is behind a single boolean so prod installs are 100%
unaffected — if the env var isn't set, none of this code runs.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, status

from drevalis.core.deps import get_settings


def is_demo_mode(settings: object = Depends(get_settings)) -> bool:
    """FastAPI dependency — returns True in demo mode."""
    return bool(getattr(settings, "demo_mode", False))


def require_not_demo(settings: object = Depends(get_settings)) -> None:
    """Gate dependency — refuses the request when demo mode is active.

    Use on destructive routes (DELETE, RESET, RESTORE, etc.) that don't
    belong in a public playground.
    """
    if getattr(settings, "demo_mode", False):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "disabled_in_demo",
        )


# Pre-baked fake data the demo pipeline streams to the UI. Values mirror
# the real pipeline shape so the frontend WebSocket handler needs zero
# branching.
DEMO_STEPS: tuple[tuple[str, float], ...] = (
    ("script", 2.5),  # step name, simulated duration seconds
    ("voice", 6.0),
    ("scenes", 18.0),
    ("captions", 4.5),
    ("assembly", 7.5),
    ("thumbnail", 2.0),
)
"""Ordered (step, seconds) pairs totalling ~40s — long enough to feel real,
short enough to keep the demo visitor engaged."""

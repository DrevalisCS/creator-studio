"""Playwright driver that captures the 6 marketing-site screenshots.

Runs on the **VPS host** (not inside a container), against the demo
Drevalis stack exposed at http://localhost:13000. License activation
is done up-front via the app's API on http://localhost:18000 using a
JWT we paste via env var.

Output PNGs are written into ``/srv/drevalis-site/public/assets/images/``
directly — the marketing nginx container bind-mounts that dir at build
time, so after this script finishes a rebuild picks up the new images.

Run:

    export DEMO_LICENSE_JWT="eyJhbGciOi..."
    python3 take_marketing_screenshots.py

Required system deps on the VPS::

    pip install playwright
    playwright install chromium
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

from playwright.async_api import Page, async_playwright

APP_URL = os.environ.get("DEMO_APP_URL", "http://localhost:18000")
FRONTEND_URL = os.environ.get("DEMO_FRONTEND_URL", "http://localhost:13000")
LICENSE_JWT = os.environ.get("DEMO_LICENSE_JWT", "")

OUT_DIR = Path(os.environ.get("MARKETING_IMAGES_DIR", "/srv/drevalis-site/public/assets/images"))


SHOTS: list[dict[str, object]] = [
    {
        "name": "hero-dashboard.png",
        "path": "/",
        "viewport": {"width": 1920, "height": 1080},
        # Give the dashboard's polling + WebSocket a moment to settle.
        "settle_ms": 2500,
    },
    {
        "name": "workflow-activity-monitor.png",
        "path": "/jobs",
        "viewport": {"width": 2100, "height": 900},
        "settle_ms": 1500,
    },
    {
        "name": "feature-script-editor.png",
        # Navigated to via JS after login — the EpisodeDetail page uses
        # an episode UUID the seed picked for us. Resolved dynamically
        # from the /api/v1/episodes list below.
        "path": "__episode_detail_review__?tab=script",
        "viewport": {"width": 1600, "height": 1200},
        "settle_ms": 1200,
    },
    {
        "name": "feature-scene-grid.png",
        "path": "__episode_detail_review__?tab=scenes",
        "viewport": {"width": 1600, "height": 1200},
        "settle_ms": 1200,
    },
    {
        "name": "feature-voice-profiles.png",
        "path": "/settings?section=voices",
        "viewport": {"width": 1600, "height": 1200},
        "settle_ms": 1200,
    },
    {
        "name": "feature-youtube-publish.png",
        "path": "/youtube",
        "viewport": {"width": 1600, "height": 1200},
        "settle_ms": 1500,
    },
]


async def _activate_license(page: Page) -> None:
    """POST the JWT straight at /api/v1/license/activate so we skip the
    wizard modal. Uses the browser's fetch so the cookie/session lands
    in the same context as subsequent page.goto() calls."""
    if not LICENSE_JWT:
        return
    result = await page.evaluate(
        """async (args) => {
            const [apiUrl, jwt] = args;
            const res = await fetch(apiUrl + '/api/v1/license/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ license_jwt: jwt }),
            });
            return { status: res.status, body: await res.text() };
        }""",
        [APP_URL, LICENSE_JWT],
    )
    print(f"  activate: status={result['status']}")
    if result["status"] >= 400:
        print(f"  activate body: {str(result['body'])[:400]}")


async def _dismiss_onboarding(page: Page) -> None:
    """Pre-arm the onboarding-dismissed flag so the wizard doesn't cover
    the dashboard screenshot."""
    await page.evaluate(
        """async (apiUrl) => {
            try {
                await fetch(apiUrl + '/api/v1/onboarding/dismiss', { method: 'POST' });
            } catch (e) {}
        }""",
        APP_URL,
    )


async def _pick_review_episode_id(page: Page) -> str | None:
    """Resolve a seeded episode in status=review to use for the
    EpisodeDetail screenshots."""
    res = await page.evaluate(
        """async (apiUrl) => {
            const r = await fetch(apiUrl + '/api/v1/episodes?limit=100');
            if (!r.ok) return null;
            const items = await r.json();
            const review = items.find(e => e.status === 'review');
            return review ? review.id : null;
        }""",
        APP_URL,
    )
    return res


async def capture(page: Page, spec: dict[str, object], review_id: str | None) -> None:
    viewport = spec["viewport"]
    await page.set_viewport_size(viewport)  # type: ignore[arg-type]

    path_template = str(spec["path"])
    if path_template.startswith("__episode_detail_review__"):
        if not review_id:
            print(f"  SKIP {spec['name']} — no review episode found")
            return
        qs = ""
        if "?" in path_template:
            qs = "?" + path_template.split("?", 1)[1]
        url = f"{FRONTEND_URL}/episodes/{review_id}{qs}"
    else:
        url = f"{FRONTEND_URL}{path_template}"

    print(f"  → {url}")
    await page.goto(url, wait_until="networkidle", timeout=30_000)
    await page.wait_for_timeout(int(spec["settle_ms"]))  # type: ignore[arg-type]

    out_path = OUT_DIR / str(spec["name"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    await page.screenshot(path=str(out_path), full_page=False)
    print(f"  ✓ {out_path} ({out_path.stat().st_size // 1024} KB)")


async def main() -> int:
    if not OUT_DIR.exists():
        print(f"ERROR: output directory does not exist: {OUT_DIR}")
        return 2
    if not LICENSE_JWT:
        print("WARN: DEMO_LICENSE_JWT not set — will try to screenshot unactivated state (likely blank)")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        # Separate context per run — device scale factor 2 gives us Retina-sharp PNGs.
        ctx = await browser.new_context(device_scale_factor=1)
        page = await ctx.new_page()

        print(f"activating license on {APP_URL}…")
        # We must hit the API from inside the browser context so the
        # license state sticks for subsequent same-origin requests.
        await page.goto(f"{FRONTEND_URL}/", wait_until="domcontentloaded")
        await _activate_license(page)
        await _dismiss_onboarding(page)

        print("resolving seeded review episode…")
        review_id = await _pick_review_episode_id(page)
        print(f"  review_id = {review_id}")

        for spec in SHOTS:
            print(f"capturing {spec['name']}")
            try:
                await capture(page, spec, review_id)
            except Exception as exc:
                print(f"  FAILED {spec['name']}: {exc}")

        await browser.close()

    # Copy the README too (keeps doc/image parity).
    repo_readme = Path(__file__).parent / "marketing_images_README.md"
    if repo_readme.exists():
        shutil.copy(repo_readme, OUT_DIR / "README.md")

    print("done. review the PNGs, then rebuild the marketing container.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

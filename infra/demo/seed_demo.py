"""Seed the demo Drevalis stack with showcase content for screenshots.

Runs *inside* the demo `app` container via::

    docker compose exec app python /app/seed_demo.py

Uses the app's own SQLAlchemy session + LocalStorage so we bypass the
REST API entirely (no auth tokens, no license activation, no risk of
tripping over tier gates). Idempotent — running twice replaces
previous demo data rather than duplicating it.

What it creates:

- 1 LLM config (LM Studio placeholder)
- 1 ComfyUI server (placeholder URL)
- 5 voice profiles (4 Edge neural voices, 1 ElevenLabs mock)
- 3 YouTube channels (fake OAuth tokens — we never try to upload)
- 3 series with different topics and visual styles
- 12 episodes across the three series:
    - 2 currently "generating" (so Activity Monitor shows life)
    - 4 in "review" with scripts + scene assets
    - 5 "exported" with thumbnails + published metadata
    - 1 "failed" (for the error-state card)

Placeholder media (gradient PNGs, short WAVs) is written to
/app/storage/episodes/<id>/ so the UI renders thumbnails + the scene
grid. The gradients look intentional at screenshot size; we don't
pretend the user generated them with a real ComfyUI run.
"""

from __future__ import annotations

import asyncio
import os
import random
import struct
import sys
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

# Use the app's own packages — this script runs inside the image.
sys.path.insert(0, "/app/src")

from sqlalchemy import text  # noqa: E402

from drevalis.core.config import Settings  # noqa: E402
from drevalis.core.database import get_session_factory, init_db  # noqa: E402
from drevalis.models.comfyui import ComfyUIServer  # noqa: E402
from drevalis.models.episode import Episode  # noqa: E402
from drevalis.models.llm_config import LLMConfig  # noqa: E402
from drevalis.models.media_asset import MediaAsset  # noqa: E402
from drevalis.models.series import Series  # noqa: E402
from drevalis.models.voice_profile import VoiceProfile  # noqa: E402
from drevalis.models.youtube_channel import YouTubeChannel  # noqa: E402

STORAGE_ROOT = Path(os.environ.get("STORAGE_BASE_PATH", "/app/storage"))


# ─────────────────────────────────────────────────────────────────
# Placeholder asset generation
# ─────────────────────────────────────────────────────────────────


def _write_gradient_png(path: Path, width: int, height: int, colour: tuple[int, int, int]) -> None:
    """Minimal PNG writer — single-colour fill plus a subtle vignette.

    Avoids Pillow dependency (which is present in the image anyway, but
    keeping this stdlib-only lets the seed script run in tiny envs too).
    """
    try:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (width, height), colour)
        draw = ImageDraw.Draw(img)
        # Gradient band across the bottom third for visual interest.
        for y in range(int(height * 0.66), height):
            alpha = (y - height * 0.66) / (height * 0.34)
            tint = tuple(int(c * (1 - alpha * 0.6)) for c in colour)
            draw.line([(0, y), (width, y)], fill=tint)
        path.parent.mkdir(parents=True, exist_ok=True)
        img.save(path, "PNG", optimize=True)
    except ImportError:
        # Fallback: 1×1 PNG — invisible but keeps the MediaAsset row valid.
        path.parent.mkdir(parents=True, exist_ok=True)
        data = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
            b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00"
            b"\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01"
            b"[\xde\x0b\xeb\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        path.write_bytes(data)


def _write_silent_wav(path: Path, duration_seconds: float = 2.0) -> None:
    """Write a short silent 16-bit mono WAV. Enough to make the UI show
    a waveform marker without triggering any real TTS work."""
    path.parent.mkdir(parents=True, exist_ok=True)
    framerate = 16000
    n_frames = int(framerate * duration_seconds)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(framerate)
        wf.writeframes(struct.pack(f"<{n_frames}h", *([0] * n_frames)))


# ─────────────────────────────────────────────────────────────────
# Seed content
# ─────────────────────────────────────────────────────────────────

VOICE_STARTERS: list[dict[str, Any]] = [
    {"name": "Aria (US English, female)", "provider": "edge", "edge_voice_id": "en-US-AriaNeural", "gender": "female"},
    {"name": "Guy (US English, male)", "provider": "edge", "edge_voice_id": "en-US-GuyNeural", "gender": "male"},
    {"name": "Jenny (US English, female)", "provider": "edge", "edge_voice_id": "en-US-JennyNeural", "gender": "female"},
    {"name": "Davis (US English, male)", "provider": "edge", "edge_voice_id": "en-US-DavisNeural", "gender": "male"},
    {"name": "ElevenLabs River", "provider": "elevenlabs", "elevenlabs_voice_id": "river-neutral-american", "gender": "neutral"},
]

YT_CHANNELS = [
    {
        "channel_id": "UCdemo-science",
        "name": "Curious Mind Science",
        "subscriber_count": 48_213,
    },
    {
        "channel_id": "UCdemo-truecrime",
        "name": "Dark Files",
        "subscriber_count": 12_904,
    },
    {
        "channel_id": "UCdemo-history",
        "name": "Odd History",
        "subscriber_count": 73_560,
    },
]

SERIES_SPECS = [
    {
        "name": "Curious Mind — 60-second Science",
        "description": "One surprising scientific fact per episode, told in 60 seconds.",
        "visual_style": "Clean editorial illustrations on dark teal backgrounds, subtle motion.",
        "content_format": "shorts",
        "target_duration_seconds": 60,
        "aspect_ratio": "9:16",
        "channel_index": 0,
        "colour": (18, 48, 54),
    },
    {
        "name": "Dark Files — True Crime Deep Dives",
        "description": "A long-form dive into a single cold case per episode. Facts first, drama second.",
        "visual_style": "Moody noir — low-key lighting, monochrome blues, rain-streaked windows, evidence boards.",
        "content_format": "longform",
        "target_duration_seconds": 60,
        "aspect_ratio": "16:9",
        "channel_index": 1,
        "colour": (22, 22, 34),
    },
    {
        "name": "Odd History — Weird Facts We Forgot",
        "description": "60-second bite-sized reminders that history was much stranger than the textbooks let on.",
        "visual_style": "Warm parchment tones, engraved illustrations, sepia photo treatments.",
        "content_format": "shorts",
        "target_duration_seconds": 60,
        "aspect_ratio": "9:16",
        "channel_index": 2,
        "colour": (74, 54, 30),
    },
]

# Pool of friendly titles cycled across the real content directories
# at seed time (one episode per real dir, no fake placeholders). The
# 1:1 mapping means everything the demo shows has actual media behind
# it — no "no video available" gaps.
TITLE_POOL = [
    "Why your hair stands up before lightning",
    "The ant-bridge that can span 70 ants wide",
    "Octopuses have three hearts and blue blood",
    "A spoonful of neutron star weighs 10 million tons",
    "Bananas are mildly radioactive (and safe)",
    "Why Victorians took photos of the dead",
    "The dancing plague of 1518",
    "Pope Stephen VI put a corpse on trial",
    "The Somerton Man — 76 years of clues",
    "Tamam Shud: the pocket note that rewrote the case",
    "Elisa Lam and the Cecil Hotel water tank",
    "The Isdal Woman — Norway's unsolved spy case",
    "The loudest sound ever recorded on Earth",
    "Why honey never spoils",
    "The coconut crab can open a can with its claws",
    "Cleopatra lived closer to the Moon landing than the pyramids",
    "Medieval people didn't think Earth was flat",
    "Why cows have best friends",
    "Saturn would float in water if you had a big enough bathtub",
    "The Roman concrete that keeps getting stronger",
]


async def seed() -> None:
    settings = Settings()
    await init_db(settings)
    Session = get_session_factory()

    async with Session() as session:
        # Nuke prior demo rows so repeated runs don't accumulate duplicates.
        # Delete in FK-safe order.
        for tbl in (
            "media_assets",
            "generation_jobs",
            "youtube_uploads",
            "scheduled_posts",
            "episodes",
            "series",
            "voice_profiles",
            "llm_configs",
            "comfyui_servers",
            "youtube_channels",
        ):
            await session.execute(text(f"DELETE FROM {tbl}"))
        await session.flush()

        # LLM config.
        llm = LLMConfig(
            name="Local — LM Studio",
            base_url="http://host.docker.internal:1234/v1",
            model_name="local-llama-3.1-8b",
        )
        session.add(llm)

        # ComfyUI server.
        comfy = ComfyUIServer(
            name="Home rig — RTX 4090",
            url="http://host.docker.internal:8188",
            max_concurrent=2,
            is_active=True,
        )
        session.add(comfy)

        # Voice profiles.
        voices: list[VoiceProfile] = []
        for v in VOICE_STARTERS:
            vp = VoiceProfile(
                name=v["name"],
                provider=v["provider"],
                edge_voice_id=v.get("edge_voice_id"),
                elevenlabs_voice_id=v.get("elevenlabs_voice_id"),
                gender=v.get("gender"),
                speed=1.0,
                pitch=1.0,
            )
            voices.append(vp)
            session.add(vp)

        # YouTube channels — mock OAuth tokens (never used).
        channels: list[YouTubeChannel] = []
        now = datetime.now(UTC)
        for c in YT_CHANNELS:
            yt = YouTubeChannel(
                channel_id=c["channel_id"],
                channel_name=c["name"],
                access_token_encrypted="demo-access-token-encrypted",
                refresh_token_encrypted="demo-refresh-token-encrypted",
                token_expiry=now + timedelta(days=365),
                upload_days=["monday", "wednesday", "friday"],
                upload_time="14:00",
            )
            channels.append(yt)
            session.add(yt)

        await session.flush()

        # Series.
        series_rows: list[Series] = []
        for spec in SERIES_SPECS:
            s = Series(
                name=spec["name"],
                description=spec["description"],
                visual_style=spec["visual_style"],
                target_duration_seconds=spec["target_duration_seconds"],
                content_format=spec["content_format"],
                aspect_ratio=spec["aspect_ratio"],
                voice_profile_id=voices[spec["channel_index"]].id,
                llm_config_id=llm.id,
                comfyui_server_id=comfy.id,
                youtube_channel_id=channels[spec["channel_index"]].id,
            )
            series_rows.append(s)
            session.add(s)
        await session.flush()

        # One seeded episode per real content directory. No gradient
        # placeholders, no fake stubs — if a dir is missing any of the
        # four required pieces (scenes + voice + thumbnail + final)
        # ``_discover_real_content`` filters it out.
        real_pool = _discover_real_content()
        print(f"  real content pool: {len(real_pool)} directories")

        if not real_pool:
            print(
                "  no complete content directories under storage/episodes/ — "
                "demo will have zero episodes. Drop a folder with "
                "output/final.mp4 + output/thumbnail.jpg + voice/full.wav "
                "+ scenes/scene_NN.png to populate."
            )

        rng = random.Random(42)
        for ep_idx, source_dir in enumerate(real_pool):
            series = series_rows[ep_idx % len(series_rows)]
            title = TITLE_POOL[ep_idx % len(TITLE_POOL)]
            scene_files = sorted((source_dir / "scenes").glob("scene_*.png"))
            scene_count = len(scene_files)

            ep = Episode(
                series_id=series.id,
                title=title,
                topic=title,
                # Stagger statuses so the UI has something in review +
                # exported: first two of every three are exported,
                # third is review.
                status="review" if ep_idx % 3 == 2 else "exported",
                content_format=series.content_format,
                script=_fake_script(title, scene_count),
                metadata_={
                    "seo": {
                        "title": title,
                        "description": (
                            f"{title}. A short, evidence-first explainer that fits in "
                            "under a minute. Subscribe for a new fact every Monday."
                        ),
                        "hashtags": ["#shorts", "#sciencefacts", "#didyouknow"],
                        "tags": ["science", "facts", "shorts", "education", "explainer"],
                        "hook": f"Did you know {title.lower()}?",
                        "virality_score": rng.randint(6, 9),
                        "virality_reasoning": "Strong open hook + universal curiosity gap.",
                    },
                },
            )
            session.add(ep)
            await session.flush()

            source_id = source_dir.name

            # Thumbnail.
            thumb_rel = f"episodes/{source_id}/output/thumbnail.jpg"
            thumb_abs = STORAGE_ROOT / thumb_rel
            session.add(
                MediaAsset(
                    episode_id=ep.id,
                    asset_type="thumbnail",
                    file_path=thumb_rel,
                    file_size_bytes=thumb_abs.stat().st_size,
                )
            )

            # Scenes (one row per scene_*.png).
            for i, scene_path in enumerate(scene_files, start=1):
                rel = f"episodes/{source_id}/scenes/{scene_path.name}"
                session.add(
                    MediaAsset(
                        episode_id=ep.id,
                        asset_type="scene",
                        scene_number=i,
                        file_path=rel,
                        file_size_bytes=scene_path.stat().st_size,
                    )
                )

            # Voice.
            voice_rel = f"episodes/{source_id}/voice/full.wav"
            voice_abs = STORAGE_ROOT / voice_rel
            session.add(
                MediaAsset(
                    episode_id=ep.id,
                    asset_type="voiceover",
                    file_path=voice_rel,
                    file_size_bytes=voice_abs.stat().st_size,
                )
            )

            # Final video.
            vid_rel = f"episodes/{source_id}/output/final.mp4"
            vid_abs = STORAGE_ROOT / vid_rel
            session.add(
                MediaAsset(
                    episode_id=ep.id,
                    asset_type="video",
                    file_path=vid_rel,
                    file_size_bytes=vid_abs.stat().st_size,
                )
            )

            _ = UUID  # keep import used if type-checker runs

        await session.commit()
        print(
            f"seeded: {len(voices)} voices, {len(channels)} yt channels, "
            f"{len(series_rows)} series, {len(real_pool)} episodes"
        )


def _fake_script(title: str, n_scenes: int) -> dict[str, Any]:
    """Minimal EpisodeScript-shaped JSON for the UI to render the Script tab.

    Includes ``title``, ``total_duration_seconds``, and ``outro`` so the
    strict ``EpisodeScript`` validator used by the editor / reassemble
    routes doesn't reject it.
    """
    scenes = []
    total = 0.0
    for i in range(1, n_scenes + 1):
        dur = 8 + (i % 3) * 2
        total += dur
        scenes.append(
            {
                "scene_number": i,
                "narration": f"[Scene {i}] Context for '{title}' — paragraph {i} of the narration, "
                "kept deliberately short so the screenshot reads clean at 1600×1200.",
                "visual_prompt": f"Cinematic establishing shot illustrating beat {i} of the topic.",
                "duration_seconds": dur,
                "keywords": ["demo", "science", f"beat-{i}"],
            }
        )
    return {
        "title": title,
        "hook": f"Did you know {title.lower()}?",
        "outro": "Subscribe for a new one every Monday.",
        "scenes": scenes,
        "total_duration_seconds": total,
        "language": "en-US",
        "description": f"{title} — short-form demo content.",
        "hashtags": ["#shorts", "#sciencefacts"],
        "thumbnail_prompt": f"High-contrast poster for '{title}'.",
        "cta": "Subscribe for a new one every Monday.",
    }


def _discover_real_content() -> list[Path]:
    """Return directories under ``storage/episodes/`` that contain a
    **complete** set of demo-worthy media: scenes + voice + thumbnail
    + **real** final video. 1-KB stub videos left over from older seed
    runs are rejected via a minimum file-size threshold.
    """
    out: list[Path] = []
    base = STORAGE_ROOT / "episodes"
    if not base.exists():
        return out
    MIN_VIDEO_BYTES = 64 * 1024  # 64 KB — anything smaller is a stub
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        final = child / "output" / "final.mp4"
        thumb = child / "output" / "thumbnail.jpg"
        voice = child / "voice" / "full.wav"
        scenes_dir = child / "scenes"
        has_final = final.exists() and final.stat().st_size >= MIN_VIDEO_BYTES
        has_thumb = thumb.exists() and thumb.stat().st_size >= 1024
        has_voice = voice.exists() and voice.stat().st_size >= 1024
        has_scenes = scenes_dir.exists() and any(scenes_dir.glob("scene_*.png"))
        if has_final and has_scenes and has_voice and has_thumb:
            out.append(child)
    return out


if __name__ == "__main__":
    asyncio.run(seed())

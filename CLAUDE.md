# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Drevalis Creator Studio** is an AI-powered YouTube Shorts and long-form video creation studio and text-to-voice platform. The product is sold by Drevalis. Python package name is `shortsfactory` (internal, pre-rebrand — do not rename). It automates the full pipeline from script generation through final video assembly and YouTube upload. The system handles two primary workflows:

1. **YouTube video generation**: An LLM writes episodic scripts from a series bible, TTS voices them, ComfyUI generates scene images/video, faster-whisper produces word-level captions, and FFmpeg composites everything into MP4 files (9:16 Shorts, 16:9 long-form, or 1:1 square) with burned-in animated subtitles. Finished videos can be uploaded directly to YouTube via OAuth. Long-form episodes use a 3-phase chunked LLM generation: outline → chapters → quality review.

2. **Text-to-Voice studio (Audiobooks)**: Converts long-form text into audiobooks with chapter detection, multi-voice casting via `[Speaker]` tags, background music with sidechain ducking, speed/pitch controls, and multiple output formats (audio-only WAV/MP3, audio+image MP4, audio+video MP4).

The application is designed as a **local-first** tool. All heavy processing (LLM inference, TTS, image generation) runs on the user's machine by default, with optional cloud fallbacks (Claude for scripts, ElevenLabs for voices, Edge TTS for free cloud voices).

## Commands

### Development

```bash
docker compose up -d                  # start all services (app, worker, postgres, redis, frontend)
docker compose up -d postgres redis   # start only infrastructure (for local backend dev)
uvicorn src.shortsfactory.main:app --reload --port 8000   # run backend locally
cd frontend && npm run dev            # run frontend locally (Vite on port 5173)
python -m arq src.shortsfactory.workers.settings.WorkerSettings   # run arq worker locally
alembic upgrade head                  # run database migrations
alembic revision --autogenerate -m "description"   # create a new migration
```

### Testing

```bash
pytest tests/ -v                            # run all tests
pytest tests/unit/ -v                       # unit tests only
pytest tests/integration/ -v                # integration tests (requires services)
pytest tests/ --cov=src/shortsfactory       # with coverage report
pytest tests/ -v -m "not slow"              # skip slow tests
pytest tests/ -v -m "not integration"       # skip integration tests
```

### Linting and Quality

```bash
ruff check src/ tests/       # lint
ruff format src/ tests/      # auto-format
mypy src/ --strict           # type check (strict mode, pydantic + SQLAlchemy plugins)
bandit -r src/ -c pyproject.toml   # security scan
pip-audit                    # dependency vulnerability check
```

## Architecture

### Layered Structure

The backend enforces strict **Router -> Service -> Repository** layering:

- **Routers** (`api/routes/`) handle HTTP concerns: request parsing, response serialization, status codes. They call services, never repositories directly.
- **Services** (`services/`) contain business logic. They orchestrate operations across multiple repositories and external providers. They never import FastAPI or know about HTTP.
- **Repositories** (`repositories/`) own all database query logic. Each repository wraps a single SQLAlchemy model. They never call other repositories or services.

### Generation Pipeline

The six-step pipeline runs as a **single arq job** with a `PipelineOrchestrator` state machine (`services/pipeline.py`). Steps execute sequentially. Each step's completion is persisted to the `generation_jobs` table before proceeding. On retry, completed steps are skipped automatically. Per-scene resumability is built in: existing `media_assets` records are detected and skipped on retry, and existing TTS WAV files on disk are reused without re-synthesis.

Steps: `script` -> `voice` -> `scenes` -> `captions` -> `assembly` -> `thumbnail`

Progress is broadcast via Redis pub/sub to WebSocket clients in real time. The `/ws/progress/all` endpoint supports pattern subscription across all active episodes simultaneously. DB progress updates are written for all status changes, not just running jobs. Each step's duration and success/failure are recorded in the in-process metrics collector.

**Cancellation**: Pipelines can be cancelled mid-run via Redis cancel flags (`cancel:{episode_id}`). The orchestrator checks for cancellation between steps. Emergency stop (`POST /api/v1/jobs/cancel-all`) cancels all generating episodes at once.

**Long-form pipeline additions**: Long-form episodes additionally store `chapters` (JSONB) on the episode record and support per-chapter music with crossfade transitions. Chapter metadata includes timing, title, and scene ranges.

**Orphan reset**: On worker startup, both episodes stuck in `generating` status and audiobooks stuck in `generating` status are automatically reset to `failed`, preventing permanently stuck jobs after a crash.

### arq Worker Jobs

The worker (`workers/settings.py`) registers job functions:

| Job | Purpose |
|-----|---------|
| `generate_episode` | Full pipeline run for an episode |
| `generate_audiobook` | Text-to-audiobook conversion |
| `retry_episode_step` | Retry a specific failed pipeline step |
| `reassemble_episode` | Re-run captions + assembly + thumbnail only (keeps voice/scenes) |
| `regenerate_voice` | Re-run voice + captions + assembly + thumbnail (keeps scenes) |
| `regenerate_scene` | Regenerate a single scene image, then reassemble |
| `regenerate_audiobook_chapter` | Regenerate single audiobook chapter audio |
| `generate_script_async` | Background LLM audiobook script generation |
| `generate_ai_audiobook` | Combined LLM script + TTS generation (single-form AI creator); skips LLM if script text already exists |
| `generate_series_async` | AI-generate series with episodes |
| `auto_deploy_runpod_pod` | Poll RunPod pod status, auto-register when ready |
| `publish_scheduled_posts` | Cron job (every 5 min) — resolves channel from `youtube_channel_id` on the series, uploads to YouTube with 3x retry and backoff |
| `generate_episode_music` | Background AceStep music generation via ComfyUI (moved from synchronous HTTP handler) |
| `generate_seo_async` | Background SEO metadata generation via LLM (moved from synchronous HTTP handler) |

Worker settings: `max_jobs=8`, `shorts_job_timeout=7200` (2 hours), `longform_job_timeout=14400` (4 hours), `max_tries=3`.

**Priority enforcement**: A `set-priority` flag in Redis (`shorts_first` / `longform_first` / `fifo`) controls job ordering. When `shorts_first` is active, long-form episode jobs are deferred while any shorts are waiting in the queue.

### Provider Abstractions

TTS and LLM integrations use **Python `Protocol` classes** (PEP 544 structural subtyping) to define provider interfaces.

**TTSProvider** -- five implementations:
- `PiperTTSProvider` -- local ONNX-based TTS via `piper` CLI subprocess
- `KokoroTTSProvider` -- local high-quality ONNX-based TTS via Kokoro library (optional dependency, `pip install .[kokoro]`)
- `EdgeTTSProvider` -- free cloud TTS via Microsoft Edge neural voices (no API key needed)
- `ElevenLabsTTSProvider` -- cloud TTS via ElevenLabs REST API
- `ComfyUIElevenLabsTTSProvider` -- ElevenLabs TTS via ComfyUI nodes (uses platform API key from `api_key_store`, submits workflow, polls for audio)

TTS synthesis is parallelised: segments are distributed across multiple ComfyUI servers concurrently.

**LLMProvider** -- two implementations:
- `OpenAICompatibleProvider` -- works with LM Studio, Ollama, vLLM, or the real OpenAI API
- `AnthropicProvider` -- Claude via the Anthropic SDK

**LLMPool**: A pool class that wraps multiple `LLMProvider` instances with round-robin dispatch and automatic failover on 5xx responses or timeouts. Adding a provider to the pool requires no changes outside `services/llm.py`.

Provider selection is per-series/per-voice-profile, configured in the database. The pipeline and audiobook service resolve providers at runtime via factory functions.

### Long-Form Video Support

Series have a `content_format` column (`shorts` | `longform`) that controls the generation path.

**LongFormScriptService** (`services/longform_script.py`) uses a 3-phase chunked LLM generation:

1. **Outline phase** -- generates a high-level chapter outline from the series bible and topic.
2. **Chapter phase** -- expands each chapter independently with scene-level detail, maintaining continuity context from the previous chapter.
3. **Quality phase** -- reviews the assembled script for consistency and rewrites scenes that fail quality checks.

Chapter metadata is stored in `episodes.chapters` (JSONB). Each chapter record includes title, scene range, duration estimate, and music mood.

**Aspect ratio support**: Series configure `aspect_ratio` (`9:16` for Shorts, `16:9` for long-form, `1:1` for square). FFmpeg and ComfyUI workflow resolution are derived from this setting.

**ComfyUI workflow routing**: `comfyui_workflows.content_format` tags workflows as `shorts` or `longform`. The pipeline selects workflows accordingly (Wan 2.2 for long-form video, Qwen Image for Shorts image generation).

**Per-chapter music**: Long-form episode assembly supports per-chapter background music with configurable crossfade transitions between chapters (`transition_duration` on series).

**Cost estimation**: `POST /episodes/{id}/estimate-cost` returns a token and compute cost estimate before committing to a full generation run.

### Load Balancing

**LLMPool** -- round-robin across configured LLM endpoints with automatic failover on 5xx / timeout. All LLM calls in the pipeline and audiobook service go through the pool.

**ComfyUI pool** -- changed from least-loaded to **round-robin distribution** (least-loaded did not work correctly with `asyncio.gather` concurrent dispatches). Each server still has its own semaphore; `max_concurrent_video_jobs` on `comfyui_servers` separately caps GPU-intensive video generation jobs.

**Dynamic generation slots**: Base concurrency is 4, plus 2 additional slots per registered ComfyUI server beyond the first. `MAX_CONCURRENT_GENERATIONS` is still the hard cap.

### Storage

`LocalStorage` (`services/storage.py`) implements the `StorageBackend` protocol. All file paths in the database are **relative** to `STORAGE_BASE_PATH`. The storage class validates all resolved paths stay within the base directory (path-traversal protection). File layout:

```
storage/
  episodes/{episode_id}/voice/
  episodes/{episode_id}/scenes/
  episodes/{episode_id}/captions/
  episodes/{episode_id}/output/
  episodes/{episode_id}/temp/
  audiobooks/{audiobook_id}/
  voice_previews/
  music/library/{mood}/
  models/piper/
  models/kokoro/
```

### Static File Serving

The FastAPI app mounts three static directories:
- `/storage/episodes/` -- episode output files (video, thumbnails, scenes)
- `/storage/voice_previews/` -- voice preview audio samples
- `/storage/audiobooks/` -- audiobook output files

Model files and temp directories are deliberately excluded.

### External Services

| Service | Integration Method | Default URL |
|---------|-------------------|-------------|
| LM Studio | OpenAI Python SDK (`AsyncOpenAI` with custom `base_url`) | `http://localhost:1234/v1` |
| Claude | Anthropic Python SDK (`AsyncAnthropic`) | Anthropic API |
| ComfyUI | httpx REST client with WebSocket polling, semaphore-guarded server pool | `http://localhost:8188` |
| Piper TTS | Subprocess calls to `piper` CLI with ONNX models | Local binary |
| Kokoro TTS | Python library (direct import via `asyncio.to_thread`) | N/A |
| Edge TTS | `edge-tts` Python library (async, free, no API key) | Microsoft Edge service |
| ElevenLabs | httpx REST client | ElevenLabs API |
| FFmpeg | `asyncio.create_subprocess_exec` with command builder | `ffmpeg` on PATH |
| faster-whisper | Python library (direct import, run in thread pool) | N/A |
| YouTube Data API v3 | `google-api-python-client` via `asyncio.to_thread` | Google APIs |
| MusicGen | `audiocraft` library (optional dependency, `pip install .[music]`) | N/A |
| RunPod | GraphQL API via httpx (`services/runpod.py`) | RunPod API |
| TikTok | OAuth 2.0 with PKCE | TikTok API |
| AceStep | ComfyUI workflow | AI music generation (12 mood presets) |

## Key Patterns

- **Router -> Service -> Repository**: strict layering, no skipping layers.
- **Protocol-based abstractions**: TTS and LLM providers use `typing.Protocol` for structural subtyping. Adding a new provider = implementing one class.
- **Single PipelineOrchestrator arq job**: state machine loop for generation. No inter-job coordination. Completed steps are skipped on retry.
- **Cancellation via Redis**: cancel flags (`cancel:{episode_id}`) checked between pipeline steps. Emergency stop cancels all generating episodes.
- **Fernet encryption with key versioning**: API keys and OAuth tokens encrypted at rest. `key_version` stored alongside ciphertext for rotation support. Keys: `ENCRYPTION_KEY`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, etc.
- **structlog with JSON output**: all logging uses structlog. Pipeline logs bind `episode_id`, `step`, and `job_id` as context. Request logs bind `request_id`.
- **ComfyUI server pool**: `ComfyUIPool` with per-server semaphores and round-robin dispatch. `max_concurrent_video_jobs` per server caps GPU-intensive video jobs independently. Servers registered dynamically from database config.
- **LLMPool**: round-robin across LLM endpoints with automatic failover on 5xx/timeout. Transparent to callers.
- **File-first pattern**: files are written to disk before database records are created/updated, to avoid orphan references on crash.
- **Path-traversal protection**: `LocalStorage.resolve_path()` validates all paths stay within `STORAGE_BASE_PATH`. `PiperTTSProvider._sanitize_voice_id()` prevents path traversal in voice model selection.
- **SSRF prevention**: `core/validators.py` validates URLs against private/internal IP ranges before making outbound HTTP requests.
- **Optional API key auth**: middleware checks `API_AUTH_TOKEN` env var. If unset, auth is disabled (local dev mode). `/health` is always exempt.
- **Dynamic generation slots**: base 4 + 2 per additional ComfyUI server. `MAX_CONCURRENT_GENERATIONS` is the hard cap.
- **In-process metrics collection**: `core/metrics.py` tracks per-step duration, success/failure rates, and overall generation counts. Exposed via `/api/v1/metrics/*` endpoints. No external dependencies required.
- **Request logging middleware**: `core/middleware.py` logs every HTTP request with method, path, status code, duration, and a unique `request_id`. Quiet paths (`/health`, `/api/v1/metrics/*`) are logged at DEBUG level.
- **Multi-channel YouTube**: Series and audiobooks each have a `youtube_channel_id` FK. Upload resolves the target channel from the series assignment (required; no fallback to a default channel). Multiple channels can be connected simultaneously — there is no `deactivate_all` logic. Each `YouTubeChannel` record has `upload_days` and `upload_time` for per-channel publishing schedules.
- **Per-chapter audiobook features**: Chapter images via ComfyUI, per-chapter music moods, context-aware speaker pauses (150ms/400ms/1.2s), chapter timing metadata.
- **Chunked LLM generation**: Long-form episodes use `LongFormScriptService` — 3-phase outline → chapter → quality approach. Long-form audiobooks (>30 min) use two-phase outline-then-chapter generation.
- **TTS segment caching**: On retry, existing WAV files for TTS segments on disk are reused without re-synthesis.
- **Per-scene resumability**: On retry, scenes with existing `media_assets` records are skipped. Scene generation uses `return_exceptions=True` in `asyncio.gather` so partial results from a batch are preserved on partial failure.
- **Safe WAV replacement**: Audiobook music mixing creates a backup before renaming, preventing file corruption on crash mid-replacement.
- **Chunk cleanup timing**: Temp chunk files are cleaned up after the DB commit completes, not before, to avoid losing data on a commit failure.
- **Scene duration scaling**: FFmpeg assembly scales scene durations proportionally to match audio length, preventing frozen last frames.
- **Orphan reset on startup**: Worker startup resets both episodes and audiobooks stuck in `generating` to `failed`.
- **Worker heartbeat**: Worker process writes a heartbeat to Redis every 60 seconds. `GET /api/v1/jobs/worker/health` reads this to report liveness.
- **Priority scheduling**: Redis flag controls job ordering (`shorts_first` / `longform_first` / `fifo`). Long-form jobs are deferred while shorts are queued when `shorts_first` is active.
- **YouTube OAuth flow**: Manual URL construction (no PKCE) to avoid state persistence issues. Tokens encrypted at rest. Auto-refresh on expiry.

- **Service layer extraction**: `EpisodeService` (`services/episode.py`) provides reusable episode operations (`get_or_raise`, `create_reassembly_jobs`, `require_status`). Domain exceptions in `core/exceptions.py` keep services free of FastAPI imports.
- **Background job migration**: Music generation and SEO generation moved from synchronous HTTP handlers to arq background jobs, preventing worker blocking for up to 10+ minutes.
- **Code splitting**: Frontend uses `React.lazy` + `Suspense` for all page routes. Large pages converted to directory packages for incremental sub-component extraction.
- **Modular packages**: All services >600 lines and routes >800 lines converted to Python packages with backward-compatible `__init__.py` re-exports. Code lives in `_monolith.py`; external code imports from the package (never from `_monolith` directly).

## Frontend

React + TypeScript + Tailwind CSS application served by Vite. All page routes use `React.lazy` for code splitting with a `Suspense` loading fallback.

The design system uses **Outfit** (display/headings) + **DM Sans** (body) fonts with glass morphism surfaces, gradient accents, and noise texture overlay.

### Pages

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Dashboard | Overview with recent episodes, generation stats |
| `/series` | SeriesList | CRUD for series (bible, voice, workflows) |
| `/series/:seriesId` | SeriesDetail | Series config, associated episodes |
| `/episodes` | EpisodesList | All episodes, filter by status/series (fetches up to 500 for correct totals) |
| `/episodes/:episodeId` | EpisodeDetail | Full episode view: script, scenes, player, export; voice/caption style/music control panels |
| `/audiobooks` | Audiobooks | Text-to-Voice studio |
| `/audiobooks/:id` | AudiobookDetail | Individual audiobook detail, chapter gallery, regeneration |
| `/youtube` | YouTube | Full YouTube management (Dashboard/Uploads/Playlists/Analytics/Social tabs) |
| `/calendar` | Calendar | Content calendar with month grid, scheduling dialog |
| `/jobs` | Jobs | Background job monitoring |
| `/logs` | Logs | Application logs viewer |
| `/about` | About | App info, pipeline visualization, tech stack |
| `/settings` | Settings | ComfyUI, LLM, voice profiles, YouTube connection |
| `/youtube/callback` | YouTubeCallback | OAuth redirect handler |

### Sidebar Navigation

Grouped navigation:

**Content Studio**: Dashboard, Series, Episodes, Text to Voice

The sidebar shows a live badge with the count of currently generating episodes.

**Social Media**: YouTube, Calendar

**System**: Settings

### Activity Monitor

A docked bottom bar (not a floating widget) with a split layout:

- **Left panel**: active task list showing in-progress jobs with per-step progress.
- **Right panel**: worker health indicator and job priority selector (`shorts_first` / `longform_first` / `fifo`).

Job controls (pause-all, cancel-all, retry-all-failed) are centralised in the Activity Monitor and removed from the Dashboard.

## API Routes

All API routes are under `/api/v1/` with the following sub-routers:

| Prefix | Router | Description |
|--------|--------|-------------|
| `/api/v1/series` | `routes/series.py` | Series CRUD |
| `/api/v1/episodes` | `routes/episodes.py` | Episode CRUD, generate, retry, script editing, scene editing, export, cancel, duplicate, reset, reassemble, regenerate-voice, regenerate-captions, regenerate-scene, set-music, bulk-generate, estimate-cost |
| `/api/v1/voice-profiles` | `routes/voice_profiles.py` | Voice profile CRUD, voice testing |
| `/api/v1/audiobooks` | `routes/audiobooks.py` | Audiobook CRUD, generation, cover image upload |
| `/api/v1/comfyui` | `routes/comfyui.py` | ComfyUI servers + workflows CRUD |
| `/api/v1/llm` | `routes/llm.py` | LLM config CRUD + test endpoint |
| `/api/v1/prompt-templates` | `routes/prompt_templates.py` | Prompt template CRUD |
| `/api/v1/jobs` | `routes/jobs.py` | Job listing, active jobs, queue status, cancel-all, pause-all, retry-all-failed, set-priority, worker health, worker restart |
| `/api/v1/metrics` | `routes/metrics.py` | Pipeline metrics (step stats, generation stats, recent history) |
| `/api/v1/settings` | `routes/settings.py` | Health check (DB, Redis, ComfyUI, FFmpeg), storage usage |
| `/api/v1/youtube` | `routes/youtube.py` | YouTube OAuth, upload, channels list, channel update, connection status, disconnect, upload history, video delete |
| `/api/v1/api-keys` | `routes/api_keys.py` | Encrypted API key CRUD |
| `/api/v1/social` | `routes/social.py` | Social platform OAuth, upload, stats |
| `/api/v1/video-templates` | `routes/video_templates.py` | Video template CRUD |
| `/api/v1/runpod` | `routes/runpod.py` | RunPod GPU pod CRUD, deploy, register |
| `/api/v1/schedule` | `routes/schedule.py` | Content scheduling CRUD, calendar view |
| `/ws/progress/{episode_id}` | `websocket.py` | Real-time generation progress via WebSocket + Redis pub/sub |
| `/ws/progress/all` | `websocket.py` | Pattern subscription — receives progress for all active episodes simultaneously |
| `/ws/progress/audiobook/{audiobook_id}` | `websocket.py` | Audiobook generation progress via WebSocket + Redis pub/sub |
| `/health` | `router.py` | Liveness/readiness probe (always exempt from auth) |

### Episode Endpoints (detailed)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/episodes/recent` | Recent episodes across all series |
| `GET/POST` | `/episodes` | List/create episodes |
| `GET/PUT/DELETE` | `/episodes/{id}` | Get/update/delete episode |
| `POST` | `/episodes/{id}/generate` | Start full generation pipeline |
| `POST` | `/episodes/{id}/retry` | Retry from first failed step |
| `POST` | `/episodes/{id}/retry/{step}` | Retry a specific pipeline step |
| `GET/PUT` | `/episodes/{id}/script` | Get/update episode script |
| `PUT` | `/episodes/{id}/scenes/{num}` | Update a single scene (narration, visual_prompt, duration, keywords) |
| `DELETE` | `/episodes/{id}/scenes/{num}` | Delete a scene |
| `POST` | `/episodes/{id}/scenes/reorder` | Reorder scenes |
| `POST` | `/episodes/{id}/regenerate-scene/{num}` | Regenerate a single scene image + reassemble |
| `POST` | `/episodes/{id}/regenerate-voice` | Regenerate voice + downstream steps; accepts `?voice_profile_id=&speed=&pitch=` overrides |
| `POST` | `/episodes/{id}/regenerate-captions` | Regenerate captions only; accepts `?caption_style=` override |
| `POST` | `/episodes/{id}/reassemble` | Re-run captions + assembly + thumbnail |
| `POST` | `/episodes/{id}/set-music` | Enable/disable background music, set mood and volume; triggers auto-reassemble |
| `POST` | `/episodes/{id}/duplicate` | Duplicate an episode |
| `POST` | `/episodes/{id}/reset` | Reset episode to draft status |
| `POST` | `/episodes/{id}/cancel` | Cancel an in-progress generation |
| `POST` | `/episodes/{id}/estimate-cost` | Return token and compute cost estimate before generation |
| `POST` | `/episodes/bulk-generate` | Enqueue up to 100 episodes for generation in one request |
| `GET` | `/episodes/{id}/export/video` | Download the final MP4 with a named filename |
| `GET` | `/episodes/{id}/export/thumbnail` | Download the thumbnail JPEG |
| `GET` | `/episodes/{id}/export/description` | Get a YouTube-ready description |
| `GET` | `/episodes/{id}/export/bundle` | Download ZIP bundle (video + thumbnail + description) |

### YouTube Endpoints (detailed)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/youtube/channels` | List all connected YouTube channels |
| `PUT` | `/youtube/channels/{id}` | Update channel settings (upload_days, upload_time, display name) |
| `DELETE` | `/youtube/videos/{video_id}` | Delete a YouTube video from the platform |

### Jobs Endpoints (new)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/jobs/worker/health` | Worker liveness — reads heartbeat timestamp from Redis |
| `POST` | `/jobs/worker/restart` | Signal worker restart and reset stuck episodes to failed |
| `POST` | `/jobs/retry-all-failed` | Enqueue all failed episodes; accepts `?priority=` parameter |
| `POST` | `/jobs/pause-all` | Pause queue processing |
| `POST` | `/jobs/set-priority` | Set job ordering strategy (`shorts_first` / `longform_first` / `fifo`) |

## Directory Structure

```
src/shortsfactory/
  main.py                    # FastAPI app factory, lifespan, CORS, static files
  core/
    config.py                # Pydantic Settings (env vars / .env)
    database.py              # Async SQLAlchemy engine + session factory
    redis.py                 # Redis connection pool + arq pool
    security.py              # Fernet encrypt/decrypt with key versioning
    auth.py                  # Optional API key middleware
    logging.py               # structlog configuration (JSON / colored console)
    deps.py                  # FastAPI dependency injection (get_db, get_redis, get_settings)
    validators.py            # URL validation (SSRF prevention), filename sanitization
    metrics.py               # In-process pipeline metrics collector
    middleware.py            # Request logging middleware (request_id, duration)
  models/
    base.py                  # SQLAlchemy declarative base + TimestampMixin + UUIDPrimaryKeyMixin
    series.py                # Series model (series bible, config references, content_format, aspect_ratio, youtube_channel_id)
    episode.py               # Episode model (script JSON, status, overrides, content_format, chapters JSONB, total_duration_seconds)
    voice_profile.py         # Voice profile (TTS provider + model config)
    llm_config.py            # LLM config (endpoint, model, encrypted API key)
    comfyui.py               # ComfyUI server + workflow models (max_concurrent_video_jobs, content_format)
    prompt_template.py       # Reusable prompt templates
    generation_job.py        # Per-step generation job tracking (chapter_number, scene_number, total_items, completed_items)
    media_asset.py           # File reference (type, path, size, duration)
    audiobook.py             # Audiobook model (text, status, chapters, voice casting, music, output paths, youtube_channel_id)
    youtube_channel.py       # YouTubeChannel (encrypted OAuth tokens, upload_days, upload_time) + YouTubeUpload (upload tracking)
    api_key_store.py         # Encrypted third-party API key storage (key_name, encrypted_value, key_version)
    social_platform.py       # Social media platform connections (TikTok, Instagram, X)
    video_template.py        # Reusable video composition templates
    scheduled_post.py        # Content scheduled for future publishing (platform, scheduled_at, status, youtube_channel_id)
  schemas/
    series.py                # Pydantic request/response schemas for series
    episode.py               # Episode schemas (create, update, list, generate, retry, script)
    script.py                # EpisodeScript + SceneScript (structured script format)
    voice_profile.py         # Voice profile schemas + VoiceTestRequest/Response
    comfyui.py               # WorkflowInputMapping + ComfyUI schemas
    comfyui_crud.py          # ComfyUI server/workflow CRUD schemas
    llm_config.py            # LLM config schemas
    prompt_template.py       # Prompt template schemas
    generation_job.py        # Job schemas (response, list response)
    settings.py              # Health check, storage usage, FFmpeg info schemas
    progress.py              # WebSocket progress message schema
    audiobook.py             # Audiobook schemas (create, update, response, list)
    youtube.py               # YouTube schemas (auth URL, channel, upload request/response, connection status)
  repositories/
    base.py                  # Generic async CRUD base repository
    series.py                # Series repository
    episode.py               # Episode repository (with status filtering, relations loading)
    voice_profile.py         # Voice profile repository
    comfyui.py               # ComfyUI server/workflow repository
    llm_config.py            # LLM config repository
    prompt_template.py       # Prompt template repository
    generation_job.py        # Generation job repository (active/failed queries)
    media_asset.py           # Media asset repository (by episode/type/scene)
    audiobook.py             # Audiobook repository
    youtube.py               # YouTubeChannel + YouTubeUpload repositories
    api_key_store.py         # ApiKeyStore repository
    social.py                # SocialPlatform + SocialUpload repositories
    video_template.py        # VideoTemplate repository
    scheduled_post.py        # ScheduledPost repository
  services/
    pipeline.py              # PipelineOrchestrator (6-step state machine with cancellation, per-scene resumability)
    longform_script.py       # LongFormScriptService (3-phase chunked LLM: outline → chapters → quality)
    storage.py               # LocalStorage (StorageBackend protocol + implementation)
    llm.py                   # LLMService + LLMPool (round-robin + failover) + OpenAI-compatible + Anthropic providers
    tts.py                   # TTSService + Piper/Kokoro/Edge/ElevenLabs/ComfyUIElevenLabs providers (parallel synthesis)
    comfyui.py               # ComfyUIService + ComfyUIPool (round-robin) + ComfyUIClient
    ffmpeg.py                # FFmpegService (async subprocess, command builder, Ken Burns, aspect-ratio-aware)
    captions.py              # CaptionService (faster-whisper + ASS/SRT with style presets)
    audiobook.py             # AudiobookService (chapters, multi-voice, music, output formats)
    music.py                 # MusicService (curated library + optional AI generation via MusicGen/AceStep)
    youtube.py               # YouTubeService (OAuth, multi-channel upload, token refresh)
    runpod.py                # RunPodService (GraphQL API: GPU types, pods, templates, create/start/stop/delete)
  api/
    router.py                # Main router aggregating all sub-routers under /api/v1 + /health
    websocket.py             # WebSocket /ws/progress/{episode_id} + /ws/progress/all (pattern) + audiobook progress
    routes/
      series.py              # /api/v1/series CRUD
      episodes.py            # /api/v1/episodes CRUD + generate + retry + scene editing + export + cancel + set-music + bulk-generate + estimate-cost
      voice_profiles.py      # /api/v1/voice-profiles CRUD + voice testing
      audiobooks.py          # /api/v1/audiobooks CRUD + generation + cover upload
      comfyui.py             # /api/v1/comfyui servers + workflows CRUD
      llm.py                 # /api/v1/llm configs CRUD + test endpoint
      prompt_templates.py    # /api/v1/prompt-templates CRUD
      jobs.py                # /api/v1/jobs listing + active + queue status + cancel-all + pause-all + retry-all-failed + set-priority + worker health + worker restart
      metrics.py             # /api/v1/metrics step stats + generation stats + recent history
      settings.py            # /api/v1/settings health + storage + FFmpeg info
      youtube.py             # /api/v1/youtube OAuth + upload + channels + channel update + status + disconnect + history + video delete
      api_keys.py            # /api/v1/api-keys encrypted API key CRUD
      social.py              # /api/v1/social platform OAuth, upload, stats
      video_templates.py     # /api/v1/video-templates CRUD
      runpod.py              # /api/v1/runpod GPU pod CRUD, deploy, register
      schedule.py            # /api/v1/schedule content scheduling CRUD, calendar view
  workers/
    settings.py              # arq WorkerSettings, job functions, startup/shutdown hooks, orphan reset, heartbeat

frontend/
  src/
    App.tsx                  # Route definitions
    pages/
      Dashboard.tsx          # Home dashboard (job controls removed — centralised in Activity Monitor)
      SeriesList.tsx         # Series listing
      SeriesDetail.tsx       # Series detail with episodes
      EpisodesList.tsx       # Episode listing with filters (fetches limit=500 for correct totals)
      EpisodeDetail.tsx      # Episode viewer: script, scenes, player, export; voice/caption/music panels
      Audiobooks.tsx         # Text-to-Voice studio
      AudiobookDetail.tsx    # Individual audiobook detail, chapter gallery, regeneration
      YouTube.tsx            # Full YouTube management (Dashboard/Uploads/Playlists/Analytics/Social tabs)
      Calendar.tsx           # Content calendar with month grid, scheduling dialog
      Jobs.tsx               # Background job monitoring
      Logs.tsx               # Application logs viewer
      About.tsx              # App info, pipeline visualization, tech stack
      Settings.tsx           # Configuration (ComfyUI, LLM, voices, YouTube)
    components/
      layout/
        Layout.tsx           # Main layout wrapper
        Sidebar.tsx          # Navigation sidebar with generating-episode badge
        ActivityMonitor.tsx  # Docked bottom bar: active tasks (left) + worker health + priority selector (right)
```

## Configuration

All configuration is in `core/config.py` as a Pydantic `Settings` class reading from environment variables and `.env`. The only **required** value is `ENCRYPTION_KEY` (Fernet key). Everything else has sensible defaults for local development.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENCRYPTION_KEY` | **(required)** | Fernet key for encrypting API keys and OAuth tokens at rest |
| `DATABASE_URL` | `postgresql+asyncpg://shortsfactory:shortsfactory@localhost:5432/shortsfactory` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection for job queue and pub/sub |
| `STORAGE_BASE_PATH` | `./storage` | Root directory for all generated media files |
| `DEBUG` | `false` | Enable debug logging and SQLAlchemy echo |
| `DB_POOL_SIZE` | `10` | asyncpg connection pool size |
| `DB_MAX_OVERFLOW` | `20` | asyncpg pool overflow limit |
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible LLM endpoint |
| `LM_STUDIO_DEFAULT_MODEL` | `local-model` | Default model name for LM Studio |
| `ANTHROPIC_API_KEY` | *(empty)* | Claude API key for cloud LLM fallback |
| `COMFYUI_DEFAULT_URL` | `http://localhost:8188` | ComfyUI server URL |
| `PIPER_MODELS_PATH` | `./storage/models/piper` | Directory for Piper `.onnx` voice models |
| `KOKORO_MODELS_PATH` | `./storage/models/kokoro` | Directory for Kokoro voice models |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg binary |
| `VIDEO_WIDTH` | `1080` | Output video width |
| `VIDEO_HEIGHT` | `1920` | Output video height (9:16 portrait) |
| `VIDEO_FPS` | `30` | Output video frame rate |
| `VIDEO_MAX_DURATION` | `60` | Maximum video duration in seconds (shorts); long-form uses `longform_job_timeout` |
| `YOUTUBE_CLIENT_ID` | *(empty)* | Google OAuth client ID for YouTube upload |
| `YOUTUBE_CLIENT_SECRET` | *(empty)* | Google OAuth client secret |
| `YOUTUBE_REDIRECT_URI` | `http://localhost:8000/api/v1/youtube/callback` | OAuth redirect URI |
| `API_AUTH_TOKEN` | *(empty)* | Optional API key; if set, all `/api/` and `/ws/` requests require `Authorization: Bearer <token>` |
| `MAX_CONCURRENT_GENERATIONS` | `4` | Hard cap on simultaneous pipeline runs (actual slots = 4 + 2 × extra ComfyUI servers) |
| `RUNPOD_API_KEY` | *(empty)* | RunPod API key for cloud GPU pod management |
| `shorts_job_timeout` | `7200` | arq job timeout for Shorts episodes (seconds) |
| `longform_job_timeout` | `14400` | arq job timeout for long-form episodes (seconds) |

The `ENCRYPTION_KEY` is validated at both the Settings model level (Pydantic validator) and at application startup (lifespan hook). The app will refuse to start with an invalid key.

## Database

- PostgreSQL 16 via asyncpg + SQLAlchemy 2.x async sessions.
- Migrations managed by Alembic.
- All models inherit `TimestampMixin` for `created_at` / `updated_at` and `UUIDPrimaryKeyMixin` for UUID primary keys.

### Tables

| Table | Model | Purpose |
|-------|-------|---------|
| `series` | `Series` | Series bible, visual style, voice/LLM/ComfyUI config references |
| `episodes` | `Episode` | Episode script (JSONB), status, topic, overrides |
| `voice_profiles` | `VoiceProfile` | TTS provider + model config per voice |
| `llm_configs` | `LLMConfig` | LLM endpoint, model, encrypted API key |
| `comfyui_servers` | `ComfyUIServer` | ComfyUI server URL + concurrency settings |
| `comfyui_workflows` | `ComfyUIWorkflow` | Workflow JSON + input mappings |
| `prompt_templates` | `PromptTemplate` | Reusable LLM prompt templates |
| `generation_jobs` | `GenerationJob` | Per-step job tracking (status, progress, error, retry count) |
| `media_assets` | `MediaAsset` | File references (type, path, size, duration, scene number) |
| `audiobooks` | `Audiobook` | Text-to-audiobook jobs (text, voice, chapters, music settings, output paths) |
| `youtube_channels` | `YouTubeChannel` | Connected YouTube channels with encrypted OAuth tokens |
| `youtube_uploads` | `YouTubeUpload` | Upload tracking per episode (status, video ID, URL) |
| `api_key_store` | `ApiKeyStore` | Encrypted third-party API key storage (key_name, encrypted_value, key_version) |
| `social_platforms` | `SocialPlatform` | Social media platform connections (TikTok, Instagram, X) |
| `social_uploads` | `SocialUpload` | Upload tracking per social platform |
| `video_templates` | `VideoTemplate` | Reusable video composition templates |
| `scheduled_posts` | `ScheduledPost` | Content scheduled for future publishing (platform, scheduled_at, status) |

### New / Updated Columns

| Table | Column | Type | Description |
|-------|--------|------|-------------|
| `series` | `content_format` | enum | `shorts` or `longform` — controls pipeline path and workflow selection |
| `series` | `target_duration_minutes` | int | Target runtime for long-form episodes |
| `series` | `chapter_enabled` | bool | Whether long-form chapter structure is active |
| `series` | `scenes_per_chapter` | int | Scene count per chapter for long-form |
| `series` | `transition_style` | str | Transition type between chapters |
| `series` | `transition_duration` | float | Crossfade duration in seconds between chapters |
| `series` | `duration_match_strategy` | str | How assembly handles audio/scene duration mismatch |
| `series` | `base_seed` | int | ComfyUI seed for visual consistency across episodes |
| `series` | `intro_template` | str | Template for episode intro narration |
| `series` | `outro_template` | str | Template for episode outro narration |
| `series` | `visual_consistency_prompt` | str | Prompt fragment appended to all scene prompts |
| `series` | `aspect_ratio` | str | `9:16`, `16:9`, or `1:1` |
| `series` | `youtube_channel_id` | FK | Assigned YouTube channel for uploads (required for upload) |
| `episodes` | `content_format` | enum | Inherited from series at creation; `shorts` or `longform` |
| `episodes` | `chapters` | JSONB | Chapter metadata array (title, scene range, timing, music mood) |
| `episodes` | `total_duration_seconds` | float | Calculated total duration after assembly |
| `generation_jobs` | `chapter_number` | int | Chapter index for long-form step tracking |
| `generation_jobs` | `scene_number` | int | Scene index within the step |
| `generation_jobs` | `total_items` | int | Total scenes or chunks in this step |
| `generation_jobs` | `completed_items` | int | Completed scenes or chunks so far |
| `comfyui_servers` | `max_concurrent_video_jobs` | int | Separate cap for GPU-intensive video generation |
| `comfyui_workflows` | `content_format` | enum | `shorts` or `longform` — used for workflow routing |
| `youtube_channels` | `upload_days` | array | Days of week for scheduled publishing |
| `youtube_channels` | `upload_time` | time | Time of day for scheduled publishing |
| `audiobooks` | `youtube_channel_id` | FK | Assigned YouTube channel for audiobook uploads |
| `scheduled_posts` | `youtube_channel_id` | FK | Target YouTube channel for scheduled upload |

### Key Relationships

- Episode deletion cascades to `media_assets` and `generation_jobs`.
- Audiobook has a foreign key to `voice_profiles` (SET NULL on delete).
- YouTubeUpload has foreign keys to both `episodes` (CASCADE) and `youtube_channels` (CASCADE).
- YouTubeChannel has a one-to-many relationship with `youtube_uploads` (cascade delete).
- Series has a nullable FK to `youtube_channels` (`youtube_channel_id`). Upload requires this to be set.
- Audiobook has a nullable FK to `youtube_channels` (`youtube_channel_id`).
- ScheduledPost has a nullable FK to `youtube_channels` (`youtube_channel_id`).

## Testing Notes

- `pytest` with `asyncio_mode = "auto"` (all async tests auto-detected).
- Markers: `slow` (long-running), `integration` (requires external services).
- Factory Boy (`factory-boy`) for test fixtures.
- httpx `AsyncClient` for API testing (FastAPI TestClient alternative).
- Repositories are mockable at the service layer for unit tests.
- Coverage is configured with branch tracking; `TYPE_CHECKING` blocks and `__main__` guards are excluded.

## Common Gotchas

- The `episode.script` column is JSONB. Always validate through `EpisodeScript.model_validate()` before writing.
- `episode.chapters` is also JSONB. Write only after `LongFormScriptService` has validated chapter structure.
- LLM configs store API keys encrypted. Never log or return decrypted keys. The response schema uses `has_api_key: bool` instead of exposing the value.
- YouTube OAuth tokens are also encrypted at rest via Fernet. Never log decrypted tokens.
- ComfyUI workflow `input_mappings` must match the `WorkflowInputMapping` schema exactly. Mismatched node IDs will silently produce wrong results.
- ComfyUI workflows have a `content_format` tag. The pipeline selects only workflows matching the episode's `content_format`. Misconfigured workflow tags will cause generation to fail at the scenes step.
- The arq worker runs in a separate process with its own DB engine and Redis connection (created in the `startup` hook). It does not share the FastAPI app's connection pools.
- Static files are served only from `storage/episodes/`, `storage/voice_previews/`, and `storage/audiobooks/` -- not the entire storage tree -- to avoid exposing model files and temp data.
- Kokoro TTS is an optional dependency. The worker startup gracefully handles its absence. Same for Edge TTS and MusicGen (audiocraft).
- `shorts_job_timeout` is 7200 seconds; `longform_job_timeout` is 14400 seconds. Long-form jobs can legitimately run for hours on slow GPU hardware.
- Scene editing endpoints (update, delete, reorder) operate on the JSONB script field. After deletion, remaining scenes are renumbered sequentially starting from 1.
- The YouTube OAuth flow uses manual URL construction (no PKCE) to avoid state persistence issues with `google_auth_oauthlib`.
- Episode statuses flow: `draft` -> `generating` -> `review`/`editing`/`exported`/`failed`. Only `draft` and `failed` episodes can be regenerated.
- Audiobook statuses flow: `draft` -> `generating` -> `done`/`failed`.
- YouTube upload statuses flow: `pending` -> `uploading` -> `done`/`failed`.
- Multiple YouTube channels can be connected simultaneously. There is no concept of an "active" channel — the channel is resolved per-series via `youtube_channel_id`. Uploading an episode whose series has no `youtube_channel_id` set will fail at the upload step, not at enqueue time.
- `publish_scheduled_posts` runs every 5 minutes (previously 15). It uses 3x retry with exponential backoff per post. Channel resolution failure (missing `youtube_channel_id`) skips the post and logs an error rather than crashing the cron job.
- The LLMPool round-robins across all configured LLM endpoints. A 5xx response or request timeout causes that request to be retried on the next provider in the pool, transparently to the caller.
- Scene generation with `asyncio.gather(..., return_exceptions=True)` means a partial batch failure saves completed scenes to `media_assets` before raising. On retry, those scenes are skipped via the per-scene resumability check.
- Worker heartbeat key in Redis: `worker:heartbeat`. `GET /api/v1/jobs/worker/health` returns `healthy` if the heartbeat was written within the last 90 seconds.
- All service and route packages use `_monolith.py` + `__init__.py` re-exports. When adding new code, add it to `_monolith.py` (or create new sub-modules and update `__init__.py`). Never import directly from `_monolith` in external code — always import from the package.
- The `UnsafeURLError` class inherits from `ValueError`. Never catch `ValueError` broadly in code that also calls SSRF validators — use `try/except UnsafeURLError` explicitly.
- Music generation and SEO generation are now arq background jobs. The HTTP endpoints enqueue and return immediately. Frontend should show a loading state and poll or use WebSocket for results.
- The Docker `app` service does NOT use `--reload`. For local development with hot reload, run `uvicorn src.shortsfactory.main:app --reload --port 8000` directly outside Docker.

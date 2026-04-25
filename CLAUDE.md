# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project Overview

**Drevalis Creator Studio** — AI-powered YouTube Shorts/long-form video and text-to-voice platform sold by Drevalis. Python package: `drevalis`. **Local-first**: heavy work (LLM, TTS, image gen) runs on the user's machine, with optional cloud fallbacks (Claude, ElevenLabs, Edge TTS).

Two workflows:

1. **Video generation** — LLM script → TTS → ComfyUI scenes → faster-whisper captions → FFmpeg assembly → optional YouTube upload. Shorts (9:16), long-form (16:9), or square (1:1). Long-form uses 3-phase chunked LLM (outline → chapters → quality).
2. **Text-to-Voice (Audiobooks)** — long text → audiobook with chapter detection, multi-voice via `[Speaker]` tags, sidechain-ducked music, speed/pitch, multiple outputs (WAV/MP3, audio+image MP4, audio+video MP4).

## Commands

### Dev

```bash
docker compose up -d                                         # all services
docker compose up -d postgres redis                          # infra only (for local backend dev)
uvicorn src.drevalis.main:app --reload --port 8000           # backend
cd frontend && npm run dev                                   # frontend (Vite, :5173)
python -m arq src.drevalis.workers.settings.WorkerSettings   # worker
alembic upgrade head                                         # migrations
alembic revision --autogenerate -m "msg"                     # new migration
```

### Test

```bash
pytest tests/ -v
pytest tests/unit/ -v
pytest tests/integration/ -v
pytest tests/ --cov=src/drevalis
pytest tests/ -v -m "not slow"
pytest tests/ -v -m "not integration"
```

### Lint / QA

```bash
ruff check src/ tests/
ruff format src/ tests/
mypy src/ --strict             # pydantic + SQLAlchemy plugins
bandit -r src/ -c pyproject.toml
pip-audit
```

## Architecture

### Layers (strict, no skipping)

- **Routers** (`api/routes/`) — HTTP only. Call services. Never repos.
- **Services** (`services/`) — business logic. Orchestrate repos + providers. No FastAPI imports.
- **Repositories** (`repositories/`) — DB query logic. One per model. Never call other repos/services.

### Generation Pipeline

Single arq job, `PipelineOrchestrator` state machine (`services/pipeline.py`). Steps run sequentially; each completion is persisted to `generation_jobs` before the next. Completed steps are skipped on retry.

Steps: `script` → `voice` → `scenes` → `captions` → `assembly` → `thumbnail`

- **Resumability**: per-scene — existing `media_assets` skipped on retry; existing TTS WAVs reused.
- **Cancellation**: Redis flags `cancel:{episode_id}` checked between steps. Emergency stop via `POST /api/v1/jobs/cancel-all` cancels all `generating` episodes.
- **Progress**: Redis pub/sub → WebSocket. `/ws/progress/all` supports pattern subscription. DB written for all status changes.
- **Long-form**: `chapters` JSONB on episode, per-chapter music with crossfade, chapter timing/title/scene-range metadata.
- **Orphan reset**: worker startup resets `generating` episodes/audiobooks to `failed`.

### arq Worker Jobs

| Job | Purpose |
|-----|---------|
| `generate_episode` | Full pipeline |
| `generate_audiobook` | Text-to-audiobook |
| `retry_episode_step` | Retry one step |
| `reassemble_episode` | Captions + assembly + thumbnail (keeps voice/scenes) |
| `regenerate_voice` | Voice + downstream (keeps scenes) |
| `regenerate_scene` | One scene image + reassemble |
| `regenerate_audiobook_chapter` | Single audiobook chapter |
| `generate_script_async` | Background audiobook script LLM |
| `generate_ai_audiobook` | LLM script + TTS (skips LLM if script exists) |
| `generate_series_async` | AI-generate series + episodes |
| `auto_deploy_runpod_pod` | Poll RunPod, register when ready |
| `publish_scheduled_posts` | Cron every 5 min — resolves channel from series, 3× retry+backoff |
| `generate_episode_music` | Background AceStep via ComfyUI |
| `generate_seo_async` | Background SEO LLM |

Worker: `max_jobs=8`, `shorts_job_timeout=7200` (2h), `longform_job_timeout=14400` (4h), `max_tries=3`.

**Priority**: Redis `set-priority` flag (`shorts_first` / `longform_first` / `fifo`). With `shorts_first`, long-form is deferred while shorts are queued.

### Provider Abstractions

`typing.Protocol` (PEP 544) for TTS + LLM. New provider = one class.

**TTSProvider**:
- `PiperTTSProvider` — local ONNX, `piper` CLI subprocess
- `KokoroTTSProvider` — local ONNX, Kokoro library (optional, `pip install .[kokoro]`)
- `EdgeTTSProvider` — free cloud, no API key
- `ElevenLabsTTSProvider` — cloud REST
- `ComfyUIElevenLabsTTSProvider` — ElevenLabs via ComfyUI nodes (uses `api_key_store`, polls)

TTS synthesis is parallelized across multiple ComfyUI servers.

**LLMProvider**:
- `OpenAICompatibleProvider` — LM Studio, Ollama, vLLM, OpenAI
- `AnthropicProvider` — Claude SDK

**LLMPool**: round-robin + auto-failover on 5xx/timeout. All pipeline + audiobook LLM calls go through the pool.

Provider selection is per-series/per-voice-profile, DB-driven, resolved at runtime via factories.

### Long-Form Video

`series.content_format` (`shorts` | `longform`) controls the pipeline path.

**LongFormScriptService** (`services/longform_script.py`) — 3 phases:
1. **Outline** — high-level chapters from bible + topic
2. **Chapter** — expand each independently, continuity context from previous
3. **Quality** — review assembled script, rewrite scenes failing checks

`episodes.chapters` JSONB stores: title, scene range, duration estimate, music mood.

- **Aspect ratio**: `series.aspect_ratio` drives FFmpeg + ComfyUI resolution
- **Workflow routing**: `comfyui_workflows.content_format` tags workflows; pipeline picks matching ones (Wan 2.2 long-form video, Qwen Image Shorts)
- **Per-chapter music** with `series.transition_duration` crossfades
- **Cost estimation**: `POST /episodes/{id}/estimate-cost`

### Load Balancing

- **LLMPool** — round-robin + 5xx/timeout failover
- **ComfyUI pool** — round-robin (least-loaded didn't work with `asyncio.gather`). Per-server semaphores; `max_concurrent_video_jobs` separately caps GPU video jobs
- **Generation slots** — base 4 + 2 per extra ComfyUI server. `MAX_CONCURRENT_GENERATIONS` is the hard cap.

### Storage

`LocalStorage` (`services/storage.py`) implements the `StorageBackend` protocol. All DB paths are **relative** to `STORAGE_BASE_PATH`. Path-traversal protection in `resolve_path()`.

```
storage/
  episodes/{id}/{voice,scenes,captions,output,temp}/
  audiobooks/{id}/
  voice_previews/
  music/library/{mood}/
  models/{piper,kokoro}/
```

Static mounts: `/storage/episodes/`, `/storage/voice_previews/`, `/storage/audiobooks/` only. Models + temp deliberately excluded.

### External Services

| Service | Method | Default URL |
|---------|--------|-------------|
| LM Studio | `AsyncOpenAI` w/ custom `base_url` | `http://localhost:1234/v1` |
| Claude | `AsyncAnthropic` | Anthropic API |
| ComfyUI | httpx + WebSocket polling, semaphore pool | `http://localhost:8188` |
| Piper | `piper` CLI subprocess | local |
| Kokoro | Python lib via `asyncio.to_thread` | N/A |
| Edge TTS | `edge-tts` async | Microsoft Edge |
| ElevenLabs | httpx | ElevenLabs API |
| FFmpeg | `asyncio.create_subprocess_exec` + cmd builder | PATH |
| faster-whisper | Python lib in thread pool | N/A |
| YouTube Data API v3 | `google-api-python-client` via `asyncio.to_thread` | Google |
| MusicGen | `audiocraft` (optional, `pip install .[music]`) | N/A |
| RunPod | GraphQL via httpx | RunPod API |
| TikTok | OAuth 2.0 + PKCE | TikTok API |
| AceStep | ComfyUI workflow | 12 mood presets |

## Patterns & Gotchas

- **Layered**: Router → Service → Repo, strict.
- **Protocol-based providers**: implement one class to add a provider.
- **Single orchestrator job**: state machine, no inter-job coordination, completed steps skipped on retry.
- **Cancellation via Redis flags**, checked between steps.
- **Fernet w/ key versioning**: API keys + OAuth tokens encrypted at rest. `key_version` stored. Rotation via `ENCRYPTION_KEY_V1`, `_V2`, etc.
- **structlog JSON logs**: pipeline binds `episode_id`, `step`, `job_id`. Requests bind `request_id`.
- **ComfyUI server pool**: round-robin, per-server semaphores, `max_concurrent_video_jobs` separate cap.
- **File-first**: write to disk before DB record creation/update — avoids orphan refs on crash.
- **Path-traversal protection**: `LocalStorage.resolve_path()`, `PiperTTSProvider._sanitize_voice_id()`.
- **SSRF prevention**: `core/validators.py` validates URLs before outbound HTTP.
- **Optional API key auth**: middleware checks `API_AUTH_TOKEN`. Unset = local dev mode. `/health` always exempt.
- **In-process metrics**: `core/metrics.py` — per-step duration + success/failure. Exposed via `/api/v1/metrics/*`. No external deps.
- **Request logging**: `core/middleware.py` — method, path, status, duration, `request_id`. Quiet paths (`/health`, `/api/v1/metrics/*`) at DEBUG.
- **Multi-channel YouTube**: series/audiobook each have `youtube_channel_id` FK. Upload resolves from series — required, no fallback. Multiple channels simultaneously, no `deactivate_all`. Per-channel `upload_days` + `upload_time`.
- **Chunked LLM**: long-form uses `LongFormScriptService` (3 phases). Long-form audiobooks (>30 min) use 2-phase outline-then-chapter.
- **TTS segment caching**: existing WAVs reused on retry.
- **Per-scene resumability**: `media_assets` records skip retry. `asyncio.gather(..., return_exceptions=True)` preserves partial results.
- **Safe WAV replacement**: backup before rename in audiobook music mixing.
- **Chunk cleanup**: temp files cleaned *after* DB commit, not before.
- **Scene duration scaling**: FFmpeg scales scene durations proportionally to audio length — prevents frozen last frames.
- **Worker heartbeat**: every 60s to Redis (`worker:heartbeat`). `GET /api/v1/jobs/worker/health` reads it; healthy if <90s old.
- **YouTube OAuth**: manual URL construction (no PKCE) to dodge state persistence issues with `google_auth_oauthlib`.
- **Service extraction**: `EpisodeService` (`services/episode.py`) reusable ops (`get_or_raise`, `create_reassembly_jobs`, `require_status`). Domain exceptions in `core/exceptions.py` keep services FastAPI-free.
- **Background jobs**: music gen + SEO gen moved from sync HTTP handlers to arq jobs (was blocking 10+ min).
- **Frontend**: `React.lazy` + `Suspense` for all routes. Large pages split into directory packages.
- **Modular packages**: services >600 LOC and routes >800 LOC → packages with backward-compat `__init__.py` re-exports. Code lives in `_monolith.py`. **Never import from `_monolith` directly** — always from the package.

## Frontend

React + TS + Tailwind, Vite. **Outfit** (display) + **DM Sans** (body), glass morphism, gradient accents, noise overlay.

### Pages

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Dashboard | Overview, recent episodes, gen stats |
| `/series` | SeriesList | Series CRUD |
| `/series/:seriesId` | SeriesDetail | Config + episodes |
| `/episodes` | EpisodesList | All episodes, filters (fetches limit=500 for accurate totals) |
| `/episodes/:episodeId` | EpisodeDetail | Script, scenes, player, export, voice/caption/music panels |
| `/audiobooks` | Audiobooks | Text-to-Voice studio |
| `/audiobooks/:id` | AudiobookDetail | Chapter gallery, regen |
| `/youtube` | YouTube | Dashboard / Uploads / Playlists / Analytics / Social tabs |
| `/calendar` | Calendar | Month grid + scheduling dialog |
| `/jobs` | Jobs | Background job monitor |
| `/logs` | Logs | App logs |
| `/about` | About | App info, pipeline viz |
| `/settings` | Settings | ComfyUI, LLM, voices, YouTube |
| `/youtube/callback` | YouTubeCallback | OAuth redirect |

### Sidebar

- **Content Studio**: Dashboard, Series, Episodes, Text to Voice (badge: live count of generating episodes)
- **Social Media**: YouTube, Calendar
- **System**: Settings

### Activity Monitor

Docked bottom bar. Left: active task list w/ per-step progress. Right: worker health + priority selector (`shorts_first` / `longform_first` / `fifo`). Job controls (pause-all, cancel-all, retry-all-failed) live here — removed from Dashboard.

## API Routes

Base: `/api/v1/`

| Prefix | Description |
|--------|-------------|
| `/series` | Series CRUD |
| `/episodes` | CRUD + generate, retry, script/scene editing, export, cancel, duplicate, reset, reassemble, regenerate-voice/captions/scene, set-music, bulk-generate, estimate-cost |
| `/voice-profiles` | CRUD + testing |
| `/audiobooks` | CRUD + generation + cover upload |
| `/comfyui` | Servers + workflows CRUD |
| `/llm` | Config CRUD + test |
| `/prompt-templates` | CRUD |
| `/jobs` | Listing, active, queue, cancel-all, pause-all, retry-all-failed, set-priority, worker health/restart |
| `/metrics` | Step stats, gen stats, recent history |
| `/settings` | Health (DB/Redis/ComfyUI/FFmpeg), storage usage |
| `/youtube` | OAuth, upload, channels, status, disconnect, history, video delete |
| `/api-keys` | Encrypted key CRUD |
| `/social` | Platform OAuth, upload, stats |
| `/video-templates` | CRUD |
| `/runpod` | GPU pod CRUD, deploy, register |
| `/schedule` | CRUD + calendar view |
| `/ws/progress/{episode_id}` | WebSocket per-episode progress |
| `/ws/progress/all` | Pattern sub — all active episodes |
| `/ws/progress/audiobook/{audiobook_id}` | Audiobook progress |
| `/health` | Liveness/readiness (always exempt) |

### Episode endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/episodes/recent` | Recent across all series |
| `GET/POST` | `/episodes` | List/create |
| `GET/PUT/DELETE` | `/episodes/{id}` | CRUD |
| `POST` | `/episodes/{id}/generate` | Start pipeline |
| `POST` | `/episodes/{id}/retry` | From first failed step |
| `POST` | `/episodes/{id}/retry/{step}` | Specific step |
| `GET/PUT` | `/episodes/{id}/script` | Get/update |
| `PUT/DELETE` | `/episodes/{id}/scenes/{num}` | Update/delete scene |
| `POST` | `/episodes/{id}/scenes/reorder` | Reorder |
| `POST` | `/episodes/{id}/regenerate-scene/{num}` | One scene + reassemble |
| `POST` | `/episodes/{id}/regenerate-voice` | Voice + downstream; `?voice_profile_id=&speed=&pitch=` |
| `POST` | `/episodes/{id}/regenerate-captions` | Captions only; `?caption_style=` |
| `POST` | `/episodes/{id}/reassemble` | Captions + assembly + thumbnail |
| `POST` | `/episodes/{id}/set-music` | Music settings + auto-reassemble |
| `POST` | `/episodes/{id}/duplicate` | Duplicate |
| `POST` | `/episodes/{id}/reset` | Back to draft |
| `POST` | `/episodes/{id}/cancel` | Cancel in-progress |
| `POST` | `/episodes/{id}/estimate-cost` | Token + compute estimate |
| `POST` | `/episodes/bulk-generate` | Up to 100 episodes |
| `GET` | `/episodes/{id}/export/{video,thumbnail,description,bundle}` | Downloads |

### YouTube endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/youtube/channels` | List (filters inactive; `?include_inactive=true`) |
| `PUT` | `/youtube/channels/{id}` | Update settings |
| `DELETE` | `/youtube/channels/{id}` | Delete + cascade history |
| `DELETE` | `/youtube/videos/{video_id}` | Delete from YouTube |

### Jobs endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/jobs/worker/health` | Heartbeat-based liveness |
| `POST` | `/jobs/worker/restart` | Signal restart + reset stuck |
| `POST` | `/jobs/retry-all-failed` | All failed; `?priority=` |
| `POST` | `/jobs/pause-all` | Pause queue |
| `POST` | `/jobs/set-priority` | `shorts_first`/`longform_first`/`fifo` |

## Directory Structure

```
src/drevalis/
  main.py                    # FastAPI factory, lifespan, CORS, static mounts
  core/
    config.py                # Pydantic Settings
    database.py              # Async SQLAlchemy engine + session factory
    redis.py                 # Redis pool + arq pool
    security.py              # Fernet encrypt/decrypt + key versioning
    auth.py                  # Optional API key middleware
    logging.py               # structlog config
    deps.py                  # FastAPI DI
    validators.py            # URL validation (SSRF), filename sanitization
    metrics.py               # In-process metrics
    middleware.py            # Request logging
    exceptions.py            # Domain exceptions (FastAPI-free services)
  models/                    # series, episode, voice_profile, llm_config, comfyui,
                             # prompt_template, generation_job, media_asset, audiobook,
                             # youtube_channel, api_key_store, social_platform,
                             # video_template, scheduled_post
  schemas/                   # Pydantic request/response per model area
  repositories/              # Generic CRUD base + per-model repos
  services/
    pipeline.py              # PipelineOrchestrator (6-step state machine)
    longform_script.py       # 3-phase chunked LLM
    storage.py               # LocalStorage (StorageBackend protocol)
    llm.py                   # LLMService + LLMPool + providers
    tts.py                   # TTSService + 5 providers (parallel)
    comfyui.py               # ComfyUIService + Pool + Client (round-robin)
    ffmpeg.py                # FFmpegService (async subprocess, Ken Burns, aspect-aware)
    captions.py              # CaptionService (faster-whisper + ASS/SRT styles)
    audiobook.py             # AudiobookService
    music.py                 # MusicService (library + MusicGen/AceStep)
    youtube.py               # OAuth, multi-channel upload, refresh
    runpod.py                # GraphQL: pods/templates/lifecycle
    episode.py               # EpisodeService (reusable ops)
  api/
    router.py                # Aggregator under /api/v1 + /health
    websocket.py             # /ws/progress/{id}, /all, /audiobook/{id}
    routes/                  # Per-prefix routers
  workers/
    settings.py              # arq WorkerSettings + jobs + startup/shutdown + heartbeat + orphan reset

frontend/src/
  App.tsx                    # Routes
  pages/                     # Dashboard, SeriesList, SeriesDetail, EpisodesList,
                             # EpisodeDetail, Audiobooks, AudiobookDetail, YouTube,
                             # Calendar, Jobs, Logs, About, Settings
  components/layout/
    Layout.tsx               # Wrapper
    Sidebar.tsx              # Nav with generating-episode badge
    ActivityMonitor.tsx      # Docked bottom bar (tasks + worker health + priority)
```

Service/route packages use `_monolith.py` + `__init__.py` re-exports. Import from the package, never `_monolith`.

## Configuration

`core/config.py` — Pydantic `Settings` from env + `.env`. Only **required** value is `ENCRYPTION_KEY` (Fernet). Validated at Settings level + lifespan startup; app refuses invalid keys.

| Var | Default | Description |
|-----|---------|-------------|
| `ENCRYPTION_KEY` | **required** | Fernet, encrypts API keys + OAuth tokens |
| `DATABASE_URL` | `postgresql+asyncpg://drevalis:drevalis@localhost:5432/drevalis` | Postgres |
| `REDIS_URL` | `redis://localhost:6379/0` | Job queue + pub/sub |
| `STORAGE_BASE_PATH` | `./storage` | Media root |
| `DEBUG` | `false` | Debug logs + SQLAlchemy echo |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `10` / `20` | asyncpg pool |
| `LM_STUDIO_BASE_URL` / `LM_STUDIO_DEFAULT_MODEL` | `http://localhost:1234/v1` / `local-model` | Local LLM |
| `ANTHROPIC_API_KEY` | empty | Claude fallback |
| `COMFYUI_DEFAULT_URL` | `http://localhost:8188` | ComfyUI |
| `PIPER_MODELS_PATH` / `KOKORO_MODELS_PATH` | `./storage/models/{piper,kokoro}` | TTS models |
| `FFMPEG_PATH` | `ffmpeg` | Binary |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` / `VIDEO_FPS` | `1080` / `1920` / `30` | Output |
| `VIDEO_MAX_DURATION` | `60` | Shorts cap; long-form uses `longform_job_timeout` |
| `YOUTUBE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | empty / empty / `http://localhost:8000/api/v1/youtube/callback` | OAuth |
| `API_AUTH_TOKEN` | empty | If set, all `/api/` + `/ws/` need `Authorization: Bearer <token>` |
| `MAX_CONCURRENT_GENERATIONS` | `4` | Hard cap (actual = 4 + 2 × extra ComfyUI servers) |
| `RUNPOD_API_KEY` | empty | RunPod cloud GPU |
| `shorts_job_timeout` / `longform_job_timeout` | `7200` / `14400` | arq timeouts (sec) |

## Database

Postgres 16, asyncpg + SQLAlchemy 2.x async. Alembic migrations. All models use `TimestampMixin` + `UUIDPrimaryKeyMixin`.

### Tables

| Table | Purpose |
|-------|---------|
| `series` | Bible, visual style, config FKs, `content_format`, `aspect_ratio`, `youtube_channel_id` |
| `episodes` | Script JSONB, status, topic, overrides, `content_format`, `chapters` JSONB, `total_duration_seconds` |
| `voice_profiles` | TTS provider + model |
| `llm_configs` | Endpoint, model, encrypted key |
| `comfyui_servers` | URL + concurrency, `max_concurrent_video_jobs` |
| `comfyui_workflows` | Workflow JSON + input mappings, `content_format` |
| `prompt_templates` | Reusable prompts |
| `generation_jobs` | Per-step tracking; `chapter_number`, `scene_number`, `total_items`, `completed_items` |
| `media_assets` | File refs (type, path, size, duration, scene_number) |
| `audiobooks` | Text, status, chapters, casting, music, outputs, `youtube_channel_id` |
| `youtube_channels` | Connected channels w/ encrypted OAuth, `upload_days`, `upload_time` |
| `youtube_uploads` | Upload tracking per episode (status, video_id, URL) |
| `api_key_store` | `key_name`, `encrypted_value`, `key_version` |
| `social_platforms` | TikTok / Instagram / X connections |
| `social_uploads` | Per-platform tracking |
| `video_templates` | Composition templates |
| `scheduled_posts` | platform, `scheduled_at`, status, `youtube_channel_id` |

### Long-form-specific series columns

`target_duration_minutes`, `chapter_enabled`, `scenes_per_chapter`, `transition_style`, `transition_duration`, `duration_match_strategy`, `base_seed` (ComfyUI seed for visual consistency), `intro_template`, `outro_template`, `visual_consistency_prompt`.

### Relationships

- Episode delete CASCADE → `media_assets`, `generation_jobs`
- Audiobook → `voice_profiles` (SET NULL)
- YouTubeUpload → `episodes` (CASCADE) + `youtube_channels` (CASCADE)
- YouTubeChannel ↔ `youtube_uploads` (1:N, cascade delete)
- Series → `youtube_channels` (nullable FK; **required for upload**)
- Audiobook → `youtube_channels` (nullable FK)
- ScheduledPost → `youtube_channels` (nullable FK)

## Testing

- `pytest` w/ `asyncio_mode = "auto"`
- Markers: `slow`, `integration`
- Factory Boy fixtures
- httpx `AsyncClient` for API tests
- Repos mockable at service layer
- Branch coverage; `TYPE_CHECKING` + `__main__` excluded

## Common Gotchas

- `episode.script` and `episode.chapters` are JSONB. Validate via `EpisodeScript.model_validate()` / `LongFormScriptService` before write.
- API keys + OAuth tokens encrypted. Never log/return decrypted. LLM config response uses `has_api_key: bool`.
- ComfyUI `input_mappings` must match `WorkflowInputMapping` exactly — mismatched node IDs silently produce wrong results.
- ComfyUI workflows have `content_format` tag. Pipeline filters by episode's `content_format` — mistagged workflows fail at scenes step.
- Worker = separate process w/ own DB engine + Redis pool (created in `startup`). Doesn't share FastAPI's pools.
- Static files limited to `episodes/`, `voice_previews/`, `audiobooks/` — not whole storage tree (avoids exposing models + temp).
- Kokoro, Edge TTS, MusicGen are optional deps. Worker startup tolerates absence.
- Long-form jobs legitimately run hours on slow GPU — that's why `longform_job_timeout=14400`.
- Scene editing operates on JSONB script. After delete, remaining scenes renumbered from 1.
- YouTube OAuth uses manual URL construction (no PKCE) to dodge `google_auth_oauthlib` state issues.
- Episode statuses: `draft` → `generating` → `review`/`editing`/`exported`/`failed`. Only `draft` + `failed` regen-able.
- Audiobook statuses: `draft` → `generating` → `done`/`failed`.
- YouTube upload statuses: `pending` → `uploading` → `done`/`failed`.
- Multi-channel YouTube: no "active" concept — resolved per-series via `youtube_channel_id`. Upload of episode whose series has no channel **fails at upload step**, not enqueue.
- `publish_scheduled_posts` cron now every 5 min (was 15). 3× retry w/ backoff. Missing `youtube_channel_id` skips + logs error rather than crashing.
- LLMPool failover transparent to callers — round-robin, retries on next provider on 5xx/timeout.
- Scene gen `asyncio.gather(..., return_exceptions=True)` saves completed scenes to `media_assets` before raising. Retry skips them.
- Worker heartbeat key: `worker:heartbeat`. Health = healthy if <90s old.
- Service/route packages: code in `_monolith.py` + re-exports in `__init__.py`. **Never import from `_monolith` directly.**
- `UnsafeURLError` inherits from `ValueError`. **Don't catch `ValueError` broadly** in code calling SSRF validators — use explicit `except UnsafeURLError`.
- Music + SEO gen are now arq jobs. HTTP endpoints enqueue + return immediately. Frontend polls or uses WebSocket.
- Docker `app` doesn't use `--reload`. For hot reload: run `uvicorn ... --reload` directly outside Docker.

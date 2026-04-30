# Changelog

All notable changes to Drevalis Creator Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.29.1] - 2026-04-30

### Strict-mode rollout — codebase-wide

The entire `drevalis` package — all 208 source files — now passes
`mypy --strict`. CI gate widened from the prior two-package adoption
(`drevalis.core.license` + `drevalis.services.updates`) to
`mypy -p drevalis --strict`.

Eight residual strict-optional issues fixed along the way (none of
them latent bugs — all type-system narrowing nudges):

- `repositories/media_asset.py` — `get_total_size_bytes()` narrows
  `result.scalar_one()` against the `COALESCE(..., 0)` guarantee so
  the return type matches the declared `int`.
- `services/comfyui/_monolith.py` — `generate_image` and
  `generate_video` now declare `server_id: UUID | None` to match
  every call site (round-robin pool dispatch passes `None`). Scene
  ref-image fallbacks rewritten to a conditional expression so the
  literal `[None]` doesn't pollute the inferred list type.
- `services/ffmpeg/_monolith.py` and `services/audiobook/_monolith.py`
  — added `assert proc.stderr is not None` after PIPE'd
  `create_subprocess_exec` so mypy can narrow before the readline
  loop.
- `services/youtube.py` — encrypt-value at OAuth callback now passes
  `credentials.token or ""` (the upstream type is `Any | None`).
- `services/cloud_gpu/registry.py` — `SUPPORTED_PROVIDERS` retyped to
  `tuple[dict[str, str | None], ...]` to admit the `settings_attr:
  None` rows for vastai/lambda. `_resolve_api_key` follows.
- `services/pipeline/_monolith.py` — chapters and music_mood Optional
  fields now coerce to `[]` / `""` at the call boundary instead of
  passing `None` into helpers that don't accept it.
- `core/metrics.py` — `float(_decode(raw))` falls back to `0.0` when
  decode returns `None`.
- `workers/jobs/scheduled.py` and `workers/jobs/audiobook.py` — fresh
  variable declarations to clear stale `str` narrowing across
  reassignments to `str | None`.

Failure mode going forward: any new `Optional` leak that was
previously masked by `--no-strict-optional` will fail CI on the
strict step. Fix at the call site, don't weaken the gate.

## [0.29.0] - 2026-04-30

### Layering refactor (audit F-A-01) — complete

Every file under `src/drevalis/api/routes/` now depends only on services.
`grep -rE "from drevalis\.repositories" src/drevalis/api/routes/` returns
zero matches across all 21 flat routes and all 4 monolith packages.

Fourteen new or significantly-expanded services own ~7000 LOC of
orchestration that previously lived in route handlers:

- **New services**: `services/schedule.py`, `services/voice_profile.py`,
  `services/runpod_orchestrator.py`, `services/license.py`,
  `services/editor.py`, `services/series.py`, `services/social.py`,
  `services/video_ingest.py`, `services/jobs.py`,
  `services/audiobook_admin.py`, `services/youtube_admin.py`.
- **Significantly expanded**: `services/episode.py` (~120 → ~1000 LOC,
  ~30 methods covering full lifecycle, script editing, scene operations,
  music tab, exports, thumbnail uploads, video edits, SEO orchestration,
  publish-all, inpainting, continuity check).
- **Re-used**: `services/llm_config.py`, `services/comfyui_admin.py`,
  `services/api_key_store.py`, `services/character_pack.py`,
  `services/asset.py`, `services/ab_test.py`,
  `services/prompt_template.py`, `services/video_template.py`.

Domain exceptions (~20 new) preserve the rich HTTP error shapes that
the frontend and operators rely on (e.g. `youtube_key_decrypt_failed`
503, `channel_cap_exceeded` 402, `series_field_locked` 409,
`migration_missing` 500, `youtube_token_expired` 401,
`channel_id_required` 400 with `connected_channels` list,
`no_channel_selected` 400, `duplicate_create` 409,
`license_server_not_configured` 400, `license_not_active` 400,
`scope_missing` 403).

Notable architectural decisions:

- `services/audiobook_admin.py` and `services/youtube_admin.py` are
  *route-orchestration* services distinct from the existing heavy
  `services/audiobook.py` and `services/youtube.py` (the upstream API
  clients). The worker keeps importing the heavy ones unchanged.
- `services/runpod_orchestrator.py` wraps the GraphQL client at
  `services/runpod.py` (same pattern).
- The episodes monolith was layered in 3 phases: lifecycle (21
  endpoints), music + export + thumbnail (10 endpoints), then
  video-edit + SEO-LLM + publish-all + inpaint + continuity (~18
  endpoints). Dead helpers (`_check_generation_slots`,
  `_get_dynamic_max_slots`, `_PIPELINE_STEPS`) removed once their
  EpisodeService equivalents covered every call site.

All 630 unit tests pass throughout. `mypy --no-strict-optional`
remains clean across the touched packages; `ruff check src/` passes.

### Added

- `SESSION_SECRET` env var for the team-mode session cookie HMAC, decoupling
  session-token forgery from `ENCRYPTION_KEY` compromise. Falls back to
  `ENCRYPTION_KEY` when unset for backwards compat.
- `COOKIE_SECURE` env var to mark session cookies as Secure (set `true`
  behind HTTPS).
- `WORKER_DB_POOL_SIZE` (default 5) and `WORKER_DB_MAX_OVERFLOW` (default 10)
  for a smaller worker-side DB pool — workers are sequential per job so the
  API's 10+20 was wasted.
- Indexes on hot-path columns: `episodes.created_at`, `audiobooks.status`,
  `media_assets(episode_id, scene_number)`, `series.content_format`,
  `scheduled_posts.youtube_channel_id` (migrations 035–039). Synchronised
  the ORM with two indexes (`ix_generation_jobs_episode_id_step`,
  `ix_series_youtube_channel_id`) that existed in the DB but not in models.
- `FFmpegService.concat_videos` for video-only concat (audio mixing happens
  later in the edit-session render flow).
- `AssetRepository.get_by_ids` and `EpisodeRepository.get_by_ids` for batch
  ID lookups, replacing N+1 patterns in pipeline + jobs cleanup.
- `GenerationJobRepository.get_done_steps` (single DISTINCT query replacing
  6 per-step calls in the regenerate handler).
- `ComfyUIPool.total_capacity()` so scene-gen concurrency tracks the sum of
  registered server capacity instead of a hardcoded 4.
- `is_demo_mode` / `require_not_demo` FastAPI deps relocated to
  `core/deps.py` (was `services/demo.py`, which violated layering).
- `docs/security/websocket-token-logging.md` — per-proxy access-log
  scrubber recipes for the WebSocket bearer-in-query-string risk.
- 49 unit tests for `seo_preflight` (0% → 97% coverage) and
  `quality_gates` pure functions.
- Replaced the 18 quarantined xfails (per `docs/ops/techdebt.md` §1) with
  current-API equivalents: pipeline orchestrator (5 tests), ffmpeg
  command builder (4 tests), LLM provider selection (4 tests), worker
  jobs (4 tests), ComfyUI pool round-robin + total_capacity (1 test
  replacing the removed least-loaded selector).
- CI workflow now triggers on push to `audit/**` branches in addition
  to `main`, so audit work shows up in GitHub Actions without a PR.

### Changed

- Bumped `cryptography>=46.0.7` (CVE-2026-34073, CVE-2026-39892) and
  `anthropic>=0.87.0` (CVE-2026-34450, CVE-2026-34452).
- Pipeline metrics now persist via Redis counters + a capped recent-events
  list (`MetricsCollector` was per-process, so the `/api/v1/metrics/*`
  endpoints permanently returned zeros — worker writes were never visible
  to the API process).
- Visual prompt refinement in the pipeline `script` step now runs scenes
  in parallel via `asyncio.gather` (was sequential — 50–150s saved on a
  50-scene long-form episode).
- Per-function arq timeouts on short admin jobs: 120s for heartbeats,
  900s for SEO / scheduled publish / AB winner. Long-running jobs
  (pipeline, audiobook, music gen) keep the global 4h ceiling.
- Worker heartbeat TTL bumped from 120s → 180s so a single missed beat
  doesn't flip the key from "stale" to "absent" before the API's
  liveness check fires.
- Cloud-GPU provider error wrapping centralised: 26 duplicated
  `raise CloudGPUProviderError(...)` sites collapsed into two helpers
  (`wrap_httpx_error`, `wrap_provider_api_error`); -107 / +58 lines.
- Export bundle endpoints (`/episodes/{id}/export-bundle`,
  `/episodes/{id}/export-raw-assets`) now build the zip in a thread via
  `asyncio.to_thread` and use `ZIP_STORED` instead of `ZIP_DEFLATED`
  (MP4/JPG/SRT are already compressed). Multi-hundred-MB exports no
  longer block the uvicorn event loop.
- `MediaAsset.asset_type` CHECK constraint widened to allow
  `scene_image`, `scene_video`, `video_proxy` — code was already
  inserting these and failing at the DB.
- Episode `chapters` ORM annotation corrected from `dict` to `list[dict]`
  (matches the runtime value and the existing Pydantic schema).
- `LLMService.storage` parameter dropped — never read; 13 call sites
  updated.
- `LongFormScriptService` binds a `longform_phase` contextvar
  (`outline` / `chapters`) at each phase entry.
- Audiobook generate() binds `audiobook_id` + `title` via structlog
  contextvars at the job boundary so every helper log carries the id.
- Worker job tarball restore now uses `tarfile.extractall(filter='data')`
  to reject symlink / hardlink / device members — closes Bandit B202.
- `LicenseGateMiddleware` heartbeat threshold doc aligned with the 120s
  code (was documented as 90s).

### Fixed

- TikTok OAuth callback now rejects requests with missing/forged/replayed
  `state` and uses atomic `getdel` for PKCE verifier lookup (matches the
  YouTube callback). Previously fell through silently to token exchange
  on state miss.
- Scene-image + scene-video generation handler signatures now declare
  `server_id: UUID | None` to match the actual call sites (every caller
  passes `None` for round-robin pool dispatch).
- Audiobook chapter image generation no longer crashes with
  `AttributeError` when `comfyui_service` is `None` — falls back to
  title cards.
- Edit-session render no longer raises `TypeError` on `concat_video_clips`
  (the call was missing `voiceover_path` and was masked by a
  `# type: ignore[call-arg]`).
- `cancel:{episode_id}` Redis key now cleared on every enqueue, so a
  worker crash mid-cancel can't silently abort the next regenerate run
  for up to an hour.
- `worker_heartbeat` failures now log at WARNING with `exc_info` instead
  of silent `pass`.
- ComfyUI pool startup failures now log at ERROR (was DEBUG); per-server
  registration failures include the server URL and `exc_info`.
- LLM-pool failover warnings now include `exc_info` and a longer
  truncation budget; visual-prompt-refine failures bumped DEBUG → WARN
  so silent quality degradation is visible.
- ComfyUI server cooldown warning now includes the server URL so
  operators don't have to cross-reference the UUID with the dashboard.
- Audiobook cover/background image resolution failures now log at
  WARNING with `exc_info` (were silently swallowed; users got the
  auto-generated title card with no log).
- `seo + music` worker jobs bind `episode_id` via structlog contextvars
  at job entry; downstream provider/LLM logs now carry it.
- N+1 cleanup in `/api/v1/jobs/cleanup`: episode-by-id loop replaced
  with one IN-clause batch load.
- N+1 in `/api/v1/jobs/tasks/active`: 2 GETs per matched key collapsed
  into 2 MGETs total (Activity Monitor polls every 2–3s).
- N+1 in `POST /episodes/{id}/generate`: 6 per-step `get_latest_by_*`
  queries collapsed into one DISTINCT query.
- Tar extraction for backup restore now uses Python 3.12+ data filter,
  closing the symlink/hardlink/device escape vector flagged by Bandit
  B202.
- TikTok OAuth state-validation gap (CSRF + state replay).
- Doc drift: `/about` → `/help` route, `services/pipeline.py` →
  `services/pipeline/_monolith.py`, sidebar groups, README env table,
  `ENCRYPTION_KEY_V*` rotation claim, cron comment.
- SceneGrid card aspect ratio corrected to 9:16 per design system §3
  (was leftover landscape `aspect-video` from earlier layout).

## [0.28.1] - 2026-04-29

<!-- TODO: backfill from GitHub Release -->

## [0.28.0] - 2026-04-28

<!-- TODO: backfill from GitHub Release -->

## [0.27.1] - 2026-04-28

<!-- TODO: backfill from GitHub Release -->

## [0.27.0] - 2026-04-28

<!-- TODO: backfill from GitHub Release -->

## [0.26.0] - 2026-04-27

<!-- TODO: backfill from GitHub Release -->

## [0.25.1] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.25.0] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.24.0] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.23.5] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.23.4] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.23.3] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.23.2] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.23.1] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.23.0] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.22.10] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.22.9] - 2026-04-26

<!-- TODO: backfill from GitHub Release -->

## [0.22.8] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.7] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.6] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.5] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.4] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.3] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.2] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.1] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.22.0] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.21.4] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.21.3] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.21.2] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.21.1] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.21.0] - 2026-04-25

<!-- TODO: backfill from GitHub Release -->

## [0.20.43] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.42] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.41] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.40] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.39] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.38] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.37] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.36] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.35] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.34] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.33] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.32] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.31] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.30] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.29] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.28] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.27] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.26] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.25] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.24] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.23] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.22] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.21] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.20] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.19] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.18] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.17] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.16] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.15] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.14] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.13] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.12] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.11] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.10] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.9] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.8] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.7] - 2026-04-24

<!-- TODO: backfill from GitHub Release -->

## [0.20.6] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.20.5] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.20.4] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.20.3] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.20.2] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.20.1] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.20.0] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.59] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.58] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.57] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.56] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.55] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.54] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.53] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.52] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.51] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.50] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.49] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.48] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.47] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.46] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.45] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.44] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.43] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.42] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.41] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.40] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.39] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.38] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.37] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.36] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.35] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.34] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.33] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.32] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.31] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.30] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.29] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.28] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.27] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.26] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.25] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.24] - 2026-04-23

<!-- TODO: backfill from GitHub Release -->

## [0.19.23] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.21] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.20] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.19] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.18] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.17] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.16] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.15] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.14] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.13] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.12] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.11] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.10] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.9] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.8] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.7] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.6] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.5] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.4] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.3] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.2] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.1] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.19.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.18.4] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.18.3] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.18.2] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.18.1] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.18.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.17.1] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.17.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.16.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.15.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.14.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.13.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.12.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.11.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.10.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.9.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.8.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.7.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.6.1] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.6.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.5.2] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.5.1] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.5.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.4.4] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.4.3] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.4.2] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.4.1] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.4.0] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.9] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.8] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.7] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.6] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.5] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.4] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.3] - 2026-04-22

<!-- TODO: backfill from GitHub Release -->

## [0.3.2] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.3.1] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.3.0] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.7] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.6] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.5] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.4] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.3] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.2] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.1] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.2.0] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.1.9] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.1.8] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.1.7] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.1.6] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.1.5] - 2026-04-21

<!-- TODO: backfill from GitHub Release -->

## [0.1.4] - 2026-04-20

<!-- TODO: backfill from GitHub Release -->

## [0.1.3] - 2026-04-20

<!-- TODO: backfill from GitHub Release -->

## [0.1.2] - 2026-04-20

<!-- TODO: backfill from GitHub Release -->

## [0.1.1] - 2026-04-20

<!-- TODO: backfill from GitHub Release -->

## [0.1.0] - 2026-04-20

<!-- TODO: backfill from GitHub Release -->


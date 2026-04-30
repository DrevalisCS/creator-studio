# Documentation Drift Audit — Drevalis Creator Studio

**Date:** 2026-04-29
**Auditor:** Claude (read-only spot-check)
**Scope:** CLAUDE.md, README.md, docs/adr/*, docs/ops/*, docs/security/2026-03-fixes.md, docs/frontend/design-system.md vs live source code.

---

## Task 1 — arq Worker Jobs (CLAUDE.md table vs WorkerSettings.functions)

10 jobs spot-checked against `src/drevalis/workers/settings.py` lines 112–136.

| CLAUDE.md job | Found in WorkerSettings.functions? |
|---|---|
| `generate_episode` | Yes |
| `generate_audiobook` | Yes |
| `retry_episode_step` | Yes |
| `reassemble_episode` | Yes |
| `regenerate_voice` | Yes |
| `regenerate_scene` | Yes |
| `regenerate_audiobook_chapter` | Yes |
| `generate_script_async` | Yes |
| `generate_ai_audiobook` | Yes |
| `generate_series_async` | Yes |
| `auto_deploy_runpod_pod` | Yes |
| `publish_scheduled_posts` | Yes |
| `generate_episode_music` | Yes |
| `generate_seo_async` | Yes |

All 14 documented jobs are registered. The CLAUDE.md table is accurate for the jobs it lists.

**Undocumented jobs in WorkerSettings.functions (not in CLAUDE.md table):**
- `regenerate_audiobook_chapter_image`
- `publish_pending_social_uploads`
- `compute_ab_test_winners`
- `worker_heartbeat`
- `license_heartbeat`
- `scheduled_backup`
- `analyze_video_ingest`
- `commit_video_ingest_clip`
- `render_from_edit`

That is 9 registered jobs with no entry in the CLAUDE.md table (findings F-DD-01 and F-DD-02 below).

---

## Task 2 — Env Var Tables vs Settings class

10 env vars checked against `src/drevalis/core/config.py`.

| Variable | Present in Settings? | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | Yes (`encryption_key: str`, required) | Correct |
| `LM_STUDIO_BASE_URL` | Yes (`lm_studio_base_url`) | Correct |
| `COMFYUI_DEFAULT_URL` | Yes (`comfyui_default_url`) | Correct |
| `MAX_CONCURRENT_GENERATIONS` | Yes (`max_concurrent_generations: int = 4`) | Correct |
| `DB_POOL_SIZE` | Yes (`db_pool_size: int = 10`) | Correct |
| `API_AUTH_TOKEN` | Yes (`api_auth_token: str \| None = None`) | Correct |
| `STORAGE_BASE_PATH` | Yes (`storage_base_path: Path`) | Correct |
| `ENCRYPTION_KEY_V1` / `ENCRYPTION_KEY_V2` | **No** — not Settings fields | Handled via `security.py` comment only; never a pydantic field |
| `REDIS_URL` | Yes (`redis_url`) | Correct |
| `ENABLE_DEMO_MODE` | **No** — field is `demo_mode` → env var is `DEMO_MODE` | CLAUDE.md cites `ENABLE_DEMO_MODE` which is wrong |

See findings F-DD-03 and F-DD-04.

---

## Task 3 — Pipeline Step List vs PipelineOrchestrator

CLAUDE.md (line 63): `script → voice → scenes → captions → assembly → thumbnail`

`src/drevalis/services/pipeline/_monolith.py` lines 63–79:

```python
class PipelineStep(StrEnum):
    SCRIPT = "script"
    VOICE = "voice"
    SCENES = "scenes"
    CAPTIONS = "captions"
    ASSEMBLY = "assembly"
    THUMBNAIL = "thumbnail"

PIPELINE_ORDER = [SCRIPT, VOICE, SCENES, CAPTIONS, ASSEMBLY, THUMBNAIL]
```

**Result: exact match.** Step names and order are correct in both CLAUDE.md and README.md.

CLAUDE.md also states the module path as `services/pipeline.py` (line 61 and line 291) — the actual implementation is in the package `services/pipeline/_monolith.py`. See finding F-DD-05.

---

## Task 4 — API Endpoint Claims vs Route Decorators

10 endpoints spot-checked.

| Documented claim | Actual route found? |
|---|---|
| `POST /api/v1/jobs/cancel-all` | Yes — `jobs/_monolith.py` line 299 |
| `GET /api/v1/jobs/worker/health` | Yes — line 589 |
| `POST /episodes/{id}/regenerate-scene/{scene_number}` | Yes — episodes `_monolith.py` line 1016 |
| `POST /episodes/{id}/regenerate-voice` | Yes — line 1102 |
| `POST /episodes/{id}/reassemble` | Yes — line 1216 |
| `POST /episodes/{id}/estimate-cost` | Yes — line 1354 |
| YouTube multi-channel: `GET /api/v1/youtube/channels` | Yes — youtube `_monolith.py` line 363 |
| YouTube: `POST /api/v1/youtube/upload/{episode_id}` | Yes — line 501 |
| Social: `GET /api/v1/social/platforms` | Yes — `social.py` line 354 |
| Audiobooks: `POST /api/v1/audiobooks/{id}/regenerate-chapter/{index}` | Yes — audiobooks `_monolith.py` line 779 |

All 10 spot-checked endpoints exist with the correct HTTP method. No mismatches found.

**Notable undocumented routes** (present in router.py, not mentioned anywhere in CLAUDE.md or README):
- `ab_tests_router` — A/B test feature
- `cloud_gpu_router` — Cloud GPU management (`/cloud-gpu` page exists in frontend)
- `character_packs_router`
- `video_ingest_router`
- `editor_router`
- `backup_router`
- `onboarding_router`
- `auth_router`
- `updates_router`
- `assets_router`

See finding F-DD-06.

---

## Task 5 — Frontend Pages Table vs App.tsx + pages/ directory

### CLAUDE.md pages table (lines 237–251)

| CLAUDE.md Route | CLAUDE.md Page | In App.tsx? | In pages/? |
|---|---|---|---|
| `/` | Dashboard | Yes | Yes |
| `/series` | SeriesList | Yes | Yes |
| `/series/:seriesId` | SeriesDetail | Yes | Yes |
| `/episodes` | EpisodesList | Yes | Yes |
| `/episodes/:episodeId` | EpisodeDetail | Yes | Yes |
| `/audiobooks` | Audiobooks | Yes | Yes |
| `/audiobooks/:id` | AudiobookDetail | Yes | Yes |
| `/youtube` | YouTube | Yes | Yes |
| `/calendar` | Calendar | Yes | Yes |
| `/jobs` | Jobs | Yes | Yes |
| `/logs` | Logs | Yes | Yes |
| `/about` | About | **No** — route is `/help`, page is `Help` | Page is `Help/` not `About` |
| `/settings` | Settings | Yes | Yes |
| `/youtube/callback` | YouTubeCallback | Yes (inline component, not a page file) | No separate file |

### Pages in App.tsx NOT in CLAUDE.md table

| Route | Page | Missing from docs |
|---|---|---|
| `/usage` | Usage | Yes |
| `/cloud-gpu` | CloudGPU | Yes |
| `/assets` | Assets | Yes |
| `/episodes/:episodeId/edit` | EpisodeEditor | Yes |
| `/audiobooks/:audiobookId/edit` | AudiobookEditor | Yes |
| `/episodes/:episodeId/shot-list` | ShotList | Yes |
| `/login` | Login | Yes |
| `/social/:platform` | SocialPlatform | Yes |

See findings F-DD-07 and F-DD-08.

### Sidebar sections vs actual Sidebar.tsx

CLAUDE.md sidebar (lines 255–256):
> **Content Studio**: Dashboard, Series, Episodes, Text to Voice (badge: live count of generating episodes)
> **Social Media**: YouTube, Calendar
> **System**: Settings

Actual `Sidebar.tsx` section groups:
- Top: Dashboard
- Content Studio: Episodes, Series, Text to Voice, Assets
- Publish: Calendar + conditional platform links (YouTube, TikTok, Instagram, Facebook, X)
- System: Settings, Cloud GPU, Jobs, Usage, Event Log
- Bottom: Help

Differences: "Social Media" is now labelled "Publish"; YouTube is conditional (only shown when connected); Jobs and Cloud GPU are now under System; Assets is a new nav item; Help is a bottom-pinned item. The CLAUDE.md sidebar description is substantially out of date. See finding F-DD-09.

---

## Findings

### F-DD-01: arq worker jobs table is missing 9 registered jobs
- **Severity:** LOW
- **Location:** `CLAUDE.md` lines 75–91 (arq Worker Jobs table)
- **Evidence:** `WorkerSettings.functions` (settings.py lines 112–136) registers 23 functions. CLAUDE.md lists 14. Missing: `regenerate_audiobook_chapter_image`, `publish_pending_social_uploads`, `compute_ab_test_winners`, `worker_heartbeat`, `license_heartbeat`, `scheduled_backup`, `analyze_video_ingest`, `commit_video_ingest_clip`, `render_from_edit`.
- **Impact:** A developer looking to add a job or debug one of these won't find it in the reference table and may duplicate or misconfigure it.
- **Effort:** Trivial — add 9 rows with one-line descriptions.
- **Suggested fix:** Add the 9 missing jobs to the CLAUDE.md arq Worker Jobs table.

---

### F-DD-02: `render_from_edit`, `analyze_video_ingest`, `commit_video_ingest_clip`, `compute_ab_test_winners`, `scheduled_backup`, `license_heartbeat` are entirely undocumented subsystems
- **Severity:** MEDIUM
- **Location:** `CLAUDE.md` — no section covers video ingest, A/B tests, backup, or license heartbeat features
- **Evidence:** `router.py` imports `ab_tests_router`, `video_ingest_router`, `backup_router`, `editor_router`; `WorkerSettings.functions` includes the corresponding jobs. None appear in CLAUDE.md architecture, conventions, or API routes sections.
- **Impact:** New engineers have no architectural context for these subsystems. A/B test logic and video ingest are non-trivial features that affect pipeline behavior.
- **Effort:** Low-to-medium — add brief subsystem descriptions under Architecture.
- **Suggested fix:** Add short paragraphs in CLAUDE.md Architecture for Video Ingest, A/B Tests, Backup, and License heartbeat subsystems.

---

### F-DD-03: `ENCRYPTION_KEY_V1` / `ENCRYPTION_KEY_V2` are not Settings fields
- **Severity:** LOW
- **Location:** `CLAUDE.md` line 179 ("Rotation via `ENCRYPTION_KEY_V1`, `_V2`, etc.")
- **Evidence:** `security.py` docstring mentions these as env var names but they are never declared in `Settings`. There is no loader in `config.py` that reads them. The current key rotation mechanism accepts the keys as function arguments (`decrypt_value_multi`), not from environment variables directly.
- **Impact:** An operator attempting to rotate keys by setting `ENCRYPTION_KEY_V1` will see no effect — the variable is simply ignored by the Settings class. This is a misleading operations claim.
- **Effort:** Trivial — clarify the CLAUDE.md note to say "rotation is done by passing old keys to `decrypt_value_multi` directly" or implement the env var loader.
- **Suggested fix:** Update CLAUDE.md line 179 to remove the implication that `ENCRYPTION_KEY_V1`/`_V2` are recognized env vars, or add them to Settings and document actual rotation procedure.

---

### F-DD-04: `ENABLE_DEMO_MODE` env var name is wrong
- **Severity:** LOW
- **Location:** `CLAUDE.md` line 206 (Gotchas, first bullet, "Required: `ENCRYPTION_KEY`. In dev...")  — the specific env var `ENABLE_DEMO_MODE` is implied by the memory file `project_demo_vps.md` (`DEMO_MODE=true`). Confirmed: the Settings field is `demo_mode: bool = False`, which maps to env var `DEMO_MODE`, not `ENABLE_DEMO_MODE`.
- **Evidence:** `config.py` line 118: `demo_mode: bool = False`. The memory file `project_demo_vps.md` correctly uses `DEMO_MODE=true`. No document explicitly calls it `ENABLE_DEMO_MODE`; the confusion comes from docs being silent on the correct name.
- **Impact:** The README configuration table (lines 154–179) does not list `DEMO_MODE` at all. Any operator deploying a demo instance has no reference for this env var.
- **Effort:** Trivial.
- **Suggested fix:** Add `DEMO_MODE` to the README configuration table with a description matching the `config.py` docstring.

---

### F-DD-05: CLAUDE.md references `services/pipeline.py` — it is a package, not a file
- **Severity:** NIT
- **Location:** `CLAUDE.md` lines 61 and 291
- **Evidence:** Line 61: `PipelineOrchestrator` state machine (`services/pipeline.py`)`. Line 291: `pipeline.py  # PipelineOrchestrator (6-step state machine)`. Actual path is `src/drevalis/services/pipeline/_monolith.py` (a package with `__init__.py` re-exports).
- **Impact:** Developers following the CLAUDE.md pointer will get a directory listing, not a file. Minor friction when navigating by path reference.
- **Effort:** Trivial.
- **Suggested fix:** Update both references to `services/pipeline/` (package) with a note that the implementation is in `_monolith.py` per the Modular packages convention.

---

### F-DD-06: `router.py` includes 10+ sub-routers with no mention in CLAUDE.md or README
- **Severity:** LOW
- **Location:** `src/drevalis/api/router.py` lines 8–36; `CLAUDE.md` API Routes section (line 263–265) just points to Swagger
- **Evidence:** Registered but undocumented routers: `ab_tests`, `cloud_gpu`, `character_packs`, `video_ingest`, `editor`, `backup`, `onboarding`, `auth`, `updates`, `assets`. CLAUDE.md says "For the full endpoint list...see Swagger UI" which is fair, but zero architectural context exists for these feature areas.
- **Impact:** Low for daily use (Swagger exists), but a developer adding a new route to `ab_tests` has no idea where that subsystem fits in the architecture.
- **Effort:** Low.
- **Suggested fix:** Extend the CLAUDE.md API Routes section with a brief table of all sub-router prefixes and their purpose (one sentence each), matching the existing arq jobs table format.

---

### F-DD-07: CLAUDE.md pages table omits 8 routes that exist in App.tsx
- **Severity:** LOW
- **Location:** `CLAUDE.md` lines 237–251 (Pages table)
- **Evidence:** App.tsx registers routes for `/usage` (Usage), `/cloud-gpu` (CloudGPU), `/assets` (Assets), `/episodes/:episodeId/edit` (EpisodeEditor), `/audiobooks/:audiobookId/edit` (AudiobookEditor), `/episodes/:episodeId/shot-list` (ShotList), `/login` (Login), `/social/:platform` (SocialPlatform). None appear in the CLAUDE.md table.
- **Impact:** A frontend developer looking for the shot-list or episode editor won't find them in the reference; they'll have to grep App.tsx anyway.
- **Effort:** Trivial.
- **Suggested fix:** Add the 8 missing routes to the CLAUDE.md pages table with one-line purpose descriptions.

---

### F-DD-08: CLAUDE.md documents `/about` → `About` page; actual route is `/help` → `Help`
- **Severity:** LOW
- **Location:** `CLAUDE.md` line 249; `App.tsx` line 114; `frontend/src/pages/Help/`
- **Evidence:** CLAUDE.md: `| /about | About | App info, pipeline viz |`. App.tsx: `<Route path="/help" element={<Help />} />`. The pages directory contains `Help/index.tsx` and `Help/_monolith.tsx`; there is no `About` page or `/about` route.
- **Impact:** Any developer directed to `/about` will hit a 404. The sidebar `Help` link and the "About" documentation are mismatched.
- **Effort:** Trivial.
- **Suggested fix:** Update CLAUDE.md table entry from `/about` / `About` to `/help` / `Help`.

---

### F-DD-09: CLAUDE.md sidebar description is substantially out of date
- **Severity:** LOW
- **Location:** `CLAUDE.md` lines 253–256 (Sidebar section)
- **Evidence:**
  - Doc claims three sections: "Content Studio", "Social Media", "System".
  - `Sidebar.tsx` has five groups: top (Dashboard), Content Studio (Episodes, Series, Text to Voice, **Assets**), Publish (Calendar + conditional platform links), System (**Settings, Cloud GPU, Jobs, Usage, Event Log**), bottom (**Help**).
  - "Social Media" section does not exist — it's now "Publish". YouTube is conditional (only shown when a YouTube account is connected). Jobs, Cloud GPU, Usage, and Event Log are all in System. Assets is a new Content Studio item. Help is pinned at the bottom.
- **Impact:** Onboarding engineers using the sidebar description to understand the nav structure will be confused by the gap between description and what they see in the browser.
- **Effort:** Trivial — rewrite 3 lines.
- **Suggested fix:** Replace the three-bullet sidebar description with the actual five-group structure from `Sidebar.tsx`.

---

### F-DD-10: `publish_scheduled_posts` cron comment says "every 15 minutes" but fires every 5
- **Severity:** LOW
- **Location:** `src/drevalis/workers/settings.py` line 138
- **Evidence:** Comment: `# Check for due scheduled posts every 15 minutes`. Cron expression: `minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}` — that is every 5 minutes (12 times per hour). CLAUDE.md (line 88) and README.md (line 69) correctly document "every 5 minutes".
- **Impact:** Low — docs are correct; only the inline code comment misleads. A developer reading only `settings.py` will believe the cadence is 15 minutes and may not understand why jobs fire more frequently.
- **Effort:** Trivial — one word change in the comment.
- **Suggested fix:** Update the comment in `settings.py` line 138 from "every 15 minutes" to "every 5 minutes".

---

### F-DD-11: CLAUDE.md `mypy src/ --strict` vs techdebt's `--no-strict-optional` CI flag
- **Severity:** NIT
- **Location:** `CLAUDE.md` line 47 (Lint / QA); `docs/ops/techdebt.md` line 27
- **Evidence:** CLAUDE.md documents `mypy src/ --strict`. `pyproject.toml` line 116 has `strict = true`. `docs/ops/techdebt.md` line 27 says CI runs `mypy -p drevalis --no-strict-optional` (which overrides strict). These are contradictory — the command in CLAUDE.md will fail where CI passes.
- **Impact:** A developer running `mypy src/ --strict` locally may see different errors than CI, causing confusion about what "green" means.
- **Effort:** Trivial.
- **Suggested fix:** Update `docs/ops/techdebt.md` to clarify this is a temporary override until the `--no-strict-optional` debt is resolved, and update the CLAUDE.md lint command to match what CI actually runs, or resolve the debt.

---

## Top 5 by ROI

1. **F-DD-08** (route `/about` → 404): Any developer or tester following the docs hits a 404. One-word fix, highest user-visible impact.
2. **F-DD-09** (sidebar description): Engineers onboarding to the frontend rely on this to understand the nav. It's visibly wrong from first launch. Three-line rewrite.
3. **F-DD-07** (8 missing routes in pages table): The EpisodeEditor and ShotList are real features that developers will need to find. Append 8 rows to the table.
4. **F-DD-03** (`ENCRYPTION_KEY_V1`/`V2` not Settings fields): This is an operations footgun — an operator following the docs will set env vars that are silently ignored during key rotation.
5. **F-DD-01** (9 undocumented arq jobs): The most mechanical fix — append 9 rows — and directly helps any developer debugging a job that doesn't appear in the reference.

---

## Don't Fix (Intentional)

- **F-DD-05 (pipeline.py vs pipeline/ package):** The directory structure comment in CLAUDE.md is a simplified view intentionally described as `.py` files. The "Modular packages" convention elsewhere in CLAUDE.md already explains that packages exist; the listing is not meant to be an exhaustive file-system dump. Fixing it would require updating the entire Directory Structure block for every packaged service, which adds noise for marginal gain.

- **F-DD-06 (undocumented sub-routers):** CLAUDE.md deliberately defers the full endpoint list to Swagger (`http://localhost:8000/docs`). Adding every sub-router with a one-line description is mildly useful but duplicates what Swagger already provides. This is a "nice to have" rather than a drift that causes wrong assumptions.

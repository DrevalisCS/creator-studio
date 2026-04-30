# Test Coverage & Quality Audit

Generated: 2026-04-29  
Command: `pytest --cov=src/drevalis --cov-branch --cov-report=term-missing tests/unit/ -q`  
Integration tests skipped — all 21 fail at fixture setup (SQLite ARRAY incompatibility; see F-Tst-01).

---

## Coverage Summary

```
562 passed, 2 skipped, 18 xfailed in 4.53s

TOTAL   19521 stmts   13057 missed   4796 branches   155 partial   29% coverage
```

### Modules Below 70% (services layer — targets 80–90%)

| Module | Stmts | Cover | Target |
|--------|-------|-------|--------|
| `services/pipeline/_monolith.py` | 855 | **9%** | 90% |
| `services/tts/_monolith.py` | 690 | **14%** | 90% |
| `services/ffmpeg/_monolith.py` | 604 | **18%** | 90% |
| `services/comfyui/_monolith.py` | 474 | **26%** | 90% |
| `services/llm/_monolith.py` | 214 | **61%** | 90% |
| `services/audiobook/_monolith.py` | 1631 | **43%** | 90% |
| `services/captions/_monolith.py` | 351 | **49%** | 80% |
| `services/music/_monolith.py` | 219 | **0%** | 80% |
| `services/longform_script.py` | 104 | **0%** | 80% |
| `services/youtube.py` | 256 | **25%** | 80% |
| `services/backup.py` | 220 | **15%** | 80% |
| `services/cloud_gpu/runpod.py` | 80 | **20%** | 80% |
| `workers/jobs/audiobook.py` | 407 | **0%** | 75% |
| `workers/jobs/episode.py` | 207 | **0%** | 75% |
| `api/routes/episodes/_monolith.py` | 1205 | **12%** | 75% |
| `api/routes/youtube/_monolith.py` | 495 | **9%** | 75% |
| `api/routes/audiobooks/_monolith.py` | 492 | **19%** | 75% |
| `api/websocket.py` | 240 | **11%** | 75% |
| `services/quality_gates.py` | 102 | **0%** | 95% |
| `services/seo_preflight.py` | 139 | **0%** | 95% |
| `services/animation.py` | 42 | **0%** | 95% |
| `services/continuity.py` | 44 | **0%** | 95% |

Modules at or above target (selected notable ones):

| Module | Cover |
|--------|-------|
| `core/exceptions.py` | 100% |
| `services/episode.py` | 100% |
| `services/storage.py` | 90% |
| `services/auto_schedule.py` | 94% |
| `services/audiobook/job_state.py` | 98% |
| `services/audiobook/render_plan.py` | 99% |
| `core/auth.py` | 77% |

---

## Findings

### F-Tst-01: Integration tests fail at fixture setup — SQLite ARRAY column
- **Severity:** HIGH
- **Location:** `tests/integration/test_api_episodes.py`, `tests/integration/test_api_series.py` — all 21 tests fail at `setup`
- **Evidence:**
  ```
  AttributeError: 'SQLiteTypeCompiler' object has no attribute 'visit_ARRAY'.
  ```
  The `assets` table (and possibly others) declares `Column('tags', ARRAY(TEXT()), ...)`.
  `conftest.py` registers `@compiles(JSONB, "sqlite")` and `@compiles(UUID, "sqlite")` adapters
  but has no adapter for `ARRAY`. All integration tests fail before the first line of test code runs.
- **Impact:** The entire integration test layer is non-functional. Route-level happy-path, 404,
  409, and validation-error contracts are completely untested in CI. A regression in any
  `api/routes/` handler is invisible.
- **Effort:** small — add `@compiles(ARRAY, "sqlite")` in `conftest.py` rendering as `TEXT` (with
  JSON serialization) or, better, switch integration tests to a session-scoped Postgres container
  via `testcontainers-python`.
- **Suggested fix:** Register a SQLite compile adapter for `ARRAY` in `conftest.py` (mirrors the
  existing JSONB adapter pattern). Alternatively, move integration tests to a Postgres
  testcontainer; that also validates FK enforcement and native JSONB queries, which the SQLite
  shimming cannot.

---

### F-Tst-02: PipelineOrchestrator — 5 quarantined tests, 9% file coverage
- **Severity:** CRITICAL
- **Location:** `src/drevalis/services/pipeline/_monolith.py` (855 stmts, 9% covered)
- **Evidence (quarantined tests):**
  ```
  test_pipeline.py::TestPipelineRunsAllSteps::test_pipeline_runs_all_steps_in_order
  test_pipeline.py::TestPipelineSkipsCompletedSteps::test_pipeline_skips_completed_steps
  test_pipeline.py::TestPipelineHandlesStepFailure::test_pipeline_handles_step_failure
  test_pipeline.py::TestPipelineBroadcastsProgress::test_pipeline_broadcasts_progress
  test_pipeline.py::TestPipelineUpdatesEpisodeStatus::test_pipeline_updates_episode_status
  ```
  The xfail reason: "PipelineOrchestrator API changed during long-form pipeline work."
  Reading the current `run()` method: it now calls `self._refresh_comfyui_pool()` before
  `_load_episode()`, uses a token accumulator contextvar (`start_accumulator` / `end_accumulator`),
  and dispatches via `_execute_step()` (not direct `_step_<name>` attribute access on
  `PipelineOrchestrator`). The stale tests mock `orchestrator._step_script` etc. directly but
  `_execute_step` uses a local handler dict — so those mocks are never invoked.

  **Uncovered state transitions currently (no active unit test):**
  - Pre-start cancellation check (`_check_cancelled` before `update_status("generating")`)
  - Per-step cancellation check (between each step in `PIPELINE_ORDER` loop)
  - `asyncio.CancelledError` during a step execution
  - Token accumulator persistence on step success
  - Token accumulator persistence on step failure (best-effort path)
  - `_get_error_suggestion` mapping for each error keyword
  - `_mark_step_done` → `_broadcast_progress(100, "done")` sequence
  - `_handle_step_failure` writing `status="failed"` to both `job_repo` and `episode_repo`
  - Final `update_status("review")` + `metrics.record_generation(success=True)` on completion
  - `_refresh_comfyui_pool` failure swallowing (the `except Exception` block at line 2213)
  - Step resumability: `existing_job.status == "done"` → `continue`
- **Impact:** The primary production code path — the 855-line state machine that runs every
  generation — has no passing unit tests. Any regression in cancellation, step dispatch,
  retry logic, or status transitions is invisible.
- **Effort:** medium — the test scaffolding (`_build_orchestrator`, mock helpers) exists and is
  correct; only the mock wiring needs updating for `_execute_step` and the new `start_accumulator`
  import.
- **Suggested fix:** Patch `_execute_step` instead of `_step_<name>` attributes; mock
  `drevalis.services.pipeline._monolith.start_accumulator` to return `(MagicMock(), MagicMock())`.
  Un-quarantine one test at a time to avoid a large diff.

---

### F-Tst-03: FFmpegService._build_assembly_command — 4 quarantined tests, 18% file coverage
- **Severity:** HIGH
- **Location:** `src/drevalis/services/ffmpeg/_monolith.py` (604 stmts, 18% covered)
- **Evidence (quarantined reason):** "FFmpegService.build_assembly_command signature changed; mocks stale."
  The stale tests call `ffmpeg_service._build_assembly_command(concat_file=..., voiceover_path=..., ...)`.
  The current signature (line ~200 of `_monolith.py`) shows `assemble_video()` dispatches to either
  `_build_kenburns_command` or `_build_assembly_command` based on `config.ken_burns_enabled`.
  The method `_build_assembly_command` still exists but its parameter list or internal filter graph
  structure changed enough to break the test assertions (e.g., tests assert `"-filter_complex" not in cmd`
  for the music-free case, but the current code may differ).

  **Uncovered code regions:**
  - `assemble_video()` core logic including Ken Burns path (`_build_kenburns_command`)
  - Scene duration scaling logic (audio > scene total → proportional stretch, capped at 3×)
  - `get_duration()` via ffprobe subprocess
  - `convert_audio()` codec conversion
  - All `_build_kenburns_command` filter graph construction
- **Impact:** The FFmpeg assembly step is the final production step. Duration scaling, Ken Burns
  motion, subtitle burn-in, and audio mixing regressions are all invisible.
- **Effort:** small — verify the current `_build_assembly_command` parameter list, update the
  four test call-sites to match, and fix the `filter_complex` assertions. The Ken Burns path
  warrants new parameterized tests.
- **Suggested fix:** Read the current `_build_assembly_command` signature; update call-sites
  and assertions. Add two new parameterized tests: `ken_burns_enabled=True` produces
  `_build_kenburns_command` output, and the 3× scene-duration cap triggers the warning log.

---

### F-Tst-04: LLMService.get_provider — 4 quarantined tests patching the wrong symbol
- **Severity:** HIGH
- **Location:** `src/drevalis/services/llm/_monolith.py:399–453` (61% overall file coverage)
- **Evidence (quarantined reason):** "Provider factory moved to LLMPool; these tests patch the wrong symbols."
  Tests use `@patch("drevalis.services.llm.OpenAICompatibleProvider")` and
  `@patch("drevalis.services.llm.AnthropicProvider")` — these symbols exist at that path in the
  current code (both classes are still defined in `_monolith.py`). The real failure is that
  `LLMService(storage=storage_mock)` now requires `encryption_key=""` as well, and the provider
  selection now calls `decrypt_value()` before the provider constructor. The mock constructor
  assertion `mock_openai_cls.assert_called_once_with(base_url=..., model=..., api_key="not-needed")`
  may fail if `decrypt_value` raises when the key is blank (line 416–421 catches and falls back
  to `"not-needed"`, so the provider construction still happens, but the caching test fails if
  `config.id` is a `MagicMock()` — `dict` key lookup on a `MagicMock()` may behave differently
  each test).

  **Uncovered regions in `llm/_monolith.py`:**
  - `LLMPool.__init__` and `generate()` with failover (lines 198–354, reported as missing)
  - `AnthropicProvider.generate()` (lines 99–173)
  - `LLMPool` round-robin and 5xx failover path
- **Impact:** LLMPool failover is the production resilience mechanism; a pool with two providers
  where the first returns a 5xx should transparently retry on the second. This is untested.
- **Effort:** small — fix the `LLMService` constructor call (add `encryption_key=""`), and add
  separate tests for `LLMPool` round-robin and failover using `AsyncMock` providers.
- **Suggested fix:** Un-quarantine the provider selection tests by fixing the constructor call.
  Add a `TestLLMPool` class with tests for: single-provider success, first-provider 5xx falls
  through to second, all providers exhausted raises `RuntimeError`.

---

### F-Tst-05: Worker music and SEO jobs — 4 quarantined tests patching wrong import paths
- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/jobs/music.py`, `src/drevalis/workers/jobs/seo.py` (0% and 16% coverage)
- **Evidence (quarantined reason):** "Worker jobs migrated from sync HTTP handlers; mocks patch wrong paths."
  The stale tests patch `"drevalis.workers.jobs.music.EpisodeRepository"` — reading `music.py`,
  that import is done inside the function body (`from drevalis.repositories.episode import
  EpisodeRepository`), which means the patch target is correct IF using `patch()` at the point
  where the name is looked up. The actual failure is likely that `Settings()` inside the function
  reads real env vars (including `ENCRYPTION_KEY`), so the test fails when `Settings()` raises
  a validation error before `EpisodeRepository` is ever called.
- **Impact:** Background music generation (10-min AceStep workflow) and SEO LLM generation jobs
  have no coverage. The `generate_episode_music` fallback paths (timeout, workflow error, no audio
  output) are completely dark.
- **Effort:** small — mock `drevalis.workers.jobs.music.Settings` (or set `ENCRYPTION_KEY` env var
  in the test) and adjust existing tests to run the Settings mock before the repo mock.
- **Suggested fix:** Use `patch.dict(os.environ, {"ENCRYPTION_KEY": Fernet.generate_key().decode()})`
  as a fixture, then the existing mock wiring for `EpisodeRepository` and `ComfyUIServerRepository`
  should work. Add the happy-path test (music file written, correct dict returned).

---

### F-Tst-06: ComfyUI pool round-robin — 1 quarantined test, least-loaded logic removed
- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/comfyui/_monolith.py:350–448` (26% file coverage)
- **Evidence (quarantined reason):** "Referenced `_select_least_loaded` which the ComfyUIPool no longer exposes."
  The pool now uses round-robin via `itertools.count()` (line 378). The stale test asserts
  least-loaded selection, which no longer exists. No replacement test covers:
  - Round-robin order across three registered servers
  - Server cool-down skip (lines 390–398): a cooled-down server is skipped in round-robin
  - Health check failure → semaphore released → server placed in 60s cool-down (lines 420–436)
  - All candidates exhausted → `RuntimeError` (line 448)
  - `acquire(server_id=<specific>)` bypasses round-robin (line 365–368)
- **Impact:** Server failover and cool-down are the main resilience mechanisms for ComfyUI. A bug
  that causes the pool to always try a dead server, or to never try the healthy backup, would
  freeze every generation job silently (the semaphore is released after the ping timeout, so the
  job would hang for 5 s per server per step).
- **Effort:** small — replace the stale test with two new ones: `test_pool_round_robin_cycles_servers`
  and `test_pool_unhealthy_server_enters_cooldown`, both using `AsyncMock` clients.
- **Suggested fix:** Build a `ComfyUIPool` with two mock clients. Make the first client's
  `get_queue_status()` raise a `RuntimeError`. Assert the pool yields the second client and
  records a cool-down for the first.

---

### F-Tst-07: services/audiobook/_monolith.py — 1631 stmts at 43%
- **Severity:** HIGH
- **Location:** `src/drevalis/services/audiobook/_monolith.py` (lines 826–915, 1112–1162, 1205–1294, 1348–1962, 2444–2602, 3454–3581, 4083–4164, 4429–4506)
- **Evidence:** Coverage output shows 893 missing lines in the 4700-line audiobook monolith.
  The uncovered regions include the multi-voice chapter rendering path (lines 826–915),
  music mixing with sidechain ducking (lines 1112–1162), multi-output export (MP3/WAV, audio+image
  MP4, audio+video MP4) at lines 1205–1294 and 1348–1962, and the entire chapter-level
  regeneration path (lines 3454–3581). Individual audiobook tests exist
  (`test_audiobook_*.py` — 14 files) but focus on early-pipeline concerns; the assembly and
  export paths have no passing coverage.
- **Impact:** The audiobook export pipeline — the main user-facing deliverable for the
  Text-to-Voice feature — is over half-uncovered. Regressions in audio mixing, sidechain
  ducking level, chapter export, or MP4 wrapping are invisible.
- **Effort:** medium — the existing `test_audiobook_mix.py` and `test_audiobook_export.py`
  need to be extended. The two tests in `test_audiobook_export.py` are already skipped
  due to `ffmpeg not on PATH`; either mock `FFmpegService` or add the ffmpeg skip at the
  method level to at least cover the logic before the subprocess call.
- **Suggested fix:** Mock `FFmpegService.assemble_video` and `FFmpegService.convert_audio`
  to return `AssemblyResult` stubs; add tests for the `mp3`, `audio_image_mp4`, and
  `audio_video_mp4` export code paths in `AudiobookService.export_chapter()`.

---

### F-Tst-08: services/longform_script.py — 104 stmts at 0%
- **Severity:** HIGH
- **Location:** `src/drevalis/services/longform_script.py:14–370`
- **Evidence:** 0% line and branch coverage. `LongFormScriptService.generate()` implements the
  3-phase chunked LLM workflow (outline → chapter expansion → quality review) and is called by
  `_step_script` for all `longform`, `music_video`, and `animation` content formats.
- **Impact:** The entire long-form script generation path — the most complex LLM orchestration
  in the system — has no unit tests. Phase transitions, chapter count auto-calculation,
  and quality gate re-writes are completely untested.
- **Effort:** medium — the service takes an `LLMProvider` (Protocol); mock it with `AsyncMock`
  returning valid outline/chapter/quality JSON structures, and assert the correct method call
  order and output shape.
- **Suggested fix:** Add `tests/unit/test_longform_script.py` with a `TestLongFormScriptService`
  class. Use a mock provider that returns a minimal outline JSON on the first call and chapter
  JSONs on subsequent calls. Assert `generate()` returns a dict with `script` and `chapters` keys.

---

### F-Tst-09: services/quality_gates.py and services/seo_preflight.py — 0% coverage
- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/quality_gates.py:16–241`, `src/drevalis/services/seo_preflight.py:11–411`
- **Evidence:** Both files at 0% despite being utility/pure-function modules that should be at
  95%+ per the project target.
- **Impact:** Quality gates control which scenes get rewritten in long-form 3-phase scripting.
  SEO preflight validates metadata before YouTube upload. Both are decision-making logic without
  tests; silent failures could degrade output quality or corrupt uploads.
- **Effort:** trivial — both modules have no I/O; they operate on plain Python dicts/strings.
  Tests require no mocks.
- **Suggested fix:** Add `tests/unit/test_quality_gates.py` and `tests/unit/test_seo_preflight.py`.
  For quality gates: provide sample scene dicts and assert pass/fail verdicts. For SEO preflight:
  provide a valid and an invalid metadata dict; assert the validator raises on the invalid one.

---

### F-Tst-10: No frontend tests whatsoever
- **Severity:** MEDIUM
- **Location:** `frontend/src/` — no `__tests__`, no `*.test.ts`, no `*.test.tsx`, no `*.spec.*` files found
- **Evidence:** `frontend/package.json` has no test runner dependency (no `vitest`, `jest`,
  `@testing-library/react`, or `playwright` entry in `devDependencies`). The only `scripts` entry
  is `"lint": "tsc --noEmit"`.
- **Impact:** All React components — the Dashboard, SeriesDetail scene editor, EpisodeDetail
  player, AudiobookDetail, ActivityMonitor progress docking bar, WebSocket progress integration —
  are completely untested. A broken `useEffect`, wrong status badge, or missing `Suspense`
  boundary could ship silently.
- **Effort:** medium — bootstrapping a test runner (Vitest + `@testing-library/react`) takes an
  hour; writing the first meaningful tests for stateful components (ActivityMonitor state machine,
  EpisodeDetail tab navigation) adds another half-day.
- **Suggested fix:** Add `vitest` and `@testing-library/react` to `devDependencies`; add
  `"test": "vitest run"` to `scripts`. Start with pure utility tests (URL builders, status-to-badge
  mapping functions) before tackling React component rendering.

---

### F-Tst-11: _get_error_suggestion is tested only implicitly (0 direct assertions)
- **Severity:** LOW
- **Location:** `src/drevalis/services/pipeline/_monolith.py:164–184`
- **Evidence:** The static method maps error string keywords to user-facing suggestion strings.
  No test currently calls it directly or asserts its output. It is incidentally uncovered
  because `_handle_step_failure` (the only caller) is also uncovered.
- **Impact:** A copy-paste typo in a keyword ("comfui" instead of "comfyui") would silently
  deliver the wrong suggestion to the user's UI.
- **Effort:** trivial — pure static method, no mocks needed.
- **Suggested fix:** Add a `TestGetErrorSuggestion` class with one parametrize call covering
  each keyword branch ("comfyui", "timeout", "piper", "ffmpeg", "cancelled", "llm", "whisper",
  "no X found").

---

### F-Tst-12: Integration tests use SQLite rather than Postgres — structural mismatch
- **Severity:** MEDIUM
- **Location:** `tests/conftest.py:103–109` (`database_url="sqlite+aiosqlite:///./test.db"`)
- **Evidence:** `conftest.py` ships adapters for JSONB → JSON and UUID → TEXT for SQLite
  compatibility, but `ARRAY(TEXT())` on the `assets` table (F-Tst-01) was never shimmed.
  Additionally, SQLite does not enforce FK constraints by default, so
  `test_create_episode_nonexistent_series` explicitly accepts `201` as a valid outcome
  (comment: "SQLite does not enforce FK constraints by default").
- **Impact:** Integration tests that pass on SQLite may still fail on production Postgres due
  to FK violations, JSONB operator differences (`->`, `->>` vs plain JSON), and ARRAY column
  semantics. The test environment does not match production.
- **Effort:** medium — swap the `client` fixture to use a session-scoped `PostgresContainer`
  from `testcontainers-python`; remove all SQLite shim code.
- **Suggested fix:** See "Don't fix (intentional)" section — this is flagged but the decision
  of SQLite-shim-fix vs. Postgres container is left to the team.

---

## Top 5 by ROI

1. **F-Tst-02 (Pipeline xfails, 9% coverage)** — Highest severity, highest LOC risk. The entire
   production state machine has no passing tests. Fix by patching `_execute_step` and mocking
   `start_accumulator`; the scaffolding already exists. Un-quarantining these 5 tests plus adding
   cancellation and step-failure unit tests would lift pipeline coverage from 9% to ~60%+ for
   minimal new code.

2. **F-Tst-01 (Integration fixture bug)** — All 21 integration route tests are dead. Adding a
   single `@compiles(ARRAY, "sqlite")` adapter (3 lines, mirrors the existing JSONB adapter)
   re-enables the entire integration layer. This immediately restores route-level regression
   coverage for series and episode CRUD.

3. **F-Tst-03 (FFmpeg xfails, 18% coverage)** — The assembly step is the last thing that runs
   before an episode is marked `review`. The 4 stale tests need only a signature update. Adding
   the Ken Burns and scene-scaling tests covers the two logic branches most likely to regress on
   a resolution config change.

4. **F-Tst-08 (LongFormScriptService 0% coverage)** — New, heavily used feature with zero tests.
   The 3-phase LLM orchestration is the highest-complexity logic in the codebase outside the
   pipeline state machine. A single `TestLongFormScriptService` with a mock provider covers the
   outline → chapter → quality path and all chapter-count edge cases.

5. **F-Tst-04 (LLMPool failover, 61% coverage)** — The production resilience mechanism for LLM
   calls. The fix is a constructor argument addition plus a new `TestLLMPool` class. Catching a
   silent failover bug before production is worth more than any other medium-effort item here.

---

## Don't Fix (Intentional)

**Integration tests on SQLite vs. Postgres (F-Tst-01 / F-Tst-12):** The SQLite shim approach was
a deliberate trade-off to avoid requiring Docker in every developer's environment. Two realistic
paths exist:

- **Option A (quick fix):** Add a `@compiles(ARRAY, "sqlite")` adapter that renders `ARRAY`
  columns as `TEXT` (serialize/deserialize as JSON in tests). This restores the integration layer
  without Docker. Downside: FK constraint gaps and JSONB operator fidelity remain.

- **Option B (correct fix):** Replace the `client` fixture with a session-scoped
  `PostgresContainer("postgres:16-alpine")` from `testcontainers-python`. This removes all SQLite
  shimming, validates FK constraints, and matches the production database. Downside: requires
  Docker in CI and local dev.

The team should decide which path to take; this audit does not recommend one over the other.
The current state (all 21 integration tests erroring out) is unambiguously wrong regardless of
which path is chosen.

**18 xfailed tests (quarantined per TECHDEBT.md):** The intent to keep them as xfail rather than
delete is correct — they encode regression intent even while broken. The xfail mechanism with
`strict=False` means XPASS would surface automatically if a refactor accidentally made them pass.
Do not delete them; fix them group by group per the priority above.

**2 skipped tests (`test_audiobook_export.py`, `test_audiobook_loudness.py`):** The skip condition
is `ffmpeg / ffprobe not on PATH`. This is reasonable as a CI gate skip. The tests themselves are
structurally sound; they only need the binary present. No action needed unless the CI runner gains
FFmpeg.

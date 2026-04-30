# Operational Quality Audit — Drevalis Creator Studio

**Date:** 2026-04-29
**Auditor:** Observability Engineer (read-only pass)
**Scope:** structlog binding coverage, error swallowing, `/api/v1/settings/health` depth, worker heartbeat safety, and in-process metrics consumption.

---

## Task 1 — structlog Binding Coverage

### F-O-01: Audiobook pipeline never binds `audiobook_id` into structlog context-vars
- **Severity:** HIGH
- **Location:** `src/drevalis/services/audiobook/_monolith.py` (entire file); `src/drevalis/workers/jobs/audiobook.py:302`
- **Evidence:**
  ```python
  log = logger.bind(audiobook_id=audiobook_id, job="generate_audiobook")
  # No structlog.contextvars.bind_contextvars() call anywhere in the module
  ```
- **Impact:** `audiobook_id` is attached only to the `log` local variable inside the worker job function. Once control enters `AudiobookService.generate()` — which calls dozens of helper methods each instantiating their own `structlog.get_logger(__name__)` calls — none of those loggers inherit `audiobook_id`. Log correlation for a failing audiobook requires grepping for an unstructured string, not a field query. A 4 h audiobook run produces thousands of log lines with no shared key.
- **Effort:** small
- **Suggested fix:** Call `structlog.contextvars.bind_contextvars(audiobook_id=str(audiobook_id))` at the top of `AudiobookService.generate()`, mirroring the `bind_pipeline_context()` pattern used in `PipelineOrchestrator.run()`. Clear it on exit.

---

### F-O-02: `generate_seo_async` and `generate_episode_music` jobs use module-level logger without binding `episode_id` into context-vars
- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/jobs/seo.py:41`; `src/drevalis/workers/jobs/music.py:49-54`
- **Evidence:**
  ```python
  # seo.py
  logger.info("seo_generate_job.start", episode_id=episode_id)  # kwarg, not ctx-var
  # music.py
  logger.info("music_generate_job.start", episode_id=episode_id, ...)  # same
  ```
- **Impact:** `episode_id` appears only as a keyword on the `start` log line. If the LLM/ComfyUI call inside these jobs logs its own events (e.g., `openai_generate_complete`, `comfyui_prompt_queued`), those lines carry no `episode_id`. Debugging a slow SEO call requires correlating timestamps — not a field join.
- **Effort:** trivial
- **Suggested fix:** Add `structlog.contextvars.bind_contextvars(episode_id=episode_id)` at the start of each job function, and `structlog.contextvars.clear_contextvars()` on exit, matching the pattern in `generate_episode`.

---

### F-O-03: `LongFormScriptService` logs topic/chapter counts but never receives or binds `episode_id`
- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/longform_script.py:82-88`
- **Evidence:**
  ```python
  log.info(
      "longform_script.generate.start",
      topic=topic[:80],
      target_minutes=target_duration_minutes,
      chapters=chapter_count,
  )
  ```
- **Impact:** The 3-phase LLM service is invoked from inside `_step_script` in the pipeline orchestrator, which *does* bind `episode_id` into context-vars before calling. Since `LongFormScriptService` uses a module-level `log = structlog.get_logger(__name__)` and structlog context-vars propagate to child calls within the same asyncio task, the `episode_id` *will* appear in log output via the inherited context. However, the service itself never validates or confirms this — future async refactors (e.g., extracting it to a thread) would silently drop the context. Additionally, there is no `step` field in any `LongFormScriptService` log calls.
- **Effort:** trivial
- **Suggested fix:** Accept `episode_id` as an optional parameter and bind it locally, making the dependency explicit rather than relying on implicit context-var inheritance.

---

### F-O-04: `ComfyUIPool.acquire()` and `ComfyUIClient` logs do not carry `episode_id` or `scene_number`
- **Severity:** LOW
- **Location:** `src/drevalis/services/comfyui/_monolith.py:407-445`
- **Evidence:**
  ```python
  logger.debug("comfyui_acquiring_server", server_id=str(chosen_id))
  logger.info("comfyui_prompt_queued", prompt_id=prompt_id, url=self.base_url)
  ```
- **Impact:** The pool is shared across concurrent scene generation tasks. Without `scene_number` or `episode_id` on pool-level logs, a `comfyui_server_unhealthy_cooldown` warning cannot be attributed to the scene or episode that triggered the health failure. Context-vars propagate from the calling task so `episode_id` *should* be present at INFO level if the pipeline has bound it — but the `asyncio.gather` fan-out in scene generation creates separate tasks that each inherit a copy of the context-vars at spawn time, which is correct. This finding is about the pool's own WARNING-level log (`comfyui_server_unhealthy_cooldown`) not including the triggering prompt or scene, making ComfyUI server diagnosis harder.
- **Effort:** trivial
- **Suggested fix:** Pass `scene_number` as an optional parameter to the `ComfyUIService.generate_scene_image()` call and include it in the `comfyui_server_unhealthy_cooldown` warning.

---

## Task 2 — Error Swallowing

### F-O-05: `worker_heartbeat` silently swallows all exceptions including Redis connection failures
- **Severity:** HIGH
- **Location:** `src/drevalis/workers/jobs/heartbeat.py:40-41`
- **Evidence:**
  ```python
  except Exception:
      pass
  ```
- **Impact:** If the Redis connection inside `worker_heartbeat` fails (e.g., Redis restart, network blip, wrong `redis_url` in ctx), the heartbeat key is not written, but the worker appears to be running normally. The API's `/api/v1/jobs/worker/health` endpoint will report `alive: False` after 120 s — but no log event is emitted to explain why. Operators see a dead-worker alert with zero diagnostic information. This is the sentinel that tells the user "restart your worker"; a silent failure at the sentinel level is particularly harmful.
- **Effort:** trivial
- **Suggested fix:** Replace `pass` with `logger.warning("worker_heartbeat_failed", exc_info=True)`. The job should not raise (arq would retry it unnecessarily), but it must log.

---

### F-O-06: `lifecycle.startup` swallows ComfyUI pool registration failures silently at WARNING, without the exception
- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/lifecycle.py:115-116`
- **Evidence:**
  ```python
  except Exception:
      logger.warning("comfyui_pool_register_failed", name=_srv.name)
  ```
- **Impact:** No `exc_info=True` — the operator sees which server name failed but not the actual error (e.g., SSL certificate, wrong URL scheme, auth error). If all servers fail to register, the pool is empty and the `scenes` step of the first episode will fail with "No ComfyUI servers registered in the pool." Debugging requires guessing from server name alone.
- **Effort:** trivial
- **Suggested fix:** Add `exc_info=True` to the `logger.warning` call so the traceback is captured.

---

### F-O-07: `_refine_visual_prompts` in the pipeline swallows per-scene LLM failures at DEBUG — invisible in production
- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/pipeline/_monolith.py:633-639`
- **Evidence:**
  ```python
  except Exception as exc:
      self.log.debug(
          "step_script.visual_prompt_refine_failed",
          scene=scene_data.get("scene_number"),
          error=str(exc)[:120],
      )
  ```
- **Impact:** Production logging is at INFO. If visual prompt refinement fails for every scene (e.g., LLM API key expired, quota exhausted), the episode proceeds with unrefined prompts and the operator sees nothing in production logs. The failure mode is subtle: output quality degrades silently. This applies to both the longform and shorts paths.
- **Effort:** trivial
- **Suggested fix:** Promote to `logger.warning` with a count of failed scenes, logged once after the loop completes (not per-scene, to avoid log spam). Retain per-scene detail at DEBUG.

---

### F-O-08: Multiple `audiobook._monolith.py` `except Exception: pass` blocks in image-path resolution have no logging
- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/audiobook/_monolith.py:1911-1917`
- **Evidence:**
  ```python
  try:
      resolved_cover = str(self.storage.resolve_path(cover_image_path))
  except Exception:
      pass
  if not resolved_cover and background_image_path:
      try:
          resolved_cover = str(self.storage.resolve_path(background_image_path))
      except Exception:
          pass
  ```
- **Impact:** If `resolve_path` raises (path traversal, missing file, storage misconfiguration), the cover image silently falls through to the title-card generator. The user gets an auto-generated card instead of their chosen cover art with no error message, no log line, no context. For a paid product this is a support blind spot.
- **Effort:** trivial
- **Suggested fix:** Replace each `pass` with `log.warning("audiobook.cover_resolve_failed", path=..., exc_info=True)`.

---

### F-O-09: `comfyui_pool_startup_failed` logged at DEBUG, not WARNING — hides complete pool startup failure
- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/lifecycle.py:117-118`
- **Evidence:**
  ```python
  except Exception:
      logger.debug("comfyui_pool_startup_failed", exc_info=True)
  ```
- **Impact:** If the entire ComfyUI pool registration block fails (e.g., DB unreachable at worker startup), this is logged at DEBUG. In production, only INFO+ is visible. The worker starts with an empty pool and the first episode that reaches the scenes step will fail with a runtime error — but startup appeared clean. The outer `except` masks the inner per-server `except` (F-O-06), making this a nested silence.
- **Effort:** trivial
- **Suggested fix:** Promote to `logger.warning` or `logger.error` since an empty pool at startup is operationally significant.

---

### F-O-10: `LLMPool` failover path logs provider failure at WARNING without `exc_info`
- **Severity:** LOW
- **Location:** `src/drevalis/services/llm/_monolith.py:339-343`
- **Evidence:**
  ```python
  logger.warning(
      "llm_pool_provider_failed",
      name=name,
      error=err_str[:100],
  )
  ```
- **Impact:** The error string is truncated to 100 chars. Long exceptions (e.g., full HTTP response bodies from OpenAI-compatible servers) are truncated without `exc_info`. Failover is transparent to callers — the only audit trail is this log line. Without the full traceback, diagnosing *why* a provider was marked failed requires log-level bumping and reproduction.
- **Effort:** trivial
- **Suggested fix:** Add `exc_info=True` to capture the full exception chain. Increase the inline `error=` truncation to 300 chars for the summary.

---

## Task 3 — `/api/v1/settings/health` Depth

### F-O-11: `/api/v1/settings/health` is substantive and does NOT just return True — but has a gap: no worker liveness
- **Severity:** LOW
- **Location:** `src/drevalis/api/routes/settings.py:400-451`
- **Evidence:** The endpoint concurrently checks:
  - PostgreSQL via `SELECT 1`
  - Redis via `PING`
  - Each active ComfyUI server via `GET /system_stats` (5 s timeout)
  - FFmpeg via subprocess `-version`
  - Piper TTS model directory (`.onnx` count)
  - LM Studio via `GET /models`
- **Impact:** This is a genuinely useful health check. The one notable gap is that worker liveness (`worker:heartbeat` Redis key) is checked by a *separate* endpoint (`/api/v1/jobs/worker/health`) rather than being aggregated here. A consumer that only calls `/settings/health` gets no signal that the generation worker is down. The overall status would show `ok` even with a dead worker.
- **Effort:** small
- **Suggested fix:** Include worker heartbeat age in the `system_health` response as an additional `ServiceHealth` component, reusing the logic from `/api/v1/jobs/worker/health`.

---

## Task 4 — Worker Heartbeat False-Positive Risk

### F-O-12: Heartbeat cron is a separate arq job — correctly decoupled from pipeline execution — but TTL math creates a 120 s dead-zone
- **Severity:** LOW
- **Location:** `src/drevalis/workers/settings.py:143`; `src/drevalis/workers/jobs/heartbeat.py:33-38`; `src/drevalis/api/routes/jobs/_monolith.py:640`
- **Evidence:**
  ```python
  cron(worker_heartbeat, minute=set(range(60)))  # every minute
  # heartbeat key TTL:
  await _r.set("worker:heartbeat", ..., ex=120)
  # health check threshold:
  return {"alive": age_seconds < 120, ...}
  ```
- **Impact:** The heartbeat is a cron job, not a thread inside the pipeline job. arq's cron jobs run as independent tasks and are not blocked by long-running pipeline jobs. A busy worker processing a 4-hour long-form episode will still fire `worker_heartbeat` every minute. **No false-positive risk from busy long jobs.**

  However, the TTL is 120 s and the cron fires every 60 s. If one heartbeat cron is delayed (e.g., arq is momentarily overloaded at `max_jobs=8`), the key can survive. The `/api/v1/jobs/worker/health` uses `age_seconds < 120` as the threshold (matches TTL), while CLAUDE.md documents "healthy if <90s old." The implementation uses 120 s, creating a 30 s discrepancy with the documented contract. If heartbeat delivery is delayed by >90 s but <120 s, the key still exists (not expired), age is between 90–120 s, and the API reports `alive: True` while CLAUDE.md says it should be `degraded`.

- **Effort:** trivial
- **Suggested fix:** Align the threshold constant in the health endpoint to match CLAUDE.md's documented 90 s value, or update CLAUDE.md to reflect the actual 120 s implementation. Add a `degraded` state for the 90–120 s window.

---

## Task 5 — `core/metrics.py` Consumption

### F-O-13: In-process `MetricsCollector` (`/api/v1/metrics/steps`, `/recent`, `/generations`) is worker-process-only; API process always returns zeros
- **Severity:** HIGH
- **Location:** `src/drevalis/core/metrics.py:155`; `src/drevalis/api/routes/metrics.py:50,70,86`
- **Evidence:**
  ```python
  # core/metrics.py
  metrics = MetricsCollector()  # singleton, in-process

  # pipeline/_monolith.py
  await metrics.record_step(...)  # called in arq worker process

  # routes/metrics.py
  return await metrics.get_step_stats()  # called in uvicorn process
  ```
- **Impact:** arq worker runs in a **separate process** from uvicorn (CLAUDE.md: "Worker = separate process w/ own DB engine + Redis pool"). The `metrics` singleton in the API process is never written to — only the worker process accumulates data via `record_step()` / `record_generation()`. The three in-process metric endpoints (`/steps`, `/generations`, `/recent`) will always return empty dicts / zero counts regardless of how many episodes have been generated.

  The `/events` and `/usage` endpoints avoid this by querying the `generation_jobs` Postgres table, and the frontend `/Logs` page calls only `metricsApi.events()` which maps to the DB-backed `/events` endpoint — so the visible UI is unaffected. However, `/steps`, `/recent`, and `/generations` endpoints are dead weight: they carry lock overhead on every call, accumulate no data, and return misleading empty responses. If operators ever curl these endpoints to diagnose pipeline performance they will conclude all steps have zero runs.

- **Effort:** medium
- **Suggested fix:** Either (a) remove the three in-process endpoints and document that `/events` and `/usage` are the authoritative sources, or (b) migrate `MetricsCollector` to write to Redis (pub/sub or a sorted set) so the API process can read what the worker writes. Option (a) is lower risk given `/usage` already provides richer DB-backed step duration data.

---

## Top 5 by ROI

| Rank | Finding | Why highest ROI |
|------|---------|-----------------|
| 1 | **F-O-13** — In-process metrics dead in API process | Highest deception risk: operators diagnose performance with `/steps` and see empty data, conclude no episodes ran. One-liner fix in `CLAUDE.md` costs nothing; removing the endpoints is a small PR. |
| 2 | **F-O-05** — `worker_heartbeat` silently swallows Redis failures | The sentinel that tells operators "worker is dead" itself dies silently. A one-line `logger.warning(..., exc_info=True)` is the highest-value single-line fix in the codebase. |
| 3 | **F-O-01** — Audiobook pipeline never binds `audiobook_id` to context-vars | Long audiobook jobs (hours) produce thousands of unattributed log lines. One `bind_contextvars` call at `generate()` entry fixes correlation for all downstream helpers. |
| 4 | **F-O-09** — Complete ComfyUI pool startup failure logged at DEBUG | Masks the most common first-run misconfiguration (wrong ComfyUI URL). Promoting to WARNING costs one character; saves hours of "why do scenes fail?" debugging. |
| 5 | **F-O-07** — Visual prompt refinement failures invisible in production | Silent quality degradation with no operator signal. Promoting the loop summary to WARNING is a two-line change with direct user-facing quality impact. |

---

## Don't Fix (Intentional)

- **`ComfyUIClient.clear_history` `except Exception: pass`** (`comfyui/_monolith.py:249-250`) — explicitly documented as best-effort cleanup. Logging would create noise for a non-fatal cleanup operation on a remote server.
- **`audiobook._broadcast_progress` `except Exception: pass`** (`audiobook/_monolith.py:684-685`) — Redis pub/sub delivery is documented as best-effort; a warning here would fire on every network blip and obscure the real audiobook errors.
- **Heartbeat false-positive concern for long jobs** — The cron-based heartbeat is correctly decoupled from job processing via arq's independent cron execution. A 4-hour LLM job does NOT block the heartbeat cron. This is working as designed.
- **`LongFormScriptService` implicit context-var inheritance** — Because `_step_script` binds `episode_id` before calling `LongFormScriptService.generate()`, and both run in the same asyncio task, context-vars propagate correctly. The explicit-parameter approach in F-O-03 is a robustness improvement, not a current bug.
- **`_QUIET_PATH_PREFIXES` for `/api/v1/metrics/*`** — Deliberate: the middleware suppresses INFO logs for metric polling to avoid log noise. This is correctly documented and intentional.

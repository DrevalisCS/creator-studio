# Backend Performance Audit — Drevalis Creator Studio

Audited: 2026-04-29  
Scope: `src/drevalis/` — services, repositories, routes, workers

---

## Findings

### F-PB-01: N+1 queries in `generate_episode` — per-step job lookup loop

- **Severity:** HIGH
- **Location:** `src/drevalis/api/routes/episodes/_monolith.py:461-472`
- **Evidence:**
  ```python
  for step in steps:                  # 6 iterations
      existing = await job_repo.get_latest_by_episode_and_step(episode_id, step)
      if existing and existing.status == "done":
          continue
  ```
- **Impact:** Every call to `POST /episodes/{id}/generate` fires 6 sequential `SELECT generation_jobs WHERE episode_id=? AND step=? ORDER BY created_at DESC LIMIT 1` queries. With `max_jobs=8` that is 48 DB round-trips per second at peak. On retries (where earlier steps are already done) all 6 queries run unconditionally, adding ~6 ms of pure latency to the enqueue path.
- **Effort:** small
- **Suggested fix:** Replace the loop with a single `SELECT * FROM generation_jobs WHERE episode_id=? AND status='done'` to get all completed steps in one query, then filter in Python.

---

### F-PB-02: N+1 Redis `GET` inside `SCAN` loop in `GET /jobs/tasks/active`

- **Severity:** HIGH
- **Location:** `src/drevalis/api/routes/jobs/_monolith.py:181-213`
- **Evidence:**
  ```python
  cursor, keys = await redis_client.scan(cursor, match="script_job:*:status", count=50)
  for key in keys:
      raw_val = await redis_client.get(key)          # 1 round-trip per key
      ...
      input_raw = await redis_client.get(f"script_job:{jid}:input")  # +1 per key
  ```
- **Impact:** This endpoint is polled by the Activity Monitor every 2–3 seconds. With `N` in-flight script/series jobs there are `2N` sequential Redis `GET` calls per poll. Each round-trip is ~0.1–0.5 ms locally but materialises as event-loop blocking time. Under load (8 concurrent jobs each spawning script generation), the poll handler stalls the event loop for measurable periods.
- **Effort:** small
- **Suggested fix:** Replace the `GET`-per-key pattern with `MGET` on the entire batch of matched keys (status keys first, then input keys) to collapse `2N` round-trips into 2 pipeline calls.

---

### F-PB-03: N+1 queries in `cleanup_stale_jobs` — per-job episode lookup

- **Severity:** HIGH
- **Location:** `src/drevalis/api/routes/jobs/_monolith.py:264-269`
- **Evidence:**
  ```python
  active_jobs = await job_repo.get_active_jobs(limit=1000)
  for job in active_jobs:
      ep = await ep_repo.get_by_id(job.episode_id)  # O(n) queries
  ```
- **Impact:** With up to 1000 active jobs returned, this fires 1000 individual `SELECT episodes WHERE id=?` queries in a serial loop. On a busy installation this endpoint (callable manually and by worker restart) can stall the DB connection pool for seconds. Identical pattern repeats in the `restart_worker` endpoint (`jobs/_monolith.py:673-681`), `cancel_all_jobs` (`jobs/_monolith.py:324-334`), and `pause_all` (`jobs/_monolith.py:456-463`).
- **Effort:** small
- **Suggested fix:** Batch-query all relevant episodes by ID set in a single `WHERE id IN (...)` statement and build a dict for O(1) lookup, identical to the fix already applied in `bulk_generate` (line 264) and `get_active_tasks` (line 133).

---

### F-PB-04: `_refine_visual_prompts` fires sequential LLM calls per scene with no parallelism

- **Severity:** HIGH
- **Location:** `src/drevalis/services/pipeline/_monolith.py:611-639`
- **Evidence:**
  ```python
  for scene_data in scenes:           # e.g. 50 scenes for longform
      ...
      result = await provider.generate(...)  # sequential LLM call
  ```
- **Impact:** A 50-scene long-form episode with `visual_prompt_template` set fires 50 sequential LLM calls before the script step can commit. At 1–3 s per LLM call that is 50–150 additional seconds added sequentially to the script step for every long-form episode. The LLMPool already supports parallel calls; the sequential loop wastes its round-robin and failover capabilities entirely.
- **Effort:** small
- **Suggested fix:** Wrap the per-scene calls in `asyncio.gather(*tasks, return_exceptions=True)` with per-scene error handling, exactly matching the existing `generate_scene_images` gather pattern.

---

### F-PB-05: `cancel:{episode_id}` Redis keys have a fixed 3600 s TTL but are never cleaned up on non-cancel paths

- **Severity:** MEDIUM
- **Location:** `src/drevalis/api/routes/jobs/_monolith.py:326, 457, 745`; `src/drevalis/api/routes/episodes/_monolith.py:1549`
- **Evidence:**
  ```python
  await redis.set(f"cancel:{episode.id}", "1", ex=3600)
  ```
  The pipeline only calls `_clear_cancel_flag()` when it detects and handles the flag. If the worker process crashes between flag creation and the pipeline's first `_check_cancelled()` call, the key persists for 3600 s. A regeneration attempt on the same episode within the hour will be silently aborted.
- **Impact:** Spurious cancellation of episode retries for up to one hour after a crash or emergency stop. The 3600 s TTL is defensive, but the lack of a cleanup step in the episode `generate` and `retry` enqueue handlers means stale flags can block otherwise-valid re-queues. Frequency: every orphan-reset cycle triggers this.
- **Effort:** trivial
- **Suggested fix:** In the `generate_episode` and `retry_episode` HTTP handlers, `DEL cancel:{episode_id}` immediately before enqueuing the new arq job — this is the authoritative "user intent is to generate" signal and should override any stale cancel flag.

---

### F-PB-06: `_MAX_SCENE_CONCURRENCY = 4` is a global constant, not derived from pool size

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/comfyui/_monolith.py:52, 954, 1229`
- **Evidence:**
  ```python
  _MAX_SCENE_CONCURRENCY: int = 4
  ...
  semaphore = asyncio.Semaphore(_MAX_SCENE_CONCURRENCY)
  ```
  The ComfyUI pool has per-server semaphores sized by `server.max_concurrent`. A second inner semaphore with hardcoded 4 is then layered on top in `generate_scene_images` and `generate_scene_videos`.
- **Impact:** With a single ComfyUI server at `max_concurrent=8`, the inner `_MAX_SCENE_CONCURRENCY=4` cap halves the utilisation. With two servers (`max_concurrent=4` each, pool capacity = 8), the same inner cap still halves throughput. The constant was reasonable as a safe default but was never wired to actual pool capacity. On a tuned multi-GPU setup this silently cuts scene throughput by 50 % or more.
- **Effort:** small
- **Suggested fix:** Pass the sum of all registered servers' `max_concurrent` values into `generate_scene_images` / `generate_scene_videos` at call time (it is already computed in `pipeline.py` when the pool is synced), and use that as the semaphore bound — falling back to 4 when no pool info is available.

---

### F-PB-07: `_resolve_reference_asset_paths` issues one DB query per asset ID in a loop

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/pipeline/_monolith.py:1213-1224`
- **Evidence:**
  ```python
  for raw_id in reference_asset_ids:
      ...
      asset = await asset_repo.get_by_id(asset_uuid)  # 1 SELECT per ID
  ```
  Called up to 5 times per scene step (episode refs, series refs, character lock, style lock, per-scene motion refs). With 10 ref IDs per call that is 10 sequential `SELECT assets WHERE id=?` queries.
- **Impact:** Adds latency proportional to `len(reference_asset_ids)` on the scene-generation hot path. Negligible for 1–2 refs; becomes 20–50 ms of serial DB I/O at 10 refs. The method is also called per-scene for motion references in video mode, compounding to `N_scenes * N_motion_refs` queries.
- **Effort:** trivial
- **Suggested fix:** Collect all IDs first, then execute a single `WHERE id IN (...)` query and build a dict; the existing per-ID loop becomes a dict lookup.

---

### F-PB-08: `worker:heartbeat` TTL is 120 s but the worker health check uses a 120 s threshold — edge case zero window

- **Severity:** LOW
- **Location:** `src/drevalis/workers/lifecycle.py:227-232`; `src/drevalis/api/routes/jobs/_monolith.py:640`
- **Evidence:**
  ```python
  # lifecycle.py
  await redis_client.set("worker:heartbeat", datetime.now(UTC).isoformat(), ex=120)
  # jobs/_monolith.py
  return {"alive": age_seconds < 120, ...}
  ```
  The TTL and the liveness threshold are both exactly 120 s. The heartbeat job fires every 60 s. In the worst case (heartbeat fires at t=0, TTL=120, next heartbeat at t=60), the key survives. But if a single cron beat is delayed by 60 s (e.g. worker is under load), the key can expire before the next write, leaving a window where the worker is alive but the API reports it dead.
- **Impact:** False "worker down" alert in the Activity Monitor for one poll interval. Cosmetic, but can cause user confusion and unnecessary restart attempts.
- **Effort:** trivial
- **Suggested fix:** Set the TTL to 180 s (3× the heartbeat interval) to give a 2-missed-beat buffer before the key expires, matching the `age_seconds < 120` liveness check that already allows one missed beat.

---

### F-PB-09: `job_timeout` in `WorkerSettings` is always `longform_job_timeout` (14400 s) for all jobs

- **Severity:** LOW
- **Location:** `src/drevalis/workers/settings.py:170`
- **Evidence:**
  ```python
  job_timeout = int(getattr(_settings_for_timeout, "longform_job_timeout", 14400))
  ```
  A single `job_timeout` applies to every arq job. Short jobs like `worker_heartbeat`, `publish_scheduled_posts`, `generate_seo_async` all share the 4-hour ceiling.
- **Impact:** A hung `publish_scheduled_posts` job (e.g. YouTube upload stall) will not be force-killed for 4 hours. arq's `max_tries=3` is irrelevant until the timeout fires. This blocks one of the 8 `max_jobs` slots for the full window. CLAUDE.md acknowledges that longform legitimately needs 4 h — but short jobs don't.
- **Effort:** medium (arq supports per-function timeout via `timeout` kwarg on the function, not on `WorkerSettings`)
- **Suggested fix:** Set `timeout=120` directly on `publish_scheduled_posts`, `worker_heartbeat`, `generate_seo_async`, and other sub-minute administrative jobs using arq's per-function decorator syntax, reserving the 14400 s global for pipeline jobs.

---

### F-PB-10: DB pool size math — 2 processes × 30 connections saturates asyncpg at peak

- **Severity:** LOW
- **Location:** `src/drevalis/core/config.py:27-28`; `src/drevalis/workers/lifecycle.py:46-47`
- **Evidence:**
  ```python
  # config.py (FastAPI)
  db_pool_size: int = 10
  db_max_overflow: int = 20   # max = 30 connections

  # lifecycle.py (worker — same values)
  pool_size=settings.db_pool_size,        # 10
  max_overflow=settings.db_max_overflow,  # 20
  ```
  Both the FastAPI server and the arq worker create independent SQLAlchemy connection pools using the same config. Combined max connections = 60. Postgres 16's default `max_connections=100` is fine, but under sustained load (8 concurrent pipeline jobs each holding a session + FastAPI handling 10 concurrent requests) the worker pool saturates: 8 jobs × 1 session each = 8 active connections, but each pipeline step internally calls repos that call `session.execute` concurrently, so the real peak is closer to 8 × N concurrent awaits within one session. The overflow connections are created and destroyed per burst — each `create` takes ~10 ms on localhost.
- **Impact:** Under peak load (8 longform jobs + 10 API requests) the combined pool may approach 40–50 connections. Not a crisis at defaults, but sizing `db_pool_size=5` for the worker (which uses sessions serially inside arq jobs) and keeping `db_pool_size=10` for the API would reduce idle connection overhead on the Postgres server side.
- **Effort:** trivial
- **Suggested fix:** Introduce a separate `worker_db_pool_size` config variable (default 5) for the arq worker, since worker jobs use sessions sequentially rather than the parallel access pattern the API pool is sized for.

---

### F-PB-11: Sync `zipfile.ZipFile` and `zf.write()` run on the event loop inside the export endpoint

- **Severity:** LOW
- **Location:** `src/drevalis/api/routes/episodes/_monolith.py:2349-2371`
- **Evidence:**
  ```python
  buffer = io.BytesIO()
  with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
      video_path = base / video_assets[-1].file_path
      if video_path.exists():
          zf.write(str(video_path), f"{safe_name}.mp4")  # blocking read + compress
  ```
  `zf.write()` reads the entire video file from disk and compresses it synchronously on the asyncio event loop. A 100 MB episode video at ZIP_DEFLATED will block the loop for multiple seconds.
- **Impact:** Single export request can stall all other FastAPI request handling for the duration of the compression. At default Uvicorn settings (1 worker process) this blocks every pending WebSocket progress update and API request during the export.
- **Effort:** small
- **Suggested fix:** Wrap the entire zip-building block in `await loop.run_in_executor(None, _build_zip, ...)` or switch to `ZIP_STORED` (no compression) since the video is already compressed H.264/H.265 — deflating an MP4 provides near-zero size reduction at high CPU cost.

---

### F-PB-12: `get_pending` in `ScheduledPostRepository` loads all pending posts without a `selectinload` for channel and episode FK navigation

- **Severity:** LOW
- **Location:** `src/drevalis/repositories/scheduled_post.py:20-27`; `src/drevalis/workers/jobs/scheduled.py:72-125`
- **Evidence:**
  ```python
  # repository — no selectinload
  stmt = select(ScheduledPost).where(...)
  # worker — then per-post:
  channel = await ch_repo.get_by_id(post.youtube_channel_id)    # +1 query
  episode = await ep_repo.get_by_id(post.content_id)             # +1 query
  series = await SeriesRepository(session).get_by_id(episode.series_id)  # +1 query
  channel = await ch_repo.get_by_id(series.youtube_channel_id)  # +1 query
  ```
  For `N` pending posts the job fires up to `4N` additional queries in the per-post loop, all within the same session.
- **Impact:** With 20 posts due at the same 5-minute window (bulk scheduling), the cron job fires up to 80 additional serial queries before the first upload even begins. The actual YouTube upload is the bottleneck in practice, but this adds measurable startup latency to the cron job and holds the DB session open longer.
- **Effort:** small
- **Suggested fix:** Add `selectinload(ScheduledPost.episode).selectinload(Episode.series).selectinload(Series.youtube_channel)` and `selectinload(ScheduledPost.youtube_channel)` to `get_pending`, eliminating the per-post DB lookups inside the cron handler.

---

## Top 5 by ROI

| # | Finding | Severity | Effort | Why it ranks here |
|---|---------|----------|--------|-------------------|
| 1 | **F-PB-04** — Serial LLM calls in `_refine_visual_prompts` | HIGH | small | Adds 50–150 s of dead time per long-form episode; `asyncio.gather` drop-in available |
| 2 | **F-PB-01** — N+1 step-job queries in `generate_episode` | HIGH | small | Fires on every generate/retry; 6 queries collapse to 1 with a trivial bulk query |
| 3 | **F-PB-02** — N+1 Redis GETs in `GET /jobs/tasks/active` | HIGH | small | Polled every 2–3 s by Activity Monitor; `MGET` collapses `2N` calls to 2 |
| 4 | **F-PB-05** — Stale `cancel:{id}` flags survive crashes | MEDIUM | trivial | Causes silent generation failures for an hour after any crash; one-line `DEL` on enqueue |
| 5 | **F-PB-06** — Hardcoded `_MAX_SCENE_CONCURRENCY=4` ignores pool capacity | MEDIUM | small | Silently halves GPU throughput on any multi-server or high-concurrency ComfyUI config |

---

## Don't fix (intentional)

**`longform_job_timeout = 14400 s`** — CLAUDE.md explicitly documents that long-form jobs on slow GPUs run for hours. This is not a misconfiguration; it reflects the real hardware ceiling. See F-PB-09 for the narrower fix (per-function timeouts for short jobs only).

**Round-robin instead of least-loaded in `ComfyUIPool`** — The CLAUDE.md ADR notes explicitly that least-loaded was tried and reverted because `asyncio.gather` makes queue-depth measurements stale by the time a lock is acquired. Round-robin is the correct call here.

**`expire_on_commit=False` on the SQLAlchemy session factory** — This is the documented asyncio-safe pattern for SQLAlchemy 2.x. The alternative (`expire_on_commit=True`) triggers lazy-load attempts on already-closed connections.

**`DB_POOL_SIZE=10` / `DB_MAX_OVERFLOW=20`** — The absolute values are reasonable for a local-first single-tenant install. F-PB-10 flags the worker-vs-API sizing opportunity, not the defaults themselves.

**`shutil.rmtree` via `run_in_executor` in `delete_episode_dir`** — Correctly offloaded to the thread pool; not a blocking issue.

**Sync `piper` CLI subprocess via `asyncio.create_subprocess_exec`** — Already fully async (subprocess + communicate). Not a blocking I/O issue.

**`faster-whisper` called via `asyncio.to_thread`** — CPU-bound transcription correctly wrapped. The thread pool prevents event-loop blocking.

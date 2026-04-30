# Database Audit — Drevalis Creator Studio

**Date:** 2026-04-29  
**Auditor:** Database Specialist agent (claude-sonnet-4-6)  
**Stack:** PostgreSQL 16, asyncpg + SQLAlchemy 2.x async, Alembic  
**Scope:** Read-only. No model, migration, or query code was modified.

---

## 1. Top 5 Query Patterns

### 1.1 Episode List (`GET /api/v1/episodes`)

**Location:** `src/drevalis/repositories/episode.py:28-40` (via `get_by_series`) and `:186-187` route fallback via `get_all`.

```python
# get_by_series — called when series_id is provided
stmt = (
    select(Episode)
    .where(Episode.series_id == series_id)   # <-- predicate 1
    .order_by(Episode.created_at.desc())
    .offset(offset)
    .limit(limit)
)
if status_filter is not None:
    stmt = stmt.where(Episode.status == status_filter)  # <-- predicate 2
```

**Index used:** `ix_episodes_series_id_status` `(series_id, status)` — covers the two-predicate form. Single-predicate form (`series_id` only) uses the same index with a partial scan on the leading column; efficient.  
When no `series_id` is given the route falls back to `BaseRepository.get_all`, which is a full-table scan ordered by `created_at` with no index on `episodes.created_at`. At scale (thousands of episodes) this degrades to an `ORDER BY` sort on every call.  
**Gap:** No index on `episodes.created_at` for the full-table `ORDER BY created_at DESC` path.

---

### 1.2 Recent Episodes (`GET /api/v1/episodes/recent`)

**Location:** `src/drevalis/repositories/episode.py:59-68`

```python
stmt = (
    select(Episode)
    .options(selectinload(Episode.series))
    .order_by(Episode.created_at.desc())
    .limit(limit)
)
```

**Index used:** None. PostgreSQL will perform a sequential scan + sort on the entire `episodes` table, then truncate at `limit`. With no index on `created_at`, the planner must materialise all rows to find the top N. This is the hottest read path on the Dashboard, polled by the frontend.  
**Gap:** Missing index on `episodes.created_at`.

---

### 1.3 Active Jobs (`GET /api/v1/jobs/active`)

**Location:** `src/drevalis/repositories/generation_job.py:34-43`

```python
stmt = (
    select(GenerationJob)
    .where(GenerationJob.status.in_(("queued", "running")))
    .order_by(GenerationJob.created_at)
    .limit(limit)
)
```

**Index used:** `ix_generation_jobs_status` `(status)` — satisfies the `IN` predicate. With low cardinality (status has 4 values), the index is effective. The Activity Monitor calls this endpoint with `limit=200` every 2–3 seconds while jobs are active.  
**Note:** The `cleanup_stale_jobs` endpoint calls `get_active_jobs(limit=1000)` and then issues one `get_by_id` per job row in a Python loop (lines 264–270 of `jobs/_monolith.py`). This is an N+1 pattern — up to 1 000 additional PK lookups in sequence. The cleanup endpoint is not on a hot path but is still worth flagging.

---

### 1.4 Scheduled Posts Due (`publish_scheduled_posts` cron)

**Location:** `src/drevalis/repositories/scheduled_post.py:20-27`

```python
stmt = (
    select(ScheduledPost)
    .where(ScheduledPost.status == "scheduled",
           ScheduledPost.scheduled_at <= before)
    .order_by(ScheduledPost.scheduled_at)
)
```

**Index used:** `ix_scheduled_posts_status_scheduled_at` `(status, scheduled_at)` — added in migration 013. The composite index is column-order-correct for this query (equality on `status` first, range on `scheduled_at` second). Plan should be an index range scan. This is well-covered.

---

### 1.5 Generation Jobs by `episode_id` + `step` (`get_latest_by_episode_and_step`)

**Location:** `src/drevalis/repositories/generation_job.py:101-117`

```python
stmt = (
    select(GenerationJob)
    .where(
        GenerationJob.episode_id == episode_id,
        GenerationJob.step == step,
    )
    .order_by(GenerationJob.created_at.desc())
    .limit(1)
)
```

**Index used:** The migration-018 index `ix_generation_jobs_episode_id_step` `(episode_id, step)` exists in the DB (created via `op.create_index` in migration 018) but is **absent from the ORM model's `__table_args__`**. Autogenerate therefore treats this index as an "extra" on the DB side and would emit `DROP INDEX` in a fresh `alembic revision --autogenerate`. The index itself works in production but the ORM is out of sync.  
**Secondary gap:** `series.youtube_channel_id` — the same migration 018 adds `ix_series_youtube_channel_id` for the `publish_scheduled_posts` cron path; this index is also missing from the `Series` model's `__table_args__`.

---

## 2. Index Audit

### Table: `episodes`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `series_id` | Yes — `ix_episodes_series_id_status (series_id, status)` | `episode.py:39` |
| `status` | Yes — `ix_episodes_status (status)` and leading column of composite | `episode.py:39-40` |
| `created_at` | **No** | Not in `__table_args__`, not in any migration |
| `content_format` | **No** | Not indexed; raw SQL in `workers/jobs/episode.py:93` JOINs on `s.content_format` |

### Table: `generation_jobs`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `episode_id` | Yes — `ix_generation_jobs_episode_id` | `generation_job.py:37` |
| `status` | Yes — `ix_generation_jobs_status` | `generation_job.py:38` |
| `(episode_id, step)` | **DB only** — missing from ORM model | Migration 018; absent in `generation_job.py:28-39` |

### Table: `media_assets`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `episode_id` | Yes — `ix_media_assets_episode_id` | `media_asset.py:47` |
| `(episode_id, asset_type)` | Yes — `ix_media_assets_episode_id_asset_type` | `media_asset.py:48` |
| `scene_number` | **No** — only composite with `episode_id` would help | Query at `media_asset.py:77-86` filters on `episode_id AND scene_number`; the existing `ix_media_assets_episode_id` covers `episode_id` but cannot narrow by `scene_number` |

### Table: `scheduled_posts`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `status` | Yes — `ix_scheduled_posts_status` | `scheduled_post.py:36` |
| `scheduled_at` | Yes — `ix_scheduled_posts_scheduled_at` | `scheduled_post.py:37` |
| `(status, scheduled_at)` | Yes — `ix_scheduled_posts_status_scheduled_at` | `scheduled_post.py:38` |
| `youtube_channel_id` | **No** | FK column, not in `__table_args__` |

### Table: `youtube_uploads`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `episode_id` | Yes — `ix_youtube_uploads_episode_id` | `youtube_channel.py:79` |
| `channel_id` | Yes — `ix_youtube_uploads_channel_id` | `youtube_channel.py:80` |

### Table: `series`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `youtube_channel_id` | **DB only** — missing from ORM model | Migration 018 creates `ix_series_youtube_channel_id`; `Series.__table_args__` only has `CheckConstraint` (`series.py:43-48`) |

### Table: `audiobooks`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `status` | **No** | `AudiobookRepository.get_by_status` queries `WHERE status = ?`; no index in `audiobook.py.__table_args__` |
| `voice_profile_id` | **No** | FK, unindexed |
| `youtube_channel_id` | **No** | FK, unindexed |

### Table: `social_uploads`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `platform_id` | Yes — `ix_social_uploads_platform_id` | `social_platform.py:92` |
| `episode_id` | Yes — `ix_social_uploads_episode_id` | `social_platform.py:93` |
| `content_type` | Yes — `ix_social_uploads_content_type` | `social_platform.py:94` |

### Table: `video_edit_sessions`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `episode_id` | Implicitly via `unique=True` on the column, which creates an index | `video_edit_session.py:25` — `unique=True` on the FK column creates a unique index; adequate for PK lookups by episode |

### Table: `ab_tests`

| Column | Indexed? | Evidence |
|--------|----------|---------|
| `series_id` | Yes — `ix_ab_tests_series_id_q` | `ab_test.py:38` |
| `episode_a_id`, `episode_b_id` | **No** | FK columns, unindexed; low-traffic table |

### Tables with no `__table_args__` indexes (FK columns unindexed)

- `llm_configs` — no FKs, low-volume config table; acceptable.
- `comfyui_servers` — no FKs, low-volume; acceptable.
- `comfyui_workflows` — no FKs; acceptable.
- `voice_profiles` — no FKs; acceptable.
- `prompt_templates` — no FKs; acceptable.
- `api_key_store` — unique constraint on `key_name` via `unique=True` (creates implicit index); acceptable.
- `video_templates` — FK to `voice_profiles.id` (`ondelete="SET NULL"`) but unindexed; table is small, low-traffic.
- `character_packs` — no FK constraints; acceptable.
- `license_state` — assumed small config table; not reviewed.

---

## 3. Alembic Drift Check

`alembic check` could not connect to the database (PostgreSQL not running on this machine — `ConnectionRefusedError: [WinError 1225]`). Drift was assessed statically by comparing migration files against ORM model `__table_args__`.

**Confirmed drift (static analysis):**

1. **`ix_generation_jobs_episode_id_step`** — created in migration 018 (`migrations/versions/018_generation_jobs_composite_index.py:33-37`) but absent from `GenerationJob.__table_args__`. Alembic autogenerate would see this as an extra DB index and emit `DROP INDEX`.

2. **`ix_series_youtube_channel_id`** — created in migration 018 (`migrations/versions/018_generation_jobs_composite_index.py:38-43`) but absent from `Series.__table_args__`. Same autogenerate risk.

3. **`media_assets.asset_type` CHECK constraint** — migration 001 allows `('voiceover', 'scene', 'caption', 'video', 'thumbnail', 'temp')`; the ORM model adds `'scene_video'` to the allowed list (`media_asset.py:44`). The DB constraint is narrower than the model allows, meaning any insert of `asset_type='scene_video'` will fail with a check-constraint violation on a database that has only run through migration 001 without a corrective migration for this value.

---

## 4. JSONB Filter Audit

No query in `src/drevalis/repositories/` or `src/drevalis/api/routes/` uses PostgreSQL JSONB operators (`->>`, `@>`, `jsonb_path_query`, etc.) to filter rows. All JSONB access is post-load in Python (e.g., `EpisodeScript.model_validate(episode.script)`). The `workers/jobs/episode.py` raw SQL joins on `series.content_format` (a plain `TEXT` column, not JSONB).

The `comfyui_workflows.input_mappings` and `episodes.script`/`chapters` columns are JSONB but are never filtered at the DB level. **No GIN index is needed at present.** If future features add server-side JSONB filtering (e.g., finding episodes whose chapters contain a specific mood), a GIN index on `episodes.chapters` and/or `episodes.script` would be required at that time.

---

## 5. Cascade Rule Verification

### Episode → media_assets (CASCADE delete)

**CLAUDE.md claim:** Episode delete CASCADE → `media_assets`, `generation_jobs`

**Model evidence:**
- `media_assets.episode_id`: `ForeignKey("episodes.id", ondelete="CASCADE")` — `media_asset.py:53-54`. ORM: `cascade="all, delete-orphan"` on `Episode.media_assets` — `episode.py:115-118`. **Verified correct.**
- `generation_jobs.episode_id`: `ForeignKey("episodes.id", ondelete="CASCADE")` — `generation_job.py:43-45`. ORM: `cascade="all, delete-orphan"` on `Episode.generation_jobs` — `episode.py:119-122`. **Verified correct.**

### YouTubeUpload → episodes (CASCADE) + youtube_channels (CASCADE)

**CLAUDE.md claim:** YouTubeUpload → episodes (CASCADE) + youtube_channels (CASCADE)

**Model evidence (`youtube_channel.py:83-92`):**
- `youtube_uploads.episode_id`: `ForeignKey("episodes.id", ondelete="CASCADE")` — **Verified correct.**
- `youtube_uploads.channel_id`: `ForeignKey("youtube_channels.id", ondelete="CASCADE")` — **Verified correct.**
- `YouTubeChannel.uploads` relationship: `cascade="all, delete-orphan"` — `youtube_channel.py:49-52`. **Verified correct.**

### Series → youtube_channels (nullable FK)

**CLAUDE.md claim:** Series → youtube_channels (nullable FK)

**Model evidence (`series.py:155-159`):**
```python
youtube_channel_id: Mapped[uuid.UUID | None] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("youtube_channels.id", ondelete="SET NULL"),
    nullable=True,
)
```
**Verified correct.** `ondelete="SET NULL"` means deleting a YouTube channel nullifies `series.youtube_channel_id`, not cascades. This is the intended behaviour.

### Audiobook → voice_profiles (SET NULL)

**CLAUDE.md claim:** Audiobook → voice_profiles (SET NULL)

**Model evidence (`audiobook.py:37-41`):**
```python
voice_profile_id: Mapped[uuid.UUID | None] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("voice_profiles.id", ondelete="SET NULL"),
    nullable=True,
)
```
**Verified correct.**

---

## Findings

### F-DB-01: Missing `episodes.created_at` index — full-table sort on every Dashboard load

- **Severity:** HIGH
- **Location:** `src/drevalis/models/episode.py:34-41`, `src/drevalis/repositories/episode.py:59-68` (`get_recent`), `src/drevalis/repositories/base.py:37-49` (`get_all`)
- **Evidence:**
  ```python
  # get_recent — called by GET /api/v1/episodes/recent (Dashboard)
  stmt = select(Episode).options(...).order_by(Episode.created_at.desc()).limit(limit)
  # get_all — called by GET /api/v1/episodes when no filters provided
  stmt = select(self.model).order_by(self.model.created_at.desc()).offset(offset).limit(limit)
  ```
- **Impact:** PostgreSQL performs a sequential scan + in-memory sort of the entire `episodes` table on every Dashboard load and every unfiltered episode list call. As the episode count grows (hundreds of series × dozens of episodes each), this query becomes the dominant DB cost. The frontend `EpisodesList` page fetches `limit=500` for accurate totals.
- **Effort:** trivial
- **Suggested fix:** Add `Index("ix_episodes_created_at", "created_at")` to `Episode.__table_args__` and create a corresponding migration using `CREATE INDEX CONCURRENTLY`.

---

### F-DB-02: `ix_generation_jobs_episode_id_step` and `ix_series_youtube_channel_id` exist in DB but not in ORM model — autogenerate drift

- **Severity:** HIGH
- **Location:** `src/drevalis/models/generation_job.py:28-39`, `src/drevalis/models/series.py:43-48`, `migrations/versions/018_generation_jobs_composite_index.py:29-43`
- **Evidence:**
  ```python
  # generation_job.py __table_args__ — only these two indexes declared:
  Index("ix_generation_jobs_episode_id", "episode_id"),
  Index("ix_generation_jobs_status", "status"),
  # ix_generation_jobs_episode_id_step is absent
  
  # series.py __table_args__ — only this constraint declared:
  CheckConstraint("target_duration_seconds IN (15, 30, 60)", name="target_duration_valid")
  # ix_series_youtube_channel_id is absent
  ```
- **Impact:** Running `alembic revision --autogenerate` will detect these two indexes as database-side extras and emit `DROP INDEX` statements in the generated migration. If that migration is applied, both indexes are silently removed. The `ix_generation_jobs_episode_id_step` index is critical for `get_latest_by_episode_and_step`, which is called six times per pipeline run. Losing it causes a sort on every step-resume check.
- **Effort:** trivial
- **Suggested fix:** Add both missing `Index(...)` declarations to the respective `__table_args__` tuples in the ORM models. No new migration needed — the indexes already exist in the DB.

---

### F-DB-03: `media_assets.asset_type` CHECK constraint is narrower than ORM model

- **Severity:** HIGH
- **Location:** `migrations/versions/001_initial_schema.py:330-333`, `src/drevalis/models/media_asset.py:43-46`
- **Evidence:**
  ```python
  # migration 001 (DB constraint):
  "asset_type IN ('voiceover', 'scene', 'caption', 'video', 'thumbnail', 'temp')"

  # ORM model (application expectation):
  "asset_type IN ('voiceover', 'scene', 'scene_video', 'caption', 'video', 'thumbnail', 'temp')"
  ```
- **Impact:** Any `INSERT` or `UPDATE` with `asset_type='scene_video'` fails with a PostgreSQL `CheckViolationError` on databases that have never had the constraint updated. If a migration correcting this was added but not captured, this is a silent rollback risk for any new install. If no such migration exists, scene-video-generating pipelines are blocked at the DB level on a clean install.
- **Effort:** small
- **Suggested fix:** Add a new migration that `ALTER TABLE media_assets DROP CONSTRAINT ck_media_assets_asset_type_valid` and recreates it with `'scene_video'` included. Use `IF EXISTS` guards consistent with the codebase `_helpers` pattern.

---

### F-DB-04: `audiobooks` table has no index on `status` — sequential scan on every task-monitor poll

- **Severity:** MEDIUM
- **Location:** `src/drevalis/models/audiobook.py:23-27`, `src/drevalis/repositories/audiobook.py:19-27`
- **Evidence:**
  ```python
  # AudiobookRepository.get_by_status — called by /jobs/tasks/active every 2-3s
  stmt = (
      select(Audiobook)
      .where(Audiobook.status == status)   # no index on status
      .order_by(Audiobook.created_at.desc())
  )
  ```
  `Audiobook.__table_args__` contains only `CheckConstraint` entries; no `Index` is declared.
- **Impact:** The Activity Monitor polls `GET /api/v1/jobs/tasks/active` every 2–3 seconds. That endpoint calls `get_by_status("generating")`, which is a full-table scan on `audiobooks`. Low row count today, but cost grows linearly. Also, `created_at` is not indexed on this table, compounding the sort cost.
- **Effort:** trivial
- **Suggested fix:** Add `Index("ix_audiobooks_status", "status")` to `Audiobook.__table_args__` and create it with `CONCURRENTLY` in a new migration.

---

### F-DB-05: `media_assets` lacks `(episode_id, scene_number)` composite index — scene-level operations scan all episode assets

- **Severity:** MEDIUM
- **Location:** `src/drevalis/models/media_asset.py:42-49`, `src/drevalis/repositories/media_asset.py:71-107`
- **Evidence:**
  ```python
  # get_by_episode_and_scene / delete_by_episode_and_scene
  .where(
      MediaAsset.episode_id == episode_id,
      MediaAsset.scene_number == scene_number,
  )
  ```
  Existing index `ix_media_assets_episode_id_asset_type` `(episode_id, asset_type)` does not help when filtering by `scene_number`. The query falls back to scanning all rows for the episode (potentially dozens for long-form episodes) and discarding non-matching scene numbers.
- **Impact:** `regenerate-scene`, `DELETE /{episode_id}/scenes/{scene_number}`, and inpaint flows all call these queries. Long-form episodes with many scenes amplify the waste. Not critical at current scale but grows O(scenes_per_episode).
- **Effort:** trivial
- **Suggested fix:** Add `Index("ix_media_assets_episode_id_scene_number", "episode_id", "scene_number")` to `MediaAsset.__table_args__` and create it with `CONCURRENTLY` in a new migration.

---

### F-DB-06: `cleanup_stale_jobs` endpoint issues N+1 DB queries — up to 1 000 sequential PK lookups

- **Severity:** MEDIUM
- **Location:** `src/drevalis/api/routes/jobs/_monolith.py:264-270`
- **Evidence:**
  ```python
  active_jobs = await job_repo.get_active_jobs(limit=1000)
  for job in active_jobs:
      ep = await ep_repo.get_by_id(job.episode_id)   # one DB round-trip per job
      if ep is None or ep.status != "generating":
          await job_repo.update_status(...)
  ```
- **Impact:** If 1 000 stale jobs exist (e.g., after a crash), this endpoint issues 1 001 sequential queries. Each `get_by_id` is a separate PK lookup. The endpoint is not on a hot path (triggered manually or at startup), but a single crash recovery run could take seconds and hold a session open for the duration.
- **Effort:** small
- **Suggested fix:** Replace the per-row `get_by_id` loop with a single bulk `SELECT id, status FROM episodes WHERE id = ANY(:ids)` and compare in-memory. No schema change required.

---

### F-DB-07: `scheduled_posts.youtube_channel_id` FK is unindexed

- **Severity:** LOW
- **Location:** `src/drevalis/models/scheduled_post.py:56-60`
- **Evidence:**
  ```python
  youtube_channel_id: Mapped[uuid.UUID | None] = mapped_column(
      UUID(as_uuid=True),
      ForeignKey("youtube_channels.id", ondelete="SET NULL"),
      nullable=True,
  )
  ```
  `ScheduledPost.__table_args__` has no index on `youtube_channel_id`.
- **Impact:** Deleting a `YouTubeChannel` triggers a `SET NULL` on all matching `scheduled_posts.youtube_channel_id` rows. Without an index, PostgreSQL performs a sequential scan of the `scheduled_posts` table on every channel deletion. Low table volume in practice, but incorrect as a design principle.
- **Effort:** trivial
- **Suggested fix:** Add `Index("ix_scheduled_posts_youtube_channel_id", "youtube_channel_id")` to `ScheduledPost.__table_args__` and a corresponding `CONCURRENTLY` migration.

---

### F-DB-08: `series.content_format` unindexed — raw SQL JOIN uses it as a filter in priority-deferral logic

- **Severity:** LOW
- **Location:** `src/drevalis/workers/jobs/episode.py:90-104`, `src/drevalis/models/series.py`
- **Evidence:**
  ```sql
  SELECT COUNT(*) FROM episodes e JOIN series s ON e.series_id = s.id
  WHERE e.status = 'generating' AND s.content_format = :fmt
  ```
  `series.content_format` has no index; the JOIN condition requires scanning `series` for a matching column value.
- **Impact:** The priority-deferral check runs on every `generate_episode` job start when `shorts_first` or `longform_first` priority is active. With a large number of series rows this scan adds latency to job dispatch. Currently low risk because series counts are small, but the pattern should be documented.
- **Effort:** trivial
- **Suggested fix:** Add `Index("ix_series_content_format", "content_format")` to `Series.__table_args__` and a corresponding migration. The existing `ix_episodes_series_id_status` already covers the `episodes` side of the JOIN.

---

### F-DB-09: `ScheduledPost.content_id` has no FK constraint — referential integrity not enforced at DB level

- **Severity:** LOW
- **Location:** `src/drevalis/models/scheduled_post.py:42`
- **Evidence:**
  ```python
  content_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  # No ForeignKey(...) — polymorphic reference to either episodes.id or audiobooks.id
  ```
- **Impact:** Deleting an episode or audiobook does not automatically clean up its `scheduled_posts` rows. The application must handle this manually. Stale `scheduled_posts` rows can accumulate and the cron job will attempt to publish them, fail, and retry. Currently the cron only fails gracefully after 3 retries, so integrity errors are absorbed, but data rot accumulates silently.
- **Effort:** medium (polymorphic FK is architecturally complex; alternatives are a trigger or application-layer cleanup)
- **Suggested fix:** Add an explicit cleanup step in the episode and audiobook delete paths to `DELETE FROM scheduled_posts WHERE content_type = 'episode' AND content_id = :id` (and the audiobook equivalent). No schema change required; this is a service-layer gap.

---

### F-DB-10: `VideoEditSession.episode_id` unique constraint creates implicit index — adequate but undocumented

- **Severity:** NIT
- **Location:** `src/drevalis/models/video_edit_session.py:22-26`
- **Evidence:**
  ```python
  episode_id: Mapped[uuid.UUID] = mapped_column(
      UUID(as_uuid=True),
      ForeignKey("episodes.id", ondelete="CASCADE"),
      nullable=False,
      unique=True,         # <-- creates a unique B-tree index implicitly
  )
  ```
- **Impact:** The implicit unique index serves the lookup-by-episode-id query pattern, so there is no functional gap. However, using `unique=True` on the column rather than an explicit `UniqueConstraint` in `__table_args__` bypasses the project's naming convention (`uq_%(table_name)s_%(column_0_name)s`). The generated constraint name is database-dialect-specific and may differ from what Alembic autogenerate expects, causing spurious migration noise.
- **Effort:** trivial
- **Suggested fix:** Move the constraint to `__table_args__` as `UniqueConstraint("episode_id", name="uq_video_edit_sessions_episode_id")` and remove `unique=True` from the column definition.

---

## Top 5 by ROI

These five findings deliver the highest query-performance or data-integrity improvement per unit of migration effort:

1. **F-DB-03** — `media_assets.asset_type` CHECK constraint mismatch. This is a **correctness bug** that silently blocks `scene_video` inserts on any install that ran only the original migration. Fix before the next release.

2. **F-DB-02** — ORM model drift on `ix_generation_jobs_episode_id_step` and `ix_series_youtube_channel_id`. An accidental `alembic revision --autogenerate` will silently drop both performance-critical indexes. Add the missing `Index()` declarations to the models immediately — zero migration required.

3. **F-DB-01** — Missing `episodes.created_at` index. The Dashboard `get_recent` query and the unfiltered `get_all` query both sort the entire `episodes` table on every call. This is the highest-traffic read path in the application.

4. **F-DB-04** — Missing `audiobooks.status` index. The Activity Monitor polls `get_by_status("generating")` every 2–3 seconds. A trivial one-line model change + `CREATE INDEX CONCURRENTLY` migration eliminates a recurring full-table scan.

5. **F-DB-05** — Missing `(episode_id, scene_number)` composite index on `media_assets`. Scene-level regeneration and deletion scan all assets for an episode then filter in memory. With long-form episodes having 40+ scenes this grows linearly.

---

## Don't Fix (Intentional)

- **No JSONB GIN indexes on `episodes.script` or `episodes.chapters`** — All JSONB access is post-load in Python. There are zero server-side JSONB filter queries. Adding GIN indexes would cost write overhead with zero query benefit at current access patterns.

- **`ScheduledPost.content_id` has no FK** — This is an intentional polymorphic design choice (the column refers to either an episode or an audiobook depending on `content_type`). PostgreSQL cannot express a polymorphic FK natively. The tradeoff (no DB-enforced referential integrity) is accepted in exchange for a simpler schema without a junction table.

- **`ab_tests.episode_a_id` / `episode_b_id` unindexed** — The A/B test table is populated by explicit creator action (not a cron or hot path). Queries on it filter by `series_id` (indexed) or load by PK. Adding FK indexes would cost write overhead for a table with negligible read load.

- **`Series` FK columns (`voice_profile_id`, `comfyui_server_id`, etc.) unindexed** — These are config FKs that only receive `SET NULL` cascade on deletion of rare config rows. With a handful of series in practice, sequential scan cost is immeasurable.

- **`BaseRepository.get_all` sort on `created_at` without index** — For all config tables (voice_profiles, llm_configs, comfyui_servers, etc.) the row count is in the single digits. Full-table sort is cheaper than index overhead at that scale. Only `episodes` and `audiobooks` cross the threshold where the index matters (tracked in F-DB-01 and F-DB-04).

- **`alembic check` could not connect** — This is a dev-environment limitation (Postgres not running locally). The static drift analysis in section 3 is a reliable substitute for the findings captured.

# Audit Summary — Drevalis Creator Studio

**Branch:** `audit/2026-04-29`
**Date:** 2026-04-29
**Phase:** 1 (read-only). No code changes have been made.

Each finding lives in the per-area file under `audit/`. This summary aggregates only.

---

## Severity counts (rough)

| Area | CRIT | HIGH | MED | LOW | NIT | File |
|------|-----:|-----:|----:|----:|----:|------|
| Security | 0 | 3 | 5 | 8 | 1 | `security.md` |
| Backend perf | 0 | 1 | 5 | 5 | 1 | `perf-backend.md` |
| Frontend perf+UX | 0 | 0 | ~6 | ~6 | 0 | `perf-frontend.md` |
| Code quality | 0 | 3 | 6 | 5 | 1 | `code-quality.md` |
| Type safety | 0 | 3 | ~5 | ~10 | many | `types.md` |
| Tests | 1 | 4 | 5 | 1 | 1 | `tests.md` |
| Database | 0 | 3 | 3 | 3 | 1 | `database.md` |
| Dependencies | 0 | 3 | 4 | ~5 | 0 | `deps.md` |
| Operational | 0 | 2 | 5 | 6 | 0 | `ops.md` |
| Docs drift | 0 | 0 | 1 | 8 | 2 | `docs-drift.md` |
| Architecture | 0 | 2 | 2 | 3 | 0 | `architecture.md` |

(CRITICAL = correctness or trust-boundary breaks today; HIGH = real production risk or data-loss / DB-level correctness; MED = degradation, leak, or future-pain; LOW = cleanup; NIT = bikeshed.)

---

## Top 10 across the whole codebase

Ranked by severity × inverse effort × blast radius.

1. **F-DB-03 — `media_assets.asset_type` CHECK constraint narrower than ORM** (HIGH, trivial). On a clean Postgres install, INSERTs of `scene_video` asset rows fail at the DB. The ORM accepts more values than the migration allows. Block-the-release class bug.

2. **F-S-05 — Backup tar extraction lacks `filter='data'`** (HIGH, trivial). `services/backup.py:415-423`. Symlink/special-file escape during restore; Bandit B202 confirms. One-line fix (`tar.extractall(dst, filter='data')`).

3. **F-S-01 — `cryptography 46.0.5` carries CVE-2026-34073 + CVE-2026-39892** (HIGH, trivial). Bump pin to `>=46.0.7`. The package underpins Fernet, Ed25519 license JWT, OAuth token encryption — entire trust boundary.

4. **F-Tst-01 — Integration fixture broken (`ARRAY` column has no SQLite shim)** (HIGH, trivial). All 21 integration tests error at setup; they have not actually run. One `@compiles(ARRAY, "sqlite")` adapter unblocks the entire suite.

5. **F-DB-02 — Two indexes exist in DB but not in ORM models** (HIGH, trivial). `ix_generation_jobs_episode_id_step` and `ix_series_youtube_channel_id` are present in migrations but absent from `__table_args__`. Next `alembic revision --autogenerate` would emit `DROP INDEX` for them.

6. **F-DB-01 — `episodes.created_at` has no index** (HIGH, trivial). Dashboard's `get_recent` does ORDER BY created_at DESC LIMIT n on a full table scan, every render.

7. **F-PB-04 — Serial LLM calls in `_refine_visual_prompts`** (HIGH, trivial). `services/pipeline/_monolith.py:611-639`. 50-scene long-form episode loses 50–150 s to a sequential `for await` that should be `asyncio.gather`.

8. **F-S-04 — TikTok OAuth callback never validates `state`** (HIGH, small). `api/routes/social.py:185-242`. CSRF + non-atomic Redis race; YouTube callback uses `getdel` correctly so the fix template exists in-repo.

9. **F-O-13 — In-process `MetricsCollector` is dead weight across processes** (HIGH, small). Worker writes, API reads — they are different processes. `/api/v1/metrics/{steps,recent,generations}` permanently return zero. Either move to Redis-backed counters or remove the endpoints.

10. **F-T-31 — `# type: ignore[call-arg]` on `concat_video_clips` hides a real signature mismatch** (HIGH, small). `edit_render.py:114`. Removing the ignore exposes a likely runtime crash.

---

## Themes (vs. one-off findings)

- **Layering drift** — 57 router→repository imports across 21 of 33 route modules (F-A-01). Not a fire today, but a CI lint rule (`import-linter`) would prevent further drift; F-A-02 (`services/demo.py` imports FastAPI) is a trivial relocation.
- **N+1 cluster on Activity Monitor / Jobs admin** — F-PB-01, F-PB-02, F-PB-03, F-PB-12 all describe loops that issue 1 query per item where `IN (...)` or `MGET` would batch. Activity Monitor polls every 2–3 s so the multiplier is real.
- **Coverage cliff** — 29% line/branch (target 85%). The cliff is concentrated on `PipelineOrchestrator` (9%), `LongFormScriptService` (0%), `LLMPool` failover (0%), `audiobook/_monolith` (43%). The 18 quarantined xfails account for most of it; they are stale, not impossible.
- **Two log-context gaps** — F-O-01 audiobook generate() never binds `audiobook_id` for hours-long runs; F-O-05 worker_heartbeat swallows all exceptions silently. Both are diagnostic darkness during exactly the moments operators need to see the lights.
- **Frontend bundle bloat from API monolith import** — Main entry is 316 KB because every page imports through `lib/api/_monolith.ts` (1625 LOC). Splitting the API surface per page is the single biggest wins on initial paint.

---

## "Don't fix" — looks wrong, isn't (verified intentional)

These appeared in audits as candidates but should not be treated as findings:

- **`_monolith.py` + `__init__.py` re-export pattern** — deliberate per CLAUDE.md.
- **`validate_safe_url_or_localhost` permits localhost / private ranges** — local-first design (ComfyUI on 127.0.0.1, NAS-hosted ComfyUI on 192.168.x.x). Don't tighten.
- **`/storage/*` exempt from license gate** — operators always deserve their own past output.
- **`/api/v1/license/*` exempt from license gate** — needed for activation wizard on unactivated installs.
- **`/api/v1/auth/mode` is unauthenticated** — intentional so `LoginGate` can pre-render before any auth exists.
- **`secure=False` cookie default in dev** — production runs behind TLS-terminating reverse proxy.
- **No HSTS / CSP** — local-first single-tenant; CSP would break React dev server.
- **WebSocket token via query string** — browsers cannot set `Authorization` on WS.
- **arq over Celery** (ADR-0001), **direct ffmpeg subprocess** (ADR-0002), **filesystem storage** (ADR-0003), **TTS Protocol** (ADR-0004), **LLM Protocol** (ADR-0005) — accepted decisions; do not propose reversal.
- **`UnsafeURLError` inheriting from `ValueError`** — documented in CLAUDE.md gotchas.
- **In-progress `audiobook/` extraction** — TODO at `services/audiobook/_monolith.py:16` dated 2026-04-27 is active work.
- **Bandit B105/B106 "hardcoded passwords"** — all URLs and the literal string `"True"`. False positives.
- **Glass-morphism / dark gradient aesthetic** — brand. Do not "modernize".

---

## Open questions for the user (decisions I cannot make alone)

1. **Major dependency bumps?** Per Hard Rule 5 these need explicit approval. Candidates noted in `deps.md`:
   - `redis-py` 5 → 7 (skipped a major; gated on `arq` compat).
   - Anything in `deps.md` "Major bumps requiring approval" section.

2. **`audiocraft` / MusicGen weights are CC-BY-NC-4.0** (F-D-09). Drevalis is sold commercially. AceStep is already the default — should `audiocraft` be removed entirely from the optional `[music]` extra, or just documented as non-commercial?

3. **`mutagen` is GPL-2.0+** (F-D-MED-legal in `deps.md`). Distribution model question, not a code fix. Replace with a more permissive ID3 lib, or keep and document?

4. **Strict-mode rollout order** (`types.md`). The two named packages (`drevalis.core.license`, `drevalis.services.updates`) pass `--strict` today with 0 errors; declare them strict in `pyproject.toml`? Same question for `drevalis.schemas` and `drevalis.models` (also 0 errors).

5. **Integration tests** — fix the `ARRAY` SQLite shim (F-Tst-01, trivial) so SQLite stays the test DB, or migrate integration tests to Postgres-in-Docker (F-Tst-12)? Both are reasonable.

6. **`MetricsCollector` cross-process gap** (F-O-13) — fix by moving to Redis-backed counters, or accept and remove the dead endpoints? CLAUDE.md claims they work today.

7. **TikTok OAuth `state` strict-reject** (F-S-04) — the existing code falls through silently when state is missing. Strict-rejecting may break already-bookmarked / mid-flight callbacks during a deploy. Confirm acceptable.

8. **Strict-rejecting `cryptography` bump** would also bump `pyca` minor — want me to verify Fernet token format is compatible (it is, but please confirm).

9. **`SESSION_SECRET` introduction (F-S-08)** — adds a new required env var. Existing single-key installs need a migration path. Confirm UX: auto-derive from `ENCRYPTION_KEY` on first boot, or hard-require operators to set it?

---

## Don't act yet

Per Hard Rule 1, Phase 1 is read-only. Phase 2 starts only after you specify which findings to fix and in what order. I'm waiting.

When you respond, please:
1. List the specific `F-xx-NN` IDs to fix, in priority order.
2. Group into batches if you want them in separate commits / sessions.
3. Answer any of the 9 open questions that apply to that batch.

Recommended starter batch (all trivial, all read by you in this summary):
- **F-S-01** (cryptography bump) → 1 commit, 1 line.
- **F-S-05** (tarfile filter) → 1 commit, 1 line.
- **F-Tst-01** (ARRAY SQLite shim) → 1 commit, ~3 lines + unblocks 21 tests.
- **F-DB-02** (sync ORM with DB indexes) → 1 commit, model edits only, no migration.
- **F-DB-03** (ARRAY/CHECK constraint correctness) → would require a migration; flag for explicit approval per Hard Rule 6.

Total: 4 trivial commits and 1 migration that needs your sign-off.

# Type Safety Audit — Drevalis Backend

**Date:** 2026-04-29
**Baseline:** `mypy -p drevalis --no-strict-optional` → 0 errors (see `audit/baseline-mypy.txt`)
**Scope:** strict-mode gap analysis, `# type: ignore` legitimacy, `Any` leaks in public
signatures, and untyped JSONB fields in schemas/models.

---

## Task 1 — Priority packages: `drevalis.core.license` and `drevalis.services.updates`

Both packages **pass `--strict` today with 0 errors** across all checked files.
They can be formally declared strict immediately — add them to `[tool.mypy.overrides]`
with `strict = true` (or remove the global `--no-strict-optional` flag for them first
as a stepping stone).

| Package | Files | Strict errors |
|---------|-------|---------------|
| `drevalis.core.license` | 10 | 0 |
| `drevalis.services.updates` | 1 | 0 |

---

## Task 2 — Broad package survey (strict error counts)

| Package | Files checked | Strict errors | Unique root causes |
|---------|--------------|---------------|--------------------|
| `drevalis.core` | 25 | 1 | 1 (bleeds from `repositories`) |
| `drevalis.schemas` | 18 | 0 | — |
| `drevalis.models` | 22 | 0 | — |
| `drevalis.repositories` | 19 | 1 | 1 (`media_asset.py:55`) |
| `drevalis.services.episode` | 1 | 1 | same as repositories |
| `drevalis.services.storage` | 1 | 1 | same as repositories |
| `drevalis.services` (all) | 46 | 17 | 8 distinct root causes |
| `drevalis.api` | 36 | 25 | 5 distinct root causes |
| `drevalis.workers` | 21 | 19 | 4 distinct root causes |

Notes on counting: `drevalis.core`, `drevalis.services.episode`, and
`drevalis.services.storage` each show exactly 1 error because mypy re-checks the
transitive dependency `repositories/media_asset.py:55` when those packages import
it. Fixing that one line eliminates the error from all three.

---

## Findings

### F-T-01: `get_total_size_bytes` returns `int | None`, declared `int`

- **Severity:** HIGH
- **Location:** `src/drevalis/repositories/media_asset.py:55`
- **Evidence:**
  ```python
  stmt = select(func.coalesce(func.sum(MediaAsset.file_size_bytes), 0))
  result = await self.session.execute(stmt)
  return result.scalar_one()  # typed int | None by SQLAlchemy
  ```
- **Impact:** Callers that sum or compare the return value (e.g. storage reporting)
  would crash at runtime if `scalar_one()` ever returns `None`. The `COALESCE`
  prevents `NULL` in SQL, but mypy cannot prove that — so every caller treats the
  value as potentially `None` without the check.
- **Effort:** trivial
- **Suggested fix:** Change return type to `int` and add `or 0` coercion:
  `return result.scalar_one() or 0`, or use `scalar_one_or_none() or 0`.

---

### F-T-02: `generate_scene_images` / `generate_scene_videos` typed `server_id: UUID` but all callers pass `None`

- **Severity:** HIGH
- **Location:** `src/drevalis/services/comfyui/_monolith.py:886,1185` (signatures);
  callers at `pipeline/_monolith.py:994,1058` and `music_video_orchestrator.py:345`
- **Evidence:**
  ```python
  # Callers:
  await self.comfyui_service.generate_scene_videos(
      server_id=None,  # Let the pool distribute across all servers
      ...
  )
  # Signature:
  async def generate_scene_images(self, server_id: UUID, ...) -> ...:
  ```
- **Impact:** The underlying pool's `acquire()` already accepts `UUID | None` and
  routes accordingly, so this is a sig/call mismatch only — no runtime failure.
  But strict mode catches it and prevents future guards from trusting `server_id` is
  non-None.
- **Effort:** trivial
- **Suggested fix:** Change both method signatures to `server_id: UUID | None` to
  match the pool's `acquire()` contract that's already in place.

---

### F-T-03: `[None]` list literal inferred as `list[None]`, not `list[str | None]`

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/comfyui/_monolith.py:1027-1028`
- **Evidence:**
  ```python
  character_ref_image=(character_lock_paths or [None])[0],
  style_ref_image=(style_lock_paths or [None])[0],
  ```
  `character_lock_paths` is `list[str] | None`; the fallback literal `[None]`
  is inferred as `list[None]`, making the first element `None` incompatible with
  the `str` item type expected by the list.
- **Impact:** No runtime failure — parameters accept `str | None`. Purely a type
  inference artefact from the fallback literal.
- **Effort:** trivial
- **Suggested fix:** Replace with an explicit cast or rewrite as
  `character_lock_paths[0] if character_lock_paths else None` to avoid the
  ambiguous list literal entirely.

---

### F-T-04: `SUPPORTED_PROVIDERS` tuple contains `None` values in a `dict[str, str]` typed container

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/cloud_gpu/registry.py:29-54` (lines 45, 52)
- **Evidence:**
  ```python
  SUPPORTED_PROVIDERS: tuple[dict[str, str], ...] = (
      ...
      {
          "name": "vastai",
          "settings_attr": None,  # no env-var fallback yet
          ...
      },
  )
  ```
- **Impact:** Any consumer that treats `settings_attr` as `str` (e.g. `getattr(settings, spec["settings_attr"])`)
  would raise `TypeError` at runtime for Vast.ai and Lambda. The annotation
  `dict[str, str]` is incorrect.
- **Effort:** small
- **Suggested fix:** Change the type annotation to
  `tuple[dict[str, str | None], ...]` to honestly reflect the optional
  `settings_attr` field, and update the `_resolve_api_key` consumer's
  `spec: dict[str, str]` parameter annotation to match.

---

### F-T-05: `encrypt_value` receives `Any | None` where `str` is required (YouTube OAuth)

- **Severity:** HIGH
- **Location:** `src/drevalis/services/youtube.py:130`
- **Evidence:**
  ```python
  access_enc, key_ver = encrypt_value(credentials.token, self.encryption_key)
  ```
  `credentials.token` is `Any | None` (google-auth returns untyped), and
  `encrypt_value` expects `str`. Passing `None` would raise at runtime when
  the OAuth token is unexpectedly absent.
- **Impact:** If Google OAuth returns a response where `.token` is `None`
  (revoked credential, partial response), the encryption call will fail with
  an unhandled `TypeError` inside the callback handler.
- **Effort:** small
- **Suggested fix:** Assert or guard `credentials.token` before encrypting:
  `if not credentials.token: raise ValueError("OAuth token missing")`.

---

### F-T-06: `StreamReader | None` de-referenced without None-check in two subprocess readers

- **Severity:** HIGH
- **Location:**
  - `src/drevalis/services/ffmpeg/_monolith.py:1283`
  - `src/drevalis/services/audiobook/_monolith.py:4679`
- **Evidence:**
  ```python
  proc = await asyncio.create_subprocess_exec(*cmd, stderr=PIPE, ...)
  while True:
      line = await proc.stderr.readline()  # proc.stderr is StreamReader | None
  ```
- **Impact:** `asyncio.create_subprocess_exec` with `stderr=PIPE` guarantees
  `proc.stderr` is a `StreamReader`. In practice this never fails, but if
  `PIPE` were ever removed the code would raise `AttributeError` with no
  useful diagnostic. More practically, strict mode refuses to compile it.
- **Effort:** trivial
- **Suggested fix:** Add `assert proc.stderr is not None` immediately after
  `create_subprocess_exec` returns (one line per call site).

---

### F-T-07: `ComfyUIService | None` accessed without None-guard in audiobook image generation

- **Severity:** HIGH
- **Location:** `src/drevalis/services/audiobook/_monolith.py:3487,3509,3511,3513`
- **Evidence:**
  ```python
  workflow = await self.comfyui_service._load_workflow(...)
  async with self.comfyui_service._pool.acquire() as (_, client):
      ...
      self.comfyui_service._extract_output_images(...)
  ```
  `self.comfyui_service` is typed `ComfyUIService | None` on `AudiobookService`.
- **Impact:** If no ComfyUI server is configured, `self.comfyui_service` is
  `None` and all four attribute accesses raise `AttributeError` at runtime
  during audiobook image generation. The missing guard is a real crash path.
- **Effort:** small
- **Suggested fix:** Add an early-return guard (`if self.comfyui_service is None: raise RuntimeError(...)`)
  before the block, narrowing the type for the rest of the method.

---

### F-T-08: `LLMService(storage=None)` violates its own `StorageBackend` parameter contract

- **Severity:** MEDIUM
- **Location:**
  - `src/drevalis/api/routes/series.py:239,245,575,581,675`
  - `src/drevalis/api/routes/youtube/_monolith.py:605`
  - `src/drevalis/api/routes/episodes/_monolith.py:3456,3613`
  - `src/drevalis/workers/jobs/series.py:71`
  - `src/drevalis/workers/jobs/seo.py:55`
- **Evidence:**
  ```python
  llm_service = LLMService(storage=None, encryption_key=settings.encryption_key)
  ```
  `LLMService.__init__` is declared `storage: StorageBackend`, not `StorageBackend | None`.
  `self._storage` is assigned but **never read** in any `LLMService` method.
- **Impact:** No runtime failure because `_storage` is dead code — but the
  annotation is a contract lie that strict mode correctly rejects at 10 call
  sites. Any future use of `self._storage` would silently receive `None`.
- **Effort:** trivial
- **Suggested fix:** Either remove the `storage` parameter entirely from
  `LLMService.__init__` (it is unused), or change the annotation to
  `StorageBackend | None` if it is intended as a future extension point.

---

### F-T-09: Router passes `None` to `get_by_id(UUID)` at audiobook YouTube upload path

- **Severity:** HIGH
- **Location:** `src/drevalis/api/routes/audiobooks/_monolith.py:1341`
- **Evidence:**
  ```python
  if getattr(audiobook, "youtube_channel_id", None):
      channel = await channel_repo.get_by_id(audiobook.youtube_channel_id)
  ```
  `audiobook.youtube_channel_id` is `UUID | None`; the truthiness guard does
  not narrow it to `UUID`, so mypy sees `UUID | None` passed to `get_by_id(UUID)`.
- **Impact:** The truthiness check makes the runtime safe (a nil UUID would be
  falsy), but mypy is right that the narrowing is implicit. A future refactor
  removing the `getattr` guard would silently pass `None` to the DB query.
- **Effort:** trivial
- **Suggested fix:** Use `if audiobook.youtube_channel_id is not None:` which
  mypy recognises as a type-narrowing guard.

---

### F-T-10: Same `UUID | None → UUID` pattern in scheduled post publisher

- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/jobs/scheduled.py:123`
- **Evidence:**
  ```python
  if series and getattr(series, "youtube_channel_id", None):
      channel = await ch_repo.get_by_id(series.youtube_channel_id)
  ```
- **Impact:** Same as F-T-09 — runtime safe due to truthiness guard, but not
  statically narrowed.
- **Effort:** trivial
- **Suggested fix:** Replace `getattr` guard with `series.youtube_channel_id is not None`.

---

### F-T-11: `_auto_select_*` pipeline methods return `Any` instead of their actual model type

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/pipeline/_monolith.py:2120,2176,2187,2215,2226`
- **Evidence:**
  ```python
  async def _auto_select_llm_config(self) -> Any:
  async def _auto_select_voice_profile(self) -> Any:
  async def _auto_select_prompt_template(self, template_type: str) -> Any:
  async def _auto_select_comfyui_server(self) -> Any:
  async def _auto_select_comfyui_workflow(self) -> Any:
  ```
- **Impact:** Return values flow into typed downstream calls (e.g. `server_id`,
  `workflow.input_mappings`) and currently suppress type errors on any attribute
  access. This is the primary reason `pipeline/_monolith.py:1512,1530` errors
  slip through — the `chapters` and `mood` values originate from `Any`-typed
  intermediaries.
- **Effort:** small
- **Suggested fix:** Annotate each method with its concrete return type
  (e.g. `LLMConfig | None`, `VoiceProfile | None`, `ComfyUIServer | None`).
  The implementations already return the correct models; only the signatures
  need updating.

---

### F-T-12: `chapters` and `mood` passed as potentially-None to methods requiring concrete types

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/pipeline/_monolith.py:1512,1530`
- **Evidence:**
  ```python
  chapters=chapters,   # type: Any | None, expected list[dict[str, Any]]
  mood=series.music_mood,  # type: str | None, expected str
  ```
- **Impact:** `_prepare_chapter_music` would receive `None` for `chapters` when
  a short-form episode has no chapter data. `get_music_for_episode` would receive
  `None` for mood, likely defaulting unexpectedly inside the music service.
- **Effort:** small
- **Suggested fix:** Add `assert chapters is not None` / `mood = series.music_mood or "neutral"`
  guards before the calls, or widen the callee signatures to accept `None` and
  handle it there.

---

### F-T-13: `_resolve_sfx_provider` and `_resolve_music_service` return `Any | None` (audiobook)

- **Severity:** LOW
- **Location:** `src/drevalis/services/audiobook/_monolith.py:1070,3587`
- **Evidence:**
  ```python
  def _resolve_sfx_provider(self) -> Any | None:
  def _resolve_music_service(self) -> Any | None:
  ```
- **Impact:** Private helpers — `Any` return type propagates into all callers,
  suppressing attribute-level type errors on the returned objects.
- **Effort:** small
- **Suggested fix:** Return their concrete types
  (`ComfyUIElevenLabsSoundEffectsProvider | None` and `MusicService | None` respectively).

---

### F-T-14: `_build_credentials` returns `Any` (YouTube service)

- **Severity:** LOW
- **Location:** `src/drevalis/services/youtube.py:162-167`
- **Evidence:**
  ```python
  def _build_credentials(self, ...) -> Any:
      from google.oauth2.credentials import Credentials
      ...
      return Credentials(...)
  ```
- **Impact:** `google.oauth2.credentials` has no stubs (covered by the mypy
  override `ignore_missing_imports`), so `-> Any` is a pragmatic workaround.
  This is **intentional** — see "Don't fix" section.
- **Effort:** n/a (intentional)
- **Suggested fix:** No change needed; the `google.*` override already suppresses
  missing-stub errors. Documenting the intent in the docstring would clarify it.

---

### F-T-15: `captions._get_model` returns `Any` (faster-whisper)

- **Severity:** LOW
- **Location:** `src/drevalis/services/captions/_monolith.py:387`
- **Evidence:**
  ```python
  def _get_model(self) -> Any:
      from faster_whisper import WhisperModel
  ```
- **Impact:** `faster-whisper` stubs are missing (covered by override).
  `Any` return is the only practical option until stubs ship.
- **Effort:** n/a (intentional)
- **Suggested fix:** No change needed. Already in the "Don't fix" category.

---

### F-T-16: `LongFormScriptService.__init__` takes `provider: Any` instead of `LLMProvider`

- **Severity:** MEDIUM
- **Location:** `src/drevalis/services/longform_script.py:53`
- **Evidence:**
  ```python
  def __init__(
      self,
      provider: Any,  # LLMProvider protocol
      ...
  ```
- **Impact:** The comment documents the intent but the annotation defeats it.
  Any object can be passed without a type error, silently bypassing the protocol
  check.
- **Effort:** trivial
- **Suggested fix:** Replace `Any` with `LLMProvider` (the Protocol is already
  defined in `services/llm`).

---

### F-T-17: `workers/jobs/audiobook.py` — `script_text` variable inferred `str | None`, used as `str`

- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/jobs/audiobook.py:891` (assignment)
- **Evidence:**
  ```python
  script_text = ""        # line ~846; inferred str
  script_text = await _generate_audiobook_script_text(...)  # returns str | None
  if script_text is None:
      script_text = ""   # reassign
  ```
  The first assignment (`script_text = ""`) fixes the inferred type as `str`.
  The reassignment with `str | None` then conflicts.
- **Impact:** Purely a strict-mode annotation artefact — the `if script_text is None: script_text = ""`
  guard two lines later makes the runtime path safe. But the variable type
  alternates between branches, causing the assignment error.
- **Effort:** trivial
- **Suggested fix:** Declare `script_text: str | None = None` at the top of
  the relevant branch so the type is consistent before and after the assignment.

---

### F-T-18: `_human_size` uses `size_bytes /= 1024.0` — divides `int` into `float`, type unsound

- **Severity:** NIT
- **Location:** `src/drevalis/api/routes/settings.py:33`
- **Evidence:**
  ```python
  def _human_size(size_bytes: int) -> str:
      for unit in ("B", "KB", "MB", "GB", "TB"):
          if abs(size_bytes) < 1024.0:
              return f"{size_bytes:.1f} {unit}"
          size_bytes /= 1024.0  # type: ignore[assignment]
  ```
  `/=` on an `int` produces `float`; the parameter is annotated `int`.
  The `# type: ignore[assignment]` suppresses it but the annotation is wrong.
- **Impact:** Cosmetic — output is always a formatted string. Silently broadens
  the type of `size_bytes` mid-loop.
- **Effort:** trivial
- **Suggested fix:** Change parameter to `float` or use a separate `val: float = float(size_bytes)`
  local, then drop the `type: ignore`.

---

### F-T-19: `RunPodPodRuntime.ports` and `.gpus` are `list[dict] | None` without type args

- **Severity:** LOW
- **Location:** `src/drevalis/schemas/runpod.py:112-113`
- **Evidence:**
  ```python
  ports: list[dict] | None = None  # type: ignore[type-arg]
  gpus: list[dict] | None = None   # type: ignore[type-arg]
  ```
- **Impact:** The RunPod API response shape for ports and gpus is not
  contractually typed, so `dict[str, Any]` is the honest annotation and
  removes the `type: ignore`.
- **Effort:** trivial
- **Suggested fix:** Change both to `list[dict[str, Any]] | None` and drop
  the `type: ignore[type-arg]` comments.

---

### F-T-20: `model_validator` callbacks use bare `dict` without type args

- **Severity:** NIT
- **Location:** `src/drevalis/schemas/script.py:91,135`
- **Evidence:**
  ```python
  def normalize_field_names(cls, data: dict) -> dict:  # type: ignore[type-arg]
  ```
- **Impact:** Pydantic v2's `mode="before"` validators receive `Any` as input
  (can be dict, model instance, etc.). The `# type: ignore[type-arg]` is
  working around a real constraint, but the annotation could be `Any` explicitly
  to avoid the suppress.
- **Effort:** trivial
- **Suggested fix:** Change to `def normalize_field_names(cls, data: Any) -> Any:`
  and drop the `type: ignore` — this is what Pydantic v2 actually passes to
  `mode="before"` validators.

---

### F-T-21: `episodes.chapters` JSONB column typed `dict[str, Any] | None` but contains a list

- **Severity:** MEDIUM
- **Location:** `src/drevalis/models/episode.py:91`
- **Evidence:**
  ```python
  chapters: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
  ```
  The CLAUDE.md describes `episodes.chapters` as a list of chapter dicts
  (`title`, `scene_range`, `duration_estimate`, `music_mood`). The ORM column
  annotation uses `dict` (singular object) but the actual runtime value is a
  `list`.
- **Impact:** Any code that reads `episode.chapters` and calls dict methods
  (`.get`, `.keys()`, etc.) will raise `AttributeError` at runtime when
  `chapters` is a non-empty list. Current callers likely iterate it as a list,
  so the annotation is simply wrong — not the code.
- **Effort:** small
- **Suggested fix:** Change to `Mapped[list[dict[str, Any]] | None]` and update
  the corresponding schema field `episodes.py:88` in `schemas/episode.py` from
  `list[dict[str, Any]] | None` (already correct) to confirm the round-trip.
  The schema already has the right type; only the model column annotation is wrong.

---

### F-T-22: `youtube_channel.upload_days` typed `list[Any] | None` — should be `list[str] | None`

- **Severity:** LOW
- **Location:** `src/drevalis/models/youtube_channel.py:45`
- **Evidence:**
  ```python
  upload_days: Mapped[list[Any] | None] = mapped_column(JSONB, nullable=True)
  ```
  Upload days are day-of-week strings ("monday", "tuesday", …).
- **Impact:** Callers that enumerate `upload_days` treat elements as `Any`,
  suppressing type errors on string operations.
- **Effort:** trivial
- **Suggested fix:** Change to `Mapped[list[str] | None]`.

---

### F-T-23: `comfyui.input_mappings` uses `dict[str, Any]` — internal structure is known

- **Severity:** MEDIUM
- **Location:** `src/drevalis/models/comfyui.py:63`,
  `src/drevalis/schemas/comfyui_crud.py:116,133,153`
- **Evidence:**
  ```python
  input_mappings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
  ```
  The `WorkflowInputMapping` TypedDict / dataclass already exists in
  `services/comfyui` and defines the expected keys (`node_id`, `field`,
  `value_key`, etc.). The model and schema use `dict[str, Any]` instead.
- **Impact:** Validation of `input_mappings` only occurs inside `ComfyUIService`
  at dispatch time. A malformed mapping silently stored in the DB produces a
  confusing error much later during scene generation.
- **Effort:** medium
- **Suggested fix:** Define a `WorkflowInputMappingSchema` Pydantic model
  mirroring `WorkflowInputMapping` and use it as the field type for the
  create/update schemas (validated at API boundary). The ORM column can remain
  `dict[str, Any]` since SQLAlchemy JSONB cannot use TypedDicts natively.

---

### F-T-24: `BaseRepository.get_all` uses `self.model.created_at` via `type: ignore[attr-defined]`

- **Severity:** LOW
- **Location:** `src/drevalis/repositories/base.py:44`
- **Evidence:**
  ```python
  .order_by(self.model.created_at.desc())  # type: ignore[attr-defined]
  ```
- **Impact:** `ModelT` is a generic TypeVar. All concrete models inherit
  `TimestampMixin` which provides `created_at`, but the TypeVar bound doesn't
  express this, so mypy can't see `created_at` on the generic. The ignore is
  a reasonable workaround but could be tightened with a `Protocol` bound.
- **Effort:** medium
- **Suggested fix:** Introduce a `TimestampedModel` protocol that declares
  `created_at: datetime` and bound `ModelT` to it in `BaseRepository`. This
  removes the `type: ignore` legitimately.

---

### F-T-25: `asset.py` — `Asset.tags.any(tag)` suppressed with `type: ignore[arg-type]`

- **Severity:** LOW
- **Location:** `src/drevalis/repositories/asset.py:38`
- **Evidence:**
  ```python
  conds.append(Asset.tags.any(tag))  # type: ignore[arg-type]
  ```
  `Asset.tags` is a JSONB array column; SQLAlchemy's `.any()` on JSONB
  returns a `ColumnElement[bool]` but its stub signature expects a different
  arg type.
- **Impact:** Narrow ignore with correct error code `[arg-type]` — intentional
  workaround for a SQLAlchemy JSONB stub limitation. No runtime risk.
- **Effort:** n/a (intentional)

---

### F-T-26: `runpod.py:294` — `dict` return without type args

- **Severity:** LOW
- **Location:** `src/drevalis/services/runpod.py:294`
- **Evidence:**
  ```python
  ) -> dict:  # type: ignore[type-arg]
  ```
- **Impact:** RunPod GraphQL responses are deeply nested with mixed types.
  `dict[str, Any]` is honest and removes the ignore.
- **Effort:** trivial
- **Suggested fix:** Change to `-> dict[str, Any]` and drop `# type: ignore[type-arg]`.

---

### F-T-27: `animation.py` — enum `style` coerced to `str` with `type: ignore[arg-type]`

- **Severity:** NIT
- **Location:** `src/drevalis/services/animation.py:99`
- **Evidence:**
  ```python
  return AnimationDirection(
      style=str(style),  # type: ignore[arg-type]
  ```
  `str(style)` already returns a plain `str`; the ignore is suppressing a
  legitimate narrowing failure if `AnimationDirection.style` is typed as a
  specific Literal or Enum.
- **Impact:** Depends on `AnimationDirection.style`'s annotation. If it is a
  `Literal[...]`, the coercion bypasses exhaustive checking.
- **Effort:** trivial
- **Suggested fix:** Inspect `AnimationDirection.style`'s type; if it is `str`,
  drop the ignore. If it is a Literal, perform the lookup against the Literal
  set and raise on unknown values.

---

### F-T-28: `websocket.py` — `pubsub.aclose()` suppressed with `[no-untyped-call]`

- **Severity:** NIT
- **Location:** `src/drevalis/api/websocket.py:231,408`
- **Evidence:**
  ```python
  await pubsub.aclose()  # type: ignore[no-untyped-call]
  ```
- **Impact:** `redis-py` async `PubSub.aclose()` is untyped in the installed
  stubs. Narrow ignore with correct code. No runtime risk.
- **Effort:** n/a (intentional until `redis` ships complete stubs)

---

### F-T-29: `core/usage.py` — `ContextVar.reset(token)` suppressed with `[arg-type]`

- **Severity:** NIT
- **Location:** `src/drevalis/core/usage.py:83`
- **Evidence:**
  ```python
  _current_accumulator.reset(reset_token)  # type: ignore[arg-type]
  ```
  `reset_token` is typed as `object` (the return type of `ContextVar.set()`
  in some mypy stubs is `Token[T]`, while the caller declares it `object`).
- **Impact:** Narrowing `reset_token: object` to the correct `Token[UsageAccumulator | None]`
  type in `end_accumulator`'s signature would remove the ignore.
- **Effort:** trivial
- **Suggested fix:** Change the function signature to
  `def end_accumulator(reset_token: Token[UsageAccumulator | None]) -> None:`.

---

### F-T-30: `verifier.py` — `async_sessionmaker` without type args

- **Severity:** NIT
- **Location:** `src/drevalis/core/license/verifier.py:56,137`
- **Evidence:**
  ```python
  session_factory: async_sessionmaker,  # type: ignore[type-arg]
  ```
- **Impact:** `async_sessionmaker[AsyncSession]` is the correct fully-parameterised
  form. The ignore is working around the missing type arg.
- **Effort:** trivial
- **Suggested fix:** Change to `async_sessionmaker[AsyncSession]` and drop the ignore.

---

### F-T-31: `edit_render.py` — `ffmpeg.concat_video_clips` called with wrong kwargs

- **Severity:** HIGH
- **Location:** `src/drevalis/workers/jobs/edit_render.py:114`
- **Evidence:**
  ```python
  await ffmpeg.concat_video_clips(  # type: ignore[call-arg]
      trimmed_paths,
      intermediate,
  )
  ```
- **Impact:** `[call-arg]` suppression means the actual signature of
  `concat_video_clips` does not match the positional arguments here. This is a
  real API mismatch — if the method signature changed and this was not updated,
  the `type: ignore` would silently hide a crash.
- **Effort:** small
- **Suggested fix:** Inspect `FFmpegService.concat_video_clips`'s current
  signature and update the call to match it, then remove the `# type: ignore`.
  This is the only `type: ignore` in the codebase suppressing a potential
  real call-arg mismatch.

---

## Task 3 — `# type: ignore` Audit

All 24 `type: ignore` comments found are narrowed with an explicit error code
(e.g. `[arg-type]`, `[no-untyped-call]`, `[type-arg]`). Zero bare
`# type: ignore` (without code) found.

| File | Line(s) | Code | Assessment |
|------|---------|------|------------|
| `api/routes/episodes/_monolith.py` | 3398 | `[arg-type]` | Borderline — see F-T-31 pattern; warrants investigation |
| `api/routes/runpod.py` | 647 | `[no-any-return]` | Intentional — `json.loads` returns `Any` |
| `api/routes/runpod.py` | 655, 671 | `[type-arg]` | Fix: use `dict[str, Any]` (see F-T-19) |
| `api/routes/settings.py` | 33 | `[assignment]` | Fix: see F-T-18 |
| `api/websocket.py` | 231, 408 | `[no-untyped-call]` | Intentional — redis stubs gap (see F-T-28) |
| `core/license/verifier.py` | 56, 137 | `[type-arg]` | Fix: see F-T-30 |
| `core/usage.py` | 83 | `[arg-type]` | Fix: see F-T-29 |
| `repositories/asset.py` | 38 | `[arg-type]` | Intentional — SQLAlchemy JSONB stub gap (see F-T-25) |
| `repositories/base.py` | 44 | `[attr-defined]` | Fix with Protocol bound (see F-T-24) |
| `schemas/runpod.py` | 112, 113 | `[type-arg]` | Fix: see F-T-19 |
| `schemas/script.py` | 91, 135 | `[type-arg]` | Fix: see F-T-20 |
| `services/animation.py` | 99 | `[arg-type]` | Investigate (see F-T-27) |
| `services/music_video.py` | 319 | `[import-not-found]` | Intentional — optional `librosa` dep |
| `services/runpod.py` | 294 | `[type-arg]` | Fix: see F-T-26 |
| `services/tts/_monolith.py` | 356 | `[operator]` | Intentional — Kokoro library untyped |
| `services/tts/_monolith.py` | 390 | `[arg-type]` | Intentional — numpy array `len()` not typed |
| `services/youtube.py` | 491 | `[no-any-return]` | Intentional — googleapiclient untyped |
| `workers/jobs/edit_render.py` | 114 | `[call-arg]` | HIGH RISK — real API mismatch (see F-T-31) |

**Fixable ignores (not intentional):** `settings.py:33`, `verifier.py:56,137`,
`usage.py:83`, `runpod.py:294`, `schemas/runpod.py:112,113`, `schemas/script.py:91,135`,
`api/routes/runpod.py:655,671`, `repositories/base.py:44`

**High-risk to investigate:** `workers/jobs/edit_render.py:114` (`[call-arg]`)

---

## Task 4 — `Any` Leaks in Public Service / Repository Signatures

Public means: not prefixed with `_`.

| Location | Signature | Risk |
|----------|-----------|------|
| `services/longform_script.py:53` | `provider: Any` in `__init__` | MEDIUM — protocol bypass (F-T-16) |
| `services/youtube.py:167` | `-> Any` on `_build_credentials` | LOW / intentional (google stubs) |
| `services/continuity.py:64` | `llm_config: Any` in public helper | MEDIUM — same as longform; should be `LLMConfig \| LLMProvider` |
| `services/backup.py:97,117,143,151,159` | Multiple `Any -> Any` helpers | LOW — generic JSON serialisation; difficult to narrow further |
| `repositories/base.py:59,67` | `**kwargs: Any` in `create`/`update` | LOW / intentional — SQLAlchemy ORM kwargs pattern |

`repositories/base.py` `**kwargs: Any` is a standard SQLAlchemy pattern for
dynamic column assignment — intentional and documented. The backup helpers deal
with arbitrary row data by design. The two `llm_config: Any` / `provider: Any`
annotations in `longform_script.py` and `continuity.py` are the highest-value
targets: both could use the existing `LLMProvider` Protocol.

---

## Task 5 — Pydantic / ORM `dict[str, Any]` / `list[Any]` JSONB Fields

Fields where a tighter type is feasible:

| Location | Field | Current type | Better type | Effort |
|----------|-------|-------------|-------------|--------|
| `models/episode.py:91` | `chapters` | `dict[str, Any] \| None` | `list[dict[str, Any]] \| None` | trivial — annotation only |
| `models/youtube_channel.py:45` | `upload_days` | `list[Any] \| None` | `list[str] \| None` | trivial |
| `models/comfyui.py:63` | `input_mappings` | `dict[str, Any]` | validated at schema level via `WorkflowInputMapping` | medium |
| `schemas/episode.py:88` | `chapters` (response) | `list[dict[str, Any]] \| None` | already correct | — |
| `schemas/episode.py:25,36,80` | `script` | `dict[str, Any]` | `EpisodeScript` Pydantic model | large (requires migration) |
| `schemas/comfyui_crud.py:116,133,153` | `input_mappings` | `dict[str, Any]` | `WorkflowInputMapping` TypedDict | medium |
| `models/asset.py:99` | `transcript` | `dict[str, Any] \| list[Any] \| None` | `list[WordTimestamp] \| None` (or leave as-is) | medium |
| `models/asset.py:100` | `candidate_clips` | `list[Any] \| None` | `list[dict[str, Any]] \| None` | trivial |

**Highest-value tightening:** `models/episode.py:91` (wrong container type — `dict` vs `list`)
is a correctness bug. All others are quality improvements.

---

## Strict-mode ROI ranking

Ranked by: (0 errors = already done, few errors = cheap win, many = expensive).
"Value" weights whether the package is on a hot path (pipeline, repos, routers).

| Rank | Package | Strict errors | Unique root causes | Value | Verdict |
|------|---------|---------------|--------------------|-------|---------|
| 1 | `drevalis.core.license` | 0 | 0 | HIGH | Declare strict now |
| 2 | `drevalis.services.updates` | 0 | 0 | LOW | Declare strict now |
| 3 | `drevalis.schemas` | 0 | 0 | HIGH | Declare strict now |
| 4 | `drevalis.models` | 0 | 0 | HIGH | Declare strict now |
| 5 | `drevalis.repositories` | 1 | 1 | HIGH | One trivial fix → strict |
| 6 | `drevalis.services.episode` | 1 (transitive) | 0 | HIGH | Fix repos → free |
| 7 | `drevalis.services.storage` | 1 (transitive) | 0 | MEDIUM | Fix repos → free |
| 8 | `drevalis.core` | 1 (transitive) | 0 | HIGH | Fix repos → free |
| 9 | `drevalis.services` (all) | 17 | 8 | HIGH | Medium effort, high value |
| 10 | `drevalis.workers` | 19 | 4 | MEDIUM | Most errors from services bleed |
| 11 | `drevalis.api` | 25 | 5 | MEDIUM | LLMService(storage=None) × 10 is the bulk |

---

## Top 5 by ROI

1. **`drevalis.schemas` + `drevalis.models`** — 0 errors each, declare strict in
   `pyproject.toml` overrides immediately. High value because every service and
   router imports from them; strict coverage protects the widest surface.

2. **`drevalis.repositories`** — 1 error (F-T-01), trivial one-liner fix, then
   declare strict. Repositories are the data-access boundary; strict here protects
   every service that calls them.

3. **`drevalis.core` (including `license` and `license` sub-package)** — 1 transitive
   error that disappears once F-T-01 is fixed. The core package has zero own errors.
   Strict here closes the security/config module gap at zero additional cost.

4. **`drevalis.services` — fix F-T-02 + F-T-08 first** — these two account for
   10 of the 17 service errors (server_id signature + LLMService storage param).
   Both are trivial annotation changes. After those, remaining errors drop to ~5,
   all in large `_monolith.py` files.

5. **`drevalis.api` + `drevalis.workers`** — bulk of errors are F-T-08 (10 call
   sites passing `storage=None`) and the `UUID | None` narrowing issues (F-T-09,
   F-T-10). Fixing F-T-08 in the service signature ripples and clears all 10
   router/worker errors in one go.

---

## Don't fix (intentional)

- **F-T-14** (`youtube.py _build_credentials -> Any`) — google-auth has no stubs;
  `Any` is the only option without vendoring or forking the stub package.
- **F-T-15** (`captions._get_model -> Any`) — faster-whisper has no stubs; covered
  by `ignore_missing_imports` override.
- **F-T-25** (`asset.py tags.any()`) — SQLAlchemy JSONB `.any()` stub is incomplete;
  the `[arg-type]` ignore is load-bearing.
- **F-T-28** (`websocket.py pubsub.aclose()`) — redis-py async stub gap; covered
  by `ignore_missing_imports`.
- **`services/tts/_monolith.py:356` `[operator]`** — Kokoro library is untyped
  optional dep; calling untyped lib code is the only option.
- **`services/tts/_monolith.py:390` `[arg-type]`** — numpy array operations on
  untyped audio data; numpy stubs are partial in this context.
- **`services/music_video.py:319` `[import-not-found]`** — optional `librosa` dep,
  already documented as `pip install .[music_video]`.
- **`repositories/base.py **kwargs: Any`** — standard SQLAlchemy ORM dynamic
  assignment pattern; narrowing would break the generic base.
- **`services/backup.py` Any helpers** — backup serialises arbitrary DB rows;
  generic JSON coercers cannot be narrowed without re-implementing the full
  type inventory.

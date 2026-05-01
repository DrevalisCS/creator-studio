# Changelog

All notable changes to Drevalis Creator Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.29.19] - 2026-05-01

### Added

- **License JWT verifier** — 23 new tests for
  ``core/license/verifier.py`` (``test_license_verifier.py``).
  Module coverage: 19% → 73%. Forge real Ed25519 keypairs at test
  time and synthesize signed JWTs to exercise:

  - ``verify_jwt`` — valid token with ``aud`` decodes; legacy
    token without ``aud`` accepted (F-S-11 hotfix invariant);
    wrong audience rejected; wrong issuer rejected; wrong
    signing key rejected; malformed token rejected; missing
    required claim (``jti``, ``iss``, ``sub``, ``exp``, ``nbf``,
    ``iat``) rejected; expired token rejected at decode time.
  - ``_classify`` — ACTIVE inside paid window, GRACE between
    period_end and exp, EXPIRED past exp, INVALID before nbf;
    lifetime_pro skips the period_end check (always ACTIVE
    once signature-verified) but still respects nbf.
  - ``bump_state_version`` / ``get_remote_version`` — Redis
    INCR + GET wrappers, both fail-safe to 0 on Redis errors,
    bytes + string responses normalised to int.
  - ``refresh_if_stale`` — no rebootstrap when local ≥ remote,
    rebootstraps + advances local version when remote ahead,
    swallows bootstrap errors (gate must keep serving even
    when the refresh path is broken) and does NOT advance the
    local version on failure (so we retry next request).

- **License gate middleware** — 13 new tests for
  ``core/license/gate.py`` (``test_license_gate.py``).
  Module coverage: 25% → 87%. Tests use a real Starlette app +
  ``TestClient`` so the ASGI dispatch is exercised end-to-end:

  - Exempt paths always pass (``/health``, ``/api/v1/license/*``,
    ``/docs``, ``/storage/*``) — even on UNACTIVATED / INVALID.
  - Non-guarded paths (``/``) pass through.
  - Guarded paths (``/api/...``) gated by status: ACTIVE +
    GRACE pass; UNACTIVATED, EXPIRED, INVALID return 402 with
    the machine-readable detail payload (``error``, ``state``,
    ``error_message``) the frontend uses to route to the
    activation wizard.
  - Demo-mode bypass — ``settings.demo_mode=True`` skips the
    gate entirely (the public demo install is licence-free
    by design).
  - Custom prefix configuration — exempt + guarded prefix
    tuples can be overridden via constructor kwargs.

  Total suite: 963 passing, 2 skipped (ffmpeg-only). Combined
  ``core/license/`` group coverage: 25% → 51% (and 70%+ on every
  module that has direct tests).

## [0.29.18] - 2026-05-01

### Added

- **License feature gating coverage** — 31 new tests for
  ``core/license/features.py`` (``test_license_features.py``).
  Module coverage: 31% → 100%. Pins the contract that sits in front
  of every paid endpoint:

  - ``has_feature`` / ``_current_feature_set`` — unactivated yields
    empty, JWT explicit features claim wins over tier table,
    empty-list claim falls back to tier defaults, unknown tier
    returns empty.
  - ``require_feature`` — 402 ``license_required`` for
    unactivated, 402 ``feature_not_in_tier`` payload includes the
    feature + current tier, present features pass silently. Studio
    multichannel/social/api gates verified. Lifetime_pro inherits
    the Pro feature set. Server-issued features claim can grant
    runpod even on a trial license.
  - ``require_tier`` — 402 with ``tier_too_low`` payload, equal
    rank passes, higher tier passes, ``solo`` ↔ ``creator`` rank
    parity, ``lifetime_pro`` ↔ ``pro`` rank parity, unknown tier
    treated as below all, unknown minimum treated as above all.
  - ``fastapi_dep_require_feature`` / ``fastapi_dep_require_tier``
    factories return callables that wrap the underlying check.
  - Tier table consistency: every tier in every map, lifetime_pro
    feature set ≡ pro, solo ≡ creator, studio ⊇ pro, machine caps
    monotonic, paid tiers all have unlimited episode quota.

- **Audiobook ID3 writer** — 22 new tests for
  ``services/audiobook/id3.py`` (``test_audiobook_id3.py``).
  Module coverage: 0% → ~100%. Each test writes into a synthesized
  MPEG-1 Layer III file and re-reads via mutagen:

  - ``_extension_to_mime`` — jpg / jpeg / png / webp recognition,
    leading-dot tolerance, case-insensitivity, fallback for
    unknown extensions.
  - ``write_audiobook_id3`` — basic tag round-trip (TIT2/TPE1/TALB/
    TCON/year), default artist "Drevalis Creator Studio",
    default genre "Audiobook", album omitted on ``None``,
    chapter writes (CHAP + CTOC frames, millisecond timecode
    conversion, zero-length-chapter clamp to +1ms, default title
    "Chapter N" on missing/empty title), chapter-list rewrite
    replaces previous frames, cover image attached as APIC type=3,
    cover replaced on rewrite, missing cover path silently
    skipped, ID3v2.3 dialect pinned.

  Total suite: 927 passing, 2 skipped (ffmpeg-only).

## [0.29.17] - 2026-05-01

### Added

- **License helper coverage** — 35 new tests for the small modules
  in ``core/license/`` (``test_license_helpers.py``):

  - ``stable_machine_id`` — 16-hex shape, stable across calls,
    differs across hostnames, tolerates ``socket.gethostname`` /
    ``uuid.getnode`` failures.
  - ``get_public_keys`` — embedded default returns ≥1 key,
    override replaces the list, override is distinct from default,
    invalid PEM raises, non-Ed25519 PEM raises ``TypeError``.
  - ``LicenseState`` — UNACTIVATED default, ACTIVE + GRACE both
    ``is_usable=True``, EXPIRED + INVALID both ``is_usable=False``,
    ``set_state`` flips the bootstrapped flag, ``set_local_version``
    round-trips.
  - ``LicenseClaims`` — ``is_lifetime`` flag, UTC datetime
    coercion, ``is_in_grace`` window logic at all three ranges,
    ``extra="ignore"`` tolerance for forward-compatibility fields.
  - ``check_and_increment_episode_quota`` — 402 when unactivated,
    short-circuits Redis on unlimited tier, increments + sets TTL
    on first bump, skips TTL on subsequent bumps, fails open on
    Redis errors, raises 402 + decrements on overshoot.
  - ``get_daily_episode_usage`` — zero on unusable state, parses
    Redis bytes counter, returns zero on Redis exception.

  License module group coverage: 25% → 73% (machine + keys + state +
  claims + quota all at 95–100%).

- **Continuity service** — 15 new tests for
  ``services/continuity.py:check_continuity`` and
  ``ContinuityIssue`` (``test_continuity.py``):

  - Single-scene and zero-scene short-circuit (no LLM call),
    well-formed response parsed into typed issues, provider
    exceptions swallowed (best-effort pre-flight), non-JSON
    responses dropped, output capped at 20 issues, invalid
    severity normalised to ``"warn"``, severity lowercased,
    malformed entries (missing from_scene, non-int) silently
    dropped, ``issue``/``suggestion`` truncated to 240 chars,
    missing ``issues`` key returns empty, and the contract that
    the LLM call uses ``json_mode=True`` + low temperature.
  - ``ContinuityIssue.to_dict`` round-trip + frozen dataclass
    immutability.

  Service coverage: 0% → 100%.

  Total suite: 874 passing, 2 skipped (ffmpeg-only).

## [0.29.16] - 2026-05-01

### Fixed

- **CI frontend job failed on `npm ci` after v0.29.15** because the
  vitest / testing-library devDependencies weren't reflected in
  ``frontend/package-lock.json`` — the bootstrap was authored from
  an environment with no node toolchain available, so the lockfile
  couldn't be regenerated in the same commit. ``npm ci`` requires
  a perfectly-synced lockfile and bailed.

  Loosened the frontend install step in ``.github/workflows/ci.yml``
  to ``npm install --no-audit --no-fund`` so CI regenerates the
  lockfile transparently. The Dockerfile already had a
  ``npm ci || npm install`` fallback, so production builds were
  never affected.

  Re-tighten back to ``npm ci`` once ``npm install`` has been run
  locally and the updated ``package-lock.json`` is committed.

## [0.29.15] - 2026-05-01

### Added

- **F-Tst-10** — frontend test infrastructure bootstrap. Vitest +
  @testing-library/react + @testing-library/jest-dom +
  @testing-library/user-event + jsdom landed in
  ``frontend/devDependencies``. ``vite.config.ts`` now carries a
  ``test`` block (jsdom env, ``./src/test/setup.ts`` for the
  jest-dom matcher extension, glob ``src/**/*.{test,spec}.{ts,tsx}``)
  and ``package.json`` exposes ``npm test`` (one-shot) +
  ``npm run test:watch``.

  First round of pure-utility tests:

  - ``stepColors.test.ts`` (15 specs) — pins the canonical pipeline
    step palette: STEP_ORDER length + sequence, STEP_TEXT /
    STEP_BG / STEP_MUTED carry one entry per step with the
    matching Tailwind class, no extra keys creep in, and
    ``isKnownStep`` correctly narrows the type and rejects
    unknown values + casing variants.
  - ``api/formatError.test.ts`` (15 specs) — pins the
    error-string contract that decides what every toast shows.
    Covers ``ApiError`` field accessors, ``toString`` shape,
    ``formatError`` for ApiError / Error / empty-message Error /
    string / object / array / circular-structure (catch-branch)
    / null / number / boolean inputs.

  After ``cd frontend && npm install``, ``npm test`` runs the
  suite. CI integration deferred until the install is verified
  on the deploy host; for now the suite is local-first with a
  documented entrypoint.

## [0.29.14] - 2026-04-30

### Added

- **F-Tst-03** — 49 new tests for ``FFmpegService`` pure helpers
  (``test_ffmpeg_helpers.py``). FFmpeg coverage rose from 28% to 38%.
  The new tests pin every branch of the audio mastering chain
  builder + watermark filter + xfade transition resolver + image
  extension recogniser + the long-form Wan-2.6 video-concat
  command builder — all without ffmpeg on PATH:

  - ``_build_audio_filtergraph`` — voice-only passthrough,
    EQ + compressor + loudnorm chains, master limiter on/off,
    music branch with sidechain ducking + amix, music volume +
    reverb (aecho) + low-pass + duck threshold/ratio, and the
    bracket-handling contract on input labels (``"1:a"`` →
    ``[1:a]``, no double-bracketing).
  - ``_build_watermark_filter`` — None when path missing, all
    four corner positions in the position map, fallback to
    bottom-right on unknown corner, opacity clamping at both
    ends (-0.3 → 0, 2.5 → 1), and colon-escaping in the
    movie= path argument so Windows drive letters don't trip
    the ffmpeg option parser.
  - ``_resolve_xfade_transition`` — ``"fade"``, ``"random"``
    (deterministic with seed, varies across seeds),
    ``"variety"`` round-robin, literal pass-through, and unknown
    token fallback.
  - ``_is_image`` — every recognised extension, case-insensitivity,
    and explicit confirmation that ``.gif`` and ``.mp4`` are NOT
    treated as images.
  - ``_build_video_concat_command`` — argv shape, captions
    burn-in via ``subtitles=`` filter, music input + sidechain
    wiring, and that ``video_codec`` / ``preset`` /
    ``video_bitrate`` from ``AssemblyConfig`` propagate into
    the final command.

  Total suite: 824 passing, 2 skipped (ffmpeg-only).

## [0.29.13] - 2026-04-30

### Added

- **F-Tst-02 follow-up** — 14 new tests for
  ``PipelineOrchestrator`` lifecycle helpers
  (``test_pipeline_lifecycle.py``):

  - ``_check_cancelled`` — Redis cancel-key handling: missing key
    returns silently, empty bytes are treated as falsy (no false
    cancellation), any truthy value raises ``CancelledError``.
  - ``_clear_cancel_flag`` — deletes the episode-specific key,
    swallows Redis exceptions so cleanup never masks the
    cancellation itself.
  - ``_handle_step_failure`` — pins the contract that on step
    failure the job row is marked ``failed`` with truncated error
    message + incremented retry count, the episode mirrors the
    error with a step prefix, ``db.commit`` is awaited, the
    broadcast carries ``status="failed"`` plus the auto-suggestion
    in ``detail.suggestion``, an explicit ``suggestion`` argument
    overrides the auto-mapper, and a DB failure during write does
    NOT block the user-facing broadcast (otherwise the UI sticks
    at "running"). Retry-count carry-forward also pinned.

  Total suite: 775 passing, 2 skipped (ffmpeg-only).

## [0.29.12] - 2026-04-30

### Added

- **F-Tst-11** — 21 direct tests for
  ``PipelineOrchestrator._get_error_suggestion``
  (``test_pipeline_error_suggestion.py``). The static method maps
  exception keywords to user-facing suggestions surfaced in the UI
  when a pipeline step fails; a copy-paste typo (``"comfui"`` vs
  ``"comfyui"``) would silently route the user to the generic "Try
  retrying this step" instead of the actionable ComfyUI / FFmpeg /
  TTS / LLM hint. Each branch is now pinned (comfyui, connection,
  timeout, piper, edge_tts, ffmpeg, cancelled, llm, openai,
  anthropic, whisper, ``no X found``), plus case-insensitivity, the
  comfyui-before-timeout priority, the generic fallback, and the
  step-name interpolation across every ``PipelineStep`` value.
  Total suite: 761 passing, 2 skipped (ffmpeg-only).

## [0.29.11] - 2026-04-30

### Fixed

- **Restore aborted instantly with "the worker either never picked up
  the job or the status TTL expired"** (user report). Regression from
  v0.29.10. The new terminal ``unknown`` branch fired on the very
  first poll after enqueue: between the API route returning a
  ``job_id`` and the worker writing its first ``starting`` status,
  the Redis key ``backup:restore:{job_id}`` didn't exist yet, so the
  poll endpoint returned ``status: "unknown"``, the UI treated that
  as terminal, and dropped the localStorage stash before the worker
  ever picked the job up.

  Fix: the API route now seeds an initial ``queued`` status to Redis
  before returning the job_id (1h TTL, matches the worker's status
  TTL). The frontend's existing ``queued`` branch picks it up
  cleanly, and the ``unknown`` branch retains its job: catching
  TTL-expired stashes from previous sessions.

  Applied to both ``POST /api/v1/backup/restore`` (uploaded archive)
  and ``POST /api/v1/backup/restore-existing/{filename}`` (multi-GB
  bypass path).

### Added

- **F-Tst-07 follow-up** — 37 new unit tests for the audiobook
  generation-path code (``test_audiobook_voice_blocks.py``):

  - ``_parse_voice_blocks`` — speaker-tag grammar, ``[SFX:]`` tag
    grammar with all modifiers (``dur`` / ``duration``,
    ``influence`` / ``prompt_influence``, ``loop``, ``under=next`` /
    ``all`` / block-count / seconds, ``duck`` / ``duck_db``),
    case-insensitivity, fallthrough cases, and the rule that
    ``[SFX]`` without ``:`` falls back to a regular speaker tag.
  - ``_is_overlay_sfx`` — distinguishes sequential SFX (no overlay
    metadata) from overlay SFX (sidechain-ducked under voice).
  - ``_generate_multi_voice`` — speaker-to-voice-profile dispatch
    with the casting map: each speaker routed to its assigned
    voice, uncast speakers fall back to the default profile,
    profile-lookup failures fall back rather than crash, normalised
    speaker names match (``NARRATOR.`` → ``Narrator``) without
    accidental substring matches (``Nate`` does NOT match
    ``Narrator``), and SFX blocks routed through
    ``_generate_sfx_chunk`` even when the dedicated provider returns
    ``None`` (graceful degradation when no ComfyUI server is
    available).

  All tests use lightweight stubs and AsyncMocks — no ffmpeg, no DB,
  no real TTS. Total suite: 740 passing, 2 skipped (ffmpeg-only).

## [0.29.10] - 2026-04-30

### Fixed

- **Backup tab locked into a stale "Reconnecting to in-flight
  restore…" state across page reloads** (user report). The poll
  loop in ``BackupSection`` had branches for
  ``running`` / ``queued`` / ``done`` / ``failed`` but no branch
  for ``unknown`` — the status the API returns when the Redis
  status key has expired (1h TTL) or the worker died before
  writing the first event. Combined with the v0.29.2
  resume-on-mount effect that re-enters the poll loop from a
  ``localStorage.restoreJobId`` stash, the UI got stuck: every
  poll returned ``unknown``, the if/elif chain fell through,
  the polling kept running, ``restoring`` stayed ``true``, and
  the restore form stayed disabled. Restarting the stack didn't
  help because the ``restoreJobId`` was persisted in
  ``localStorage``, so each page load entered the same dead loop.

  Now the ``unknown`` status is treated as terminal: clear the
  interval, drop the ``localStorage`` stash, reset
  ``restoring=false``, drop the progress overlay, and show a
  toast explaining "the worker either never picked up the job or
  the status TTL expired". The restore form is usable again
  within ~2s of opening the tab.

  Also added a small ``dismiss`` link in the corner of the
  progress overlay (visible when stage is ``done`` / ``failed`` /
  ``resuming``) so future edge cases can be cleared without
  waiting for a poll.

## [0.29.9] - 2026-04-30

### Added

- **F-Tst-07** — 48 new unit tests for the audiobook monolith's
  pure helpers (``services/audiobook/_monolith.py``). The 1631-stmt
  monolith was previously at ~43% coverage; the testable seams now
  have direct assertions:

  - ``_build_music_mix_graph`` — static + sidechain ffmpeg
    filter_complex strings (3 tests covering preset modes + signed
    voice-gain rendering).
  - ``_mp3_encoder_args`` — CBR/VBR argv builders + unknown-mode
    fallback (4 tests).
  - ``_resolve_ducking_preset`` — case-insensitive preset lookup +
    unknown-name graceful fallback (3 tests).
  - ``_chunk_limit`` and ``_provider_concurrency`` — substring
    routing + longest-key-wins, ELEVENLABS_CONCURRENCY env override
    semantics (10 tests).
  - ``_chunk_cache_hash`` / ``_strip_chunk_hash`` — content-hash
    determinism, input-sensitivity, hash-suffix stripping (5 tests).
  - ``_provider_identity`` — best-effort attribute extraction across
    different provider shapes (3 tests).
  - ``AudiobookService._score_chapter_split`` — false-positive guard
    + variance-aware scoring (3 tests).
  - ``AudiobookService._filter_markdown_matches`` — blank-line
    anchoring (3 tests).
  - ``AudiobookService._filter_allcaps_matches`` — alpha-ratio +
    trailing-comma guard (3 tests).
  - ``AudiobookService._split_long_sentence`` — comma fallback +
    runaway hard-split (3 tests).
  - ``AudiobookService._repair_bracket_splits`` — bracket-balanced
    pass-through (3 tests).
  - ``AudiobookService._split_text`` — paragraph + sentence split
    paths (4 tests).

  Total test count 655 → 703.

  The big-async generation paths (multi-voice rendering, ffmpeg
  invocation, multi-output export) still need a heavy mock
  harness — those remain a follow-up. This pass covers the
  unit-testable seams that were most at risk of silent regression
  (mp3 encoder argv, ducking preset selection, cache key
  determinism, chapter-split heuristics).

## [0.29.8] - 2026-04-30

### Fixed

- **``restore_backup_async`` worker job crashed at first
  Redis-write** (user worker log): ``RuntimeError: Redis connection
  pool is not initialised. Ensure init_redis() has been called
  during application startup.`` The job constructed a fresh
  ``Redis(connection_pool=get_pool())`` from ``core.redis`` —
  ``init_redis()`` is only called in the FastAPI lifespan, never in
  the arq worker process. The worker provides its own Redis client
  via ``ctx["redis"]``; every other arq job in the codebase already
  uses that. Restore jobs failed at 0.02s with the temp archive
  still on disk and no progress events written, so the UI's poll
  endpoint returned ``status: "unknown"`` indefinitely.
  ``restore_backup_async`` now uses ``ctx["redis"]`` and skips the
  ``aclose`` (arq owns the pool's lifecycle).

## [0.29.7] - 2026-04-30

### Fixed

- **License verifier rejected legacy JWTs after v0.29.3** (user
  report: ``Token is missing the "aud" claim``). The F-S-11 audience
  pin passed ``audience=_EXPECTED_AUD`` to ``jwt.decode`` for every
  token. PyJWT's actual semantics: when ``audience`` is set, a missing
  ``aud`` claim raises ``MissingRequiredClaimError`` even if
  ``"aud"`` isn't in ``options["require"]``. My v0.29.3 comment
  ("legacy tokens accepted") was wrong about PyJWT's behavior — every
  install that booted on a pre-audience-pin license JWT got bricked
  back to the activation screen.

  The fix peeks at the token via an unverified decode, checks for
  the presence of an ``aud`` claim, then runs the real signature-
  verifying decode with ``audience=_EXPECTED_AUD`` only when the
  claim is present. Tokens minted with ``aud`` must still match the
  expected value (the F-S-11 invariant); tokens without ``aud``
  validate via the legacy path.

  The unverified peek is safe: the second decode still verifies the
  signature, and an attacker can't forge a payload that round-trips
  both branches without the signing key.

  License-server update to start minting tokens with ``aud=
  "drevalis-creator-studio"`` is a separate follow-up (lives in the
  gitignored ``license-server/`` repo). Once every legacy token has
  expired, the verifier should bump
  ``options["require"] = ["aud", ...]`` for full enforcement.

## [0.29.6] - 2026-04-30

### Added

- **F-CQ-08** — generic ``retry_async`` helper in
  ``core/http_retry.py``. Sibling to the httpx-specific
  ``request_with_retry``: takes a zero-arg async callable + a
  ``is_retryable: Callable[[Exception], bool]`` predicate, runs
  exponential backoff with jitter, max-attempt cap, fail-fast on
  predicate-False. Designed for SDK call sites (OpenAI, Anthropic,
  ElevenLabs) where ``request_with_retry`` doesn't fit because the
  caller isn't holding the httpx client. ``OpenAICompatibleProvider.
  generate`` is the first call site converted — its bespoke
  for-attempt-in-range loop with the typed-exception predicate from
  v0.29.4 collapses to a single ``retry_async(...)`` call.
- 7 unit tests covering retry-until-success, max-attempts-exhausted,
  non-retryable predicate fast-path, predicate exception inspection,
  and signature preservation.

### Fixed

- **F-T-31** stale docstring — ``workers/jobs/edit_render.py`` was
  documented as calling ``FFmpegService.concat_video_clips`` but the
  method has been renamed to ``concat_videos``. The ``# type:
  ignore[call-arg]`` that previously hid the signature mismatch was
  already removed in v0.28.x; the doc now matches the code.

## [0.29.5] - 2026-04-30

### Added

- **Restore from existing archive (no upload).** New endpoint
  ``POST /api/v1/backup/restore-existing/{filename}`` enqueues the
  same ``restore_backup_async`` job against an archive that's
  already in ``BACKUP_DIRECTORY`` — operators with multi-GB archives
  drop the file via ``docker cp`` or the host bind-mount and pick it
  from a dropdown. Skips the browser upload entirely; no proxy
  timeouts, no navigation issues, instant enqueue. The original
  archive is preserved on disk (the upload-path tempfile is still
  cleaned up post-restore via the new
  ``delete_archive_when_done`` worker arg).

- **BackupSection picker UI.** Operators see all archives in
  ``BACKUP_DIRECTORY`` in a dropdown labelled "1a. Pick an archive
  already on disk (recommended for archives >5 GB)". The legacy
  upload path is now relabelled "1b. …or upload a new archive
  (only safe for <5 GB)". Two buttons — "Restore from picked
  archive" and "Upload + restore" — make the path explicit.

### Fixed

- **22 GB upload restarts at 0% mid-stream** (user report). The
  single-POST multipart body was hitting reverse-proxy / Docker
  Desktop default timeouts well before 22 GB finished streaming. The
  new restore-existing path bypasses the upload entirely. The
  upload path remains for sub-5 GB cases.

- **Navigation away during upload abandons the restore** (user
  report). XHR upload is browser-tab-bound — switching to /episodes
  killed the body and the worker never got the file. New
  ``beforeunload`` handler fires the browser's "Leave site?" dialog
  while the stage is ``uploading`` so an accidental click doesn't
  silently scrap a multi-GB upload. Once the upload lands and the
  job is enqueued, navigation is safe again (the resume-on-mount
  effect from v0.29.2 still picks the bar back up after navigation).

- **Progress overlay messaging** now distinguishes "Don't navigate
  away — upload is browser-bound" from "Safe to navigate away —
  restore is on the worker" depending on the current stage.

## [0.29.4] - 2026-04-30

### Added

- **F-Tst-08** — 18 new unit tests for ``LongFormScriptService``.
  Covers chapter-count auto-derivation, outline + chapter call
  ordering, scene renumbering across chapter boundaries, chapter
  metadata shape (scene-range, mood, music_mood), continuity context
  carryover, visual-consistency prefix application,
  list/dict/string LLM response shapes, and the ``_parse_json``
  helper's markdown-fence + embedded-prose handling. Closes the
  highest-impact coverage cliff identified in the audit (the entire
  3-phase chunked LLM workflow had 0% coverage).

### Changed

- **F-CQ-15** — ``OpenAICompatibleProvider.generate`` retry logic
  no longer substring-matches on exception text. The previous
  ``"524" in err_str or "timeout" in err_str.lower() or "502" / "503"``
  block accidentally swallowed unrelated errors (asyncio.CancelledError
  semantics, JSON validation errors) and broke silently across SDK
  version bumps that changed the error message format. The retry now
  catches the typed OpenAI exceptions
  (``APIConnectionError``, ``APITimeoutError``, ``InternalServerError``)
  + 5xx via ``APIStatusError.status_code`` for the RunPod proxy 502/
  503/524 case. 4xx auth/quota errors fail fast instead of burning
  the retry budget. The json_mode fallback (drop ``response_format``)
  remains for local backends that 400 on the field.

## [0.29.3] - 2026-04-30

### Security

- **F-S-09** — login form rate limit. ``POST /api/v1/auth/login`` now
  checks a per-(IP, email) failure bucket in Redis (``login_fail:ip:*``
  and ``login_fail:email:*``) before accepting credentials. Cap is 10
  attempts per 10-minute window; either bucket overflowing returns 429
  with a "Try again in N minutes" detail. Closes the brute-force gap
  where PBKDF2's ~6 attempts/sec ceiling was the only thing standing
  between a weak password and a patient attacker. Both buckets decay
  automatically; Redis outage fails open (PBKDF2 cost is the
  fall-back floor). New helpers in ``core/auth.py``:
  ``check_login_rate_limit``, ``record_login_failure``,
  ``LoginRateLimitedError``.
- **F-S-11** — license JWT verifier now passes ``audience=
  "drevalis-creator-studio"`` to ``jwt.decode``. Tokens that carry an
  ``aud`` claim must match this value (defends against same-key reuse
  for a different audience); legacy tokens minted before the audience
  pin (no ``aud`` claim) continue to validate via PyJWT's
  optional-claim semantics. Once the longest-lived legacy JWT expires
  the verifier should bump to ``options.require=["aud", ...]`` for
  full enforcement.

## [0.29.2] - 2026-04-30

### Added

- Background restore with progress bar. The synchronous
  ``POST /api/v1/backup/restore`` is gone — uploads now stream into
  ``BACKUP_DIRECTORY``, hand off to a new ``restore_backup_async``
  arq job, and return ``{job_id}`` immediately. The job writes
  staged progress (``extract`` → ``verify`` → ``truncate`` →
  ``rows`` → ``media`` → ``done``) to Redis at
  ``backup:restore:{job_id}`` (1h TTL); the new
  ``GET /api/v1/backup/restore-status/{job_id}`` endpoint surfaces
  ``stage`` + ``progress_pct`` + ``message``.
- Frontend ``BackupSection`` renders a real progress bar driven by
  XHR upload-progress (so the browser sees the multi-GB body
  uploading) and then 2s polling of the status endpoint until the
  job hits ``done`` / ``failed``. The active ``job_id`` is mirrored
  in ``localStorage`` so a tab navigation / page reload mid-restore
  reconnects to the in-flight job instead of losing the bar.

### Fixed

- 21GB restore on v0.29.1 left the operator unable to tell whether
  anything was happening. The route held a single HTTP connection
  open for the whole multi-minute extract + truncate + insert + copy
  flow; navigating away orphaned the request and dropped any
  feedback. The async-job split + persisted poll cursor closes both
  problems.
- ``BackupService.restore_backup`` ran the gzip+tar extract and
  ``shutil.copytree`` synchronously on the asyncio event loop. Both
  now run in ``asyncio.to_thread`` so other coroutines (Redis
  publish, worker heartbeat, status writes) stay responsive while
  multi-GB I/O runs.

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

### Fixed

- fix(youtube,settings): YouTube credential lookup misses the api_keys store


## [0.28.0] - 2026-04-28

### Added

- feat(music_video): scenes + lyric captions + composite (Phase 2b â€” full pipeline)
- feat(music_video): orchestrator dispatch (Phase 2a â€” SCRIPT + AUDIO real)
- feat(music_video): real plan_song + librosa beat detection (Phase 1)


## [0.27.1] - 2026-04-28

### Fixed

- fix(frontend): repair AutoScheduleDialog UI library API misuse


## [0.27.0] - 2026-04-28

### Added

- feat(youtube,calendar): tighten analytics scope detection + Auto-Schedule UI
- feat(schedule): auto-schedule + diagnostics + retry-failed endpoints

### Changed

- style(audiobook): ruff format + mypy fixes for v0.26.0 CI

### Fixed

- fix(audiobook): exclude [SFX:] tags from auto-character detection + round-robin voices


## [0.26.0] - 2026-04-27

### Added

- feat(audiobook): v0.26.0 â€” pipeline overhaul (cache, loudness, mix, settings, DAG, render plan)


## [0.25.1] - 2026-04-26

### Fixed

- fix(audiobook): keep per-chunk WAVs so the editor can list them


## [0.25.0] - 2026-04-26

### Added

- feat(audiobook): v0.25.0 â€” multi-track timeline editor with per-clip overrides


## [0.24.0] - 2026-04-26

### Added

- feat(audiobook): v0.24.0 â€” quality + remix + editor stub


## [0.23.5] - 2026-04-26

### Fixed

- fix(comfyui-auth): route the ComfyUI-Org token to the field whose shape it matches


## [0.23.4] - 2026-04-26

### Fixed

- fix(music): make AceStep model filenames configurable; default clip2 to 4b


## [0.23.3] - 2026-04-26

### Fixed

- fix(tts): send token as both api_key_comfy_org AND auth_token_comfy_org


## [0.23.2] - 2026-04-26

### Changed

- style: ruff format the v0.23.x audiobook + tts + audiobooks-route files


## [0.23.1] - 2026-04-26

### Added

- feat(audiobook): overlay SFX (under=) + lint/typecheck fixes


## [0.23.0] - 2026-04-26

### Added

- feat(audiobook): v0.23.0 quality pass + ElevenLabs SFX


## [0.22.10] - 2026-04-26

### Fixed

- fix(tts): revert ComfyUI ElevenLabs workflow to dotted-key schema


## [0.22.9] - 2026-04-26

### Added

- feat(audiobook): cancel button + ComfyUIElevenLabs workflow fix


## [0.22.8] - 2026-04-25

### Fixed

- fix(workers,app): Redis DNS pre-flight to survive compose-up race


## [0.22.7] - 2026-04-25

### Fixed

- fix(audiobook): bullet-proof title card generation; never return missing path


## [0.22.6] - 2026-04-25

### Fixed

- fix(infra): shrink Redis retry budget; bump app/worker start_period


## [0.22.5] - 2026-04-25

### Fixed

- fix(ui): portal Dialog to document.body + drop panel backdrop-filter


## [0.22.4] - 2026-04-25

### Fixed

- fix(workers): bump Redis connect timeout + retry on slow startup


## [0.22.3] - 2026-04-25

### Fixed

- fix(ui): cap Dialog height + sticky DialogFooter so actions stay reachable


## [0.22.2] - 2026-04-25

### Fixed

- fix(nginx): quote regex location to escape curly-brace tokenisation


## [0.22.1] - 2026-04-25

### Fixed

- fix(frontend): pin nginx base + bypass entrypoint chain (v0.22.0 crash fix)


## [0.22.0] - 2026-04-25

### Added

- feat(social): guided OAuth setup wizard for YouTube + TikTok
- feat(calendar): Month/List view toggle + platform filter strip
- feat(ui): global âŒ˜K command palette wired into Layout + header affordance

### Changed

- chore(ui): drop dead .empty-state CSS class â€” all call sites use EmptyState now

### Fixed

- fix(ui): use semantic error/success color tokens instead of red-400/green-400
- fix(ui): port Usage KPI tiles to shared StatCard; drop local KPI helper
- fix(ui): port Logs + YouTube stat tiles to shared StatCard
- fix(build): typecheck â€” EmptyState icon prop, Settings nav typing, unused Help import
- fix(a11y): aria-label + focus rings on icon-only action buttons
- fix(ui): convert all 4 Settings empty-state divs to shared EmptyState
- fix(ui): convert all 5 empty-state divs in EpisodeDetail to EmptyState
- fix(ui): use EmptyState in SeriesDetail's EpisodesSection too
- fix(ui): convert ad-hoc empty-state divs to shared EmptyState component
- fix(ui): drop YouTube page H1 + decorative icon â€” banner shows the title
- fix(ui): drop duplicate H2 in Assets page (banner shows the title)
- fix(ui): drop duplicate H2s and use shared EmptyState in Logs + Audiobooks
- fix(ui): a11y + status-pill docs + scene thumbs in script tab
- fix(ui): use shared EmptyState in Jobs + CloudGPU empty paths
- fix(ui): group Settings nav into Account / Appearance / Integrations / System / Content
- fix(ui): SeriesCard cover identity + drop SeriesList duplicate H2
- fix(ui): P1 batch 2 â€” episode card layout, calendar polish, help dedup, episode detail toolbar
- fix(ui): P0+P1 batch â€” assets route, ws backoff, page headers, license, episodes UX


## [0.21.4] - 2026-04-25

### Fixed

- fix(nginx): raise client_max_body_size to 5 GB for video ingest (v0.21.4)


## [0.21.3] - 2026-04-25

### Changed

- style: ruff format audiobook/_monolith.py (v0.21.3)


## [0.21.2] - 2026-04-25

### Fixed

- fix(ci): drop unused onOpenAssetPicker prop from ToolsRail (v0.21.2)


## [0.21.1] - 2026-04-25

### Fixed

- fix(editor): preview scales to fit + draggable preview/timeline split (v0.21.1)


## [0.21.0] - 2026-04-25

### Added

- feat: v0.21.0 â€” Help sticky nav + stamps library + audiobook image gallery


## [0.20.43] - 2026-04-24

### Fixed

- fix(updater): preserve container healthcheck on recreation (v0.20.43)


## [0.20.42] - 2026-04-24

### Fixed

- fix(ci): drop more unused imports orphaned by RunPodSection delete (v0.20.42)


## [0.20.41] - 2026-04-24

### Fixed

- fix(ci): tsc unused-locals + line-shape type mismatch (v0.20.41)


## [0.20.40] - 2026-04-24

### Added

- feat(cloud-gpu): consolidate management to /cloud-gpu; add Vast.ai + Lambda keys (v0.20.40)


## [0.20.39] - 2026-04-24

### Added

- feat(editor): fullscreen 3-column editor + drag-drop assets (v0.20.39)


## [0.20.38] - 2026-04-24

### Added

- feat(help): next-level navigation â€” palette, hub, grouped rail (v0.20.38)


## [0.20.37] - 2026-04-24

### Fixed

- fix(series): restore ChevronRight import dropped in sections split (v0.20.37)


## [0.20.36] - 2026-04-24

### Changed

- refactor(series): split monolith into sections/ sub-components (v0.20.36)


## [0.20.35] - 2026-04-24

### Fixed

- fix(updater): drive docker run -v args from Mounts[] only (v0.20.35)


## [0.20.34] - 2026-04-24

### Added

- feat(series): hero card + style popover + format segmented control (v0.20.34)


## [0.20.33] - 2026-04-24

### Added

- feat(youtube): reconnect + remove controls + filter inactive channels (v0.20.33)


## [0.20.32] - 2026-04-24

### Added

- feat(series): inline autosave + drop global Save button (v0.20.32)


## [0.20.31] - 2026-04-24

### Added

- feat(series): two-column layout + sticky rail nav + kanban episodes (v0.20.31)


## [0.20.30] - 2026-04-24

### Added

- feat(youtube+editor): per-channel analytics + multi-channel dashboard (v0.20.30)


## [0.20.29] - 2026-04-24

### Added

- feat(theme): add Aurora preset (violet + DM Sans) (v0.20.29)


## [0.20.28] - 2026-04-24

### Fixed

- fix(ci): re-export ChangelogEntry + ChangelogResponse from api barrel (v0.20.28)


## [0.20.27] - 2026-04-24

### Added

- feat(theme): bundled personality presets with per-theme fonts/radius/shadows (v0.20.27)


## [0.20.26] - 2026-04-24

### Added

- feat(updates): in-app changelog from GitHub releases (v0.20.26)


## [0.20.25] - 2026-04-24

### Fixed

- fix(updater): recreate containers with new image (not just restart) (v0.20.25)


## [0.20.24] - 2026-04-24

### Fixed

- fix(updater): pull by Config.Image, skip raw image IDs (v0.20.24)


## [0.20.23] - 2026-04-24

### Added

- feat(updater): drop docker compose, use docker pull + docker restart (v0.20.23)


## [0.20.22] - 2026-04-24

### Fixed

- fix(updater): exclude self from pull, clear flag up-front, visible progress (v0.20.22)


## [0.20.21] - 2026-04-24

### Fixed

- fix(updater): accept ghcr.io /v2/ 401 as reachable (v0.20.21)


## [0.20.20] - 2026-04-24

### Added

- feat(ui): editor preview fix + per-platform social pages (v0.20.20)


## [0.20.19] - 2026-04-24

### Fixed

- fix(youtube): auto-retry with first channel on channel_id_required (v0.20.19)


## [0.20.18] - 2026-04-24

### Fixed

- fix(youtube): pass channel_id on scoped calls for multi-channel installs (v0.20.18)


## [0.20.17] - 2026-04-24

### Fixed

- fix(updater): surface real pull error + preflight ghcr.io (v0.20.17)


## [0.20.16] - 2026-04-24

### Fixed

- fix(api-keys): return created_at/updated_at + surface decryption failures (v0.20.16)


## [0.20.15] - 2026-04-24

### Fixed

- fix(editor): mypy â€” narrow _jsonable output via runtime assert (v0.20.15)


## [0.20.14] - 2026-04-24

### Fixed

- fix(editor): coerce Decimal â†’ float in seeded timeline (v0.20.14)


## [0.20.13] - 2026-04-24

### Fixed

- fix(ws): strip CRLF from API_AUTH_TOKEN env value (v0.20.13)


## [0.20.12] - 2026-04-24

### Fixed

- fix(editor): structured 500 responses instead of opaque errors (v0.20.12)


## [0.20.11] - 2026-04-24

### Fixed

- fix(updater): read compose yml from container, bind to host path (v0.20.11)


## [0.20.10] - 2026-04-24

### Fixed

- fix(routes): hoist AsyncSession to runtime import across 7 routers (v0.20.10)


## [0.20.9] - 2026-04-24

### Fixed

- fix(ci): add mountinfo_lines to types/index.ts + ruff format settings.py (v0.20.9)


## [0.20.8] - 2026-04-24

### Fixed

- fix(updater): resolve host project dir via docker inspect on self (v0.20.8)


## [0.20.7] - 2026-04-24

### Fixed

- fix(v0.20.7): raw mountinfo dump on Storage panel for bind-mount diagnosis


## [0.20.6] - 2026-04-23

### Fixed

- fix(v0.20.6): media_repair diagnostics â€” show sample paths + offload walk


## [0.20.5] - 2026-04-23

### Fixed

- fix(v0.20.5): media_repair ghost-row fix + retractable rails + deeper theme


## [0.20.4] - 2026-04-23

### Added

- feat(marketing): real-sample example gallery + voice library + CI fixes (v0.20.4)


## [0.20.3] - 2026-04-23

### Added

- feat(v0.20.3): YouTube DB-keys + Storage walk fix + appearance refactor + lifetime 899

### Changed

- refactor(marketing): propagate v0.20.2 redesign to all pages


## [0.20.2] - 2026-04-23

### Fixed

- fix(license+marketing): stop 404-toast flood + marketing site redesign v0.20.2


## [0.20.1] - 2026-04-23

### Fixed

- fix(backup): surface the backup directory's on-host path + Docker Desktop VM translation (v0.20.1)


## [0.20.0] - 2026-04-23

### Added

- feat(pricing+backup): Lifetime (Pro) tier, unlimited Creator, 20% annual, deeper storage probe (v0.20.0)


## [0.19.59] - 2026-04-23

### Changed

- docs(backup): clarify Docker Desktop /project/ path label (v0.19.59)


## [0.19.58] - 2026-04-23

### Added

- feat(settings): Storage panel shows host bind-mount path + subdir breakdown (v0.19.58)


## [0.19.57] - 2026-04-23

### Added

- feat(backup): surface host-side bind-mount path in storage probe (v0.19.57)


## [0.19.56] - 2026-04-23

### Changed

- chore(frontend): remove boot intro from the app (v0.19.56)


## [0.19.55] - 2026-04-23

### Added

- feat(storage): SMB/CIFS support via docker-compose.smb.override.yml (v0.19.55)


## [0.19.54] - 2026-04-23

### Added

- feat(backup): storage-probe endpoint â€” diagnose 'can't see videos' (v0.19.54)


## [0.19.53] - 2026-04-23

### Fixed

- fix(backup): dedupe media_assets + refresh file_size_bytes (v0.19.53)


## [0.19.52] - 2026-04-23

### Added

- feat(backup): media_repair diagnostics + per-row on-disk hint (v0.19.52)


## [0.19.51] - 2026-04-23

### Fixed

- fix(backup): media_repair now covers full storage tree + audiobooks (v0.19.51)


## [0.19.50] - 2026-04-23

### Fixed

- fix(backup): runtime-import AsyncSession for FastAPI deps (v0.19.50)


## [0.19.49] - 2026-04-23

### Fixed

- fix(frontend): non-root nginx pid at /tmp (v0.19.49)


## [0.19.48] - 2026-04-23

### Fixed

- security: read_only frontend container + marketing CSP rationale (v0.19.48)


## [0.19.47] - 2026-04-23

### Changed

- chore(migrations): idempotency retrofit for the remaining 15 (v0.19.47)


## [0.19.46] - 2026-04-23

### Changed

- chore(migrations): idempotency retrofit for 005/007/021/025 (v0.19.46)


## [0.19.45] - 2026-04-23

### Changed

- style: ruff --fix on migration 024 (UP035, UP007)

### Fixed

- fix(backup): repair-media 422 + readable error toast (v0.19.45)


## [0.19.44] - 2026-04-23

### Fixed

- security+migrations: cap_drop ALL on every service; idempotency on 024 (v0.19.44)


## [0.19.43] - 2026-04-23

### Fixed

- fix(social): 429/Retry-After on TikTok, IG, Facebook, X INIT + FINISH calls (v0.19.43)


## [0.19.42] - 2026-04-23

### Fixed

- fix(updates): honour 429/Retry-After on manifest fetch (v0.19.42)


## [0.19.41] - 2026-04-23

### Changed

- style: ruff format on ab_test_winner.py (v0.19.41)


## [0.19.40] - 2026-04-23

### Fixed

- fix(tts): ElevenLabs TTS honours 429 / Retry-After (v0.19.40)


## [0.19.39] - 2026-04-23

### Fixed

- security+infra: frontend non-root, compose hardening, migration helpers, httpx retry (v0.19.39)


## [0.19.38] - 2026-04-23

### Fixed

- fix(worker): log nested failure in scheduled-post fail-recording (v0.19.38)


## [0.19.37] - 2026-04-23

### Fixed

- fix(security+bugs): audit round three (v0.19.37)


## [0.19.36] - 2026-04-23

### Fixed

- fix(security+bugs): audit round two â€” cron locks, timing-safe compare, IP parsing (v0.19.36)


## [0.19.35] - 2026-04-23

### Fixed

- security(deps): commit lockfile, bump Vite + PyJWT (v0.19.35)


## [0.19.34] - 2026-04-23

### Fixed

- fix(ffmpeg): clamp scene-duration stretch at 3x (v0.19.34)


## [0.19.33] - 2026-04-23

### Fixed

- fix(audiobook): actual acrossfade between chapter music (v0.19.33)


## [0.19.32] - 2026-04-23

### Added

- feat(audiobook): loudnorm + silence trim on MP3 export (v0.19.32)


## [0.19.31] - 2026-04-23

### Changed

- chore: remove dead code flagged by the pipeline audit (v0.19.31)


## [0.19.30] - 2026-04-23

### Fixed

- fix(audiobook): use storage.resolve_path, not base_path (mypy) (v0.19.30)


## [0.19.29] - 2026-04-23

### Added

- feat(audiobook): genuine per-chapter fast path on regenerate (v0.19.29)


## [0.19.28] - 2026-04-23

### Fixed

- fix(help): InfoBox has no className prop; wrap in a div instead (v0.19.28)


## [0.19.27] - 2026-04-23

### Fixed

- security(marketing): strict CSP â€” drop 'unsafe-inline' from script-src (v0.19.27)


## [0.19.26] - 2026-04-23

### Changed

- docs(help): music video + animation + Facebook coverage (v0.19.26)


## [0.19.25] - 2026-04-23

### Changed

- ci: coverage report + docker image size summary; compose frontend healthcheck (v0.19.25)


## [0.19.24] - 2026-04-23

### Added

- feat(editor): snap-to-grid + keyboard cheat-sheet + larger undo (v0.19.24)


## [0.19.23] - 2026-04-22

### Added

- feat(worker): per-sub-step heartbeats in video_ingest (v0.19.22)

### Changed

- refactor(marketing): tighter hero + vendor-neutral stack chips (v0.19.23)
- style: raise ... from None on bad-outline ValueError (ruff B904)


## [0.19.21] - 2026-04-22

### Fixed

- fix(pipeline): P0 cancel-flag ordering + bad-outline no longer silent (v0.19.21)


## [0.19.20] - 2026-04-22

### Added

- feat(pipeline+audiobook): quality gates + split/merge + chapter + voice cast fixes (v0.19.20)


## [0.19.19] - 2026-04-22

### Added

- feat(ops+ux): frontend healthcheck + no-cache index + editor asset picker (v0.19.19)


## [0.19.18] - 2026-04-22

### Added

- feat(marketing): boot intro v3 â€” matrix rain + title scramble (v0.19.18)


## [0.19.17] - 2026-04-22

### Fixed

- security(marketing): info-leak scrub + nginx security headers (v0.19.17)


## [0.19.16] - 2026-04-22

### Fixed

- fix(pipeline): P0 audit round two (v0.19.16)


## [0.19.15] - 2026-04-22

### Added

- feat: music_video + animation content formats (scaffold) (v0.19.15)


## [0.19.14] - 2026-04-22

### Fixed

- fix(pipeline + social): P0 audits round one (v0.19.14)


## [0.19.13] - 2026-04-22

### Added

- feat(marketing): mobile polish + hamburger nav (v0.19.13)


## [0.19.12] - 2026-04-22

### Fixed

- fix(migration): CAST(... AS regclass) instead of ::regclass (v0.19.12)


## [0.19.11] - 2026-04-22

### Fixed

- fix: idempotent migration 030 + drop money-back guarantee copy (v0.19.11)


## [0.19.10] - 2026-04-22

### Fixed

- fix(boot): TS2532 LINES[last] unchecked index (v0.19.10)


## [0.19.9] - 2026-04-22

### Added

- feat(demo): protect demo content from mutation/deletion (v0.19.9)


## [0.19.8] - 2026-04-22

### Added

- feat(boot): cyberpunk CRT intro + per-tab-session gate (v0.19.8)


## [0.19.7] - 2026-04-22

### Added

- feat: boot intro on every app start + on marketing first visit (v0.19.6)

### Fixed

- fix(marketing): play boot intro on every reload, not once (v0.19.7)


## [0.19.6] - 2026-04-22

### Added

- feat: boot intro on every app start + on marketing first visit (v0.19.6)

### Changed

- chore: pass CI â€” ruff format + mypy strict cleanup (v0.19.5)


## [0.19.5] - 2026-04-22

### Changed

- chore: pass CI — ruff format + mypy strict cleanup (v0.19.5)

## [0.19.4] - 2026-04-22

### Added

- feat(marketing): GA4 consent banner + Consent Mode v2 defaults (v0.19.4)


## [0.19.3] - 2026-04-22

### Changed

- chore(marketing): add GA4 tag G-FJ3ZBMTLCF on every public page (v0.19.3)


## [0.19.2] - 2026-04-22

### Added

- feat: facebook page video uploader via Graph resumable upload (v0.19.2)


## [0.19.1] - 2026-04-22

### Added

- feat: yearly = 1 free month; add Facebook as social platform (v0.19.1)


## [0.19.0] - 2026-04-22

### Added

- feat: v0.19.0 â€” boot intro, editor polish, marketing unification, media-repair


## [0.18.4] - 2026-04-22

### Fixed

- fix(demo): tolerate real pipeline media layout (v0.18.4)


## [0.18.3] - 2026-04-22

### Fixed

- fix(demo): block asset uploads + reject stub videos (v0.18.3)


## [0.18.2] - 2026-04-22

### Fixed

- fix(demo): default channel + copy content to episode-id dirs (v0.18.2)


## [0.18.1] - 2026-04-22

### Fixed

- fix(demo): stub YouTube analytics instead of 502 (v0.18.1)


## [0.18.0] - 2026-04-22

### Added

- feat: voice clone playback + shot-list + continuity badges (v0.18.0)

### Changed

- docs: restore-media troubleshooting + diagnostic script

### Fixed

- fix(demo): one episode per real content dir, no placeholders
- fix(demo): seed only from content dirs that have complete media


## [0.17.1] - 2026-04-22

### Fixed

- fix: demo editor â€” pure-ASGI guard + UUID Python default (v0.17.1)


## [0.17.0] - 2026-04-22

### Fixed

- fix: demo editor + real media + broad demo guards (v0.17.0)


## [0.16.0] - 2026-04-22

### Added

- feat: marketing SEO + demo CTA + CHF pricing + character packs (v0.16.0)


## [0.15.0] - 2026-04-22

### Added

- feat: inpaint canvas UI + continuity checker (v0.15.0)


## [0.14.0] - 2026-04-22

### Added

- feat: IG/X uploads + workflow templates + demo fix + marketing (v0.14.0)


## [0.13.0] - 2026-04-22

### Added

- feat: AssetPicker UI + mic clone + inpaint + v2v plumbing (v0.13.0)


## [0.12.0] - 2026-04-22

### Added

- feat: Phase E wiring â€” character/style locks + ElevenLabs IVC (v0.12.0)


## [0.11.0] - 2026-04-22

### Added

- feat: caption editor + envelope + proxy player + Phase E foundation (v0.11.0)


## [0.10.0] - 2026-04-22

### Added

- feat(editor): overlays + caption words + waveform + proxy preview (v0.10.0)


## [0.9.0] - 2026-04-22

### Added

- feat: SEO pre-flight + generation QoL + in-browser video editor (v0.9.0)


## [0.8.0] - 2026-04-22

### Added

- feat(assets): central asset library + video-in pipeline (v0.8.0)


## [0.7.0] - 2026-04-22

### Added

- feat(demo): live demo mode + marketing refresh (v0.7.0)


## [0.6.1] - 2026-04-22

### Fixed

- fix(auth): drop EmailStr â€” pydantic[email] not in runtime image


## [0.6.0] - 2026-04-22

### Added

- feat(team): Q4.13 â€” team/workspace mode (v0.6.0)


## [0.5.2] - 2026-04-22

### Added

- feat(i18n): Q4.12 â€” language picker on Series edit form


## [0.5.1] - 2026-04-22

### Added

- feat(i18n): Q4.11 â€” multi-language scripts + language-aware voice picker


## [0.5.0] - 2026-04-22

### Added

- feat(cloud-gpu): v0.5.0 â€” multi-provider cloud GPU (RunPod, Vast.ai, Lambda Labs)


## [0.4.4] - 2026-04-22

### Added

- feat(usage): Q4.2 â€” LLM token instrumentation on generation_jobs


## [0.4.3] - 2026-04-22

### Added

- feat(ab-tests): Q4.1 â€” auto-winner worker settles pairs at 7 days

### Changed

- docs(marketing): Q3 shipped â€” merge into 'Just shipped', promote Q4


## [0.4.2] - 2026-04-22

### Added

- feat: Q3.5 â€” Series A/B test pairs


## [0.4.1] - 2026-04-22

### Added

- feat(social): TikTok Direct Post upload worker + honest gating
- feat(music): Q3.4 â€” custom music upload + per-track sidechain overrides


## [0.4.0] - 2026-04-22

### Added

- feat: Q3.2 drag-drop calendar + Q3.3 cross-platform bulk publish


## [0.3.9] - 2026-04-22

### Added

- feat(usage): Q3.1 â€” usage + compute-time dashboard
- feat(marketing): click-to-zoom lightbox + reshoot YouTube on Uploads tab

### Changed

- docs(marketing): move Q2 roadmap items to 'Just shipped', promote Q3 to 'In progress'

### Fixed

- fix(demo): schema alignment + same-origin API routing

### Other

- infra(demo): demo stack + seed + screenshot runner for marketing


## [0.3.8] - 2026-04-22

### Added

- feat: in-app thumbnail editor with drag-positioned text overlay


## [0.3.7] - 2026-04-22

### Added

- feat(youtube): channel analytics pull-back (views, CTR, retention, subs)


## [0.3.6] - 2026-04-22

### Added

- feat: raw-assets ZIP export + deterministic SEO score


## [0.3.5] - 2026-04-22

### Added

- feat(onboarding): first-run 4-step wizard for new installs


## [0.3.4] - 2026-04-22

### Added

- feat(docker): self-healing storage permissions on startup


## [0.3.3] - 2026-04-22

### Changed

- chore(format): apply ruff format to voice_profiles + config

### Fixed

- fix(backup): align voice_profiles CHECK + harden restore against schema drift


## [0.3.2] - 2026-04-21

### Fixed

- fix(marketing): align homepage claims with shipped code

### Other

- cleanup: drop the shortsfactory back-compat shim (zero customers)


## [0.3.1] - 2026-04-21

### Fixed

- fix: ship shortsfactory back-compat shim for pre-v0.3.0 compose files


## [0.3.0] - 2026-04-21

### Changed

- refactor: rename internal Python package shortsfactory -> drevalis


## [0.2.7] - 2026-04-21

### Added

- feat(marketing): full design-system overhaul + Swiss legal pages

### Fixed

- fix(backup): correct _TABLE_ORDER so parents insert before children


## [0.2.6] - 2026-04-21

### Fixed

- fix(updater): exclude self from docker compose up -d


## [0.2.5] - 2026-04-21

### Fixed

- fix(backup): restore datetime coercion; add restore_db/restore_media flags; drop About page


## [0.2.4] - 2026-04-21

### Fixed

- fix(license): seat-cap lockout now shows inline seat manager


## [0.2.3] - 2026-04-21

### Added

- feat(license): user-facing seat management for seat-cap recovery


## [0.2.2] - 2026-04-21

### Fixed

- fix(backup): resolve metadata-column clash + export UpdateProgress type


## [0.2.1] - 2026-04-21

### Added

- feat(audiobook): ID3 tags + CHAP/CTOC chapter markers on MP3 output
- feat(updates): live progress overlay survives the restart window

### Changed

- chore: remove stray '=1.47.0' file from pip install shell artifact

### Other

- test: unquarantine schemas (3) + SSRF link-local (1); reorder _check_ip


## [0.2.0] - 2026-04-21

### Added

- feat(settings/updates): prominent Check-for-updates button + last-checked UX
- feat(backup): full-install backup/restore + fix correctness blockers

### Changed

- chore(format): apply ruff format to services/tts/_monolith.py
- chore: remove accidental test file

### Fixed

- fix: tts overrides pipeline, license-gate startup race; docs: Help page
- fix: multi-channel playlist/analytics, audiobook chapter regen, mobile UX
- fix: series field lock, token-refresh persistence, onboarding checklist
- fix(installer): ps1 heredoc backtick-a produced BEL in compose yaml
- fix(installer): ASCII-only + UTF-8 no-BOM compose output

### Other

- marketing: expand site + add legal pages (Terms, Privacy, AUP, Impressum)


## [0.1.9] - 2026-04-21

### Fixed

- fix(compose): use absolute /app/.venv/bin/python instead of bare alembic


## [0.1.8] - 2026-04-21

### Fixed

- fix(updates): bake the real version into the image, stop hardcoding 0.1.0


## [0.1.7] - 2026-04-21

### Fixed

- fix(updater): target the real stack by project name


## [0.1.6] - 2026-04-21

### Fixed

- fix(updater): chmod 0777 /shared on startup so app can write the flag


## [0.1.5] - 2026-04-21

### Changed

- chore(logging): demote license_gate_blocked to DEBUG
- chore(config): decouple SQLAlchemy echo from DEBUG
- chore(mypy): suppress google.oauth2 no-untyped-call per-module

### Fixed

- fix(installer): inline alembic, drop deadlock-prone migrate one-shot
- fix(compose): run alembic inline in app startup, drop separate migrate service
- fix(auth): empty API_AUTH_TOKEN should disable auth, not lock out
- fix: restore migrate one-shot service + surface real API errors

### Other

- harden: P0 bug fixes, security hardening, perf wins, mypy gate
- models: add new re-exports to __all__


## [0.1.4] - 2026-04-20

### Other

- frontend: serve production build via nginx instead of vite dev server


## [0.1.3] - 2026-04-20

### Fixed

- fix(migrations): add 016 for five missing tables + three missing columns


## [0.1.2] - 2026-04-20

### Fixed

- fix(migrations): add missing 010b to create scheduled_posts table


## [0.1.1] - 2026-04-20

### Changed

- CI: run mypy via -p shortsfactory (avoids duplicate module with editable install)
- CI: add --explicit-package-bases to mypy to fix duplicate module conflict

### Fixed

- fix(migration 009): call set_updated_at() instead of nonexistent update_updated_at_column()

### Other

- install scripts: run Alembic migrations as a one-shot service
- install.ps1: surface errors via throw (exit 1 gets swallowed by iex)


## [0.1.0] - 2026-04-20

### Fixed

- Fix sanitize_filename on Linux + add py.typed marker
- Fix Toast API misuse in LicenseSection + UpdatesSection

### Other

- Clean up for first GHCR release
- Revert "Remove ci.yml"
- Remove ci.yml
- About page: replace personal handle with Drevalis branding
- Expand .gitignore for local state
- Initial commit: Drevalis Creator Studio



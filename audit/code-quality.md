# Drevalis Backend - Code Quality Audit

**Scope:** C:\Users\admin\PycharmProjects\PythonProject\ytsgen\src\drevalis
**Mode:** Read-only. No code modified.
**Tools:** radon cc -s -a, vulture --min-confidence 80, grep, git blame.
**Total LOC audited:** ~53,839 across 286 Python files.

The repo's _monolith.py + package __init__.py re-export pattern is deliberate (see CLAUDE.md "Service extraction"). It is NOT flagged. What IS flagged is direct from-_monolith imports from outside the owning package - those bypass the seam.

---

## Findings

### F-CQ-01: AudiobookService.generate cyclomatic complexity 92 (grade F)
- **Severity:** HIGH
- **Location:** src/drevalis/services/audiobook/_monolith.py:1300
- **Evidence:** radon cc reports M 1300:4 AudiobookService.generate - F (92). The method takes 27 keyword parameters and orchestrates parsing, TTS, concat, music, captions, MP3, and video in one body.
- **Impact:** Untestable in isolation; one regression in the music branch breaks the audio_only path; every reviewer must hold the entire pipeline in their head.
- **Effort:** large
- **Suggested fix:** The in-file TODO at line 16 already maps the extraction (chaptering, script_tags, chunking, tts_render, concat_executor, mix_executor, image_gen, video_render, metadata, captions). Execute that plan one block per commit. Do not delete _monolith.py; keep it as the re-export shim per ADR.

### F-CQ-02: upload_episode route at CC 68 mixes auth, SEO, refresh, retry, persistence
- **Severity:** HIGH
- **Location:** src/drevalis/api/routes/youtube/_monolith.py:507
- **Evidence:** Single FastAPI handler does demo-mode short-circuit, channel resolution, asset lookup, on-the-fly LLM SEO generation (lines 582-635), token refresh + commit, upload record creation, then enqueue/upload - radon grade F (68).
- **Impact:** A 4xx in any one branch can leak partially-committed channel-token rows; the nested _extract_json + LLMService call inside an HTTP handler violates the Routers-call-services layer rule from CLAUDE.md.
- **Effort:** medium
- **Suggested fix:** Extract _resolve_channel_for_upload, _ensure_seo_metadata (move to services/youtube.py or a new services/seo.py), and _refresh_and_persist_tokens helpers. Route becomes a 30-line orchestrator.

### F-CQ-03: PipelineOrchestrator._step_assembly CC 60 and _step_scenes CC 56
- **Severity:** HIGH
- **Location:** src/drevalis/services/pipeline/_monolith.py:1373 (assembly) and :768 (scenes)
- **Evidence:** Each step branches on content_format (shorts / longform / music_video), use_video_concat, chapters_enabled, music presence, captions style, intro/outro. State-machine steps end up doing ~600 lines of conditional dispatch.
- **Impact:** Long-form regression risk every time shorts logic changes (Liskov-style: same step, three behavioral contracts). The orchestrator is the load-bearing piece in CLAUDE.md - its complexity directly threatens reliability.
- **Effort:** large
- **Suggested fix:** Strategy pattern keyed on content_format: ShortsAssemblyStrategy, LongFormAssemblyStrategy, MusicVideoAssemblyStrategy, each implementing a small AssemblyStrategy Protocol. _step_assembly becomes resolve-strategy + dispatch.

### F-CQ-04: get_seo_score CC 50 inside route monolith
- **Severity:** MEDIUM
- **Location:** src/drevalis/api/routes/episodes/_monolith.py:2418
- **Evidence:** radon reports F (50). The function lives in the route layer and is essentially business logic.
- **Impact:** Same layering violation as F-CQ-02; cannot unit-test without spinning up FastAPI.
- **Effort:** medium
- **Suggested fix:** Extract to services/seo.py (a stub already exists at services/seo_preflight.py). Route becomes a thin dispatcher.

### F-CQ-05: _publish_scheduled_posts_locked CC 42 cron worker
- **Severity:** MEDIUM
- **Location:** src/drevalis/workers/jobs/scheduled.py:41
- **Evidence:** Cron-driven publisher does platform routing, channel resolution, token refresh-with-commit, 3x upload retry loop (line 169), thumbnail upload, status update, and per-platform error mapping in one body.
- **Impact:** Scheduler runs every 5 minutes per CLAUDE.md; a partial failure mid-loop can leave posts in inconsistent state. Hard to reason about which retry counter applies to which side effect.
- **Effort:** medium
- **Suggested fix:** Split into per-platform publishers (_publish_to_youtube, _publish_to_tiktok, etc.) with a shared _with_token_refresh_retry helper that wraps the 3-attempt loop currently inlined.

### F-CQ-06: ComfyUIElevenLabsTTSProvider.synthesize CC 33
- **Severity:** MEDIUM
- **Location:** src/drevalis/services/tts/_monolith.py:955
- **Evidence:** Method dispatches on token shape, queues prompt, polls websocket, decodes audio-or-error response, classifies auth failures, retries.
- **Impact:** New TTS providers have to clone this control flow; a bug in token classification (_classify_comfyui_token at 831) silently returns wrong audio.
- **Effort:** medium
- **Suggested fix:** Extract _run_comfyui_workflow helper (workflow submit + poll + extract output) shared by TTS, music, and SFX providers. The class then only owns input/output mapping.

### F-CQ-07: External imports reach into services._monolith from another package (10 sites)
- **Severity:** MEDIUM
- **Location:**
  - src/drevalis/workers/jobs/episode.py:142 -> services.llm._monolith.LLMPool
  - src/drevalis/services/music_video.py:44 -> services.llm._monolith.LLMProvider (TYPE_CHECKING only)
  - src/drevalis/services/music_video_orchestrator.py:45-48,395-396,472 -> 6 imports from captions/comfyui/ffmpeg/llm/tts _monolith
  - src/drevalis/services/music/_monolith.py:348 -> services.tts._monolith._build_comfyui_auth_extra_data
  - src/drevalis/api/routes/audiobooks/_monolith.py:1316 -> api.routes.youtube._monolith._build_youtube_service
- **Evidence:** Grep for _monolith outside each package's own __init__.py returns these files. CLAUDE.md explicitly bans this: "Never import from _monolith directly".
- **Impact:** Defeats the seam. When the audiobook monolith extraction (F-CQ-01) actually moves _strip_chunk_hash out of _monolith.py, those importers will silently break or silently keep importing a stale duplicate.
- **Effort:** trivial
- **Suggested fix:** For each, the symbol must be re-exported from the package __init__.py (some already are, e.g. LLMPool) - change the offending site to from-drevalis.services.llm-import-LLMPool. For private symbols not yet re-exported (_strip_chunk_hash, _build_comfyui_auth_extra_data, _build_youtube_service), add them to the __init__.py and update the imports. Note: services/audiobook/render_plan.py:112 is INSIDE the audiobook package importing its own _monolith, which is acceptable.

### F-CQ-08: Three competing retry/backoff implementations for outbound HTTP/LLM
- **Severity:** MEDIUM
- **Location:**
  - src/drevalis/core/http_retry.py:77 - canonical request_with_retry, used in only 4 files
  - src/drevalis/services/llm/_monolith.py:121 - bespoke 3-attempt loop, classifies 524/timeout/502/503 by string matching
  - src/drevalis/services/audiobook/_monolith.py:957 - separate retry loop for TTS chunks
  - src/drevalis/api/routes/series.py:266,599 ; workers/jobs/series.py:112 ; workers/jobs/scheduled.py:169 ; workers/jobs/runpod.py:75 - six more ad-hoc for-attempt-in-range loops
- **Evidence:** Grep for for-attempt-in-range returns 9 sites with near-identical structure: try, check error, exponential or linear sleep, break/continue. Only 4 files use the shared helper.
- **Impact:** The LLM provider retry at llm/_monolith.py:121 matches errors by str(exc) substring - fragile when SDK upgrades change exception messages. Each re-implementation is a place for retry semantics to drift.
- **Effort:** medium
- **Suggested fix:** Generalize core/http_retry.py to accept a predicate Callable[[Exception], bool] and/or predicate_response Callable[[httpx.Response], bool], then call it from the LLM/TTS sites. Per-call retry knobs (max_attempts, base_backoff_s) are already exposed.

### F-CQ-09: Cloud-GPU providers duplicate identical httpx error-wrap boilerplate
- **Severity:** MEDIUM
- **Location:** src/drevalis/services/cloud_gpu/lambda_labs.py (12 occurrences), vastai.py (7), runpod.py (7)
- **Evidence:** Each public method is wrapped by the same try/except block: catch httpx.HTTPError, raise CloudGPUProviderError(provider=..., status_code=getattr(exc.response, status_code, 500) if hasattr(exc, response) else 500, detail=...). 26 occurrences across the three providers.
- **Impact:** Adding a 4th provider means re-cloning this pattern; any improvement (e.g. honouring Retry-After) has to be made in 26 places.
- **Effort:** small
- **Suggested fix:** Add a _request method on a shared mixin or base.py helper async-def-cloud_gpu_request(client, method, url, *, provider, **kw) -> httpx.Response that performs the call + raise_for_status + wrap into CloudGPUProviderError. Each provider method becomes one line.

### F-CQ-10: _extract_json LLM-output parser used from 4 external sites with leading-underscore name
- **Severity:** LOW
- **Location:** src/drevalis/services/llm/_monolith.py (defined), referenced from api/routes/episodes/_monolith.py:3426,3477 ; api/routes/series.py:30,277,608,700 ; api/routes/youtube/_monolith.py:597,626 ; services/continuity.py:18,90
- **Evidence:** Grep for _extract_json returns 10 hits across 4 importing files.
- **Impact:** A leading underscore signals module-private yet it is used as a public utility. Refactoring it inside the LLM monolith breaks four other call sites silently.
- **Effort:** trivial
- **Suggested fix:** Rename to extract_json_from_llm_output and re-export through services/llm/__init__.py. (No behavior change.)

### F-CQ-11: Three confirmed dead variables (vulture 100% confidence) - one is a real bug
- **Severity:** LOW
- **Location:**
  - src/drevalis/services/comfyui/_monolith.py:1198 - motion_reference_paths_by_scene parameter unused
  - src/drevalis/services/music_video.py:408 - structure parameter (already noqa ARG001)
  - src/drevalis/services/music_video.py:411 - provider_preference parameter (already noqa ARG001)
- **Evidence:** vulture src/drevalis --min-confidence 80 output. The music_video.py case is a deliberate NotImplementedError stub (lines 407-424); vulture flags despite the noqa marker since noqa applies to ruff only.
- **Impact:** The ComfyUI case is a real bug: the caller passes per-scene motion references that are then discarded. Long-form video may be using a generic motion ref instead of per-scene.
- **Effort:** trivial (investigation), small (fix)
- **Suggested fix:** For comfyui/_monolith.py:1198, trace whether the parameter was wired up and dropped during a refactor. Either consume it or remove the parameter from the public signature so the caller stops sending stale data. The two music_video.py warnings are false positives (deliberate stub) - add to a vulture whitelist if vulture is wired into CI.

### F-CQ-12: No TODO/FIXME older than the 6-month threshold
- **Severity:** NIT
- **Location:** All TODO/FIXME hits dated 2026-04-20 through 2026-04-27 (git blame confirms)
- **Evidence:**
  - services/audiobook/_monolith.py:16 - TODO refactor - 2026-04-27 (in progress, not stale)
  - workers/jobs/scheduled.py:22 - Other-platforms-are-TODO - 2026-04-20 (~9 days old)
  - services/tts/_monolith.py:807 - XXX appears inside a URL example, not a marker - false positive
- **Impact:** None. Repo is hygienic on stale-TODO front.
- **Effort:** n/a
- **Suggested fix:** None. Re-run this check next quarter.

### F-CQ-13: 14 D-grade functions outside the monoliths (CC 21-29)
- **Severity:** LOW
- **Location:** Notable offenders:
  - services/media_repair.py:288 repair_media_links - E (37)
  - api/routes/backup.py:456 _storage_probe_hints - E (38)
  - services/quality_gates.py:39 check_voice_track - D (21)
  - workers/jobs/runpod.py:17 auto_deploy_runpod_pod - D (29)
  - workers/jobs/edit_render.py:34 render_from_edit - D (27)
  - workers/jobs/audiobook.py:802 generate_ai_audiobook - D (24)
  - api/routes/episodes/_monolith.py:3157 publish_all - D (27)
  - api/routes/jobs/_monolith.py:100 get_active_tasks - D (25)
- **Evidence:** radon cc -s (full list above).
- **Impact:** Each is a candidate for extract-method but none is on the critical correctness path the way pipeline orchestrator and audiobook generate are.
- **Effort:** medium each, small in aggregate (most can be split into 2-3 helpers)
- **Suggested fix:** Track in the backlog. Apply extract-method passes opportunistically when those areas are touched for other reasons.

### F-CQ-14: services/tts/ and services/llm/ are single-file packages
- **Severity:** LOW
- **Location:** src/drevalis/services/tts/ contains only _monolith.py (1815 LOC) + __init__.py. Same for services/llm/ (704 LOC).
- **Evidence:** ls services/tts services/llm shows two files each.
- **Impact:** The package shape signals extraction-in-progress but no actual extraction has happened (compare services/audiobook/ which has render_plan.py, or services/cloud_gpu/ with base.py + per-provider files). For a reader the empty package adds a hop without value.
- **Effort:** medium (proper extraction) / trivial (no-op accept)
- **Suggested fix:** Either (a) extract one provider per file (services/tts/edge.py, services/tts/elevenlabs.py, services/tts/comfyui_elevenlabs.py, ...), each ~150 LOC, with _monolith.py shrinking to common types + protocol, or (b) accept the current shape and document on the package __init__.py that the extraction is intentional but deferred. Same call applies to services/llm/.

### F-CQ-15: OpenAICompatibleProvider.generate retry uses substring matching on exception text
- **Severity:** LOW
- **Location:** src/drevalis/services/llm/_monolith.py:121-139
- **Evidence:** is_timeout combines four substring tests (524, timeout, 502, 503) inside an except-Exception block.
- **Impact:** Brittle - httpx.HTTPStatusError, httpx.ReadTimeout, and OpenAI SDK exceptions all carry typed status codes. String matching fails when SDK version changes the message format. Also except-Exception swallows e.g. asyncio.CancelledError semantics that should surface immediately.
- **Effort:** small
- **Suggested fix:** Catch the typed exceptions: except (openai.APIConnectionError, openai.APITimeoutError, openai.RateLimitError, openai.InternalServerError) (or use the shared request_with_retry once F-CQ-08 lands).

---

## Top 5 by ROI

1. F-CQ-07 (_monolith import leaks) - trivial fix, immediately restores the seam invariant the codebase already declares; one-line edits at ~10 sites.
2. F-CQ-09 (cloud_gpu boilerplate) - small effort, removes ~26 duplicated blocks; future provider adds become one method per call.
3. F-CQ-08 (consolidate retry helpers) - medium effort, eliminates 5+ ad-hoc retry loops and the brittle string-match in F-CQ-15. High blast radius for stability.
4. F-CQ-11 (motion_reference_paths_by_scene unused) - likely a real bug in long-form video; trivial to verify, small to fix.
5. F-CQ-02 (upload_episode route) - medium effort, isolates SEO + token-refresh + retry from the route layer; restores the layer rule and unlocks unit-testing the SEO path.

---

## Don't fix (intentional)

- _monolith.py + __init__.py re-export pattern - Documented in CLAUDE.md (Service extraction) as the deliberate seam. Per audit instructions, not flagged. Files: services/{audiobook,captions,comfyui,ffmpeg,llm,music,pipeline,tts}/_monolith.py and api/routes/{audiobooks,episodes,jobs,youtube}/_monolith.py.
- In-progress services/audiobook/ extraction - TODO at line 16 of audiobook/_monolith.py documents the migration plan dated 2026-04-27 with render_plan.py already landed. F-CQ-01 references this plan but does not contradict it.
- UnsafeURLError inheriting from ValueError - Documented in CLAUDE.md gotchas; intentional shape, just needs explicit handling at call sites (CLAUDE.md already warns).
- Single-orchestrator job state machine - Per CLAUDE.md Single-orchestrator-job; the high CC of PipelineOrchestrator._step_assembly / _step_scenes (F-CQ-03) is criticized as INTERNAL complexity; the orchestrator-vs-multi-job decision itself is not reversed.
- render_song stub in services/music_video.py:407 - explicit NotImplementedError placeholder; vulture flags its parameters but they are already noqa ARG001-marked.
- TODOs in workers/jobs/scheduled.py:22 and services/audiobook/_monolith.py:16 - both ~10 days old at audit time (today is 2026-04-29), well within the 6-month threshold.

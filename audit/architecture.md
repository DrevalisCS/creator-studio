# Drevalis - Architecture Drift Audit (read-only)

**Date:** 2026-04-29  
**Scope:** Layering rules from CLAUDE.md Architecture > Layers, Protocol-based provider abstractions (ADR-0004, ADR-0005), and intra-service coupling.  
**Method:** Static grep audit of src/drevalis/. No code modified.  
**ADRs reviewed:** ADR-0001 (arq), ADR-0002 (FFmpeg subprocess), ADR-0003 (filesystem storage), ADR-0004 (TTS Protocol), ADR-0005 (LLM Protocol).

## Headline numbers

| Check | Result |
|---|---|
| Routers importing repositories directly | **57 occurrences across 21 of 33 route modules** |
| Services importing fastapi | **1 module** (services/demo.py) |
| Repositories importing other repos / services | **0** (clean) |
| isinstance(x, ConcreteProvider) against Protocol-typed params | **0** (clean) |
| asyncio.run() inside services/ | **0** (clean) |
| Service code reaching into peer _monolith.py | **multiple** (see F-A-04, F-A-07) |

The dominant drift is layer-skipping at the router->repository boundary. Provider abstractions and repository purity are intact.

---

## Blockers

None. Nothing here causes data loss, security holes, or breaks deploy.

## Major Issues

### F-A-01: Routers bypass services and call repositories directly
- **Severity:** HIGH
- **Location:** src/drevalis/api/routes/ - 57 hits across 21 files. Top offenders:
  - episodes/_monolith.py:26-28, 82, 1373, 1389, 3380, 3425, 3598 (9 imports)
  - youtube/_monolith.py:17-19, 73, 554, 592, 753 (7 imports)
  - voice_profiles.py:16-17, 438, 569-570 (5 imports)
  - audiobooks/_monolith.py:21-22, 1317, 1456 (4 imports)
  - runpod.py:32-33, 230, 522 (4 imports)
  - series.py:18-20, 467 (4 imports)
  - schedule.py:19-22 (4 imports)
  - editor.py:28-30 (3 imports), jobs/_monolith.py:18-19, 157 (3 imports)
  - 13 more files with 1-2 hits each.
- **Evidence:**
  ```python
  # api/routes/llm.py:14, 53-58
  from drevalis.repositories.llm_config import LLMConfigRepository
  ...
  async def list_llm_configs(db: AsyncSession = Depends(get_db)) -> ...:
      repo = LLMConfigRepository(db)
      configs = await repo.get_all()
      return [_config_to_response(c) for c in configs]
  ```
- **Impact:** Direct violation of CLAUDE.md "Routers - HTTP only. Call services. Never repos." Business logic (validation, encryption envelopes, status guards, dynamic-slot math) lives in handler bodies and is not reusable from arq workers, scripts, or tests. Each new route reinforces the pattern - drift is self-perpetuating. When the data layer changes (new index, soft-delete, multi-tenancy), 21 route modules must change in lockstep.
- **Effort:** large (per-resource service classes, then route refactor)
- **Suggested fix:** Adopt the existing EpisodeService template (services/episode.py) as the model. Create one service per resource (SeriesService, LLMConfigService, VoiceProfileService, ApiKeyService, YouTubeChannelService, ScheduledPostService, RunPodKeyService, etc.) with domain exceptions in core/exceptions.py. Migrate routers incrementally; start with thin CRUD routers (llm.py, prompt_templates.py, api_keys.py, comfyui.py, character_packs.py) which are the cheapest to convert and yield the cleanest examples for follow-on work.

### F-A-02: services/demo.py imports FastAPI
- **Severity:** HIGH
- **Location:** src/drevalis/services/demo.py:20-40
- **Evidence:**
  ```python
  from fastapi import Depends, HTTPException, status
  from drevalis.core.deps import get_settings

  def is_demo_mode(settings: object = Depends(get_settings)) -> bool: ...
  def require_not_demo(settings: object = Depends(get_settings)) -> None:
      if getattr(settings, "demo_mode", False):
          raise HTTPException(status.HTTP_403_FORBIDDEN, "disabled_in_demo")
  ```
- **Impact:** Violates "Services - No FastAPI imports." These two functions are not services - they are FastAPI route dependencies. They cannot be reused from arq workers (where the demo gate also matters) without dragging FastAPI Depends into a non-HTTP context. The other services (episode.py, audiobook/_monolith.py, pipeline/_monolith.py) correctly raise domain exceptions and stay framework-free; demo.py is the lone deviation.
- **Effort:** trivial
- **Suggested fix:** Move is_demo_mode and require_not_demo to api/deps.py (or core/deps.py next to the other DI helpers). Keep the data constants (DEMO_STEPS, etc.) in services/demo.py as plain values. Routers that depend on the gate import it from the deps module.

### F-A-03: Routers re-import repositories inside function bodies (lazy imports for layer-bypass)
- **Severity:** MEDIUM
- **Location:** Examples - episodes/_monolith.py:82, 1373, 1389, 3380, 3425, 3598; youtube/_monolith.py:73, 554, 592, 753; voice_profiles.py:438, 569-570; runpod.py:230, 522; social.py:63; series.py:467; settings.py:236; audiobooks/_monolith.py:1317, 1456; jobs/_monolith.py:157.
- **Evidence:**
  ```python
  # api/routes/episodes/_monolith.py:82
  from drevalis.repositories.comfyui import ComfyUIServerRepository
  repo = ComfyUIServerRepository(db)
  servers = await repo.get_active_servers()
  ```
- **Impact:** Function-body imports are how F-A-01 was extended without touching module-level imports - making the violation harder to spot in linters/CI and concentrating cyclomatic risk inside long handlers. Also defeats ruff import-sorting and mypy module-graph reasoning.
- **Effort:** small (collapses naturally as F-A-01 is fixed)
- **Suggested fix:** Treat in-function repo imports as the priority targets when refactoring. Each one is direct evidence that the handler is doing service-layer work.

### F-A-04: Cross-service reach into peer _monolith.py private helpers
- **Severity:** MEDIUM
- **Location:**
  - services/music/_monolith.py:348 -> from drevalis.services.tts._monolith import _build_comfyui_auth_extra_data
  - services/audiobook/render_plan.py:112 -> from drevalis.services.audiobook._monolith import _strip_chunk_hash
- **Evidence:**
  ```python
  # services/music/_monolith.py:348
  from drevalis.services.tts._monolith import _build_comfyui_auth_extra_data
  extra_data = dict(_build_comfyui_auth_extra_data(self.comfyui_api_key))
  ```
- **Impact:** Two violations of the CLAUDE.md rule "Never import from _monolith directly - always from the package." Both reach for *underscore-prefixed* helpers (Python private convention), not exported names - so they bypass both the package-import rule and the API stability signal. render_plan.py is in the same package, so the second case is an internal cycle being papered over with a deferred import.
- **Effort:** small
- **Suggested fix:** _build_comfyui_auth_extra_data is a generic ComfyUI auth helper, not TTS-specific - move it to services/comfyui/auth.py and re-export from services/comfyui/__init__.py. _strip_chunk_hash belongs in services/audiobook/_chunks.py (a new module imported by both _monolith.py and render_plan.py); both files then import the public name. The _monolith.py files stop being canonical homes for cross-package utilities.

### F-A-05: TTS provider concretely imports ComfyUIClient from a peer service package via runtime in-function imports
- **Severity:** LOW
- **Location:** services/tts/_monolith.py:964, 1275; also services/music/_monolith.py:317; services/pipeline/_monolith.py:935.
- **Evidence:**
  ```python
  # services/tts/_monolith.py:964
  from drevalis.services.comfyui import ComfyUIClient
  ```
- **Impact:** Not a layer violation per se (services may orchestrate other services), but the function-local imports indicate a circular-import workaround between tts and comfyui. Long-term this argues for ComfyUIClient being thin enough to live in a leaf module that both can import without TYPE_CHECKING gymnastics.
- **Effort:** medium
- **Suggested fix:** Hoist ComfyUIClient (just the HTTP client, not ComfyUIService which orchestrates pools) into a leaf module services/comfyui/client.py. tts, music, pipeline import the leaf; comfyui/_monolith.py keeps the orchestrator. Removes 4 function-local imports and clarifies the dependency arrow.

## Minor Issues

### F-A-06: _extract_json is exported with leading underscore but treated as public API
- **Severity:** LOW
- **Location:** services/llm/__init__.py:10, 20; called from api/routes/series.py:30, 277, 608, 700, api/routes/episodes/_monolith.py:3426, api/routes/youtube/_monolith.py:597, services/continuity.py:18, services/music_video.py (similar _extract_json_block), workers/jobs/series.py:58, workers/jobs/seo.py:35.
- **Evidence:** Underscore-prefixed name appears in 6 modules top-level imports plus the package __all__.
- **Impact:** Mixed signals - the underscore tells readers "private," __all__ says "public." Routers and workers parsing LLM JSON responses are duplicating glue that should be a real public utility (or, better, an LLM-method that returns dict directly).
- **Effort:** trivial
- **Suggested fix:** Either rename to extract_json (public) and remove from underscore-prefixed forms, or push JSON-parsing into the LLMService.generate_json(...) method so callers never see raw text. The latter also eliminates the duplicated _extract_json paste in music_video.py.

### F-A-07: Module-level _monolith imports in workers/orchestrators
- **Severity:** LOW
- **Location:** services/music_video_orchestrator.py:45-50, 395-396, 472; services/music_video.py:44; workers/jobs/episode.py:142.
- **Evidence:**
  ```python
  # services/music_video_orchestrator.py:45-48
  from drevalis.services.captions._monolith import CaptionService
  from drevalis.services.comfyui._monolith import ComfyUIService
  from drevalis.services.ffmpeg._monolith import FFmpegService
  from drevalis.services.llm._monolith import LLMPool
  ```
- **Impact:** Direct _monolith imports - same rule as F-A-04. Most of these are inside if TYPE_CHECKING: blocks and so "only" affect type hints today, but they normalise the wrong shape. The non-TYPE_CHECKING examples (lines 395, 472, and the worker import) execute at runtime.
- **Effort:** trivial
- **Suggested fix:** Replace every services.<pkg>._monolith import with services.<pkg> - the public re-exports already exist in each __init__.py.

## Commendable

- **Repository purity:** zero cross-repo or repo->service imports across all 19 repository modules. Every file imports only models.*, core.*, and .base. This is rare in projects this size - preserve it.
- **EpisodeService is the right template** (services/episode.py:52-100). Domain exceptions (EpisodeNotFoundError, EpisodeNoScriptError, EpisodeInvalidStatusError) keep the service free of HTTPException and Depends. Use this exact shape for the new services proposed in F-A-01.
- **Provider Protocols are clean.** No isinstance(provider, PiperTTSProvider) or similar. ADR-0004/ADR-0005 structural typing is intact - provider selection is via factories and DB config, never via runtime concrete-class checks.
- **No asyncio.run() inside services.** The single hit (workers/__main__.py:120) is a legitimate entrypoint usage. Async boundaries are uniform.
- **Repository __init__.py is properly curated** - only the public Repository classes exported, no stray helpers.

## Recommendations (strategic)

1. **Make F-A-01 the next refactor sprint anchor.** It is the largest source of architectural debt and the one that compounds fastest. Use the EpisodeService shape as the canonical template; document it in CLAUDE.md with a short "How to add a router" recipe.
2. **Lint the layer rules.** Add an import-linter (grimp) contract or a custom ruff rule enforcing:
   - drevalis.api.routes.* cannot import drevalis.repositories.*
   - drevalis.services.* cannot import fastapi
   - drevalis.repositories.* cannot import drevalis.services.* or sibling drevalis.repositories.*
   - drevalis.* cannot import drevalis.*._monolith (anywhere)
   Run in CI. Without this, every fix decays.
3. **Move ComfyUI auth + chunk-hash helpers out of _monolith files** (F-A-04 fix) - these are the only two known cross-package _monolith reaches and are fixable in a single PR.
4. **Service module sprawl.** services/ has 25+ modules at the top level alongside 7 packages. Worth deciding whether auto_schedule.py, continuity.py, media_repair.py, quality_gates.py, seo_preflight.py, etc. belong under a services/episode/ or services/quality/ sub-namespace. Not urgent - flag for next refactor cycle.

---

## Top 5 by ROI

1. **F-A-02** - Move demo.py FastAPI helpers to api/deps.py. Trivial effort, eliminates the only services->fastapi violation, restores a clean grep-verifiable invariant.
2. **F-A-04** - Relocate _build_comfyui_auth_extra_data and _strip_chunk_hash. Small, mechanical, removes both cross-package _monolith private-helper reaches in one PR.
3. **F-A-07** - Replace _monolith imports in music_video_orchestrator.py, music_video.py, and workers/jobs/episode.py with package-level imports. Trivial; protects the convention.
4. **Add the import-linter contract from Recommendation #2.** Without it, every other fix in this audit decays back to drift.
5. **F-A-01, scoped to the 5 thinnest CRUD routers first** (llm.py, prompt_templates.py, api_keys.py, comfyui.py, character_packs.py). Establishes the service-class template, gives 5 worked examples for the larger routers (episodes/, youtube/, audiobooks/).

## Don't fix (intentional)

- **services/captions/_monolith.py:25 re-using WordTimestamp from services/tts.** Documented in the file as deliberate type sharing between two paired services. Not a layer violation.
- **services/cloud_gpu/runpod.py importing services/runpod.py.** Two services collaborating; the cloud_gpu provider wraps the lower-level RunPod GraphQL client. Fine.
- **workers/__main__.py:120 asyncio.run(_wait_for_redis(...)).** Legitimate entrypoint usage in a __main__ module.
- **The _monolith.py + __init__.py re-export pattern itself.** ADR-aligned per CLAUDE.md "Service extraction" / "Modular packages" - proposing its removal would be **ADR revision needed**. The audit findings target *direct imports of _monolith*, which the rule already forbids; not the pattern itself.
- **ADR-0002 FFmpeg direct subprocess.** No drift here. Any proposal to wrap FFmpeg in ffmpeg-python or moviepy would be **ADR revision needed**.
- **ADR-0004 / ADR-0005 Protocol-based provider abstraction.** No drift here; no isinstance smell. Any proposal to swap to ABCs would be **ADR revision needed**.


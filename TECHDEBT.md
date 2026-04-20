# Technical Debt

Known debt, scoped and tracked so each item is visible in CI and fixable
independently. Nothing here blocks shipping; everything here should be
worked down over time.

## 1. Quarantined tests (22)

Tests that were written against an earlier version of the codebase and no
longer match the current structure. They're marked `xfail(strict=False)` in
`tests/conftest.py` — CI reports them as XFAIL instead of FAIL.

Each group needs the same treatment: read the production code, update the
mocks and assertions to match, remove from the `_STALE_TESTS` set.

| File | Count | Why stale |
|------|------:|-----------|
| `test_comfyui.py::TestComfyUIPool::test_pool_least_loaded_selection` | 1 | Pool switched from least-loaded to round-robin; method was removed |
| `test_ffmpeg.py::TestBuildAssemblyCommand` | 4 | `FFmpegService.build_assembly_command` signature changed (Ken Burns, aspect ratio params) |
| `test_llm.py::TestProviderSelection` | 4 | Provider factory moved to `LLMPool`; tests patch the wrong symbols |
| `test_pipeline.py::TestPipeline*` | 5 | `PipelineOrchestrator` API changed for long-form pipeline work |
| `test_schemas.py::TestEpisodeScript` + `TestSceneScript` | 3 | Validators relaxed; required-field assertions no longer hold |
| `test_validators_ssrf.py::TestUnsafeURLErrorNotSwallowed` | 1 | `UnsafeURLError` hierarchy changed |
| `test_worker_jobs.py::TestGenerate*` | 4 | Music/SEO jobs migrated from sync HTTP handlers; mocks patch old paths |

## 2. Strict mypy coverage

`mypy --strict` currently reports ~600 errors across 90 files. The CI
workflow runs non-strict mypy; strict coverage is a per-module cleanup
task.

**Roadmap:** enable strict mypy one top-level package at a time by adding
`[[tool.mypy.overrides]]` entries in `pyproject.toml` with
`strict = true`. Start with `core/`, then `models/`, `repositories/`,
then `services/`, and finally `api/`.

## 3. Bandit / pip-audit

Not yet enabled in CI. Enable both, fix each finding, commit the allow-list
for any remaining false positives.

## 4. Frontend lint coverage

CI runs `tsc --noEmit` and the production build. No ESLint yet. When time
permits, add ESLint with `@typescript-eslint/recommended` and a small set
of opinionated rules.

## 5. Docker image size

App image is ~2 GB. Multi-stage build already in place. Further reductions
would require:
- Replacing `debian:bookworm-slim` piper download stage with pre-built
  ARM64/AMD64 binaries shipped via GitHub Releases
- Swapping `python:3.11-slim` for `python:3.11-alpine` (requires verifying
  every native dep compiles on musl)

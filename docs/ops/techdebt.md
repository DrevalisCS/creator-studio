# Technical Debt

Known debt, scoped and tracked so each item is visible in CI and fixable
independently. Nothing here blocks shipping; everything here should be
worked down over time.

## 1. Quarantined tests (18)

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
| `test_worker_jobs.py::TestGenerate*` | 4 | Music/SEO jobs migrated from sync HTTP handlers; mocks patch old paths |

## 2. Mypy (gated in CI)

Mypy **is** a CI gate as of this commit. The whole-package run
`mypy -p drevalis --no-strict-optional` returns 0 errors across
138 source files.

Remaining debt is on the strictness axis:

- [ ] Tighten to `--strict` per package (blocked on each package's own
      `Any`-leak audit). Start with `drevalis.core.license` and
      `drevalis.services.updates` — both are small and entirely
      authored in-repo.
- [ ] Remove the `--no-strict-optional` flag once the `None`-handling
      drift in repositories/ORM paths is cleaned up.
- [ ] Audit the `# type: ignore[...]` comments that remain for
      legitimacy (should be narrow and commented, not blanket).

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

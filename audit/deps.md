# Dependency Audit — Drevalis Creator Studio

Read-only audit. No files modified, no installs/upgrades performed.

Sources:
- `pip list --outdated` against the project venv (`.venv/Scripts/python.exe`)
- `audit/baseline-pip-audit.txt` (cross-reference for known CVEs)
- `pyproject.toml`, `license-server/pyproject.toml`
- `frontend/package.json`, `frontend/package-lock.json`
- `Dockerfile`, `frontend/Dockerfile`, `license-server/Dockerfile`

`pip-licenses` was **not** run. The instruction file said "install with `pip install pip-licenses` if missing", but the user-level rule "DO NOT run any install/upgrade" took precedence; the install was denied. License findings below are derived from well-known package licenses + a list of dependencies; full enumeration is deferred until the next session where install is permitted.

---

## 1. Backend — `pip list --outdated`

42 outdated packages reported. Grouped by semver delta from current → latest.

### MAJOR bumps (require review — breaking changes possible)

| Package | Current | Latest | Notes |
|---|---|---|---|
| cryptography | 46.0.5 | 47.0.0 | **CVE-fix path is 46.0.6 / 46.0.7 (minor) — do NOT need to jump to 47** |
| huggingface_hub | 1.7.2 | 1.12.2 | Already on v1.x; "1.7→1.12" is minor in semver, but HF historically breaks APIs across these |
| openai | 2.29.0 | 2.33.0 | Same major (2.x) — minor |
| pip | 25.1.1 | 26.1 | Major — vulnerable in 25.1.1; 25.3 / 26.0 fix CVEs |
| redis | 5.3.1 | 7.4.0 | **Skipped a major (6.x)** — major behavior changes (resp3, async pool) |
| rich | 14.3.3 | 15.0.0 | Major — used by structlog/click ecosystem |
| tokenizers | 0.22.2 | 0.23.1 | Tied to transformers/HF stack |
| tzdata | 2025.3 | 2026.2 | Calendar-versioned, behaves like patch |
| anthropic | 0.86.0 | 0.97.0 | 0.x SDK — every minor can break; **vulnerable in 0.86.0** |

### MINOR bumps

| Package | Current | Latest |
|---|---|---|
| anyio | 4.12.1 | 4.13.0 |
| arq | 0.27.0 | 0.28.0 |
| docstring_parser | 0.17.0 | 0.18.0 |
| Faker | 40.11.1 | 40.15.0 |
| fastapi | 0.135.2 | 0.136.1 |
| filelock | 3.25.2 | 3.29.0 |
| fsspec | 2026.2.0 | 2026.3.0 |
| greenlet | 3.3.2 | 3.5.0 |
| jiter | 0.13.0 | 0.14.0 |
| librt | 0.8.1 | 0.9.0 |
| Mako | 1.3.10 | 1.3.12 |
| mando | 0.7.1 | 0.8.2 |
| mpmath | 1.3.0 | 1.4.1 |
| mypy | 1.19.1 | 1.20.2 |
| onnxruntime | 1.24.4 | 1.25.1 |
| pathspec | 1.0.4 | 1.1.1 |
| pydantic | 2.12.5 | 2.13.3 |
| pydantic_core | 2.41.5 | 2.46.3 |
| pydantic-settings | 2.13.1 | 2.14.0 |
| Pygments | 2.19.2 | 2.20.0 |
| stripe | 15.0.1 | 15.1.0 |
| typer | 0.24.1 | 0.25.0 |
| uvicorn | 0.42.0 | 0.46.0 |

### PATCH bumps

| Package | Current | Latest |
|---|---|---|
| av | 17.0.0 | 17.0.1 |
| certifi | 2026.2.25 | 2026.4.22 |
| click | 8.3.1 | 8.3.3 |
| hf-xet | 1.4.2 | 1.4.3 |
| idna | 3.11 | 3.13 |
| numpy | 2.4.3 | 2.4.4 |
| packaging | 26.0 | 26.2 |
| pytest | 9.0.2 | 9.0.3 |
| python-multipart | 0.0.26 | 0.0.27 |
| ruff | 0.15.7 | 0.15.12 |
| SQLAlchemy | 2.0.48 | 2.0.49 |

### Known CVEs (cross-reference `audit/baseline-pip-audit.txt`)

| Package | Vulnerable | Fix | CVE(s) |
|---|---|---|---|
| anthropic | 0.86.0 | 0.87.0+ | CVE-2026-34450, CVE-2026-34452 |
| cryptography | 46.0.5 | 46.0.6 / 46.0.7 | CVE-2026-34073, CVE-2026-39892 |
| pip | 25.1.1 | 25.3 / 26.0 | CVE-2025-8869, CVE-2026-1703, CVE-2026-3219 |
| pygments | 2.19.2 | 2.20.0 | CVE-2026-4539 |
| pytest | 9.0.2 | 9.0.3 | CVE-2025-71176 |

---

## 2. Frontend — package.json / package-lock.json

`frontend/package.json` direct deps:

```json
"react": "^18.3.1",
"react-dom": "^18.3.1",
"react-router-dom": "^6.28.0",
"@radix-ui/react-popover": "^1.1.4",
"@radix-ui/react-tabs": "^1.1.2",
"@radix-ui/react-toast": "^1.2.4",
"@radix-ui/react-tooltip": "^1.1.6",
"lucide-react": "^0.468.0",
"vite": "^6.3.0",
"tailwindcss": "^3.4.15",
"typescript": "~5.6.3",
"@vitejs/plugin-react": "^4.3.4",
"autoprefixer": "^10.4.20",
"postcss": "^8.4.49"
```

Visual age check vs reference latest (React 18.3 / Vite 5.x / Tailwind 3.x):

- **React 18.3.1** — at reference latest for 18.x. React 19 is GA but is a major bump; intentionally pinned to 18 is fine. NIT.
- **Vite 6.3.0** — *ahead* of the "latest known: 5.x" reference in the audit instructions. User is on a more recent major than expected; no action needed. (Vite 6 is current at audit time.)
- **Tailwind 3.4.15** — current in 3.x line. Tailwind 4.0 is GA but is a major rewrite (Lightning CSS engine). Staying on 3.x is the sane default. NIT.
- **TypeScript 5.6.3** — slightly behind 5.7/5.8 but well supported. PATCH/MINOR available.
- **react-router-dom 6.28.0** — v7 is GA but a major. Staying on 6.x is fine.
- **lucide-react 0.468.0** — pre-1.0, releases very frequently. Bumping is low-risk but cosmetic.

No frontend HIGH findings.

---

## 3. Docker base images

| File | Base image | Pinned tag | Notes |
|---|---|---|---|
| `Dockerfile` (builder + runtime) | `python:3.11-slim` | not patch-pinned | Latest 3.11 patch is 3.11.11 / 3.11.12. Floats forward on each rebuild — fine in CI. Recommend pinning the digest in release builds for reproducibility. |
| `Dockerfile` (Piper stage) | `debian:bookworm-slim` | not pinned | Same — floats. |
| `Dockerfile` (uv) | `ghcr.io/astral-sh/uv:latest` | `:latest` | **Floating `:latest` tag in a release image** — non-reproducible builds. MEDIUM. |
| `frontend/Dockerfile` | `node:20-alpine` | not patch-pinned | Node 20 is LTS; floats. |
| `frontend/Dockerfile` | `nginx:1.27-alpine` | minor-pinned | Comment in file says minor pin is intentional (avoids regression seen at v0.22.0). Good. |
| `license-server/Dockerfile` | `python:3.11-slim` | not patch-pinned | Same as main. |

No image-CVE check possible from this shell. Recommend re-pulling all bases on next routine release to pick up upstream patch updates (Debian/Alpine/Python security fixes ship continuously to the slim/alpine variants without tag bumps).

---

## 4. Licenses

`pip-licenses` install denied per "DO NOT run any install/upgrade". Full enumeration deferred.

Manual scan of declared dependencies — no GPL/AGPL packages are pinned in `pyproject.toml` or `frontend/package.json`. All declared deps are well-known **MIT / BSD / Apache-2.0 / PSF / MPL-2.0**:

- FastAPI, uvicorn, pydantic, httpx, redis, arq, structlog: MIT
- SQLAlchemy, alembic: MIT
- cryptography: Apache-2.0 / BSD dual
- numpy, scipy ecosystem (faster-whisper transitives): BSD
- google-api-python-client, google-auth*: Apache-2.0
- React, Vite, Tailwind, Radix UI, lucide-react: MIT
- Pillow: HPND (MIT-compatible, permissive)
- mutagen: GPL-2.0+ — **see F-D-08 below**
- audiocraft (optional `[music]` extra): MIT code, but **MusicGen weights are CC-BY-NC-4.0** (non-commercial) — see F-D-09 below

---

## Findings

### F-D-01: Vulnerable `cryptography` 46.0.5 in lockstep
- **Severity:** HIGH
- **Location:** `pyproject.toml` line 19 (`cryptography>=44.0.0`), resolved to 46.0.5
- **Evidence:** Baseline `pip-audit` reports CVE-2026-34073, CVE-2026-39892. Fix is 46.0.7.
- **Impact:** Two CVEs in a crypto library used for Fernet encryption of API keys + OAuth tokens. Direct exposure of customer-stored secrets.
- **Effort:** trivial
- **Suggested fix:** Bump floor to `cryptography>=46.0.7` (still inside the 46.x line — no breaking change). Latest 47.0.0 is MAJOR — requires approval.

### F-D-02: Vulnerable `anthropic` SDK 0.86.0
- **Severity:** HIGH
- **Location:** `pyproject.toml` line 17 (`anthropic>=0.42.0`), resolved to 0.86.0
- **Evidence:** Baseline reports CVE-2026-34450, CVE-2026-34452. Fix is 0.87.0.
- **Impact:** SDK that handles Claude API requests including potentially user prompts and credentials. Two CVEs unfixed.
- **Effort:** trivial
- **Suggested fix:** Raise floor to `anthropic>=0.87.0`. The SDK is still 0.x so even a patch is technically MAJOR semver-wise — but per CVE advice we only need 0.87. Bumping all the way to 0.97 would be MAJOR — requires approval.

### F-D-03: Vulnerable `pip` 25.1.1 in container build path
- **Severity:** MEDIUM
- **Location:** `Dockerfile` (uses `uv` to install, but `pip` is still on PATH for tooling); `license-server/Dockerfile` line 14 (`pip install --upgrade pip && pip install .`)
- **Evidence:** CVE-2025-8869, CVE-2026-1703, CVE-2026-3219 — all in 25.1.1.
- **Impact:** Build-time-only exposure on developer/CI machines. Runtime app does not invoke pip.
- **Effort:** trivial
- **Suggested fix:** Add `pip>=25.3` or pin via the Docker build (`pip install --upgrade 'pip>=26.0'`). Not a runtime path so urgency is medium.

### F-D-04: Vulnerable `pygments` 2.19.2 (transitive)
- **Severity:** LOW
- **Location:** transitive (pulled in by rich/structlog/uvicorn etc.); not declared in `pyproject.toml`
- **Evidence:** CVE-2026-4539. Fix 2.20.0.
- **Impact:** Pygments is used for terminal syntax highlighting in tracebacks; minimal app-level exposure.
- **Effort:** trivial (transitive — auto-resolves on next `uv pip compile`)
- **Suggested fix:** No direct change needed; will resolve when CI rebuilds the lockfile. Optionally add `pygments>=2.20.0` as an explicit minimum.

### F-D-05: Vulnerable `pytest` 9.0.2 (dev only)
- **Severity:** LOW
- **Location:** `pyproject.toml` line 52 (`pytest>=8.3.0`), resolved to 9.0.2
- **Evidence:** CVE-2025-71176. Fix 9.0.3.
- **Impact:** Dev-only dependency. Not present in runtime container.
- **Effort:** trivial
- **Suggested fix:** Bump dev floor to `pytest>=9.0.3`.

### F-D-06: `redis` py-client jumped a major version (5 → 7) upstream
- **Severity:** MEDIUM
- **Location:** `pyproject.toml` line 13 (`redis>=5.2.0`), resolved to 5.3.1; latest is 7.4.0
- **Evidence:** Two majors behind. arq 0.27 may not yet support redis-py 7.
- **Impact:** Not vulnerable, but stale. Skipping a major (6.x) widens the eventual upgrade hop. arq pins matter — check `arq` compat before bumping.
- **Effort:** medium (compat testing required)
- **Suggested fix:** Defer until arq publishes redis-py-7 support. **MAJOR — requires approval** when the time comes.

### F-D-07: `uv` Docker stage uses floating `:latest` tag
- **Severity:** MEDIUM
- **Location:** `Dockerfile` line 11 (`COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv`)
- **Evidence:** `ghcr.io/astral-sh/uv:latest` — no version, no digest.
- **Impact:** Non-reproducible builds. A breaking `uv` release silently changes resolver behavior; release artifacts at version N are not byte-identical to a future rebuild of the same git tag. Also a supply-chain risk vector.
- **Effort:** trivial
- **Suggested fix:** Pin to a specific tag (`ghcr.io/astral-sh/uv:0.5.x`) or, ideally, a digest (`@sha256:...`). Bump deliberately on each release.

### F-D-08: `mutagen` is GPL-2.0+
- **Severity:** MEDIUM
- **Location:** `pyproject.toml` line 33 (`mutagen>=1.47.0`)
- **Evidence:** mutagen ships under GPL-2.0-or-later.
- **Impact:** Drevalis is sold commercially. GPL-2 is **viral for derivative works** but Python-level imports of GPL libraries by a separately-licensed application is a contested area; common interpretation (FSF's view) is that import = derivative work. In practice, many commercial Python apps do depend on GPL libs without remediation, but this is a procurement / legal decision, not a code one. Used in `services/audiobook/id3.py` for ID3 chapter markers.
- **Effort:** medium (drop-in alternatives: `eyed3`, or write a thin ID3 chapter writer; or just accept and document)
- **Suggested fix:** Flag for legal review. If commercial license posture is "no GPL", swap to `eyed3` (MIT) or hand-roll the ~50 LOC ID3 chapter frame writer. Otherwise document the choice in `THIRD_PARTY_LICENSES.md`.

### F-D-09: MusicGen model weights are CC-BY-NC (non-commercial)
- **Severity:** HIGH (procurement)
- **Location:** `pyproject.toml` line 42 (`audiocraft>=1.0.0; python_version >= '3.11'`) under `[project.optional-dependencies] music`
- **Evidence:** audiocraft library is MIT, but the **MusicGen pretrained weights from Meta are CC-BY-NC-4.0** (non-commercial use only). Drevalis is sold commercially.
- **Impact:** Customers running `pip install .[music]` and downloading MusicGen weights through audiocraft are using non-commercial weights for a commercial purpose. This is a license-compliance issue for the customer (and arguably for Drevalis as the seller, depending on how the music feature is marketed).
- **Effort:** small to large depending on remediation
- **Suggested fix:** Procurement / legal issue, not a code fix. Options: (a) document clearly that the MusicGen mood-music feature is "personal/non-commercial use only" in the README + UI; (b) replace MusicGen with AceStep (already supported via ComfyUI workflow — the codebase already prefers it) and remove the `[music]` extra; (c) pay Meta for a commercial license. Recommend (b) — the AceStep workflow is the documented default already (`AceStep — ComfyUI workflow, 12 mood presets`).

### F-D-10: Several minor bumps available across the dependency tree (no CVE)
- **Severity:** NIT
- **Location:** see "MINOR bumps" + "PATCH bumps" tables above
- **Evidence:** ~30 packages with non-security minor/patch bumps available.
- **Impact:** Routine drift. None are security-relevant.
- **Effort:** small
- **Suggested fix:** Run `uv pip compile pyproject.toml -o requirements.txt --upgrade` on the next routine maintenance window. CI will surface anything that breaks.

### F-D-11: Docker bases not patch-pinned and not periodically rebuilt
- **Severity:** LOW
- **Location:** `Dockerfile`, `frontend/Dockerfile`, `license-server/Dockerfile`
- **Evidence:** `python:3.11-slim`, `node:20-alpine`, `debian:bookworm-slim` — all float at the major.minor.
- **Impact:** Each new release picks up upstream patches automatically (good), but if a customer never re-pulls, they sit on stale OS-level CVEs (bad).
- **Effort:** trivial
- **Suggested fix:** No code change. Add a periodic "rebase" release (rebuild from latest base + same source tag) in CI, or document that customers should `docker compose pull` monthly. Already partly handled by the `nginx:1.27-alpine` minor pin which is an *intentional* exception to avoid the v0.22.0 entrypoint regression — keep that one.

---

## Top 5 by ROI

1. **F-D-01** — Bump `cryptography` floor to `>=46.0.7`. Trivial. Closes 2 CVEs in the crypto path that protects all stored API keys + OAuth tokens.
2. **F-D-02** — Bump `anthropic` floor to `>=0.87.0`. Trivial. Closes 2 CVEs in the SDK, no breaking change at 0.86→0.87.
3. **F-D-07** — Pin `uv` Docker stage to a specific version or digest. Trivial. Reproducible builds + supply-chain hygiene.
4. **F-D-09** — Resolve MusicGen license posture (drop the `[music]` extra in favor of AceStep, or document non-commercial). Procurement issue, but the highest *legal* risk on the list.
5. **F-D-03 + F-D-05** — Bump `pip>=25.3` and `pytest>=9.0.3` (paired since both trivial and ride the same maintenance commit). Small risk surface (build/dev only) but free.

## Major bumps requiring approval

- **`cryptography` 46 → 47** — minor-line fix (46.0.7) is enough; do NOT need 47 unless you want it.
- **`redis-py` 5 → 7** — skipped a major; gated on `arq` compat. F-D-06.
- **`huggingface_hub` 1.7 → 1.12** — same major numerically, but the 1.x line breaks APIs across these jumps; verify `faster-whisper` + `tokenizers` compat first.
- **`anthropic` 0.86 → 0.97** — `0.x` SDK; only bump to 0.87 for CVE fix unless a feature-driven reason exists.
- **`openai` 2.29 → 2.33** — same major, low risk, but mark as "next routine bump" rather than urgent.
- **`pip` 25 → 26** — major version; 25.3 is enough for CVEs.
- **`rich` 14 → 15** — major; transitive consumer (structlog) needs verification.
- **React 18 → 19**, **Tailwind 3 → 4**, **react-router 6 → 7** — frontend majors. Not flagged as findings; intentionally on the prior major. Approve before any of these.

## Don't fix (intentional)

- **`nginx:1.27-alpine` minor pin** — explicit comment in `frontend/Dockerfile` (lines 18-26) explains this is a *guard* against the v0.22.0 entrypoint regression. Keep pinned.
- **`pip-licenses` not run** — install was correctly denied per the user's "no install/upgrade" rule. License pass deferred to the next session where install is allowed.
- **React 18 / Tailwind 3 / react-router 6** — staying on the prior major in the JS ecosystem is a deliberate stability choice; React 19 / Tailwind 4 / RR7 are all GA but require migration work disproportionate to benefit. Leave alone.
- **`audiocraft` as optional extra** — already optional and not installed by default; user-installed only. Keep as-is from a code POV; license question (F-D-09) is independent.
- **`mutagen` GPL** (F-D-08) — flagged for legal, not a "fix immediately" item. May intentionally stay if legal accepts the risk.
- **Floating `:latest` tags on `python:3.11-slim` / `node:20-alpine` / `debian:bookworm-slim`** — intentional patch-tracking, balanced by re-pulling on each release. Only the `uv:latest` pin (F-D-07) is genuinely problematic.

# Security Audit — Drevalis Creator Studio (post-March-2026 re-audit)

Scope: re-audit after the 2026-03-23 fixes (C1, C2, H1–H5, M1–M5). Those fixes are present and not regressed. Two HIGH bandit findings, plus several SSRF / auth / encryption / OAuth / dependency findings remain.

## Critical-flagged dependency CVEs (from baseline-pip-audit)

### F-S-01: `cryptography 46.0.5` carries two CVEs (CVE-2026-34073, CVE-2026-39892)
- **Severity:** HIGH
- **Location:** `pyproject.toml` (cryptography pin); `audit/baseline-pip-audit.txt:6-7`
- **Evidence:**
  ```
  cryptography 46.0.5  CVE-2026-34073 46.0.6
  cryptography 46.0.5  CVE-2026-39892 46.0.7
  ```
- **Impact:** `cryptography` underpins Fernet encryption (`core/security.py`), OAuth token encryption (`services/youtube.py`), Ed25519 license JWT signing (`license-server/app/crypto.py`), and license JWT verification (`core/license/keys.py`, `verifier.py`). Any flaw here propagates across the entire trust boundary.
- **Effort:** trivial
- **Suggested fix:** Pin `cryptography>=46.0.7` and re-run pip-audit.

### F-S-02: `anthropic 0.86.0` carries two CVEs (CVE-2026-34450, CVE-2026-34452)
- **Severity:** MEDIUM
- **Location:** `pyproject.toml`; `audit/baseline-pip-audit.txt:4-5`
- **Evidence:** `anthropic 0.86.0  CVE-2026-34450 / 34452 → 0.87.0`
- **Impact:** Used by `AnthropicProvider` in `services/llm/_monolith.py:186` for outbound LLM calls.
- **Effort:** trivial
- **Suggested fix:** Bump to `anthropic>=0.87.0`.

### F-S-03: `pip 25.1.1` (3 CVEs); `pygments 2.19.2` (CVE-2026-4539); `pytest 9.0.2` (CVE-2025-71176)
- **Severity:** LOW
- **Location:** `audit/baseline-pip-audit.txt:8-12`
- **Impact:** All are dev/build-time. Pip is build-time only; pygments + pytest are dev-only.
- **Effort:** trivial
- **Suggested fix:** Update dev pins; document `pip>=26.0` requirement in CONTRIBUTING.md or pre-commit.

---

## Application code findings

### F-S-04: TikTok OAuth callback never validates the `state` parameter against Redis-issued state
- **Severity:** HIGH
- **Location:** `src/drevalis/api/routes/social.py:185-242`
- **Evidence:**
  ```python
  raw = await redis_client.get(f"tiktok_pkce:{state}")
  if raw:
      code_verifier = raw if isinstance(raw, str) else raw.decode()
      await redis_client.delete(f"tiktok_pkce:{state}")
  ...
  if code_verifier:
      token_payload["code_verifier"] = code_verifier
  ```
- **Impact:** When the Redis lookup misses (unknown / forged / replayed state), the code silently proceeds with token exchange minus the PKCE verifier. CSRF protection is delegated entirely to TikTok's optional PKCE enforcement. The non-atomic `get` + `delete` is also a race; YouTube callback uses `getdel` correctly (`youtube/_monolith.py:194`).
- **Effort:** small
- **Suggested fix:** Reject the request when state lookup misses or returns empty; switch to atomic `getdel`.

### F-S-05: Backup tar extraction lacks `filter='data'` — symlink/special-file escape during extract
- **Severity:** HIGH
- **Location:** `src/drevalis/services/backup.py:415-423`
- **Evidence:**
  ```python
  for member in tar.getmembers():
      member_path = (dst / member.name).resolve()
      if not str(member_path).startswith(str(dst_resolved)):
          raise BackupError(f"tar entry escapes target: {member.name!r}")
  tar.extractall(dst)
  ```
- **Impact:** Pre-walk only checks `member.name` against target dir. Symlinks/hardlinks/devices/FIFOs are extracted unchanged. Bandit confirms (B202 HIGH/HIGH). Restore is owner-gated, but a backup uploaded to `/api/v1/backup/upload` is the attack vector.
- **Effort:** trivial
- **Suggested fix:** Use `tar.extractall(dst, filter='data')` (Python 3.12+ tarfile data filter).

### F-S-06: License server URL not SSRF-validated before outbound calls
- **Severity:** MEDIUM
- **Location:** `src/drevalis/core/license/activation.py:46-66, 89-105, 128-145, 150-185, 188-225`; `src/drevalis/services/updates.py:69-95`; `src/drevalis/api/routes/license.py:537`
- **Evidence:**
  ```python
  async def exchange_key_for_jwt(server_url: str, ...):
      url = server_url.rstrip("/") + "/activate"
      async with httpx.AsyncClient(timeout=timeout) as client:
          resp = await client.post(url, json=payload)
  ```
- **Impact:** `settings.license_server_url` is configurable via env. Pointing it at internal hosts (`http://localhost:9200/admin`, `http://169.254.169.254/...`) leaks license keys + machine IDs and enables internal scanning. Helper exists (`validate_safe_url_or_localhost`) but isn't used.
- **Effort:** small
- **Suggested fix:** Call `validate_safe_url_or_localhost(server_url)` once at the top of each helper in `activation.py` and inside `updates.py:_fetch_manifest`.

### F-S-07: Trusts upstream-provided URLs for outbound PUTs (TikTok upload, RunPod proxy)
- **Severity:** MEDIUM
- **Location:** `src/drevalis/workers/jobs/social.py:255-272`; `src/drevalis/services/cloud_gpu/runpod.py:163-167`; `src/drevalis/services/cloud_gpu/lambda_labs.py:252-254`
- **Evidence:**
  ```python
  init_data = init_resp.json().get("data") or {}
  upload_url = init_data.get("upload_url")
  ...
  async with httpx.AsyncClient(timeout=300.0) as client:
      put_resp = await client.put(upload_url, content=body, ...)
  ```
- **Impact:** TikTok-supplied `upload_url` implicitly trusted. RunPod/Lambda `public_url` strings registered as ComfyUI/LLM servers without re-validation.
- **Effort:** medium
- **Suggested fix:** Apply `validate_safe_url` (strict) on `upload_url` before PUT. Re-validate provider proxy URLs at registration.

### F-S-08: Session cookie `secure=False`; secret reuses Fernet `ENCRYPTION_KEY` for HMAC
- **Severity:** MEDIUM
- **Location:** `src/drevalis/api/routes/auth.py:139-147`; `src/drevalis/services/team.py:89-119`
- **Evidence:**
  ```python
  response.set_cookie(
      _COOKIE_NAME, token,
      httponly=True,
      secure=False,
      samesite="lax", ...
  )
  ...
  def _sign(body: str, secret: str) -> str:
      mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
  ```
- **Impact:** (a) Session cookie sent over HTTP if proxy misconfigured. (b) Same `ENCRYPTION_KEY` that encrypts every API key, OAuth token, and license JWT is reused as session-token HMAC secret — any leak of the Fernet key (backup leak, log capture, side-channel) immediately allows session forgery for the whole fleet.
- **Effort:** small
- **Suggested fix:** Add separate `SESSION_SECRET` env; HKDF-derive at startup. Default `secure=True`; gate behind explicit dev override.

### F-S-09: No rate limiting on `POST /api/v1/auth/login`
- **Severity:** MEDIUM
- **Location:** `src/drevalis/api/routes/auth.py:119-149`
- **Evidence:** No dependency-injected rate limiter. `OptionalAPIKeyMiddleware` rate-limits per-IP failed Bearer attempts only — login form 401s pass through middleware.
- **Impact:** PBKDF2 at 480k iterations gives ~6 attempts/sec. CWE-307.
- **Effort:** small
- **Suggested fix:** Per-(IP, email) rate limiter analogous to `core/auth.py:_record_auth_failure`. Lock accounts after N consecutive failures.

### F-S-11: License JWT verifier doesn't require explicit `aud` claim
- **Severity:** LOW
- **Location:** `src/drevalis/core/license/verifier.py:99-105`
- **Evidence:**
  ```python
  payload = jwt.decode(
      token, key=key, algorithms=["EdDSA"],
      issuer=_EXPECTED_ISS,
      options={"require": ["iss", "sub", "exp", "nbf", "iat", "jti"]},
  )
  ```
- **Impact:** Algorithm pinning correct. `iss/exp/nbf/iat` validated. `aud` not required. If the same key is reused for another audience later, tokens minted there validate here. Currently single-audience so practical impact nil.
- **Effort:** trivial
- **Suggested fix:** Add `"aud"` to the `require` list; mint with `aud="drevalis-app"`; verify with `audience=`.

### F-S-12: Webhook idempotency — `unmark_webhook_processed` re-enables replay on partial-failure
- **Severity:** LOW
- **Location:** `license-server/app/routes/webhook.py:299-318`; `license-server/app/db.py:247-274`
- **Evidence:**
  ```python
  if not await db.mark_webhook_processed(event_id):
      return {"received": True, "duplicate": True}
  ...
  try:
      await handler(event)
  except Exception:
      await db.unmark_webhook_processed(event_id)
      raise HTTPException(status_code=500, ...)
  ```
- **Impact:** Handlers are mostly idempotent UPDATEs, so practical impact minimal — but the "processed" guard becomes best-effort.
- **Effort:** medium
- **Suggested fix:** Make handlers fully idempotent and remove `unmark_webhook_processed`; rely on Stripe redelivery only when first INSERT fails.

### F-S-13: License server admin endpoint has no rate limit
- **Severity:** LOW
- **Location:** `license-server/app/routes/admin.py:45-119`
- **Evidence:** Admin endpoints depend only on `_require_admin`. No `rate_limit_ip` decorator.
- **Impact:** With a leaked admin token, a scanner can enumerate every license, mint preview JWTs, and revoke licenses at full speed.
- **Effort:** trivial
- **Suggested fix:** Apply same `RateLimiter` pattern used in `activate.py`.

### F-S-15: SHA-1 used for filename slug (Bandit B324 HIGH false positive)
- **Severity:** NIT
- **Location:** `src/drevalis/services/audiobook/_monolith.py:4436`
- **Evidence:** `slug = hashlib.sha1(title.encode(...)).hexdigest()[:8]`
- **Impact:** None — slug is filename-collision avoider, not integrity check.
- **Effort:** trivial
- **Suggested fix:** Pass `usedforsecurity=False` to silence scanner.

### F-S-16: ComfyUI/LLM URL re-validation gap on legacy DB rows + worker-inserted servers
- **Severity:** LOW
- **Location:** `src/drevalis/services/comfyui/_monolith.py:302-339`; `src/drevalis/workers/jobs/runpod.py:202-227`
- **Evidence:** `sync_from_db()` reads `srv.url` directly into `ComfyUIClient(base_url=srv.url)`; no re-validation. `register_pod_as_llm_server` constructs `base_url` from `proxy_url` and stores via `llm_repo.create()` — bypassing the schema validator on `LLMConfigCreate.base_url`.
- **Impact:** URLs inserted before C2 fix are unvalidated. Worker auto-deploy bypasses schema validator entirely.
- **Effort:** small
- **Suggested fix:** Run `validate_safe_url_or_localhost(srv.url)` inside `ComfyUIPool.sync_from_db()`. In auto-deploy, validate `base_url` before `llm_repo.create()`.

### F-S-17: Unauthenticated `/api/v1/auth/mode` reveals team-mode probe
- **Severity:** LOW
- **Location:** `src/drevalis/api/routes/auth.py:163-181`
- **Evidence:** Public endpoint exposes `team_mode: bool` derived from `count(User) > 0 OR OWNER_EMAIL set`.
- **Impact:** Lets a remote scanner detect team-mode without credentials. Information disclosure only.
- **Effort:** trivial
- **Suggested fix:** Either keep public (intentional per docstring) or strip to single `team_mode_required: bool`.

### F-S-19: WebSocket auth token in query string (logged by reverse proxies)
- **Severity:** LOW
- **Location:** `src/drevalis/api/websocket.py:69-76`
- **Evidence:** `ws_token = websocket.query_params.get("token", "")`
- **Impact:** Misconfigured nginx access-log writes API token to disk on every WS connection.
- **Effort:** trivial
- **Suggested fix:** Document loudly that operators should disable query-string logging for `/ws/*`. Optionally accept sub-protocol header (`Sec-WebSocket-Protocol: bearer.<token>`).

### F-S-20: `/storage/*` exempt from license gate (intentional per ADR — listed for transparency)
- **Severity:** LOW (intentional)
- **Location:** `src/drevalis/core/license/gate.py:34-41`
- **Evidence:** `_EXEMPT_PREFIXES` includes `/storage`. Comment: "blocking would prevent users downloading their own past output."
- **Impact:** When `API_AUTH_TOKEN` unset (local dev), `/storage/*` is wide-open and bypasses license gate. Acceptable for local-first.
- **Effort:** none — accept.
- **Suggested fix:** No change.

---

## Top 5 by ROI

1. **F-S-01** — Bump `cryptography>=46.0.7` (trivial, two CVEs against the most security-critical dep).
2. **F-S-05** — Add `filter='data'` to `tarfile.extractall` in `services/backup.py:423` (trivial, closes HIGH bandit + symlink-escape).
3. **F-S-04** — Validate TikTok OAuth `state` and use `getdel` (small, closes OAuth-CSRF gap).
4. **F-S-08** — Dedicated `SESSION_SECRET` and default `secure=True` (small, decouples session forgery from Fernet-key compromise).
5. **F-S-09** — Per-IP/per-email rate limit on `POST /api/v1/auth/login` (small, defeats brute-force).

## Don't fix (intentional)

- **C2 SSRF allowlist permits localhost / private ranges** — local-first design (`core/validators.py:116-128`). Don't tighten.
- **F-S-20** `/storage/*` license-gate exempt — operators always deserve their own past output.
- **`/api/v1/auth/mode`** intentionally public so LoginGate can pre-render.
- **`/api/v1/license/*`** license-gate exempt so unactivated install can respond.
- **Permissive CORS for localhost dev origins** (`main.py:107-114`) — local-first dev; production fronts via NPM with origin restriction.
- **`secure=False` cookie default in dev** documented; deployed install runs behind TLS-terminating proxy.
- **No HSTS / CSP headers** — local-first single-tenant; CSP would break React dev server.
- **WebSocket token in query string** — browsers can't set Authorization on WS.
- **Bandit B105/B106 "hardcoded passwords"** — all URLs and the literal string `"True"`. Ignore.

---

Tools run:
- `bandit -r src/ -c pyproject.toml` — 2 HIGH (B324 SHA-1 false-positive in audiobook slug, B202 tar extractall in backup.py:423), 5 MEDIUM B105/B106 (false positives), 48 LOW B110 (try/except/pass).
- pip-audit baseline used (`audit/baseline-pip-audit.txt`).

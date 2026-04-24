#!/usr/bin/env bash
# Polls /shared/do_update once per 15 seconds. When the flag appears, pulls
# the new images (tags come from the compose file / env) and restarts the
# stack with docker compose up -d --remove-orphans.
#
# Progress is written to /shared/update_status.json so the frontend can
# show a live phase indicator even while the app container is being
# recycled. Phases: idle -> pulling -> pulled -> restarting -> done / failed.
#
# Deletes the flag on success AND on failure so a broken update doesn't
# wedge the sidecar in an infinite retry loop -- the user can always
# re-click "Update now" from the UI.

set -euo pipefail

FLAG=/shared/do_update
STATUS_FILE=/shared/update_status.json
POLL_SECONDS=${POLL_SECONDS:-15}
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"

log() {
  printf '[updater] %s\n' "$*"
}

# Write a JSON status frame. Shape:
#   { "phase": "...", "detail": "...", "ts": "...", "started_at": "..." }
# Phases are listed in the file header. ``started_at`` is set once per
# update cycle and preserved across frames so the UI can show elapsed time.
STARTED_AT=""
write_status() {
  local phase="$1"
  local detail="${2:-}"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [[ -z "${STARTED_AT}" || "${phase}" == "pulling" ]]; then
    STARTED_AT="${now}"
  fi
  # Escape double quotes in detail so we never emit malformed JSON.
  local escaped_detail="${detail//\\/\\\\}"
  escaped_detail="${escaped_detail//\"/\\\"}"
  cat > "${STATUS_FILE}.tmp" <<EOF
{"phase": "${phase}", "detail": "${escaped_detail}", "ts": "${now}", "started_at": "${STARTED_AT}"}
EOF
  mv -f "${STATUS_FILE}.tmp" "${STATUS_FILE}"
  chmod 0644 "${STATUS_FILE}"
}

# Named volumes are initialised root:root 0755 by Docker, which blocks
# the non-root `appuser` (UID 1000) in the app container from creating
# the flag file. The updater runs as root, so it's the only place that
# can relax the permissions once on startup.
mkdir -p /shared
chmod 0777 /shared
log "shared volume readied (0777 /shared)"

# Initialise status. ``idle`` + missing ``started_at`` tells the UI that no
# update is in progress, so the overlay won't reappear on page load.
write_status "idle" ""
STARTED_AT=""

# v0.20.8 — resolve our own container's /project mount to the REAL
# host directory. Previously the updater passed ``--project-directory
# /project`` (our container-side mount point), so docker compose
# recorded bind-mount sources as ``/project/storage`` — a Linux-VM
# path that's meaningless on Windows hosts. Result: /app/storage in
# the app container was bound to the updater's bind, not the user's
# %USERPROFILE%\Drevalis\storage. Media invisible despite being
# present on disk. See issue: v0.20.5-v0.20.7 "content not available".
#
# Fix: ``docker inspect $(hostname)`` returns our own container; read
# the Source of the /project mount to get the host path Docker has
# on file, and pass THAT as --project-directory. Docker then resolves
# ``./storage`` against the real host dir, so bind sources match
# what the user would see if they ran ``docker compose up -d`` from
# PowerShell themselves.
UPDATER_ID=$(cat /etc/hostname 2>/dev/null || hostname)
HOST_PROJECT_DIR=""
if [[ -n "${UPDATER_ID}" ]]; then
  HOST_PROJECT_DIR=$(
    docker inspect "${UPDATER_ID}" --format \
      '{{range .Mounts}}{{if eq .Destination "/project"}}{{.Source}}{{end}}{{end}}' \
      2>/dev/null || true
  )
fi

if [[ -n "${HOST_PROJECT_DIR}" && "${HOST_PROJECT_DIR}" != "/project" ]]; then
  log "host project directory resolved via docker inspect: ${HOST_PROJECT_DIR}"
  # The compose CLI runs INSIDE this updater container, so the --file
  # argument must point at a path readable from here (``/project/…``).
  # --project-directory is used by the daemon to resolve relative bind
  # mounts in the compose file — set it to the REAL host path so
  # Docker records ``C:\Users\...\storage`` instead of ``/project/
  # storage`` on bind-mount sources.
  compose_args=(
    --file /project/docker-compose.yml
    --project-directory "${HOST_PROJECT_DIR}"
  )
else
  # Fallback for bare-Linux installs where /project IS the host path
  # (no path translation needed) or for environments where docker
  # inspect on our own ID is denied.
  log "host project directory fallback: /project (Linux-native or inspect denied)"
  compose_args=(--project-directory /project)
fi

if [[ -n "${PROJECT_NAME}" ]]; then
  compose_args+=(--project-name "${PROJECT_NAME}")
  log "using compose project name: ${PROJECT_NAME}"
else
  log "WARNING: COMPOSE_PROJECT_NAME not set -- sidecar will default to 'project' and may create a parallel stack instead of restarting the real one"
fi

log "watching ${FLAG} (poll ${POLL_SECONDS}s)"

while true; do
  if [[ -f "${FLAG}" ]]; then
    log "flag detected -- pulling new images"
    write_status "pulling" "docker compose pull started"

    # v0.20.21 — pre-flight network check. Hit ghcr.io's /v2/ endpoint
    # and accept 200 OR 401 as "reachable" — the registry protocol
    # ALWAYS returns 401 for unauthenticated requests to /v2/, so
    # treating it as a failure (v0.20.17 did) blocks every legitimate
    # update with a bogus network-error message. A 401 here proves
    # DNS + TLS + TCP are fully working; `docker compose pull` handles
    # the token exchange itself a moment later.
    ghcr_rc=0
    ghcr_status=$(curl -sS --max-time 8 -o /dev/null \
        -w "%{http_code}" https://ghcr.io/v2/ 2>/tmp/curl.err) || ghcr_rc=$?
    if [[ ${ghcr_rc} -ne 0 ]]; then
      err_detail=$(head -c 300 /tmp/curl.err 2>/dev/null | tr '\n' ' ')
      write_status "failed" "cannot reach ghcr.io (network / DNS / TLS): ${err_detail}"
      log "preflight ghcr.io unreachable (curl rc=${ghcr_rc}) — ${err_detail}"
      rm -f "${FLAG}"
      continue
    fi
    case "${ghcr_status}" in
      200|401)
        log "preflight ghcr.io reachable (status=${ghcr_status})"
        ;;
      *)
        write_status "failed" "ghcr.io returned unexpected status ${ghcr_status}"
        log "preflight ghcr.io unexpected status ${ghcr_status}"
        rm -f "${FLAG}"
        continue
        ;;
    esac

    # Capture pull output and its exit code. Can't use tee in a pipeline
    # for the exit code (set -o pipefail is on, but the tee wouldn't
    # reflect the pull's rc anyway — PIPESTATUS[0] is what we want).
    set +o pipefail
    docker compose "${compose_args[@]}" pull > /tmp/pull.log 2>&1
    pull_rc=$?
    set -o pipefail
    cat /tmp/pull.log

    if [[ ${pull_rc} -eq 0 ]]; then
      write_status "pulled" "images pulled, about to restart services"
      log "pull ok -- restarting stack"

      # Restart every service EXCEPT this updater itself. If we included
      # 'updater' in the up -d call, docker compose would SIGTERM us
      # mid-flight while recreating the updater service, leaving the app
      # container stuck in 'Created' state (never started). Compose is
      # synchronous and runs in a child of this bash script -- kill the
      # script and you kill compose too.
      #
      # Trade-off: if the UPDATER image itself changed in this release,
      # the new updater image is pulled but not started until the next
      # manual `docker compose up -d updater`. That's rare and safe.
      services_to_restart=$(docker compose "${compose_args[@]}" config --services 2>/dev/null | grep -v '^updater$' | tr '\n' ' ')
      if [[ -z "${services_to_restart// /}" ]]; then
        write_status "failed" "could not enumerate compose services"
        log "could not enumerate services -- aborting"
        rm -f "${FLAG}"
        continue
      fi
      log "restarting services (excluding self): ${services_to_restart}"

      write_status "restarting" "docker compose up -d ${services_to_restart}"
      # shellcheck disable=SC2086 # intentional word-splitting of service list
      if docker compose "${compose_args[@]}" up -d --remove-orphans ${services_to_restart} 2>&1 | tee /tmp/up.log; then
        write_status "done" "stack recreated on the new image"
        log "restart ok"
      else
        write_status "failed" "docker compose up -d returned non-zero; check updater logs"
        log "restart FAILED"
      fi
    else
      # Put the tail of the actual pull log into the status JSON so
      # the UI can show the real error (missing image tag, ghcr auth,
      # DNS failure, etc.) instead of a generic "pull failed".
      pull_tail=$(tail -n 5 /tmp/pull.log 2>/dev/null | tr '\n' ' ' | head -c 400)
      write_status "failed" "docker compose pull failed (rc=${pull_rc}): ${pull_tail}"
      log "pull FAILED (rc=${pull_rc}) -- flag cleared"
      log "--- last lines of pull.log ---"
      tail -n 20 /tmp/pull.log 2>/dev/null || true
      log "--- end pull.log ---"
    fi
    rm -f "${FLAG}"
    STARTED_AT=""
  fi
  sleep "${POLL_SECONDS}"
done

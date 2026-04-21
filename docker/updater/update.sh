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

compose_args=(--project-directory /project)
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

    if docker compose "${compose_args[@]}" pull 2>&1 | tee /tmp/pull.log; then
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
      write_status "failed" "docker compose pull failed; check updater logs + network access to ghcr.io"
      log "pull FAILED -- flag cleared, retry from UI if needed"
    fi
    rm -f "${FLAG}"
    STARTED_AT=""
  fi
  sleep "${POLL_SECONDS}"
done

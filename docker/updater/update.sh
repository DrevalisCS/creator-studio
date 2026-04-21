#!/usr/bin/env bash
# Polls /shared/do_update once per 15 seconds. When the flag appears, pulls
# the new images (tags come from the compose file / env) and restarts the
# stack with docker compose up -d --remove-orphans.
#
# Deletes the flag on success AND on failure so a broken update doesn't
# wedge the sidecar in an infinite retry loop — the user can always
# re-click "Update now" from the UI.

set -euo pipefail

FLAG=/shared/do_update
POLL_SECONDS=${POLL_SECONDS:-15}
# COMPOSE_PROJECT_NAME must match the host's project name so the sidecar
# operates on the *real* running stack. Otherwise `docker compose up -d`
# creates a parallel "project" stack under a different name and the user's
# original containers keep running the old image. Set by the installer
# compose file via `environment.COMPOSE_PROJECT_NAME: ${COMPOSE_PROJECT_NAME}`
# (Docker Compose itself exports the variable into the sidecar env).
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"

log() {
  printf '[updater] %s\n' "$*"
}

# Named volumes are initialised root:root 0755 by Docker, which blocks
# the non-root `appuser` (UID 1000) in the app container from creating
# the flag file (observed: `[Errno 13] Permission denied: '/shared/do_update'`).
# The updater runs as root, so it's the only place that can relax the
# permissions once on startup. After this chmod, the app can freely
# toggle the flag and no race exists — this runs before the poll loop
# even begins, and the app only writes the flag on a user-initiated update.
mkdir -p /shared
chmod 0777 /shared
log "shared volume readied (0777 /shared)"

compose_args=(--project-directory /project)
if [[ -n "${PROJECT_NAME}" ]]; then
  compose_args+=(--project-name "${PROJECT_NAME}")
  log "using compose project name: ${PROJECT_NAME}"
else
  log "WARNING: COMPOSE_PROJECT_NAME not set — sidecar will default to 'project' and may create a parallel stack instead of restarting the real one"
fi

log "watching ${FLAG} (poll ${POLL_SECONDS}s)"

while true; do
  if [[ -f "${FLAG}" ]]; then
    log "flag detected — pulling new images"
    if docker compose "${compose_args[@]}" pull; then
      log "pull ok — restarting stack"
      if docker compose "${compose_args[@]}" up -d --remove-orphans; then
        log "restart ok"
      else
        log "restart FAILED"
      fi
    else
      log "pull FAILED — flag cleared, retry from UI if needed"
    fi
    rm -f "${FLAG}"
  fi
  sleep "${POLL_SECONDS}"
done

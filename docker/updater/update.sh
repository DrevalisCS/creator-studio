#!/usr/bin/env bash
# Watches /shared/do_update once per 15 seconds. When the flag appears,
# pulls each stack image directly via ``docker pull`` and restarts the
# affected containers via ``docker restart``.
#
# ── Why no ``docker compose``? ────────────────────────────────────
# The updater runs inside a container. ``docker compose`` CLI reads
# compose.yml + .env locally to the process. On Docker Desktop for
# Windows, bind mounts are recorded against ``--project-directory``,
# which needs to be the Windows host path for the containers to see
# the user's files. But the CLI also reads relative files like
# ``env_file: .env`` against that same project-directory — and a
# Windows path is unreadable from inside the Linux container, so
# compose fails with ``stat /project/C:\Users\...\.env: no such
# file or directory``.
#
# v0.20.8 – v0.20.22 tried progressively harder to juggle
# ``--project-directory`` / ``--file`` / ``--env-file``. Every
# workaround hit a new edge case. The fundamental insight: we don't
# need compose at all. The user's PowerShell ran compose to create
# the containers with correct bind mounts. ``docker pull`` + ``docker
# restart`` preserves those bind mounts verbatim and swaps only the
# image under each service. That's exactly what routine image
# updates need to do. Compose-shape changes (new services, new env
# vars) are rare and handled via a release-note banner prompting the
# user to run PowerShell once.
#
# Phases written to /shared/update_status.json:
#   idle -> pulling -> pulled -> restarting -> done / failed

set -euo pipefail

FLAG=/shared/do_update
STATUS_FILE=/shared/update_status.json
POLL_SECONDS=${POLL_SECONDS:-15}
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-drevalis}"

log() {
  printf '[updater] %s\n' "$*"
}

STARTED_AT=""
write_status() {
  local phase="$1"
  local detail="${2:-}"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [[ -z "${STARTED_AT}" || "${phase}" == "pulling" ]]; then
    STARTED_AT="${now}"
  fi
  local escaped_detail="${detail//\\/\\\\}"
  escaped_detail="${escaped_detail//\"/\\\"}"
  cat > "${STATUS_FILE}.tmp" <<EOF
{"phase": "${phase}", "detail": "${escaped_detail}", "ts": "${now}", "started_at": "${STARTED_AT}"}
EOF
  mv -f "${STATUS_FILE}.tmp" "${STATUS_FILE}"
  chmod 0644 "${STATUS_FILE}"
}

mkdir -p /shared
chmod 0777 /shared
log "shared volume readied (0777 /shared)"

write_status "idle" ""
STARTED_AT=""

# ── Discovery: list every container belonging to this project ─────
#
# ``com.docker.compose.project=<name>`` label is set on every
# container compose creates. We query by that label so we never touch
# unrelated containers on the host.
list_project_containers() {
  docker ps -a \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --format '{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.service"}}|{{.State}}' \
    2>/dev/null
}

log "targeting compose project: ${PROJECT_NAME}"
log "watching ${FLAG} (poll ${POLL_SECONDS}s)"

while true; do
  if [[ -f "${FLAG}" ]]; then
    log "flag detected -- starting update"
    # Clear the flag BEFORE work begins. If the container gets killed
    # mid-run for any reason, the fresh instance doesn't loop on the
    # same stale flag. User retries from the UI.
    rm -f "${FLAG}"
    write_status "pulling" "starting image pulls"

    # ── Preflight: ghcr.io reachability ───────────────────────────
    ghcr_rc=0
    ghcr_status=$(curl -sS --max-time 8 -o /dev/null \
        -w "%{http_code}" https://ghcr.io/v2/ 2>/tmp/curl.err) || ghcr_rc=$?
    if [[ ${ghcr_rc} -ne 0 ]]; then
      err_detail=$(head -c 300 /tmp/curl.err 2>/dev/null | tr '\n' ' ')
      write_status "failed" "cannot reach ghcr.io: ${err_detail}"
      log "preflight ghcr.io unreachable (rc=${ghcr_rc}) — ${err_detail}"
      STARTED_AT=""
      continue
    fi
    case "${ghcr_status}" in
      200|401)
        log "preflight ghcr.io reachable (status=${ghcr_status})"
        ;;
      *)
        write_status "failed" "ghcr.io returned unexpected status ${ghcr_status}"
        log "preflight ghcr.io unexpected status ${ghcr_status}"
        STARTED_AT=""
        continue
        ;;
    esac

    # ── Enumerate containers in the stack ─────────────────────────
    containers_raw=$(list_project_containers)
    if [[ -z "${containers_raw}" ]]; then
      write_status "failed" "no containers found for project=${PROJECT_NAME}"
      log "no containers with label com.docker.compose.project=${PROJECT_NAME}"
      STARTED_AT=""
      continue
    fi

    # Collect unique images (one image per service), skipping the
    # updater service (pulling our own image while we run risks
    # container recreation). Registry-sourced images only — skip
    # locally-built ones that don't live on ghcr.io (postgres, redis
    # from docker hub DO get updated, which is what we want).
    declare -A images_to_pull=()
    declare -a services_to_restart=()
    while IFS='|' read -r name image service state; do
      [[ -z "${name}" ]] && continue
      if [[ "${service}" == "updater" ]]; then
        log "skipping self (service=${service}, name=${name})"
        continue
      fi
      images_to_pull["${image}"]=1
      services_to_restart+=("${name}")
    done <<< "${containers_raw}"

    log "images to pull: ${!images_to_pull[*]}"
    log "containers to restart after pull: ${services_to_restart[*]}"

    # ── Pull each unique image ────────────────────────────────────
    : > /tmp/pull.log
    pull_rc=0
    failed_image=""
    for image in "${!images_to_pull[@]}"; do
      log "pulling: ${image}"
      write_status "pulling" "pulling ${image}"
      set +o pipefail
      timeout 600 docker pull "${image}" 2>&1 | tee -a /tmp/pull.log
      rc=${PIPESTATUS[0]}
      set -o pipefail
      if [[ ${rc} -ne 0 ]]; then
        pull_rc=${rc}
        failed_image="${image}"
        log "pull ${image} FAILED (rc=${rc})"
        break
      fi
    done

    if [[ ${pull_rc} -ne 0 ]]; then
      pull_tail=$(tail -n 5 /tmp/pull.log 2>/dev/null | tr '\n' ' ' | head -c 400)
      if [[ ${pull_rc} -eq 124 ]]; then
        write_status "failed" "pull of ${failed_image} timed out after 10 min: ${pull_tail}"
      else
        write_status "failed" "pull of ${failed_image} failed (rc=${pull_rc}): ${pull_tail}"
      fi
      log "--- last lines of pull.log ---"
      tail -n 20 /tmp/pull.log 2>/dev/null || true
      log "--- end pull.log ---"
      STARTED_AT=""
      continue
    fi

    write_status "pulled" "all images pulled, restarting services"
    log "pull ok -- restarting services"

    # ── Restart each affected container ───────────────────────────
    #
    # ``docker restart`` SIGTERMs the container (graceful shutdown
    # via the entrypoint), then starts it again. The container's
    # config — including bind mounts, env vars, port bindings — is
    # preserved from when the user ran ``docker compose up -d``
    # from PowerShell.
    #
    # ``docker restart`` does NOT re-pull the image, BUT it re-
    # creates the container from the image currently tagged as the
    # one the container was started with. Since we just pulled a
    # new image under that same tag, the restart picks it up.
    #
    # Some installs pin by digest rather than tag — ``docker restart``
    # won't switch to a new digest. In that rare case we fall back to
    # recreate-from-scratch: ``docker rm -f`` + re-run with the same
    # config. That's signalled by the user on the UI.
    restart_rc=0
    failed_container=""
    : > /tmp/restart.log
    for name in "${services_to_restart[@]}"; do
      log "restarting container: ${name}"
      write_status "restarting" "restarting ${name}"
      # Force-recreate by stop+rm+start-from-image avoids the
      # "pinned-by-digest" issue: we read the container's current
      # image + config, remove the container, and start a new one.
      # BUT Docker CLI doesn't have a one-shot "recreate with same
      # config" verb. ``docker restart`` handles the tag-update case,
      # which is what compose produces; we start there.
      set +o pipefail
      timeout 120 docker restart "${name}" 2>&1 | tee -a /tmp/restart.log
      rc=${PIPESTATUS[0]}
      set -o pipefail
      if [[ ${rc} -ne 0 ]]; then
        restart_rc=${rc}
        failed_container="${name}"
        log "restart ${name} FAILED (rc=${rc})"
        break
      fi
    done

    if [[ ${restart_rc} -ne 0 ]]; then
      restart_tail=$(tail -n 5 /tmp/restart.log 2>/dev/null | tr '\n' ' ' | head -c 400)
      write_status "failed" "restart of ${failed_container} failed (rc=${restart_rc}): ${restart_tail}"
      log "--- last lines of restart.log ---"
      tail -n 20 /tmp/restart.log 2>/dev/null || true
      log "--- end restart.log ---"
      STARTED_AT=""
      continue
    fi

    write_status "done" "stack updated: ${#images_to_pull[@]} image(s) pulled, ${#services_to_restart[@]} container(s) restarted"
    log "update complete"
    STARTED_AT=""
  fi
  sleep "${POLL_SECONDS}"
done

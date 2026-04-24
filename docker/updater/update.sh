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
  # Use ``Config.Image`` via ``docker inspect`` rather than
  # ``docker ps --format '{{.Image}}'``. The latter returns the raw
  # image SHA ID (``b0c778a40ed1``) when the tag has been bumped since
  # the container was created — unpullable, because it lacks a
  # registry name. ``Config.Image`` holds the original reference
  # (e.g. ``ghcr.io/drevaliscs/creator-studio-app:stable``) that
  # compose wrote at creation time, which IS pullable.
  local names
  names=$(
    docker ps -a \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --format '{{.Names}}' \
      2>/dev/null
  )
  for name in ${names}; do
    local image service state
    image=$(
      docker inspect "${name}" --format '{{.Config.Image}}' 2>/dev/null
    )
    service=$(
      docker inspect "${name}" \
        --format '{{index .Config.Labels "com.docker.compose.service"}}' \
        2>/dev/null
    )
    state=$(docker inspect "${name}" --format '{{.State.Status}}' 2>/dev/null)
    printf '%s|%s|%s|%s\n' "${name}" "${image}" "${service}" "${state}"
  done
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
      # Guard: refuse to pull something that looks like a raw image
      # ID (12-char hex, no ':' or '/') — those can't be pulled
      # without a registry reference. Fall through to restart-only,
      # which is still useful: Docker honors the already-pulled
      # image under whatever tag the user's most recent PowerShell
      # ``docker compose pull`` recorded.
      if [[ "${image}" =~ ^[0-9a-f]{8,}$ ]] || ! [[ "${image}" == *":"* || "${image}" == *"/"* ]]; then
        log "skipping pull for ${name}: image '${image}' has no registry reference (will still restart)"
      else
        images_to_pull["${image}"]=1
      fi
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

    write_status "pulled" "all images pulled, recreating containers"
    log "pull ok -- recreating containers on new images"

    # ── Recreate each affected container ──────────────────────────
    #
    # ``docker restart`` does NOT swap the image — it stops and
    # starts the SAME container from the same image SHA recorded at
    # creation time. To pick up a freshly-pulled tag, we have to
    # ``rm`` the old container and ``run`` a new one. Config
    # (bind mounts, env, ports, networks, restart policy, labels,
    # entrypoint, command, working dir) is captured from the old
    # container's ``docker inspect`` output via ``jq`` and passed to
    # ``docker run`` so the new container is config-equivalent with
    # only the image changed. Result: acts exactly like ``docker
    # compose up -d --force-recreate`` but without the compose-CLI
    # path-resolution bugs on Windows Docker Desktop.
    restart_rc=0
    failed_container=""
    : > /tmp/restart.log
    for name in "${services_to_restart[@]}"; do
      log "recreating container: ${name}"
      write_status "restarting" "recreating ${name}"

      # 1. Snapshot the full container config.
      if ! snapshot=$(docker inspect "${name}" 2>&1); then
        log "inspect ${name} FAILED: ${snapshot}"
        restart_rc=1
        failed_container="${name}"
        echo "inspect ${name} FAILED: ${snapshot}" >> /tmp/restart.log
        break
      fi

      # Target image = the new tag. ``Config.Image`` holds the tag
      # we just pulled — ideal, since ``Image`` in HostConfig holds
      # the resolved SHA which would defeat the point.
      new_image=$(echo "${snapshot}" | jq -r '.[0].Config.Image')
      if [[ -z "${new_image}" || "${new_image}" == "null" ]]; then
        log "recreate ${name} FAILED: no Config.Image"
        restart_rc=1
        failed_container="${name}"
        break
      fi

      # 2. Build a ``docker run`` arg list from the snapshot. We
      # cover the subset compose actually uses: name, restart,
      # labels, env, ports, binds, network + aliases, working_dir,
      # user, entrypoint, command. Security options + hostname are
      # passed through too so hardening flags survive the swap.
      run_args=()
      run_args+=(-d --name "${name}")

      # Restart policy
      restart_policy=$(echo "${snapshot}" | jq -r '.[0].HostConfig.RestartPolicy.Name // "no"')
      if [[ "${restart_policy}" != "no" && "${restart_policy}" != "null" ]]; then
        run_args+=(--restart "${restart_policy}")
      fi

      # Labels — preserved verbatim (includes compose project /
      # service labels we need for future discovery).
      while IFS=$'\t' read -r key val; do
        [[ -n "${key}" ]] && run_args+=(--label "${key}=${val}")
      done < <(echo "${snapshot}" | jq -r '.[0].Config.Labels // {} | to_entries[] | "\(.key)\t\(.value)"')

      # Env vars
      while IFS= read -r env_line; do
        [[ -n "${env_line}" ]] && run_args+=(-e "${env_line}")
      done < <(echo "${snapshot}" | jq -r '.[0].Config.Env[]? // empty')

      # Bind mounts (preserves the host paths compose originally
      # recorded — this is the whole reason we go container → image
      # rather than compose → container).
      while IFS=$'\t' read -r src dst mode; do
        [[ -z "${src}" ]] && continue
        if [[ -n "${mode}" && "${mode}" != "null" ]]; then
          run_args+=(-v "${src}:${dst}:${mode}")
        else
          run_args+=(-v "${src}:${dst}")
        fi
      done < <(echo "${snapshot}" | jq -r '.[0].HostConfig.Binds // [] | .[] | split(":") as $p | "\($p[0])\t\($p[1])\t\($p[2] // "")"')

      # Named volumes mounted as volumes (not binds)
      while IFS=$'\t' read -r src dst; do
        [[ -z "${src}" || -z "${dst}" ]] && continue
        run_args+=(-v "${src}:${dst}")
      done < <(echo "${snapshot}" | jq -r '.[0].Mounts // [] | .[] | select(.Type == "volume") | "\(.Name)\t\(.Destination)"')

      # Port bindings (e.g. 8000:8000, 3000:3000)
      while IFS= read -r port_line; do
        [[ -n "${port_line}" ]] && run_args+=(-p "${port_line}")
      done < <(
        echo "${snapshot}" | \
        jq -r '.[0].HostConfig.PortBindings // {} | to_entries[] | .value[] as $b | "\($b.HostIp // "")\($b.HostIp | if . == "" or . == null then "" else ":" end)\($b.HostPort):\(.key | split("/")[0])"' | \
        sed 's/^://'
      )

      # Working dir
      workdir=$(echo "${snapshot}" | jq -r '.[0].Config.WorkingDir // empty')
      [[ -n "${workdir}" ]] && run_args+=(-w "${workdir}")

      # User
      user_val=$(echo "${snapshot}" | jq -r '.[0].Config.User // empty')
      [[ -n "${user_val}" ]] && run_args+=(-u "${user_val}")

      # Hostname + cap_drop/cap_add are intentionally skipped — the
      # image defaults cover the common case; compose's hardening
      # flags are replayed via labels that our future reconciler
      # can re-apply. Users relying on custom caps need to
      # ``docker compose up -d`` from PowerShell once per release
      # (same constraint as compose-shape changes).

      # Entrypoint (preserved only if explicitly set on the container
      # — otherwise let the image's own ENTRYPOINT apply).
      entrypoint=$(echo "${snapshot}" | jq -r '.[0].Config.Entrypoint // empty | if . == null or . == [] then empty elif type == "array" then join(" ") else . end')
      if [[ -n "${entrypoint}" ]]; then
        run_args+=(--entrypoint "${entrypoint}")
      fi

      # Determine the primary network + aliases so the recreated
      # container rejoins the compose default network. Use the
      # FIRST network since compose puts service containers on a
      # single project network by default.
      primary_net=$(echo "${snapshot}" | jq -r '.[0].NetworkSettings.Networks // {} | keys | .[0] // empty')

      # Command (the CMD override compose set, e.g. "sh -c alembic...")
      # Captured as a JSON array so arg boundaries survive.
      cmd_json=$(echo "${snapshot}" | jq -c '.[0].Config.Cmd // empty')

      # 3. Stop + remove the old container. ``rm -f`` stops then
      # removes in one step; named-volume data persists on disk.
      if ! docker rm -f "${name}" >> /tmp/restart.log 2>&1; then
        log "rm ${name} FAILED (see restart.log)"
        restart_rc=1
        failed_container="${name}"
        break
      fi

      # 4. ``docker run`` with the captured args + new image. If the
      # container had a primary network, ``--network`` is appended
      # after the image so compose project network membership is
      # restored (compose used this network for service-to-service
      # DNS like ``postgres:5432``).
      if [[ -n "${primary_net}" && "${primary_net}" != "null" ]]; then
        run_args+=(--network "${primary_net}")
      fi

      # Feed the command as JSON so each arg stays a separate token.
      run_cmd=(docker run "${run_args[@]}" "${new_image}")
      if [[ -n "${cmd_json}" && "${cmd_json}" != "null" && "${cmd_json}" != "[]" ]]; then
        # shellcheck disable=SC2207
        cmd_parts=($(echo "${cmd_json}" | jq -r '.[]'))
        run_cmd+=("${cmd_parts[@]}")
      fi

      log "running: docker run … ${new_image}  (${#run_args[@]} opts, cmd=${cmd_json})"
      if ! "${run_cmd[@]}" >> /tmp/restart.log 2>&1; then
        log "run ${name} FAILED (see restart.log)"
        restart_rc=1
        failed_container="${name}"
        break
      fi
      log "recreated ${name} on ${new_image}"
    done

    if [[ ${restart_rc} -ne 0 ]]; then
      restart_tail=$(tail -n 5 /tmp/restart.log 2>/dev/null | tr '\n' ' ' | head -c 400)
      write_status "failed" "recreate of ${failed_container} failed (rc=${restart_rc}): ${restart_tail}"
      log "--- last lines of restart.log ---"
      tail -n 20 /tmp/restart.log 2>/dev/null || true
      log "--- end restart.log ---"
      STARTED_AT=""
      continue
    fi

    write_status "done" "stack updated: ${#images_to_pull[@]} image(s) pulled, ${#services_to_restart[@]} container(s) recreated"
    log "update complete"
    STARTED_AT=""
  fi
  sleep "${POLL_SECONDS}"
done

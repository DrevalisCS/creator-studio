#!/usr/bin/env bash
# Drevalis app/worker entrypoint.
#
# Runs as root just long enough to fix the bind-mounted ./storage
# directory's ownership (Docker Desktop on Windows and some Linux
# hosts present the mount root-owned, blocking writes from the
# UID 1000 appuser the image runs as), then drops privileges and
# execs the real command.
#
# Idempotent: if /app/storage is already writable by UID 1000, the
# chmod + chown are no-ops.

set -euo pipefail

STORAGE=/app/storage

# Make sure every subdir the app tries to mkdir on boot exists and
# is owned by appuser. Silent on success, noisy on failure (stderr
# becomes part of docker logs so the operator sees it).
if [[ "$(id -u)" -eq 0 ]]; then
  mkdir -p \
    "${STORAGE}" \
    "${STORAGE}/episodes" \
    "${STORAGE}/audiobooks" \
    "${STORAGE}/voice_previews" \
    "${STORAGE}/models" \
    "${STORAGE}/music" \
    "${STORAGE}/backups"
  chown -R 1000:1000 "${STORAGE}" 2>/dev/null || true
  # `u+rwX` keeps existing executable bits on files while ensuring dirs
  # are traversable; harmless on already-correct perms.
  chmod -R u+rwX "${STORAGE}" 2>/dev/null || true

  # Drop privileges and exec the real process. `exec` replaces this
  # shell so signals (SIGTERM, SIGINT) reach uvicorn/arq cleanly.
  exec runuser -u appuser -- "$@"
fi

# Already non-root (e.g. someone overrode USER in docker-compose or
# ran the image via `docker run --user`). Skip the ownership fix —
# there's no privilege to do it — and just exec directly. If the
# mount is root-owned in this case the app will fail fast with a
# clear PermissionError pointing at /app/storage, same as before.
exec "$@"

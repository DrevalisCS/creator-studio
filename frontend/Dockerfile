# ── Stage 1: Build ───────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# ``npm ci`` requires a committed lockfile and gives reproducible,
# vulnerability-pinned installs. Falls back to ``npm install`` only if
# the lockfile is missing (shouldn't happen in CI / release images).
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ── Stage 2: Serve via nginx ─────────────────────────────────────────────
# Static bundle from ``dist/`` + reverse proxy to the backend at
# ``http://app:8000`` (api) and ``ws://app:8000`` (websockets).
#
# Pinned to a specific minor (1.27-alpine) instead of plain ``alpine``
# because v0.22.0 saw "nginx: invalid option: off;" crash loops on
# customer installs that pulled a newer stock image. The newer
# image's entrypoint chain re-tokenises the default CMD's
# ``daemon off;`` argument under our non-root USER, breaking startup.
# Pinning the minor stops the base from drifting underneath us; the
# entrypoint is also bypassed below so future regressions can't
# repeat the issue.
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# Ensure nginx can read everything regardless of the host's umask.
RUN chmod -R a+rX /usr/share/nginx/html

# Run as the built-in non-root ``nginx`` user. The stock nginx:alpine
# image still drops into root by default; flipping the USER here means
# a container escape starts as an unprivileged uid.
#
# nginx:alpine defaults to ``pid /run/nginx.pid`` (NOT /var/run) so we
# rewrite the nginx.conf pid directive to /tmp/nginx.pid, a path the
# ``nginx`` uid can always write to. Cache + log dirs get chowned so
# the non-root process can use them.
RUN sed -i 's#^pid[[:space:]]\+.*;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && chown -R nginx:nginx \
       /usr/share/nginx/html \
       /var/cache/nginx \
       /var/log/nginx \
       /etc/nginx/conf.d
USER nginx

# wget is in busybox on alpine — use it for the healthcheck so we don't
# inflate the image with curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:3000/ || exit 1

EXPOSE 3000

# Bypass the stock /docker-entrypoint.sh that runs the
# /docker-entrypoint.d/*.sh chain. Those scripts (in particular
# 30-tune-worker-processes.sh and 15-local-resolvers.envsh in newer
# nginx:alpine) misbehave when run under USER nginx and are
# responsible for the "invalid option: off;" crash that broke v0.22.0
# updates. We don't need any of their behaviors:
#   - Our config has its own ``resolver 127.0.0.11`` block.
#   - We don't use Nginx's worker_processes autotune.
#   - We don't use template-style envsubst.
# So we set an empty ENTRYPOINT and exec nginx directly with the
# canonical ``daemon off;`` arg properly quoted as a single argv
# element.
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]

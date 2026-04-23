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
FROM nginx:alpine AS runtime

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
# the non-root process can use them, and the stock entrypoint scripts
# stay happy.
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

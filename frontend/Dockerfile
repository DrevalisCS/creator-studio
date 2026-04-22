# ── Stage 1: Build ───────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

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

# wget is in busybox on alpine — use it for the healthcheck so we don't
# inflate the image with curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:3000/ || exit 1

EXPOSE 3000

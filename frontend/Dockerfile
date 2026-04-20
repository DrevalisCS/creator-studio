# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer caching)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy application source and config
COPY . .

# Build the Vite application
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy dependency manifests and install production deps only
COPY package.json package-lock.json* ./
RUN npm install

# Copy built assets from builder (for production use with vite preview)
COPY --from=builder /app/dist ./dist

# Copy config files needed at runtime
COPY --from=builder /app/vite.config.* ./
COPY --from=builder /app/tailwind.config.* ./
COPY --from=builder /app/tsconfig*.json ./
COPY --from=builder /app/postcss.config.* ./
COPY --from=builder /app/index.html ./

# Copy source for dev mode hot reload
COPY --from=builder /app/src ./src

# Create non-root user
RUN addgroup -g 1001 -S appuser && \
    adduser -S -u 1001 -G appuser appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 3000

# Dev mode: Vite dev server with HMR
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "3000"]

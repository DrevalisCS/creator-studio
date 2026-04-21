# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /build

# Install uv (fast Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency manifest first (layer caching for deps)
COPY pyproject.toml ./

# Create venv, compile pinned requirements from pyproject.toml, install deps
RUN uv venv /build/.venv && \
    uv pip compile pyproject.toml -o requirements.txt && \
    uv pip install --python /build/.venv/bin/python --no-cache -r requirements.txt

# Copy application source and migrations
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY alembic.ini ./

# Install the project itself (no-deps since deps already installed)
RUN uv pip install --python /build/.venv/bin/python --no-cache --no-deps .

# ── Stage 2: Piper TTS binary ───────────────────────────────────────────────
FROM debian:bookworm-slim AS piper-dl

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN curl -sL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
    | tar xz -C /opt

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:/opt/piper:$PATH"

# Baked in by the release workflow (--build-arg APP_VERSION=0.1.7). Local
# `docker build .` without the arg leaves it at 0.0.0-dev, which the
# Settings/Updates UI uses to signal "unreleased build".
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=${APP_VERSION}

# Install runtime system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Piper TTS binary and its libs
COPY --from=piper-dl /opt/piper /opt/piper

# Create non-root user
RUN groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

# Copy virtual environment from builder
COPY --from=builder /build/.venv /app/.venv

# Copy application source and migrations
COPY --from=builder /build/src /app/src
COPY --from=builder /build/migrations /app/migrations
COPY --from=builder /build/alembic.ini /app/alembic.ini

# Create storage directory
RUN mkdir -p /app/storage && chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "drevalis.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

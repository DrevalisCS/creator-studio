"""In-process metrics collection for the generation pipeline.

Provides a lightweight, async-safe metrics collector that tracks:
- Per-step execution duration and success/failure rates
- Overall generation counts (total, success, failed)
- Recent step execution history

No external dependencies (Prometheus, StatsD, etc.) required.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class StepMetric:
    """A single recorded pipeline step execution."""

    step: str
    duration_seconds: float
    success: bool
    episode_id: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        """Serialise to a JSON-friendly dictionary."""
        return {
            "step": self.step,
            "duration_seconds": round(self.duration_seconds, 3),
            "success": self.success,
            "episode_id": self.episode_id,
            "timestamp": self.timestamp.isoformat(),
        }


class MetricsCollector:
    """In-process metrics for the generation pipeline.

    Thread-/task-safe via an ``asyncio.Lock``.  Keeps a bounded history
    of step metrics to avoid unbounded memory growth.
    """

    def __init__(self, max_history: int = 1000) -> None:
        self._step_metrics: list[StepMetric] = []
        self._max_history = max_history
        self._generation_counts: dict[str, int] = {
            "total": 0,
            "success": 0,
            "failed": 0,
        }
        self._lock = asyncio.Lock()

    # ── Recording ─────────────────────────────────────────────────────────

    async def record_step(
        self,
        step: str,
        duration: float,
        success: bool,
        episode_id: str,
    ) -> None:
        """Record the outcome of a single pipeline step."""
        metric = StepMetric(
            step=step,
            duration_seconds=duration,
            success=success,
            episode_id=episode_id,
        )
        async with self._lock:
            self._step_metrics.append(metric)
            # Trim history to keep memory bounded
            if len(self._step_metrics) > self._max_history:
                self._step_metrics = self._step_metrics[-self._max_history :]

    async def record_generation(self, success: bool) -> None:
        """Record the outcome of a full generation pipeline run."""
        async with self._lock:
            self._generation_counts["total"] += 1
            if success:
                self._generation_counts["success"] += 1
            else:
                self._generation_counts["failed"] += 1

    # ── Queries ───────────────────────────────────────────────────────────

    async def get_step_stats(self) -> dict[str, Any]:
        """Return average duration and success rate grouped by step name.

        Example return value::

            {
                "script": {
                    "count": 12,
                    "avg_duration_seconds": 4.32,
                    "success_rate": 0.917,
                    "last_duration_seconds": 3.8,
                },
                ...
            }
        """
        async with self._lock:
            by_step: dict[str, list[StepMetric]] = {}
            for m in self._step_metrics:
                by_step.setdefault(m.step, []).append(m)

        stats: dict[str, Any] = {}
        for step_name, entries in by_step.items():
            durations = [e.duration_seconds for e in entries]
            successes = sum(1 for e in entries if e.success)
            stats[step_name] = {
                "count": len(entries),
                "avg_duration_seconds": round(sum(durations) / len(durations), 3),
                "min_duration_seconds": round(min(durations), 3),
                "max_duration_seconds": round(max(durations), 3),
                "success_rate": round(successes / len(entries), 3) if entries else 0.0,
                "last_duration_seconds": round(entries[-1].duration_seconds, 3),
            }
        return stats

    async def get_generation_stats(self) -> dict[str, Any]:
        """Return overall generation pipeline statistics.

        Example return value::

            {
                "total": 25,
                "success": 20,
                "failed": 5,
                "success_rate": 0.8,
            }
        """
        async with self._lock:
            counts = dict(self._generation_counts)

        total = counts["total"]
        return {
            **counts,
            "success_rate": round(counts["success"] / total, 3) if total > 0 else 0.0,
        }

    async def get_recent_metrics(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return the most recent step metrics (newest first)."""
        async with self._lock:
            recent = self._step_metrics[-limit:]

        # Return newest first
        return [m.to_dict() for m in reversed(recent)]


# ── Singleton instance ────────────────────────────────────────────────────
metrics = MetricsCollector()

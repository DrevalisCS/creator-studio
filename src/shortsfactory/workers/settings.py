"""Back-compat shim — re-exports
``drevalis.workers.settings.WorkerSettings`` under the old
``shortsfactory.workers.settings.WorkerSettings`` path used by
pre-v0.3.0 compose files."""

from drevalis.workers.settings import WorkerSettings  # noqa: F401

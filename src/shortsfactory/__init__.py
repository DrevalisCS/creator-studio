"""Back-compat shim for pre-v0.3.0 compose files.

The Python package was renamed ``shortsfactory`` → ``drevalis`` in
v0.3.0. Customer-side compose files written by older installers still
pass ``shortsfactory.main:app`` to uvicorn and
``shortsfactory.workers.settings.WorkerSettings`` to arq. This package
keeps those two entry-point strings resolvable so `docker compose
pull && up -d` continues to work without touching the compose file.

If you're writing new code: import from ``drevalis`` directly. This
shim only re-exports the two load-bearing entry points (app factory
+ worker settings) and is not a general compatibility layer.
"""

import warnings as _warnings

_warnings.warn(
    "The 'shortsfactory' package was renamed to 'drevalis' in v0.3.0. "
    "This shim exists only to keep legacy compose files working. "
    "Update your docker-compose.yml to reference 'drevalis.main:app' "
    "and 'drevalis.workers.settings.WorkerSettings' at your convenience.",
    DeprecationWarning,
    stacklevel=2,
)

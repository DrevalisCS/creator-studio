"""Back-compat shim — re-exports ``drevalis.main:app`` under the old
``shortsfactory.main:app`` path used by pre-v0.3.0 compose files."""

from drevalis.main import app, create_app  # noqa: F401

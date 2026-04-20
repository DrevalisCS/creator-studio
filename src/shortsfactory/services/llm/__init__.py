"""LLM service package — backward-compatible re-exports."""
from shortsfactory.services.llm._monolith import (  # noqa: F401
    AnthropicProvider,
    LLMPool,
    LLMProvider,
    LLMResult,
    LLMService,
    OpenAICompatibleProvider,
    _extract_json,
)

__all__ = [
    "AnthropicProvider",
    "LLMPool",
    "LLMProvider",
    "LLMResult",
    "LLMService",
    "OpenAICompatibleProvider",
    "_extract_json",
]
"""FFmpeg service package — backward-compatible re-exports."""
from shortsfactory.services.ffmpeg._monolith import (  # noqa: F401
    AUDIO_PRESETS,
    AssemblyConfig,
    AssemblyResult,
    AudioMixConfig,
    FFmpegService,
    SceneInput,
    XFADE_TRANSITIONS,
)

__all__ = [
    "AUDIO_PRESETS",
    "AssemblyConfig",
    "AssemblyResult",
    "AudioMixConfig",
    "FFmpegService",
    "SceneInput",
    "XFADE_TRANSITIONS",
]
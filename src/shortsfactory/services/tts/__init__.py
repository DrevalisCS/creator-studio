"""TTS service package — backward-compatible re-exports.

All public names from the original monolithic tts.py are re-exported
here so existing imports like ``from shortsfactory.services.tts import TTSService``
continue to work unchanged.
"""

from shortsfactory.services.tts._monolith import (
    ComfyUIElevenLabsTTSProvider,
    EdgeTTSProvider,
    ElevenLabsTTSProvider,
    KokoroTTSProvider,
    PiperTTSProvider,
    TTSProvider,
    TTSResult,
    TTSService,
    VoiceInfo,
    WordTimestamp,
    _chars_to_words,
    _concatenate_wav_segments,
    _estimate_mp3_duration,
    _generate_silence_wav,
    _wav_info,
)

__all__ = [
    "ComfyUIElevenLabsTTSProvider",
    "EdgeTTSProvider",
    "ElevenLabsTTSProvider",
    "KokoroTTSProvider",
    "PiperTTSProvider",
    "TTSProvider",
    "TTSResult",
    "TTSService",
    "VoiceInfo",
    "WordTimestamp",
    "_chars_to_words",
    "_concatenate_wav_segments",
    "_estimate_mp3_duration",
    "_generate_silence_wav",
    "_wav_info",
]

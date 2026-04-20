"""Tests for FFmpegService -- command builder and assembly config."""

from __future__ import annotations

from pathlib import Path

import pytest

from shortsfactory.services.ffmpeg import AssemblyConfig, FFmpegService, SceneInput


@pytest.fixture
def scenes() -> list[SceneInput]:
    """Return a list of SceneInput objects for testing."""
    return [
        SceneInput(image_path=Path("/tmp/scene_001.png"), duration_seconds=5.0),
        SceneInput(image_path=Path("/tmp/scene_002.png"), duration_seconds=6.0),
        SceneInput(image_path=Path("/tmp/scene_003.png"), duration_seconds=4.0),
    ]


class TestBuildAssemblyCommand:
    """Test the pure _build_assembly_command method."""

    def test_build_assembly_command_basic(
        self, ffmpeg_service: FFmpegService, scenes: list[SceneInput]
    ) -> None:
        """No music, no captions -- simplest case."""
        config = AssemblyConfig()
        cmd = ffmpeg_service._build_assembly_command(
            concat_file=Path("/tmp/concat.txt"),
            voiceover_path=Path("/tmp/voiceover.wav"),
            output_path=Path("/tmp/output.mp4"),
            captions_path=None,
            background_music_path=None,
            music_volume_db=-12.0,
            config=config,
        )

        assert cmd[0] == "ffmpeg"
        assert "-y" in cmd

        # Concat demuxer input
        assert "-f" in cmd
        concat_idx = cmd.index("-f")
        assert cmd[concat_idx + 1] == "concat"

        # Voiceover input
        assert str(Path("/tmp/voiceover.wav")) in cmd

        # No filter_complex -- should use -vf for video filters
        assert "-vf" in cmd
        assert "-filter_complex" not in cmd

        # Simple mapping: 0:v and 1:a
        assert "0:v" in cmd
        assert "1:a" in cmd

        # Output encoding
        assert "-c:v" in cmd
        assert "libx264" in cmd
        assert "-shortest" in cmd
        assert str(Path("/tmp/output.mp4")) in cmd

    def test_build_assembly_command_with_captions(self, ffmpeg_service: FFmpegService) -> None:
        """Captions path should produce a subtitles filter."""
        config = AssemblyConfig()
        cmd = ffmpeg_service._build_assembly_command(
            concat_file=Path("/tmp/concat.txt"),
            voiceover_path=Path("/tmp/voiceover.wav"),
            output_path=Path("/tmp/output.mp4"),
            captions_path=Path("/tmp/captions.ass"),
            background_music_path=None,
            music_volume_db=-12.0,
            config=config,
        )

        # Should contain a subtitles filter reference in -vf
        vf_idx = cmd.index("-vf")
        vf_value = cmd[vf_idx + 1]
        assert "subtitles=" in vf_value

    def test_build_assembly_command_with_music(self, ffmpeg_service: FFmpegService) -> None:
        """Background music should trigger filter_complex with audio mixing."""
        config = AssemblyConfig()
        cmd = ffmpeg_service._build_assembly_command(
            concat_file=Path("/tmp/concat.txt"),
            voiceover_path=Path("/tmp/voiceover.wav"),
            output_path=Path("/tmp/output.mp4"),
            captions_path=None,
            background_music_path=Path("/tmp/music.mp3"),
            music_volume_db=-15.0,
            config=config,
        )

        # Should use filter_complex instead of -vf
        assert "-filter_complex" in cmd
        assert "-vf" not in cmd

        fc_idx = cmd.index("-filter_complex")
        fc_value = cmd[fc_idx + 1]

        # Audio mixing with volume adjustment
        assert "volume=-15.0dB" in fc_value
        assert "amix" in fc_value

        # Music input present
        assert str(Path("/tmp/music.mp3")) in cmd

        # Output mapping via filter labels
        assert "[vout]" in cmd
        assert "[aout]" in cmd

    def test_build_assembly_command_full(self, ffmpeg_service: FFmpegService) -> None:
        """Captions + music together."""
        config = AssemblyConfig(
            width=720,
            height=1280,
            fps=24,
            video_codec="libx265",
            preset="fast",
        )
        cmd = ffmpeg_service._build_assembly_command(
            concat_file=Path("/tmp/concat.txt"),
            voiceover_path=Path("/tmp/voiceover.wav"),
            output_path=Path("/tmp/output.mp4"),
            captions_path=Path("/tmp/captions.ass"),
            background_music_path=Path("/tmp/music.mp3"),
            music_volume_db=-10.0,
            config=config,
        )

        assert "-filter_complex" in cmd
        fc_idx = cmd.index("-filter_complex")
        fc_value = cmd[fc_idx + 1]

        # Video filters should include scaling, padding, fps, format, and subtitles
        assert "scale=720:1280" in fc_value
        assert "pad=720:1280" in fc_value
        assert "fps=24" in fc_value
        assert "subtitles=" in fc_value

        # Audio mixing
        assert "amix" in fc_value

        # Encoding with custom config
        assert "libx265" in cmd
        assert "fast" in cmd


class TestCreateConcatFileFormat:
    """Test the concat-demuxer file content."""

    async def test_create_concat_file_format(
        self, ffmpeg_service: FFmpegService, tmp_path: Path
    ) -> None:
        scenes = [
            SceneInput(image_path=Path("/images/scene_001.png"), duration_seconds=5.0),
            SceneInput(image_path=Path("/images/scene_002.png"), duration_seconds=3.5),
        ]

        concat_file = await ffmpeg_service._create_concat_file(scenes, tmp_path)
        assert concat_file.exists()
        content = concat_file.read_text(encoding="utf-8")
        lines = content.strip().split("\n")

        # 2 scenes x 2 lines each + 1 trailing repeated last entry = 5 lines
        assert len(lines) == 5

        # First scene
        assert "file " in lines[0]
        assert "scene_001.png" in lines[0]
        assert lines[1] == "duration 5.0"

        # Second scene
        assert "scene_002.png" in lines[2]
        assert lines[3] == "duration 3.5"

        # Last image repeated (FFmpeg concat demuxer requirement)
        assert "scene_002.png" in lines[4]

    async def test_create_concat_file_single_scene(
        self, ffmpeg_service: FFmpegService, tmp_path: Path
    ) -> None:
        scenes = [
            SceneInput(image_path=Path("/images/only.png"), duration_seconds=10.0),
        ]
        concat_file = await ffmpeg_service._create_concat_file(scenes, tmp_path)
        content = concat_file.read_text(encoding="utf-8")
        lines = content.strip().split("\n")

        # 1 scene x 2 lines + 1 trailing repeat = 3 lines
        assert len(lines) == 3
        assert "duration 10.0" in lines[1]


class TestAssemblyConfigDefaults:
    """Test AssemblyConfig default values."""

    def test_assembly_config_defaults(self) -> None:
        config = AssemblyConfig()

        assert config.width == 1080
        assert config.height == 1920
        assert config.fps == 30
        assert config.video_codec == "libx264"
        assert config.audio_codec == "aac"
        assert config.audio_bitrate == "192k"
        assert config.video_bitrate == "4M"
        assert config.pixel_format == "yuv420p"
        assert config.preset == "medium"

    def test_assembly_config_custom(self) -> None:
        config = AssemblyConfig(
            width=720,
            height=1280,
            fps=60,
            video_codec="libx265",
            preset="ultrafast",
        )
        assert config.width == 720
        assert config.height == 1280
        assert config.fps == 60
        assert config.video_codec == "libx265"
        assert config.preset == "ultrafast"

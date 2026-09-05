"""Versioned Edge TTS audio normalization with FFmpeg loudnorm."""

import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import tempfile


TTS_VERSION = "2"
TTS_TARGET_LUFS = -20.0
TTS_TRUE_PEAK_DB = -2.0
TTS_LRA = 7.0
TTS_SAMPLE_RATE = 24000
TTS_BITRATE = "48k"
TTS_VOICES = {
    "zh": "zh-CN-XiaoxiaoNeural",
    "en": "en-US-JennyNeural",
}


class VoiceAudioError(RuntimeError):
    pass


def parse_language(value: str) -> str:
    language = (value or "zh").strip().lower()
    if language not in TTS_VOICES:
        raise ValueError("lang 仅支持 zh 或 en")
    return language


def voice_for_language(language: str) -> str:
    return TTS_VOICES[parse_language(language)]


def tts_cache_key(text: str, language: str, voice: str) -> str:
    contract = "\0".join((TTS_VERSION, language, voice, str(TTS_TARGET_LUFS), str(TTS_TRUE_PEAK_DB), text))
    return hashlib.sha256(contract.encode("utf-8")).hexdigest()


def _ffmpeg_command(arguments):
    configured = os.environ.get("FFMPEG_BIN")
    if configured:
        executable = configured
    else:
        try:
            import imageio_ffmpeg
            executable = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as error:
            raise VoiceAudioError("FFmpeg 不可用") from error
    return [executable, "-hide_banner", "-nostdin", *arguments]


def _run_ffmpeg(arguments):
    try:
        return subprocess.run(
            _ffmpeg_command(arguments),
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except OSError as error:
        raise VoiceAudioError("FFmpeg 不可用") from error
    except subprocess.TimeoutExpired as error:
        raise VoiceAudioError("FFmpeg 音频处理超时") from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip().splitlines()
        detail = message[-1] if message else "未知 FFmpeg 错误"
        raise VoiceAudioError(f"FFmpeg loudnorm 失败: {detail}") from error


def _loudnorm_filter(measurement=None) -> str:
    options = [f"I={TTS_TARGET_LUFS}", f"TP={TTS_TRUE_PEAK_DB}", f"LRA={TTS_LRA}"]
    if measurement is not None:
        options.extend((
            f"measured_I={measurement['input_i']}",
            f"measured_TP={measurement['input_tp']}",
            f"measured_LRA={measurement['input_lra']}",
            f"measured_thresh={measurement['input_thresh']}",
        ))
        options.append(f"offset={measurement['target_offset']}")
        options.extend(("linear=true", "print_format=json"))
    else:
        options.append("print_format=json")
    return "loudnorm=" + ":".join(options)


def _parse_measurement(stderr: str) -> dict:
    matches = re.findall(r"\{\s*\"input_i\"\s*:\s*\"[^}]+\}", stderr, flags=re.DOTALL)
    if not matches:
        raise VoiceAudioError("FFmpeg 未返回 loudnorm 测量值")
    try:
        measurement = json.loads(matches[-1])
    except json.JSONDecodeError as error:
        raise VoiceAudioError("FFmpeg loudnorm 测量值无效") from error
    required = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
    if any(name not in measurement for name in required):
        raise VoiceAudioError("FFmpeg loudnorm 测量值不完整")
    try:
        finite = all(math.isfinite(float(measurement[name])) for name in required)
    except (TypeError, ValueError) as error:
        raise VoiceAudioError("FFmpeg loudnorm 测量值无效") from error
    if not finite:
        raise VoiceAudioError("朗读音频没有可测量的声音")
    return measurement


def measure_loudness(source: pathlib.Path) -> dict:
    result = _run_ffmpeg([
        "-v", "info", "-i", str(source), "-af", _loudnorm_filter(), "-f", "null", "-",
    ])
    return _parse_measurement(result.stderr)


def normalize_mp3(source: pathlib.Path, output: pathlib.Path) -> None:
    measurement = measure_loudness(source)
    _run_ffmpeg([
        "-v", "error", "-y", "-i", str(source), "-af", _loudnorm_filter(measurement),
        "-ac", "1", "-ar", str(TTS_SAMPLE_RATE), "-c:a", "libmp3lame", "-b:a", TTS_BITRATE, str(output),
    ])
    if not output.exists() or output.stat().st_size <= 500:
        raise VoiceAudioError("FFmpeg 未生成有效朗读音频")


def normalize_mp3_bytes(source_audio: bytes) -> bytes:
    if len(source_audio) <= 500:
        raise VoiceAudioError("朗读服务返回无效音频")
    with tempfile.TemporaryDirectory(prefix="chazi-loudnorm-") as directory:
        source = pathlib.Path(directory) / "source.mp3"
        output = pathlib.Path(directory) / "normalized.mp3"
        source.write_bytes(source_audio)
        normalize_mp3(source, output)
        return output.read_bytes()

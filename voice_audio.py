"""Versioned Edge TTS audio normalization with FFmpeg loudnorm."""

import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import tempfile
import xml.sax.saxutils as sx


TTS_VERSION = "2"
TTS_TARGET_LUFS = -20.0
TTS_TRUE_PEAK_DB = -2.0
TTS_LRA = 7.0
TTS_SAMPLE_RATE = 24000
TTS_BITRATE = "48k"
TTS_VOICES = {
    "zh": "zh-CN-XiaoxiaoNeural",
    "en": "en-US-JennyNeural",
    # 粤语走 Azure 官方接口：只有它能让我们用 `alphabet="sapi"` 把粤拼逐字喂进去。
    # 选 HiuMaan 的依据见 doc/core/plan-yueyu.md §25/§26：三个音色里只有它第 1 声不掉下去。
    "yue": "zh-HK-HiuMaanNeural",
}
AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
JYUTPING = re.compile(r"^[a-z]+[0-9]$")


class VoiceAudioError(RuntimeError):
    pass


class ReadingRejectedError(VoiceAudioError):
    """上游说这个读法它发不出来（4xx）：是送进去的粤拼问题，不是我们连不上上游。"""
    pass


def parse_language(value: str) -> str:
    language = (value or "zh").strip().lower()
    if language not in TTS_VOICES:
        raise ValueError("lang 仅支持 zh、en 或 yue")
    return language


def voice_for_language(language: str) -> str:
    return TTS_VOICES[parse_language(language)]


def tts_cache_key(text: str, language: str, voice: str, readings: str = "") -> str:
    # 粤语的音频由 readings 决定，必须进 key，否则同一句换读法会命中旧音频。
    # readings 只在 yue 时参与，保证 zh/en 的既有缓存键一字不变（不作废现网音频）。
    contract = "\0".join((TTS_VERSION, language, voice, str(TTS_TARGET_LUFS), str(TTS_TRUE_PEAK_DB), text))
    if language == "yue":
        contract += "\0" + readings
    return hashlib.sha256(contract.encode("utf-8")).hexdigest()


def split_readings(raw: str) -> list:
    return [item for item in re.split(r"[\s,|]+", (raw or "").strip()) if item != ""]


def jyutping_to_sapi(item: str) -> str:
    """Azure 的 zh-HK sapi 要"音节 空格 声调"；写成 ngan4 会被回一个没有正文的 400"""
    return f"{item[:-1]} {item[-1]}" if item and item[-1].isdigit() else item


def azure_ssml(text: str, readings, voice: str) -> str:
    """逐字包 <phoneme alphabet="sapi">；非汉字原样保留。读法不合法就直接拒，绝不把外部字符串拼进 SSML。"""
    items = split_readings(readings) if isinstance(readings, str) else list(readings or [])
    han = [ch for ch in text if "\u3400" <= ch <= "\u9fff"]
    if len(items) != len(han):
        raise VoiceAudioError(f"粤拼数量 {len(items)} 与汉字数 {len(han)} 不一致")
    for item in items:
        if not JYUTPING.match(item):
            raise VoiceAudioError(f"粤拼格式不合法：{item!r}")
    parts, index = [], 0
    for ch in text:
        if "\u3400" <= ch <= "\u9fff":
            parts.append(f'<phoneme alphabet="sapi" ph="{sx.escape(jyutping_to_sapi(items[index]))}">{sx.escape(ch)}</phoneme>')
            index += 1
        else:
            parts.append(sx.escape(ch))
    return ("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-HK'>"
            f"<voice name='{sx.escape(voice)}'>{''.join(parts)}</voice></speak>")


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

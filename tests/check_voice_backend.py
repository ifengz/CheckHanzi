#!/usr/bin/env python3
"""Backend voice contract checks. The integration case uses real Edge TTS audio."""

import asyncio
import base64
import importlib.util
import io
import json
import pathlib
import os
import math
import ssl
import sys
import tempfile
import types
import unittest
import wave
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import voice_audio

TEST_CACHE = tempfile.TemporaryDirectory(prefix="chazi-voice-test-")
os.environ["TTS_CACHE_DIR"] = TEST_CACHE.name

SPEC = importlib.util.spec_from_file_location("server_voice", ROOT / "server-voice.py")
server_voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server_voice)


def recording(sample, sample_rate=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(sample.to_bytes(2, "little", signed=True) * 3200)
    return output.getvalue()


class FakeWebSocket:
    def __init__(self, responses):
        self.responses = iter(responses)

    def send(self, _payload):
        pass

    def recv(self):
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response

    def close(self):
        pass


def quiet_tone_recording(amplitude=0.01):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        samples = [int(32767 * amplitude * math.sin(2 * math.pi * 220 * i / 16000)) for i in range(6400)]
        wav.writeframes(b"".join(sample.to_bytes(2, "little", signed=True) for sample in samples))
    return output.getvalue()


class VoiceBackendContractTest(unittest.TestCase):
    def test_sensevoice_only_uses_itn_for_chinese(self):
        calls = []

        class FakeRecognizer:
            @staticmethod
            def from_sense_voice(**kwargs):
                calls.append(kwargs)
                return object()

        fake_sherpa = types.SimpleNamespace(OfflineRecognizer=FakeRecognizer)
        with patch.dict(sys.modules, {"sherpa_onnx": fake_sherpa}), \
             patch.object(server_voice.os.path, "exists", return_value=True):
            server_voice._make_sensevoice("zh")
            server_voice._make_sensevoice("en")
        self.assertEqual([call["use_itn"] for call in calls], [True, False])

    def test_english_postprocess_preserves_lookup_text(self):
        self.assertEqual(
            server_voice.postprocess_en("<|en|>I have 2 apples, and a friend's book!"),
            "I have 2 apples, and a friend's book!",
        )

    def test_explicit_english_does_not_use_chinese_or_fallback(self):
        with patch.object(server_voice, "normalize_wav", return_value=b"audio"), \
             patch.object(server_voice, "sensevoice_asr", return_value=("I like a book.", 1.0)) as recognize, \
             patch.object(server_voice, "ASR_ENGINE", "sensevoice"), \
             patch.object(server_voice, "xfyun_asr", side_effect=AssertionError("Chinese engine called")), \
             patch.object(server_voice, "whisper_asr", side_effect=AssertionError("Unexpected fallback")):
            result = server_voice.recognize(b"audio", "en")
            recognize.assert_called_once_with(b"audio", lang="en")
            self.assertEqual(result, ("I like a book.", "sensevoice-en", 1.0))

    def test_number_only_chinese_result_is_rechecked_in_english(self):
        def recognize_audio(_audio, *, lang="zh"):
            return ("eleven", 0.7) if lang == "en" else ("十一", 1.0)

        with patch.object(server_voice, "normalize_wav", return_value=b"audio"), \
             patch.object(server_voice, "XFYUN_ENABLED", True), \
             patch.object(server_voice, "xfyun_asr", return_value=("十一", 1.0)), \
             patch.object(server_voice, "sensevoice_asr", side_effect=recognize_audio):
            result = server_voice.recognize(b"audio", "zh")
        self.assertEqual(result, ("eleven", "sensevoice-en", 0.7))

    def test_number_only_result_keeps_chinese_when_english_recheck_is_empty(self):
        def recognize_audio(_audio, *, lang="zh"):
            return ("", 0.7) if lang == "en" else ("十一", 1.0)

        with patch.object(server_voice, "normalize_wav", return_value=b"audio"), \
             patch.object(server_voice, "XFYUN_ENABLED", True), \
             patch.object(server_voice, "xfyun_asr", return_value=("十一", 1.0)), \
             patch.object(server_voice, "sensevoice_asr", side_effect=recognize_audio):
            result = server_voice.recognize(b"audio", "zh")
        self.assertEqual(result, ("十一", "xfyun", 1.0))

    def test_multipart_language_reaches_recognizer(self):
        with patch.object(server_voice, "recognize", return_value=("a", "sensevoice-en", 1)) as recognize, \
             patch.object(server_voice.os, "makedirs", side_effect=OSError("No debug recording in tests")):
            response = server_voice.app.test_client().post("/api/asr", data={
                "file": (io.BytesIO(recording(1)), "audio.wav"), "lang": "en",
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(recognize.call_args.args[1], "en")
            self.assertEqual(response.json["text"], "a")

    def test_zero_pcm_never_reaches_a_recognizer(self):
        with patch.object(server_voice, "recognize", return_value=("I.", "sensevoice-en", 1)) as recognize, \
             patch.object(server_voice.os, "makedirs", side_effect=OSError("No debug recording in tests")):
            for lang in ("en", "zh"):
                response = server_voice.app.test_client().post(
                    "/api/asr?lang=" + lang, data=recording(0), content_type="audio/wav",
                )
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json["code"], "silent_audio")
                self.assertNotIn("text", response.json)
            recognize.assert_not_called()

    def test_quiet_voice_is_boosted_before_recognition(self):
        original, _ = server_voice.wav_bytes_to_samples(quiet_tone_recording())
        boosted, _ = server_voice.wav_bytes_to_samples(server_voice.normalize_wav(quiet_tone_recording()))
        original_peak = float(abs(original).max())
        boosted_peak = float(abs(boosted).max())
        self.assertGreater(boosted_peak, original_peak * 1.5)
        self.assertLessEqual(boosted_peak, 0.9)

    def test_invalid_wav_never_reaches_a_recognizer(self):
        with patch.object(server_voice, "recognize") as recognize:
            response = server_voice.app.test_client().post(
                "/api/asr?lang=en", data=b"invalid" * 200, content_type="audio/wav",
            )
            self.assertEqual(response.status_code, 400)
            recognize.assert_not_called()

    def test_unsafe_sample_rate_never_reaches_a_recognizer(self):
        with patch.object(server_voice, "recognize") as recognize:
            response = server_voice.app.test_client().post(
                "/api/asr?lang=zh", data=recording(1, sample_rate=1), content_type="audio/wav",
            )
            self.assertEqual(response.status_code, 400)
            recognize.assert_not_called()

    def test_xfyun_partial_text_without_final_frame_falls_back(self):
        partial_text = base64.b64encode(json.dumps({
            "ws": [{"cw": [{"w": "半句"}]}],
        }).encode("utf-8")).decode("ascii")
        websocket = FakeWebSocket([
            json.dumps({
                "header": {"code": 0, "status": 1},
                "payload": {"result": {"status": 1, "text": partial_text}},
            }),
            TimeoutError("connection closed before final result"),
        ])
        module = types.SimpleNamespace(create_connection=lambda *_args, **_kwargs: websocket)
        with patch.dict(sys.modules, {"websocket": module}), \
             patch.object(server_voice, "XFYUN_ENABLED", True), \
             patch.object(server_voice, "XFYUN_APP_ID", "app"), \
             patch.object(server_voice, "XFYUN_API_KEY", "key"), \
             patch.object(server_voice, "XFYUN_API_SECRET", "secret"), \
             patch.object(server_voice, "ASR_ENGINE", "sensevoice"), \
             patch.object(server_voice, "sensevoice_asr", return_value=("完整结果", 1.0)):
            self.assertEqual(
                server_voice.recognize(recording(1), "zh"),
                ("完整结果", "sensevoice", 1.0),
            )

    def test_xfyun_connection_keeps_tls_certificate_verification(self):
        connection_options = {}

        def connect(*_args, **kwargs):
            connection_options.update(kwargs)
            return FakeWebSocket([json.dumps({
                "header": {"code": 0, "status": 2},
                "payload": {},
            })])

        module = types.SimpleNamespace(create_connection=connect)
        with patch.dict(sys.modules, {"websocket": module}), \
             patch.object(server_voice, "XFYUN_ENABLED", True), \
             patch.object(server_voice, "XFYUN_APP_ID", "app"), \
             patch.object(server_voice, "XFYUN_API_KEY", "key"), \
             patch.object(server_voice, "XFYUN_API_SECRET", "secret"):
            server_voice.xfyun_asr(recording(1))
        self.assertNotEqual(
            connection_options.get("sslopt", {}).get("cert_reqs"),
            ssl.CERT_NONE,
        )

    def test_invalid_language_rejected_without_tts_generation(self):
        response = server_voice.app.test_client().get("/api/tts?text=apple&lang=fr")
        self.assertEqual(response.status_code, 400)

    def test_silent_measurement_is_not_a_normalized_voice(self):
        with self.assertRaises(voice_audio.VoiceAudioError):
            voice_audio._parse_measurement('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-70","target_offset":"inf"}')

    def test_tts_cache_key_isolates_voice_contract(self):
        text = "apple"
        self.assertNotEqual(
            voice_audio.tts_cache_key(text, "zh", "zh-CN-XiaoxiaoNeural"),
            voice_audio.tts_cache_key(text, "en", "en-US-JennyNeural"),
        )
        self.assertEqual(
            voice_audio.tts_cache_key(text, "en", "en-US-JennyNeural"),
            voice_audio.tts_cache_key(text, "en", "en-US-JennyNeural"),
        )

    def test_real_edge_tts_is_normalized_with_peak_headroom(self):
        import edge_tts
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "source.mp3"
            output = pathlib.Path(directory) / "normalized.mp3"
            asyncio.run(asyncio.wait_for(edge_tts.Communicate("apple", "en-US-JennyNeural").save(str(source)), 15))
            voice_audio.normalize_mp3(source, output)
            measurement = voice_audio.measure_loudness(output)
        self.assertLessEqual(float(measurement["input_tp"]), voice_audio.TTS_TRUE_PEAK_DB + 0.25)
        self.assertLessEqual(abs(float(measurement["input_i"]) - voice_audio.TTS_TARGET_LUFS), 1.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)

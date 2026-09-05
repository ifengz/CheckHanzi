#!/usr/bin/env python3
"""Backend voice contract checks. The integration case uses real Edge TTS audio."""

import asyncio
import importlib.util
import pathlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import voice_audio

TEST_CACHE = tempfile.TemporaryDirectory(prefix="chazi-voice-test-")
os.environ["TTS_CACHE_DIR"] = TEST_CACHE.name

SPEC = importlib.util.spec_from_file_location("server_voice", ROOT / "server-voice.py")
server_voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server_voice)


class VoiceBackendContractTest(unittest.TestCase):
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

    def test_multipart_language_reaches_recognizer(self):
        import io
        with patch.object(server_voice, "recognize", return_value=("a", "sensevoice-en", 1)) as recognize, \
             patch.object(server_voice.os, "makedirs", side_effect=OSError("No debug recording in tests")):
            response = server_voice.app.test_client().post("/api/asr", data={
                "file": (io.BytesIO(b"audio" * 300), "audio.wav"), "lang": "en",
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(recognize.call_args.args[1], "en")
            self.assertEqual(response.json["text"], "a")

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

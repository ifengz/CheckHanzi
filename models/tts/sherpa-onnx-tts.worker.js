// sherpa-onnx TTS Web Worker — 在独立线程中运行 TTS 引擎，
// 与主线程的 ASR 引擎完全隔离，避免两个 Emscripten glue 冲突。
//
// 协议：
//   main → worker:  { type:'load-models', files:{ 'name':ArrayBuffer } }
//   main → worker:  { type:'generate', text, sid, speed }
//   worker → main:  { type:'sherpa-onnx-tts-wasm-ready' }
//   worker → main:  { type:'sherpa-onnx-tts-ready', sampleRate, numSpeakers }
//   worker → main:  { type:'sherpa-onnx-tts-result', samples:Float32Array, sampleRate }
//   worker → main:  { type:'sherpa-onnx-tts-progress', status }
//   worker → main:  { type:'error', message }
//
// 模型文件加载方式：主线程负责下载（可显示进度），通过 transferable ArrayBuffer
// 传入 worker；worker 用 FS.writeFile 写入虚拟文件系统。此方式绕过 glue 内置的
// .data 大文件（198MB），只下载实际需要的模型（约 32MB）。

let tts = null;

self.Module = {
  // 绕过 .data 下载：返回一个极小 buffer，glue 不再发起网络请求
  getPreloadedPackage: function (name, size) {
    return new ArrayBuffer(4096);
  },
  locateFile: function (path, scriptDirectory = "") {
    // Worker 的 base URL 就在 models/tts/ 目录下，直接返回 basename
    var base = path.split("/").pop();
    if (base.endsWith(".wasm")) return base;
    if (base.endsWith(".data")) return base;
    return scriptDirectory + path;
  },
  setStatus: function (status) {
    self.postMessage({ type: "sherpa-onnx-tts-progress", status });
  },
  onRuntimeInitialized: function () {
    // 引擎已就绪，等待主线程传入模型文件
    self.postMessage({ type: "sherpa-onnx-tts-wasm-ready" });
  },
};

importScripts("sherpa-onnx-wasm-main-tts.js");
importScripts("sherpa-onnx-tts.js");

function getErrorMessage(err) {
  if (err instanceof Error) {
    if (err.stack) {
      return `${err.message}\n${err.stack}`;
    }
    return err.message;
  }
  return `${err}`;
}

function initTTS() {
  if (tts) return;
  tts = createOfflineTts(self.Module, {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: {
        model: "/model.onnx",
        lexicon: "/lexicon.txt",
        tokens: "/tokens.txt",
        noiseScale: 0.667,
        noiseScaleW: 0.8,
        lengthScale: 1.0,
      },
      numThreads: 1,
      debug: 0,
      provider: "cpu",
    },
    ruleFsts: "",
    ruleFars: "",
    maxNumSentences: 1,
  });
}

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type == "load-models") {
    try {
      const files = e.data.files || {};
      for (const name of Object.keys(files)) {
        const buf = files[name];
        FS.writeFile(name, new Uint8Array(buf));
      }
      initTTS();
      self.postMessage({
        type: "sherpa-onnx-tts-ready",
        sampleRate: tts.sampleRate,
        numSpeakers: tts.numSpeakers,
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: "TTS Initialization failed: " + getErrorMessage(err),
      });
    }
  } else if (type == "generate") {
    if (!tts) {
      return;
    }
    try {
      const audio = tts.generate({
        text: e.data.text,
        sid: e.data.sid || 0,
        speed: e.data.speed || 1.0,
      });
      const samples = audio.samples;
      const sampleRate = audio.sampleRate;
      self.postMessage(
        {
          type: "sherpa-onnx-tts-result",
          samples: samples,
          sampleRate: sampleRate,
        },
        [samples.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        message: "Generation failed: " + getErrorMessage(err),
      });
    }
  } else if (type == "generateWithConfig") {
    if (!tts) {
      return;
    }
    try {
      const config = Object.assign({}, e.data.genConfig || {});
      config.callback = (samples, n, progress) => {
        self.postMessage({
          type: "sherpa-onnx-tts-generation-progress",
          progress: progress,
        });
        return 1;
      };
      const audio = tts.generateWithConfig(e.data.text, config);
      const samples = audio.samples;
      const sampleRate = audio.sampleRate;
      self.postMessage(
        {
          type: "sherpa-onnx-tts-result",
          samples: samples,
          sampleRate: sampleRate,
        },
        [samples.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        message: "Generation failed: " + getErrorMessage(err),
      });
    }
  }
};

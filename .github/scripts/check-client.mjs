import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const html = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:char-dict.html'], { cwd: root, encoding: 'utf8' })
  : readFileSync(resolve(root, 'char-dict.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
for (const script of scripts) new vm.Script(script);

const start = html.indexOf('function resample(');
const end = html.indexOf('function floatToWav(', start);
assert.ok(start >= 0 && end > start, 'Audio resampler must be present');
const context = vm.createContext({ Float32Array, Math });
vm.runInContext(html.slice(start, end), context);
const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
for (const rate of [16000, 22050, 44100, 48000]) {
  const input = Float32Array.from({ length: rate }, (_, index) => Math.sin(2 * Math.PI * 1000 * index / rate));
  const output = context.resample(input, rate, 16000);
  assert.equal(output.length, 16000, `${rate}: preserve recording duration`);
  assert.ok(output.every(Number.isFinite), `${rate}: resampling must not corrupt audio with NaN`);
  assert.ok(Math.abs(rms(output) - Math.SQRT1_2) < 0.025, `${rate}: preserve speech-band energy`);
  const silence = context.resample(new Float32Array(rate), rate, 16000);
  assert.ok(silence.every(value => value === 0), `${rate}: silence must remain silent`);
}
const highTone = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(2 * Math.PI * 10000 * index / 48000));
assert.ok(rms(context.resample(highTone, 48000, 16000)) < 0.02, 'Suppress above-Nyquist energy before downsampling');
const toneStart = html.indexOf('function stripTone(');
const toneEnd = html.indexOf('function lookup(', toneStart);
vm.runInContext(html.slice(toneStart, toneEnd), context);
for (const [input, expected] of [['lǚ', 'lv'], ['LÜ', 'lv'], ['nǚ', 'nv'], ['lù', 'lu']]) {
  assert.equal(context.stripTone(input), expected, 'Umlaut pinyin must remain distinct: ' + input);
}

const asrStart = html.indexOf('function cloudRecognize(');
const asrEnd = html.indexOf('function stripTone(', asrStart);
const asrRequests = [];
class TestXHR {
  constructor() { this.status = 0; this.responseText = ''; asrRequests.push(this); }
  open() {}
  send() {}
}
class TestFormData { append() {} }
const asrContext = vm.createContext({
  Float32Array,
  XMLHttpRequest: TestXHR,
  FormData: TestFormData,
  audioCtx: { sampleRate: 16000 },
  resample: samples => samples,
  floatToWav: () => new Blob(),
  window: {},
});
vm.runInContext(html.slice(asrStart, asrEnd), asrContext);
const runAsr = () => {
  asrRequests.length = 0;
  const promise = asrContext.cloudRecognize(new Float32Array(1600));
  assert.equal(asrRequests.length, 1, 'ASR must send one request');
  return { promise, request: asrRequests[0] };
};
{
  const { promise, request } = runAsr();
  request.status = 200;
  request.responseText = JSON.stringify({ text: '', provider: '本地' });
  request.onload();
  assert.equal(await promise, '', 'empty ASR text is a valid success result');
}
{
  const { promise, request } = runAsr();
  request.status = 500;
  request.responseText = JSON.stringify({ error: 'failed' });
  request.onload();
  await assert.rejects(promise, /识别服务返回错误/);
}
{
  const { promise, request } = runAsr();
  request.status = 200;
  request.responseText = '{';
  request.onload();
  await assert.rejects(promise, /识别服务返回格式错误/);
}
{
  const { promise, request } = runAsr();
  request.onerror();
  await assert.rejects(promise, /识别网络连接失败/);
}

const submitStart = html.indexOf('function submitRecording(');
const submitEnd = html.indexOf('function scheduleAutoCapture(', submitStart);
const submitEvents = [];
const submitContext = vm.createContext({
  Float32Array,
  rec: { captureSeq: 7 },
  setRecState: mode => submitEvents.push(['state', mode]),
  toast: message => submitEvents.push(['toast', message]),
  handleVoiceResult: text => submitEvents.push(['result', text]),
  cloudRecognize: () => Promise.reject(new Error('识别请求超时，请稍后重试')),
});
vm.runInContext(html.slice(submitStart, submitEnd), submitContext);
submitContext.submitRecording(new Float32Array(1600), 7);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [
  ['state', 'recognize'],
  ['state', 'off'],
  ['toast', '识别请求超时，请稍后重试'],
], 'current ASR failure must reset UI and show the service error');
submitEvents.length = 0;
submitContext.rec.captureSeq = 8;
submitContext.submitRecording(new Float32Array(1600), 7);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [['state', 'recognize']], 'stale ASR failure must not reset current UI');

const waveStart = html.indexOf('function startWave(');
const waveEnd = html.indexOf('function stopWave(', waveStart);
let clearedWaveTimer = null;
const waveContext = vm.createContext({
  rec: { btn: { id: 'recBtn' }, animTimer: 11 },
  document: { querySelectorAll: () => [] },
  clearInterval: timer => { clearedWaveTimer = timer; },
  setInterval: () => 12,
});
vm.runInContext(html.slice(waveStart, waveEnd), waveContext);
waveContext.startWave();
assert.equal(clearedWaveTimer, 11, 'starting the wave must clear the previous interval');

const bindStart = html.indexOf('function bindRecButton(');
const bindEnd = html.indexOf('\nbindRecButton($("recBtn"))', bindStart);
const listeners = {};
const bindContext = vm.createContext({
  rec: { autoMode: false, active: true, cancelled: false },
  cancelAutoRec: () => { throw new Error('auto capture should not be used'); },
  endHold: () => { assert.equal(bindContext.rec.cancelled, true, 'pointercancel must mark the capture cancelled'); },
});
vm.runInContext(html.slice(bindStart, bindEnd), bindContext);
bindContext.bindRecButton({
  addEventListener: (name, handler) => { listeners[name] = handler; },
});
listeners.pointercancel({ preventDefault() {} });
console.log('Client syntax, audio resampling, and umlaut pinyin checks passed');

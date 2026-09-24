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
const englishScript = readFileSync(resolve(root, 'english-lookup.js'), 'utf8');
for (const [name, source] of [['english-lookup.js', englishScript], ['lucide-icons.js', readFileSync(resolve(root, 'lucide-icons.js'), 'utf8')]]) {
  new vm.Script(source, { filename:name });
}
assert.doesNotMatch(html, /<input\b/i, 'voice-only lookup must not retain an input element');
assert.doesNotMatch(englishScript, /config\.input|english-submit|searchInput/, 'English lookup must not depend on typed entry');
assert.match(html, /#recBtn\{[^}]*touch-action:none/, 'record button must reserve touch gestures for recording');
assert.match(html, /id="lookupCounter"/, 'lookup results must expose the unobtrusive lookup counter');
assert.match(html, /#lookupCounter\{[^}]*position:fixed[^}]*right:[^}]*bottom:/, 'lookup counter must stay in the lower-right corner');
assert.match(html, /#languageMode\{[^}]*display:none/, 'combined lookup must remove the language switcher from the child-facing UI');
assert.match(html, /id="combinedEnglishResult"/, 'combined results must reserve one inline English result area');
assert.match(html, /function showCombinedSentenceMode\(/, 'mixed speech must render through the combined result mode');
assert.match(html, /className\s*=\s*['"]mixed-char-button['"]/, 'Chinese characters in a mixed sentence must keep individual touch targets');
assert.match(html, /hanzi\.length >= 2 \|\| \(hanzi\.length >= 1 && hasLatin\)/, 'mixed Chinese and Latin speech must use the sentence result view');
assert.match(html, /function showSentenceMode\(text\)\{\s*if\(\/\[A-Za-z\]\/.test\(text\)\)/, 'sentence history must restore the same combined result view');

const lookupCounterStart = html.indexOf('var lookupCount = 0;');
const lookupCounterEnd = html.indexOf('function showWorkspace(', lookupCounterStart);
assert.ok(lookupCounterStart >= 0 && lookupCounterEnd > lookupCounterStart, 'lookup counter state must be defined before workspace rendering');
const counterNode = { hidden:true, textContent:'', setAttribute() {} };
const counterContext = vm.createContext({ $: id => id === 'lookupCounter' ? counterNode : null });
vm.runInContext(html.slice(lookupCounterStart, lookupCounterEnd), counterContext);
counterContext.recordLookup();
assert.equal(counterNode.textContent, '1', 'first lookup must display count 1');
assert.equal(counterNode.hidden, false, 'counter must be visible after a lookup');
counterContext.recordLookup();
assert.equal(counterNode.textContent, '2', 'each new lookup must increment the counter');
const voiceResultStart = html.indexOf('function handleVoiceResult(');
const voiceResultEnd = html.indexOf('// 声调工具', voiceResultStart);
assert.match(html.slice(voiceResultStart, voiceResultEnd), /showSentenceMode\(text2\);[\s\S]*recordLookup\(\)|recordLookup\(\)[\s\S]*showVoiceResults/, 'Chinese successful lookup branches must record one count');

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
for (const rate of [22050, 44100]) {
  const tone = Float32Array.from({ length: rate }, (_, index) => Math.sin(2 * Math.PI * 10000 * index / rate));
  assert.ok(rms(context.resample(tone, rate, 16000)) < 0.02, `${rate}: preserve anti-aliasing at fractional ratios`);
}
const toneStart = html.indexOf('function stripTone(');
const toneEnd = html.indexOf('function showWorkspace(', toneStart);
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
  send(form) { this.form = form; }
}
class TestFormData { constructor() { this.fields = {}; } append(key, value) { this.fields[key] = value; } }
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
const runAsr = (lang = 'zh') => {
  asrRequests.length = 0;
  const promise = asrContext.cloudRecognize(new Float32Array(1600), lang);
  assert.equal(asrRequests.length, 1, 'ASR must send one request');
  assert.equal(asrRequests[0].form.fields.lang, lang, 'recording language must reach the server');
  return { promise, request: asrRequests[0] };
};
{
  const { promise, request } = runAsr('en');
  request.status = 200;
  request.responseText = JSON.stringify({ text: "I have a friend's book.", provider: '本地' });
  request.onload();
  assert.equal(await promise, "I have a friend's book.", 'English ASR must preserve short words and punctuation');
}
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
  const { promise, request } = runAsr('en');
  request.status = 422;
  request.onload();
  await assert.rejects(promise, error => error.code === 'silent_audio' && /没有录到声音/.test(error.message));
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
const submitEnd = html.indexOf('function startHold(', submitStart);
const submitEvents = [];
const submitContext = vm.createContext({
  Float32Array,
  rec: { captureSeq: 7 },
  setRecState: mode => submitEvents.push(['state', mode]),
  toast: message => submitEvents.push(['toast', message]),
  showWorkspace: page => submitEvents.push(['workspace', page]),
  handleVoiceResult: text => submitEvents.push(['result', text]),
  englishLookupController: { handleRecognition: text => submitEvents.push(['english', text]) },
  cloudRecognize: () => Promise.reject(new Error('识别请求超时，请稍后重试')),
  releaseMicStream: () => submitEvents.push(['release']),
});
vm.runInContext(html.slice(submitStart, submitEnd), submitContext);
const quietRecording = new Float32Array(1600).fill(1 / 32768);
submitContext.submitRecording(quietRecording, 7);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [
  ['state', 'recognize'],
  ['state', 'off'],
  ['toast', '识别请求超时，请稍后重试'],
], 'current ASR failure must reset UI and show the service error');
submitEvents.length = 0;
submitContext.rec.captureSeq = 8;
submitContext.submitRecording(quietRecording, 7);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [['state', 'recognize']], 'stale ASR failure must not reset current UI');
submitEvents.length = 0;
submitContext.rec.captureSeq = 9;
submitContext.cloudRecognize = () => Promise.resolve('I have 2 apples.');
submitContext.submitRecording(quietRecording, 9, 'en');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [
  ['state', 'recognize'],
  ['state', 'off'],
  ['workspace', 'english'],
  ['english', 'I have 2 apples.'],
], 'English ASR from history must return to the English workspace and preserve I, numbers, spaces, and punctuation');
submitEvents.length = 0;
let releaseStaleEnglish;
submitContext.rec.captureSeq = 10;
submitContext.cloudRecognize = () => new Promise(resolve => { releaseStaleEnglish = resolve; });
submitContext.submitRecording(quietRecording, 10, 'en');
submitContext.rec.captureSeq = 11;
releaseStaleEnglish('I should not replace the newer result.');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [['state', 'recognize']], 'stale English ASR must not replace a newer language or recording result');

for (const invalid of [new Float32Array(1600), new Float32Array(0), quietRecording.map(() => NaN)]) {
  submitEvents.length = 0;
  submitContext.cloudRecognize = () => { throw new Error('Invalid capture must not reach ASR'); };
  submitContext.submitRecording(invalid, 11, 'en');
  assert.ok(submitEvents.some(event => event[0] === 'release'), 'invalid capture must release the microphone so the next press reacquires it');
  assert.ok(submitEvents.some(event => event[0] === 'toast'), 'capture failure must be visible');
}
submitEvents.length = 0;
submitContext.cloudRecognize = () => Promise.reject(Object.assign(new Error('没有录到声音'), { code: 'silent_audio' }));
submitContext.submitRecording(quietRecording, 11, 'en');
await new Promise(resolve => setImmediate(resolve));
assert.ok(submitEvents.some(event => event[0] === 'release'), 'server silence rejection must also renew capture on the next press');

const captureStart = html.indexOf('function ensureAudio(');
const captureEnd = html.indexOf('function resample(', captureStart);
const captureSource = html.slice(captureStart, captureEnd);
assert.match(captureSource, /function waitFor\([\s\S]*?setTimeout[\s\S]*?Promise\.race/, 'microphone acquisition must time out instead of leaving a press pending forever');
assert.match(captureSource, /getUserMedia\([\s\S]*?waitFor\(/, 'microphone acquisition must use the bounded wait');
function captureHarness(state = 'running', immediateMicTimeout = false) {
  const streams = [], processors = [], constraints = [];
  let requested = 0, resumed = 0;
  const node = () => ({ connect() {}, disconnect() { this.disconnected = true; } });
  const audio = {
    state, sampleRate: 16000, destination: {},
    async resume() { resumed++; this.state = 'running'; },
    createMediaStreamSource: node,
    createScriptProcessor(bufferSize = 4096) { const proc = node(); proc.bufferSize = bufferSize; processors.push(proc); return proc; },
    createGain() { return { ...node(), gain: { value: 1 } }; },
  };
  const timer = immediateMicTimeout
    ? (callback, delay) => delay === 5000 ? (callback(), 1) : setTimeout(callback, delay)
    : setTimeout;
  const capture = vm.createContext({
    Float32Array, window: { AudioContext: function() { return audio; } },
    setTimeout: timer,
    clearTimeout,
    navigator: { mediaDevices: { async getUserMedia(options) {
      requested++;
      constraints.push(options);
      const track = { readyState: 'live', enabled: true, muted: false, stop() { this.readyState = 'ended'; } };
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      streams.push(stream);
      return stream;
    } } },
  });
  vm.runInContext(html.slice(captureStart, captureEnd), capture);
  const feed = (proc, value) => proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(proc.bufferSize || 4096).fill(value) } });
  return { capture, audio, streams, processors, constraints, feed, counts: () => ({ requested, resumed }) };
}
{
  const h = captureHarness('running', true);
  const lateResolvers = [], lateTracks = [];
  h.capture.navigator.mediaDevices.getUserMedia = () => {
    h.capture.__micRequests = (h.capture.__micRequests || 0) + 1;
    return new Promise(resolve => { lateResolvers.push(resolve); });
  };
  await assert.rejects(h.capture.startRecording(), /麦克风权限启动超时/);
  await assert.rejects(h.capture.startRecording(), /麦克风权限启动超时/);
  assert.equal(h.capture.__micRequests, 2, 'a timed-out microphone request must not poison the next press');
  lateResolvers.forEach(resolve => {
    const track = {readyState:'live', enabled:true, muted:false, stop(){ this.readyState = 'ended'; }};
    lateTracks.push(track);
    resolve({getTracks:() => [track], getAudioTracks:() => [track]});
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(lateTracks.every(track => track.readyState === 'ended'), 'timed-out late microphone streams must release their tracks');
}
{
  const h = captureHarness('suspended', true);
  h.audio.resume = () => new Promise(() => {});
  await assert.rejects(h.capture.startRecording(), /音频启动超时/);
  assert.equal(h.capture.audioCtx, null, 'a stuck AudioContext must be discarded so the next press can create a fresh one');
}
{
  const h = captureHarness();
  await h.capture.ensureMicStream();
  assert.equal(h.constraints[0].audio.autoGainControl.ideal, true, 'microphone capture must request automatic gain for distant speech');
  assert.equal(h.constraints[0].audio.noiseSuppression.ideal, false, 'microphone capture must not suppress quiet child speech');
}
for (const broken of ['ended', 'muted', 'disabled']) {
  const h = captureHarness();
  const first = await h.capture.ensureMicStream();
  assert.equal(await h.capture.ensureMicStream(), first, 'healthy warm capture must retain preroll');
  const track = first.stream.getAudioTracks()[0];
  if (broken === 'ended') track.stop();
  if (broken === 'muted') track.muted = true;
  if (broken === 'disabled') track.enabled = false;
  const next = await h.capture.ensureMicStream();
  assert.notEqual(next.stream, first.stream, broken + ': next recording must acquire a working stream');
  assert.equal(track.readyState, 'ended', 'replaced stream must release hardware');
  assert.equal(first.proc.onaudioprocess, null, 'discard stale preroll callbacks');
  assert.equal(h.counts().requested, 2);
}
{
  const h = captureHarness();
  const acquire = h.capture.navigator.mediaDevices.getUserMedia;
  let release, requested = 0;
  const permission = new Promise(resolve => { release = resolve; });
  h.capture.navigator.mediaDevices.getUserMedia = async () => { requested++; await permission; return acquire(); };
  const first = h.capture.startRecording();
  const second = h.capture.startRecording();
  release();
  const [stale, current] = await Promise.all([first, second]);
  assert.equal(requested, 1, 'cancel and repress during permission must share one hardware request');
  stale.stop();
  h.feed(current.proc, 0.1);
  assert.ok(current.stop().some(value => value !== 0), 'discarding a stale capture must preserve the current recording');
  h.capture.releaseMicStream();
  assert.ok(h.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'no orphan microphone stream may survive cleanup');
}
{
  const h = captureHarness('interrupted');
  await h.capture.startRecording();
  assert.equal(h.audio.state, 'running', 'iPad interruption must be resumed before recording starts');
  assert.ok(h.counts().resumed > 0);
}
{
  const h = captureHarness('suspended');
  let resume;
  h.audio.resume = () => new Promise(resolve => { resume = () => { h.audio.state = 'running'; resolve(); }; });
  const pending = h.capture.startRecording();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.processors.length, 0, 'capture must wait until resume completes');
  resume();
  const recorder = await pending;
  h.feed(recorder.proc, 1 / 32768);
  assert.ok(recorder.stop().some(value => value !== 0), 'preserve quiet valid microphone input');
}
{
  const h = captureHarness();
  const warm = await h.capture.ensureMicStream();
  h.feed(warm.proc, 0.1);
  const recorder = await h.capture.startRecording();
  assert.equal(recorder.mute.gain.value, 0, 'recording monitor must stay muted to avoid echo suppression of quiet speech');
  h.feed(recorder.proc, 0);
  assert.ok(recorder.stop().every(value => value === 0), 'stale preroll alone cannot turn a silent capture into a previous word');
}
{
  const h = captureHarness('suspended');
  h.audio.resume = async () => { throw new Error('resume denied'); };
  await assert.rejects(h.capture.startRecording(), /resume denied/);
  assert.equal(h.counts().requested, 0, 'failed resume must not start a misleading silent recording');
}
{
  const h = captureHarness();
  let resolveMic;
  const acquire = h.capture.navigator.mediaDevices.getUserMedia;
  h.capture.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
    resolveMic = async () => resolve(await acquire());
  });
  const holdEvents = [];
  const holdContext = h.capture;
  Object.assign(holdContext, {
    Date,
    Promise,
    rec: {
      active: false, cancelled: false, captureSeq: 0,
      btn: { id: 'recBtn', classList: { add() {}, remove() {} } },
    },
    cloudASR: true,
    lookupLanguage: 'zh',
    cancelSpeech() {},
    setRecState: mode => holdEvents.push(['state', mode]),
    stopWave() {},
    toast: message => holdEvents.push(['toast', message]),
    submitRecording: (samples, seq, lang) => holdEvents.push(['submit', samples.length, seq, lang]),
  });
  const holdStart = html.indexOf('function startHold(');
  const holdEnd = html.indexOf('function startWave(', holdStart);
  vm.runInContext(html.slice(holdStart, holdEnd), holdContext);
  holdContext.startHold();
  holdContext.endHold();
  assert.equal(holdContext.rec.releasePending, true, 'early release must wait for microphone initialization');
  assert.deepEqual(holdEvents.filter(event => event[0] === 'toast'), [], 'early release must not report a false silent capture');
  assert.ok(holdEvents.some(event => event[0] === 'state' && event[1] === 'starting'), 'released startup must remain visibly pending until audio arrives');
  await resolveMic();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(holdContext.rec.captureReady, false, 'creating nodes is not proof of actual audio delivery');
  assert.equal(holdEvents.some(event => event[0] === 'submit'), false);
  h.feed(holdContext.rec.recorderObj.proc, 0.1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(holdContext.rec.captureReady, true);
  assert.equal(holdContext.rec.releasePending, false, 'ready recorder must finish the released capture');
  assert.deepEqual(holdEvents.filter(event => event[0] === 'submit'), [['submit', 2048, 1, 'zh']], 'ready recorder must submit immediately without another recording window');
  h.capture.releaseMicStream();
}
{
  const h = captureHarness();
  let requests = 0;
  h.capture.navigator.mediaDevices.getUserMedia = async () => { requests++; throw new Error('permission denied'); };
  await assert.rejects(h.capture.startRecording(), /permission denied/);
  assert.equal(requests, 1, 'permission failure must be surfaced without a hidden second request');
}

const waveStart = html.indexOf('function startWave(');
function prewarmHarness(permission = 'granted') {
  const h = captureHarness();
  const status = {dataset:{}, textContent:''};
  const hint = {textContent:'按住说字'};
  const button = {
    activation:false,
    ariaLabel:'按住说话查字',
    classList:{toggle(name, value){ if(name === 'mic-activation') button.activation = value; }},
    querySelector: selector => selector === '.hint' ? hint : null,
    setAttribute(name, value){ if(name === 'aria-label') button.ariaLabel = value; },
  };
  Object.assign(h.capture, {
    document: {hidden:false, getElementById: name => name === 'micStatus' ? status : button},
    rec: {active:false},
  });
  h.capture.navigator.permissions = {query:async () => ({state:permission})};
  return {...h, status, button, hint};
}
{
  const h = prewarmHarness();
  const pending = h.capture.prewarmMicrophone();
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(h.status.dataset.state, 'ready', 'permission alone cannot establish microphone readiness');
  h.feed(h.capture.micWarm.proc, 0.01);
  await pending;
  assert.equal(h.status.textContent, '麦克风已就绪');
  assert.equal(h.capture.recorder, null, 'prewarm must not start a recognition recording');
  const recorder = await h.capture.startRecording();
  assert.equal(h.counts().requested, 1, 'first press must reuse the prewarmed hardware');
  h.feed(recorder.proc, 0.02); recorder.stop();
  h.capture.releaseMicStream();
}
{
  const h = prewarmHarness();
  h.capture.navigator.permissions.query = async () => { throw new Error('unsupported'); };
  const pending = h.capture.prewarmMicrophone();
  await new Promise(resolve => setImmediate(resolve));
  if (h.capture.micWarm) h.feed(h.capture.micWarm.proc, 0.01);
  await pending;
  assert.equal(h.counts().requested, 0, 'an unavailable permission query must not start a background microphone request');
  assert.equal(h.status.textContent, '轻点启用麦克风', 'a failed prewarm must make the first action an explicit activation tap');
  assert.equal(h.button.activation, true, 'a failed prewarm must recolor the main microphone button');
  assert.equal(h.hint.textContent, '轻点启用麦克风', 'the main microphone button must show the activation action');
  const recorder = await h.capture.startRecording();
  h.feed(recorder.proc, 0.02);
  assert.ok(recorder.stop().some(value => value !== 0), 'the first gesture must own microphone startup after a skipped prewarm');
  h.capture.releaseMicStream();
}
{
  const h = prewarmHarness();
  h.capture.navigator.permissions.query = async () => { throw new Error('unsupported'); };
  let audioWakeCalls = 0;
  h.capture.ensureAudio = () => { audioWakeCalls++; };
  const pending = h.capture.prewarmMicrophone(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audioWakeCalls, 1, 'the first activation tap must wake AudioContext synchronously before async startup');
  h.feed(h.capture.micWarm.proc, 0.01);
  await pending;
  assert.equal(h.counts().requested, 1, 'the activation tap must request the microphone without another permission query');
  assert.equal(h.status.textContent, '麦克风已就绪', 'successful activation must restore the ready status');
  assert.equal(h.capture.micNeedsGesture, false, 'successful activation must return to hold-to-talk mode');
  assert.equal(h.button.activation, false, 'successful activation must restore the normal button color');
  assert.equal(h.hint.textContent, '按住说字', 'successful activation must restore the hold-to-talk label');
  h.capture.releaseMicStream();
}
{
  const h = prewarmHarness();
  h.audio.state = 'suspended';
  let resumeCalls = 0;
  h.audio.resume = () => { resumeCalls++; return new Promise(() => {}); };
  const pending = h.capture.prewarmMicrophone();
  await pending;
  assert.equal(resumeCalls, 0, 'automatic prewarm must not leave a suspended AudioContext resume pending');
  h.audio.resume = async () => { resumeCalls++; h.audio.state = 'running'; };
  const recorder = await h.capture.startRecording();
  h.feed(recorder.proc, 0.02);
  assert.ok(recorder.stop().some(value => value !== 0), 'the first gesture must recover a suspended context and record');
  assert.equal(resumeCalls, 1, 'only the gesture-owned startup should resume the context');
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  const status = {dataset:{}, textContent:''};
  Object.assign(h.capture, {document:{hidden:false, getElementById:() => status}});
  h.capture.navigator.permissions = {query:async () => ({state:'granted'})};
  const timers = [];
  h.capture.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  h.capture.clearTimeout = () => {};
  const acquire = h.capture.navigator.mediaDevices.getUserMedia;
  let requests = 0;
  let releaseLate;
  let lateStream;
  h.capture.navigator.mediaDevices.getUserMedia = () => {
    requests++;
    if (requests === 1) return new Promise(resolve => { releaseLate = async () => { lateStream = await acquire(); resolve(lateStream); }; });
    return acquire();
  };
  const prewarm = h.capture.prewarmMicrophone();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1, 'the running-context prewarm should own its first request');
  const listeners = {};
  const bindStart = html.indexOf('function bindRecButton(');
  const bindEnd = html.indexOf('\nbindRecButton($("recBtn"))', bindStart);
  vm.runInContext(html.slice(bindStart, bindEnd), h.capture);
  h.capture.bindRecButton({
    addEventListener: (name, handler) => { listeners[name] = handler; },
    setPointerCapture() {}, classList:{add(){}, remove(){}},
  });
  let lateStopped = false;
  try {
    listeners.pointerdown({preventDefault(){}, isPrimary:true, button:0, pointerId:1, clientY:100});
    await h.flush();
    assert.equal(requests, 2, 'the gesture must issue a fresh microphone request');
    assert.ok(h.capture.rec.recorderObj, 'the first hold must create a recorder while prewarm is pending');
    h.feed(h.capture.rec.recorderObj.proc, 0.02);
    await h.flush();
    assert.equal(h.capture.rec.captureReady, true, 'the first hold must reach listening without an activation tap');
  } finally {
    h.capture.cancelRecording();
    await releaseLate();
    await new Promise(resolve => setImmediate(resolve));
    await prewarm;
    lateStopped = lateStream.getTracks().every(track => track.readyState === 'ended');
    assert.ok(h.capture.micWarm, 'a stale prewarm must not reset the gesture-owned capture');
    h.capture.releaseMicStream();
  }
  assert.ok(lateStopped, 'a superseded late stream must be stopped');
}
for (const permission of ['prompt', 'denied']) {
  const h = prewarmHarness(permission);
  await h.capture.prewarmMicrophone();
  assert.equal(h.counts().requested, 0, 'automatic startup must not request ungranted permission');
  assert.equal(h.status.dataset.state, 'gesture');
  assert.equal(h.status.textContent, permission === 'denied' ? '麦克风权限未开启' : '轻点启用麦克风');
}
{
  const h = prewarmHarness();
  let permissionResolve;
  h.capture.navigator.permissions.query = () => new Promise(resolve => { permissionResolve = resolve; });
  const pending = h.capture.prewarmMicrophone();
  h.capture.micPrewarmToken++;
  h.capture.document.hidden = true;
  permissionResolve({state:'granted'});
  await pending;
  assert.equal(h.counts().requested, 0, 'background transition must cancel pending prewarm');
}
{
  const h = prewarmHarness();
  h.capture.setTimeout = callback => setTimeout(callback, 0);
  h.audio.state = 'suspended';
  h.audio.resume = () => new Promise(() => {});
  await h.capture.prewarmMicrophone();
  assert.equal(h.capture.audioCtx, null);
  assert.equal(h.status.textContent, '轻点启用麦克风');
}
function holdHarness(state = 'running') {
  const h = captureHarness(state);
  const events = [], timers = new Map();
  let timerId = 0;
  Object.assign(h.capture, {
    rec: { active:false, captureSeq:0, btn:{ id:'recBtn', classList:{ add(){}, remove(){} } } },
    lookupLanguage:'zh', cancelSpeech(){}, stopWave(){},
    setRecState: mode => events.push(['state', mode]),
    toast: message => events.push(['toast', message]),
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    submitRecording: samples => events.push(['submit', samples.length]),
  });
  vm.runInContext(html.slice(html.indexOf('function cancelRecording('), html.indexOf('function submitRecording(')), h.capture);
  vm.runInContext(html.slice(html.indexOf('function startHold('), waveStart), h.capture);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fire = delay => {
    const found = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(found, 'expected timer ' + delay);
    timers.delete(found[0]); found[1].callback();
  };
  return { ...h, events, timers, flush, fire };
}
{
  const h = holdHarness();
  h.capture.startHold(); await h.flush();
  const recorder = h.capture.rec.recorderObj;
  assert.equal(recorder.proc.bufferSize, 2048, 'capture must use a smaller frame for responsive finalization');
  assert.equal(recorder.frameDurationMs, 128, 'capture must expose its actual frame duration');
  h.feed(recorder.proc, 0.02); await h.flush();
  h.capture.endHold();
  assert.equal(h.events.some(event => event[0] === 'submit'), false, 'release must wait for queued final audio frames');
  assert.ok([...h.timers.values()].some(timer => timer.delay === 148), 'release must wait one frame plus a small scheduling margin, not a fixed tail');
  h.feed(recorder.proc, 0.03);
  h.fire(148);
  assert.deepEqual(h.events.filter(event => event[0] === 'submit'), [['submit', 4096]], 'release must retain final frame');
  assert.equal(h.timers.size, 0);
  h.capture.releaseMicStream();
}
{
  const h = holdHarness('suspended');
  const resumeResolvers = [];
  let resumeCalls = 0;
  h.audio.resume = () => {
    resumeCalls++;
    return new Promise(resolve => { resumeResolvers.push(() => { h.audio.state = 'running'; resolve(); }); });
  };
  h.capture.startHold();
  try {
    assert.equal(resumeCalls, 1, 'one hold gesture must issue only one AudioContext resume');
  } finally {
    resumeResolvers.forEach(resolve => resolve());
  }
  await h.flush();
  assert.equal(h.counts().requested, 1, 'the hold gesture must proceed to a microphone request');
  h.capture.cancelRecording();
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  h.audio.sampleRate = 48000;
  h.capture.startHold(); await h.flush();
  const recorder = h.capture.rec.recorderObj;
  h.feed(recorder.proc, 0.02); await h.flush();
  h.capture.endHold();
  assert.ok([...h.timers.values()].some(timer => timer.delay === 63), 'higher-rate capture must use its shorter actual frame duration');
  h.capture.cancelRecording();
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  h.capture.startHold(); await h.flush();
  const recorder = h.capture.rec.recorderObj;
  h.feed(recorder.proc, 0.02); await h.flush();
  h.capture.endHold();
  const history = { classList: { contains: () => false } };
  Object.assign(h.capture, {
    $: name => name === 'history' ? history : (name === 'recBtn' ? { setAttribute() {}, querySelector: () => null } : null),
    closeHistoryConfirm() {},
    showWorkspace() {},
    updateHistoryUI() {},
    renderHistory() {},
  });
  const languageStart = html.indexOf('function setLookupLanguage(');
  const languageEnd = html.indexOf('window.addEventListener("english-lookup-ready"', languageStart);
  vm.runInContext(html.slice(languageStart, languageEnd), h.capture);
  h.capture.setLookupLanguage('en');
  assert.equal(recorder.proc.onaudioprocess, null, 'language switch during the tail must stop the old recorder');
  assert.equal(h.capture.rec.recorderObj, null, 'language switch must release the recorder reference');
  assert.equal([...h.timers.values()].some(timer => timer.delay === 148), false, 'language switch must cancel pending tail submission');
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  h.capture.startHold(); await h.flush();
  const first = h.capture.rec.recorderObj;
  h.capture.endHold();
  h.capture.startHold(); await h.flush();
  assert.equal(first.proc.onaudioprocess, null, 'repress during startup must disconnect the old recorder');
  const second = h.capture.rec.recorderObj;
  assert.notEqual(first, second);
  h.feed(second.proc, 0.02); await h.flush();
  assert.equal(h.capture.rec.captureReady, true);
  h.capture.cancelRecording(); await h.flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.some(event => event[0] === 'submit'), false);
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  h.capture.startHold(); await h.flush();
  const first = h.capture.rec.recorderObj;
  h.feed(first.proc, 0.02); await h.flush();
  h.capture.endHold();
  h.capture.startHold(); await h.flush();
  assert.notEqual(h.capture.rec.recorderObj, first, 'a new press during the audio tail must start a new recording');
  assert.equal(first.proc.onaudioprocess, null);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 148), false, 'the old tail must not submit into the new recording');
  h.capture.cancelRecording(); await h.flush();
  assert.equal(h.timers.size, 0);
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  h.capture.startHold(); await h.flush();
  const recorder = h.capture.rec.recorderObj;
  h.feed(recorder.proc, 0.02); await h.flush();
  h.capture.endHold();
  assert.equal(h.capture.rec.active, false, 'short press must finish the recording on release');
  assert.equal([...h.timers.values()].some(timer => timer.delay === 3000), false, 'short press must not wait a fixed three seconds');
  assert.ok([...h.timers.values()].some(timer => timer.delay === 148), 'short press must only wait for the final audio frame');
  h.feed(recorder.proc, 0.03);
  h.fire(148);
  assert.equal(h.events.filter(event => event[0] === 'submit').length, 1);
  h.capture.releaseMicStream();
}
{
  const h = holdHarness();
  h.capture.startHold(); await h.flush();
  h.fire(5000); await h.flush();
  assert.equal(h.capture.audioCtx, null, 'no audio callbacks must reset the capture context');
  assert.equal(h.capture.rec.active, false);
  assert.ok(h.events.some(event => event[0] === 'toast' && /没有收到音频/.test(event[1])));
  assert.equal(h.timers.size, 0);
}
{
  const h = captureHarness('interrupted');
  h.audio.resume = async () => {};
  await assert.rejects(h.capture.startRecording(), /音频未恢复/);
  assert.equal(h.capture.audioCtx, null, 'resolved resume without running must discard the context');
}
{
  const h = captureHarness();
  const warm = await h.capture.ensureMicStream();
  warm.lastFrame = Date.now() - 5000;
  const renewed = await h.capture.ensureMicStream();
  assert.notEqual(renewed, warm, 'live track with stale audio callbacks must be reacquired');
  h.capture.releaseMicStream();
}
{
  const h = captureHarness();
  let resolveMic;
  const acquire = h.capture.navigator.mediaDevices.getUserMedia;
  h.capture.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveMic = async () => resolve(await acquire()); });
  const pending = h.capture.startRecording();
  h.capture.resetCaptureAudio();
  await resolveMic();
  await assert.rejects(pending, /录音已取消/);
  assert.ok(h.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'background cleanup must stop a late permission stream');
}
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
const moveModes = [];
const bindContext = vm.createContext({
  micPrewarmToken: 0,
  rec: { active: true, cancelled: false, startY: 100 },
  cancelRecording: () => { throw new Error('pointercancel should not call cancellation twice'); },
  setRecState: mode => moveModes.push(mode),
  endHold: () => { assert.equal(bindContext.rec.cancelled, true, 'pointercancel must mark the capture cancelled'); },
});
vm.runInContext(html.slice(bindStart, bindEnd), bindContext);
bindContext.bindRecButton({
  addEventListener: (name, handler) => { listeners[name] = handler; },
});
listeners.pointercancel({ preventDefault() {} });
assert.equal(listeners.pointermove, undefined, 'ordinary finger movement must not cancel an active recording');
assert.deepEqual(moveModes, [], 'ordinary finger movement must not cancel an active recording');
{
  const events = [];
  const firstPressListeners = {};
  const firstPressContext = vm.createContext({
    micPrewarmToken: 0,
    rec: { active:false, cancelled:false, startY:0 },
    micNeedsGesture: true,
    prewarmMicrophone: () => events.push('enable'),
    startHold: () => events.push('record'),
    endHold() {},
  });
  vm.runInContext(html.slice(bindStart, bindEnd), firstPressContext);
  firstPressContext.bindRecButton({
    addEventListener: (name, handler) => { firstPressListeners[name] = handler; },
    setPointerCapture() {},
  });
  firstPressListeners.pointerdown({
    preventDefault() {}, isPrimary:true, button:0, pointerId:1, clientY:100,
  });
  assert.deepEqual(events, ['enable'], 'the first tap after automatic prewarm failure must enable the microphone without recording');
  firstPressContext.micNeedsGesture = false;
  firstPressListeners.pointerdown({
    preventDefault() {}, isPrimary:true, button:0, pointerId:2, clientY:100,
  });
  assert.deepEqual(events, ['enable', 'record'], 'a later hold must return to normal recording after activation');
}

const languageStart = html.indexOf('function setLookupLanguage(');
const languageEnd = html.indexOf('window.addEventListener("english-lookup-ready"', languageStart);
const languageWorkspaceHistory = { classList: { contains: () => false } };
const languageContext = vm.createContext({
  rec: { captureSeq:9, active:false },
  micNeedsGesture: false,
  cancelSpeech() {}, cancelRecording() {}, setRecState() {}, showWorkspace: page => { languageContext.workspace = page; },
  $: name => name === 'history' ? languageWorkspaceHistory : (name === 'recBtn' ? { setAttribute() {}, querySelector: () => null } : null),
});
vm.runInContext(html.slice(languageStart, languageEnd), languageContext);
languageContext.setLookupLanguage('en');
assert.equal(languageContext.rec.captureSeq, 10, 'Changing language must invalidate an ASR request even after recording stopped');
assert.equal(languageContext.workspace, 'english', 'English mode must keep the right-side result workspace active');
languageContext.setLookupLanguage('zh');
assert.equal(languageContext.workspace, null, 'Chinese mode must clear the English workspace selection');

class TestNode {
  constructor(tag = 'div', text = '') {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this.style = {};
    this._text = text;
    this.classList = {
      add: name => { if (!this.className.split(/\s+/).includes(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.className.split(/\s+/).includes(name) : force;
        if (enabled) this.classList.add(name); else this.classList.remove(name);
        return enabled;
      },
    };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  get innerHTML() { return this._html || ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() {
    const event = { stopPropagation() {} };
    if (typeof this.onclick === 'function') this.onclick(event);
    if (this.listeners.click) this.listeners.click(event);
  }
  querySelector(selector) { return selector === 'button' ? new TestNode('button') : null; }
  querySelectorAll() { return []; }
}
const findByClass = (node, className) => {
  if (node.className.split(/\s+/).includes(className)) return node;
  for (const child of node.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
};
const findToken = (node, text) => {
  if (node.className.split(/\s+/).includes('english-token') && node.textContent === text) return node;
  for (const child of node.children) {
    const found = findToken(child, text);
    if (found) return found;
  }
  return null;
};
const findByAttribute = (node, name, value) => {
  if (node.getAttribute(name) === value) return node;
  for (const child of node.children) {
    const found = findByAttribute(child, name, value);
    if (found) return found;
  }
  return null;
};
const renderWordsStart = html.indexOf('function renderWords(');
const renderWordsEnd = html.indexOf('document.addEventListener("pointerdown"', renderWordsStart);
assert.ok(renderWordsStart >= 0 && renderWordsEnd > renderWordsStart, 'Chinese word cards must be rendered by a dedicated function');
const wordBox = new TestNode();
const selectedChineseWords = [];
const wordContext = vm.createContext({
  current: '花',
  $: id => id === 'words' ? wordBox : null,
  document: { createElement: () => new TestNode() },
  esc: text => String(text),
  addHistory: (character, word) => selectedChineseWords.push([character, word]),
  speak() {},
  fitResultCards() {},
  requestAnimationFrame: callback => callback(),
});
vm.runInContext(html.slice(renderWordsStart, renderWordsEnd), wordContext);
wordContext.renderWords({ w:['花朵'] });
wordBox.children[0].click();
assert.deepEqual(selectedChineseWords, [['花', '花朵']], 'selecting a Chinese word must persist the word, not only its current character');
const englishRoot = new TestNode();
const englishResponses = [
  { ok:true, json: async () => ({ kind:'sentence', translation:'我喜欢苹果。', source:{ name:'MyMemory', url:'https://mymemory.translated.net/' } }) },
  { ok:true, json: async () => ({ kind:'word', word:'apples', phonetic:"'æplz", meanings:[{ partOfSpeech:'n.', translation:'苹果' }], source:{ name:'ECDICT', url:'https://github.com/skywind3000/ECDICT' } }) },
  { ok:false, status:502, json: async () => ({ error:{ message:'词典暂时不可用' } }) },
];
const englishRequests = [];
const englishHistoryRecords = [];
let englishHistoryCount = 0;
let englishLookupCount = 0;
let englishHistoryBacks = 0;
let createEnglishLookup;
class TestCustomEvent { constructor(_name, init) { this.detail = init.detail; } }
const englishContext = vm.createContext({
  AbortController,
  Array,
  CustomEvent: TestCustomEvent,
  Event: class {},
  Promise,
  TextEncoder,
  URL,
  clearTimeout,
  document: {
    createElement: tag => new TestNode(tag),
    createTextNode: text => new TestNode('#text', text),
    createDocumentFragment: () => new TestNode('#fragment'),
  },
  fetch: async (url, options) => {
    assert.ok(englishResponses.length, 'English test must not issue an unexpected request');
    englishRequests.push({ url, body:JSON.parse(options.body) });
    return englishResponses.shift();
  },
  location: { href:'https://hanzi.usfan.net/char-dict.html' },
  setTimeout,
  window: {
    TextEncoder,
    dispatchEvent: event => { createEnglishLookup = event.detail.create; },
  },
});
vm.runInContext(englishScript, englishContext);
assert.equal(typeof createEnglishLookup, 'function', 'English lookup factory must register');
const englishController = createEnglishLookup({
  root: englishRoot,
  toggle: new TestNode(),
  cancelSpeech() {},
  icon: () => null,
  isEnglish: () => true,
  onLanguageChange() {},
  onHistorySave: record => englishHistoryRecords.push(record),
  onHistoryCount: () => { englishHistoryCount++; },
  onLookupCount: () => { englishLookupCount++; },
  onHistoryBack: () => { englishHistoryBacks++; },
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
englishController.handleRecognition('I like apples.');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[0], { url:'/api/english', body:{ text:'I like apples.' } }, 'recognized sentence must be sent unchanged');
assert.equal(englishHistoryRecords.length, 1, 'successful English sentence must notify history exactly once');
assert.equal(englishLookupCount, 1, 'successful English sentence must increment the lookup counter');
assert.deepEqual({ ...englishHistoryRecords[0], t:undefined }, {
  query:'I like apples.', kind:'sentence', translation:'我喜欢苹果。', source:{ name:'MyMemory', url:'https://mymemory.translated.net/' }, t:undefined,
}, 'sentence history must retain the result needed for offline history rendering');
const token = findByClass(englishRoot, 'english-token');
assert.equal(token.textContent, 'I', 'recognized sentence must render tappable words without an input');
let appleToken = findToken(englishRoot, 'apples');
assert.ok(appleToken, 'recognized sentence must keep each English word selectable');
appleToken.click();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[1], { url:'/api/english', body:{ text:'apples' } }, 'selected sentence word must be sent as the dictionary query');
assert.equal(findByClass(englishRoot, 'english-word').textContent, 'apples', 'sentence token must load its word result');
assert.equal(englishHistoryRecords.length, 2, 'successful English word must notify history');
assert.equal(englishLookupCount, 2, 'selecting a sentence word must increment the lookup counter');
assert.deepEqual({ ...englishHistoryRecords[1], t:undefined }, {
  query:'apples', kind:'word', word:'apples', phonetic:"'æplz", meanings:[{ partOfSpeech:'n.', translation:'苹果' }], source:{ name:'ECDICT', url:'https://github.com/skywind3000/ECDICT' }, t:undefined,
}, 'word history must retain its displayed dictionary data');
assert.equal(englishHistoryCount, 2, 'only successful English results may refresh the history count');
findByClass(englishRoot, 'english-back').click();
assert.ok(findByClass(englishRoot, 'english-sentence'), 'word back must restore the recognized sentence');
appleToken = findToken(englishRoot, 'apples');
assert.ok(appleToken, 'sentence back must preserve selectable words');
appleToken.click();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[2], { url:'/api/english', body:{ text:'apples' } }, 'failed dictionary query must preserve the selected word');
assert.ok(findByClass(englishRoot, 'english-error'), 'failed word query must display an error');
assert.equal(englishHistoryRecords.length, 2, 'failed English lookup must not create history');
assert.equal(englishLookupCount, 2, 'failed English lookup must not increment the lookup counter');
findByClass(englishRoot, 'english-back').click();
assert.ok(findByClass(englishRoot, 'english-sentence'), 'error back must restore the recognized sentence');

englishResponses.push({ ok:true, json: async () => ({ kind:'word', word:'apple', meanings:[], source:{ name:'ECDICT', url:'https://github.com/skywind3000/ECDICT' } }) });
englishController.lookup('apple', false, true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(englishHistoryRecords.length, 2, 'reopening an English history record must not save it again or reorder the list');
assert.equal(englishLookupCount, 2, 'reopening an English history record must not increment the lookup counter');
const historyBack = findByAttribute(englishRoot, 'aria-label', '返回历史');
assert.ok(historyBack, 'history-opened English result must provide a return control');
historyBack.click();
assert.equal(englishHistoryBacks, 1, 'history return must notify its navigation owner');

englishResponses.push(
  { ok:true, json: async () => ({ kind:'sentence', translation:'我看到一只蜜蜂。' }) },
  { ok:true, json: async () => ({ kind:'word', word:'a', meanings:[] }) },
);
const historySentenceRoot = new TestNode();
const historySentenceRecords = [];
let historySentenceBacks = 0;
const historySentenceController = createEnglishLookup({
  root: historySentenceRoot,
  toggle: new TestNode(),
  cancelSpeech() {},
  icon: () => null,
  isEnglish: () => true,
  onLanguageChange() {},
  onHistorySave: record => historySentenceRecords.push(record),
  onHistoryBack: () => { historySentenceBacks++; },
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
historySentenceController.lookup('I see a bee.', false, true, true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(historySentenceRecords.length, 0, 'opening a sentence from history must not save or reorder it');
findToken(historySentenceRoot, 'a').click();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(historySentenceRecords.map(record => record.query), ['a'], 'a new word selected from a history sentence must be saved');
findByAttribute(historySentenceRoot, 'aria-label', '返回原句').click();
assert.ok(findByClass(historySentenceRoot, 'english-sentence'), 'word back from a history sentence must restore that sentence');
findByAttribute(historySentenceRoot, 'aria-label', '返回历史').click();
assert.equal(historySentenceBacks, 1, 'restored history sentence must still return to the history list');

let releaseStaleHistory;
let releaseCurrentHistory;
englishResponses.push(
  new Promise(resolve => { releaseStaleHistory = resolve; }),
  new Promise(resolve => { releaseCurrentHistory = resolve; }),
);
const staleHistoryRecords = [];
const staleRoot = new TestNode();
const staleController = createEnglishLookup({
  root: staleRoot,
  toggle: new TestNode(),
  cancelSpeech() {},
  icon: () => null,
  isEnglish: () => true,
  onLanguageChange() {},
  onHistorySave: record => staleHistoryRecords.push(record),
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
staleController.handleRecognition('older result');
staleController.handleRecognition('current result');
releaseStaleHistory({ ok:true, json: async () => ({ kind:'word', word:'older', meanings:[] }) });
await new Promise(resolve => setImmediate(resolve));
assert.equal(staleHistoryRecords.length, 0, 'stale English response must not create history');
releaseCurrentHistory({ ok:true, json: async () => ({ kind:'sentence', translation:'当前结果' }) });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(staleHistoryRecords.map(record => record.query), ['current result'], 'only the current English response may enter history');

englishResponses.push(
  { ok:true, json: async () => ({ kind:'word', word:'first', meanings:[] }) },
  { ok:true, json: async () => ({ kind:'word', word:'older', meanings:[] }) },
);
const snapshotRoot = new TestNode();
const snapshotHistoryRecords = [];
const snapshotController = createEnglishLookup({
  root: snapshotRoot,
  toggle: new TestNode(),
  cancelSpeech() {},
  icon: () => null,
  isEnglish: () => true,
  onLanguageChange() {},
  onHistorySave: record => snapshotHistoryRecords.push(record),
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
snapshotController.handleRecognition('first');
await new Promise(resolve => setImmediate(resolve));
const originalEnglishView = snapshotController.viewSnapshot();
snapshotController.lookup('older', false, true, true);
await new Promise(resolve => setImmediate(resolve));
snapshotController.restoreView(originalEnglishView);
assert.equal(findByClass(snapshotRoot, 'english-word').textContent, 'first', 'history exit must restore the English result that opened history');
assert.equal(findByAttribute(snapshotRoot, 'aria-label', '返回历史'), null, 'restored original English result must not retain the older record\'s history back control');
assert.equal(snapshotHistoryRecords.length, 1, 'opening an older English history record must not add or reorder history');

englishResponses.push(
  { ok:true, json: async () => ({ kind:'sentence', translation:'我有一只猫。' }) },
  { ok:true, json: async () => ({ kind:'word', word:'a', meanings:[] }) },
);
const sentenceSnapshotRoot = new TestNode();
const sentenceSnapshotController = createEnglishLookup({
  root: sentenceSnapshotRoot,
  toggle: new TestNode(),
  cancelSpeech() {},
  icon: () => null,
  isEnglish: () => true,
  onLanguageChange() {},
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
sentenceSnapshotController.handleRecognition('I have a cat.');
await new Promise(resolve => setImmediate(resolve));
findToken(sentenceSnapshotRoot, 'a').click();
await new Promise(resolve => setImmediate(resolve));
findByAttribute(sentenceSnapshotRoot, 'aria-label', '返回原句').click();
const sentenceView = sentenceSnapshotController.viewSnapshot();
assert.equal(sentenceView.result.kind, 'sentence', 'returning to an English sentence must update the history snapshot from the selected word');
assert.equal(sentenceView.query, 'I have a cat.', 'sentence snapshot must retain its recognized query');

englishResponses.push({ ok:true, json: async () => ({ kind:'word', word:'older', meanings:[] }) });
const emptySnapshotRoot = new TestNode();
const emptySnapshotController = createEnglishLookup({
  root: emptySnapshotRoot,
  toggle: new TestNode(),
  cancelSpeech() {},
  icon: () => null,
  isEnglish: () => true,
  onLanguageChange() {},
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
const emptyEnglishView = emptySnapshotController.viewSnapshot();
emptySnapshotController.lookup('older', false, true, true);
await new Promise(resolve => setImmediate(resolve));
emptySnapshotController.restoreView(emptyEnglishView);
assert.equal(findByClass(emptySnapshotRoot, 'english-word'), null, 'an empty English workspace must not retain the older history record');

const historyStorage = new Map([
  ['chazi_history', JSON.stringify([{ c:'旧', t:1 }, { c:'字', t:2 }])],
  ['english_history', JSON.stringify([])],
]);
const historyElements = new Map();
const historyElement = id => {
  if (!historyElements.has(id)) {
    const element = new TestNode();
    element.id = id;
    element.focus = () => { element.focused = true; };
    historyElements.set(id, element);
  }
  return historyElements.get(id);
};
for (const id of ['history', 'detail', 'results', 'historyList', 'historyTitle', 'clearHistory', 'historyBtn', 'resHistBtn', 'detHistBtn', 'histCount', 'resHistCount', 'detHistCount', 'historyConfirm', 'historyConfirmText', 'historyCancel', 'historyConfirmOk', 'histBack']) historyElement(id);
const historyContext = vm.createContext({
  Date,
  JSON,
  localStorage: {
    getItem: key => historyStorage.get(key) ?? null,
    setItem: (key, value) => { historyStorage.set(key, value); },
  },
  toast() {},
  cancelSpeech() {},
  requestAnimationFrame: callback => callback(),
  document: { addEventListener() {}, createElement: () => new TestNode(), getElementById: historyElement },
  $: historyElement,
  DICT: {},
  esc: text => String(text),
  speak() {},
  fitDetailChar() {},
  fitStrokeCells() {},
  fitResultCards() {},
  renderDetail() {},
  showResultsPage() {},
  cleanups: [],
  clearInterval() {},
});
const historyInitStart = html.indexOf('var mode = "cn";');
const historyInitEnd = html.indexOf('var toastTimer', historyInitStart);
assert.ok(historyInitStart >= 0 && historyInitEnd > historyInitStart, 'history storage initialization must be present');
vm.runInContext(html.slice(historyInitStart, historyInitEnd), historyContext);
assert.equal(JSON.stringify(historyContext.histList), JSON.stringify([{ c:'旧', t:1 }, { c:'字', t:2 }]), 'legacy Chinese {c,t} history must load unchanged');
historyContext.renderHistCount = () => {};
const historyWriteStart = html.indexOf('function addHistory(');
const historyWriteEnd = html.indexOf('function currentHistoryList()', historyWriteStart);
vm.runInContext(html.slice(historyWriteStart, historyWriteEnd), historyContext);
historyContext.addHistory('新');
assert.deepEqual(JSON.parse(historyStorage.get('chazi_history')), [{ c:'新', t:historyContext.histList[0].t }, { c:'旧', t:1 }, { c:'字', t:2 }], 'new Chinese selection must preserve prior legacy records');
historyContext.addHistory('语', '词语');
historyContext.addHistory('语', '词语');
assert.equal(historyContext.histList.filter(record => record.w === '词语').length, 1, 'Chinese word history must deduplicate independently from character history');
for (let index = 0; index < 47; index++) historyContext.addHistory(`中${index}`);
assert.equal(historyContext.histList.length, 50, 'Chinese history must cap independently at 50 records');
for (let index = 0; index < 51; index++) historyContext.saveEnglishRecord({ kind:'word', query:`word-${index}`, word:`word-${index}`, t:index });
historyContext.saveEnglishRecord({ kind:'word', query:'word-50', word:'word-50', t:99 });
assert.equal(historyContext.englishHistList.length, 50, 'English history must cap independently at 50 records');
assert.equal(historyContext.englishHistList.filter(record => record.query === 'word-50').length, 1, 'repeated English history must deduplicate');
assert.equal(historyContext.histList.some(record => record.c === '旧'), true, 'English history writes must not alter Chinese history');

const historyUiStart = html.indexOf('function currentHistoryList()');
const historyUiEnd = html.indexOf('var rec =', historyUiStart);
historyContext.showWorkspace = page => {
  historyContext.workspace = page;
  for (const name of ['history', 'detail', 'results']) historyElement(name).classList.toggle('show', page === name);
};
vm.runInContext(html.slice(historyUiStart, historyUiEnd), historyContext);
Object.assign(historyContext.DICT, { 春:{}, 夏:{}, 秋:{}, 冬:{} });
let restoredWordChars = null;
historyContext.showResultsPage = (chars, tone, fromHistory) => { restoredWordChars = { chars:[...chars], tone, fromHistory }; };
historyContext.openChineseWordHistory({ w:'春夏秋冬' });
assert.deepEqual(restoredWordChars, { chars:['春', '夏', '秋', '冬'], tone:0, fromHistory:true }, 'opening a Chinese word history record must restore every available character');
historyContext.lookupLanguage = 'en';
historyContext.openHistory();
historyContext.openHistory();
assert.equal(historyContext.workspace, 'history', 'reopening English history must keep the history workspace active');
historyElement('histBack').click();
assert.equal(historyContext.workspace, 'english', 'English history back must return to the English workspace');
historyContext.openHistory();
assert.equal(historyContext.workspace, 'history', 'history must reopen after returning to English');
historyContext.requestClearHistory();
historyContext.closeHistoryConfirm();
assert.equal(historyContext.englishHistList.length, 50, 'canceling English clear must retain English history');
assert.equal(historyContext.histList.some(record => record.c === '旧'), true, 'canceling English clear must retain Chinese history');
historyContext.requestClearHistory();
historyContext.confirmClearHistory();
assert.equal(historyContext.englishHistList.length, 0, 'confirmed English clear must remove English history');
assert.equal(historyContext.histList.some(record => record.c === '旧'), true, 'confirmed English clear must not remove Chinese history');
historyContext.englishHistList = [{ kind:'word', query:'apple', word:'apple', t:1 }];
historyContext.lookupLanguage = 'zh';
historyContext.requestClearHistory();
historyContext.confirmClearHistory();
assert.equal(historyContext.histList.length, 0, 'confirmed Chinese clear must remove Chinese history');
assert.equal(historyContext.englishHistList.length, 1, 'confirmed Chinese clear must not remove English history');

Object.assign(historyContext.DICT, { 甲:{}, 乙:{} });
historyContext.histList = [{ c:'乙', t:1 }];
historyContext.current = '甲';
const renderedDetails = [];
historyContext.renderDetail = () => {
  renderedDetails.push(historyContext.current);
  historyContext.showWorkspace('detail');
};
historyContext.lookupLanguage = 'zh';
historyContext.showWorkspace('detail');
historyContext.openHistory();
historyElement('historyList').children[0].click();
assert.deepEqual(renderedDetails, ['乙'], 'opening an older Chinese character from history must show that record');
historyElement('backBtn').click();
assert.equal(historyContext.workspace, 'history', 'detail back after a history record must return to history');
historyElement('histBack').click();
assert.equal(historyContext.current, '甲', 'history back must restore the detail that opened history, not the record just viewed');
assert.deepEqual(renderedDetails, ['乙', '甲'], 'restoring the original detail must render its original character again');
assert.equal(historyElement('history').classList.contains('show'), false, 'restoring a detail must hide history');
assert.equal(historyElement('detail').classList.contains('show'), true, 'restoring a detail must show the detail workspace');

const restoredCandidateViews = [];
historyContext.showResultsPage = (...args) => {
  restoredCandidateViews.push(args);
  historyContext.resultsView = { kind:'candidates', chars:[...args[0]], toneNum:args[1], fromHistory:args[2], preserveAll:args[3] };
  historyContext.showWorkspace('results');
};
historyContext.resultsView = { kind:'candidates', chars:['甲', '乙'], toneNum:2, fromHistory:false, preserveAll:false };
historyContext.showWorkspace('results');
historyContext.openHistory();
historyContext.showResultsPage(['春', '夏'], 0, true, true);
historyContext.showWorkspace('history');
historyElement('histBack').click();
assert.deepEqual(restoredCandidateViews.at(-1), [['甲', '乙'], 2, false, false], 'history back must restore the original Chinese candidates after another word replaced them');

const originalEnglishHistoryView = { result:{ kind:'word', word:'apple', meanings:[] }, query:'apple', fromHistory:false };
const restoredEnglishViews = [];
const EnglishHistoryCalls = [];
historyContext.englishLookupController = {
  viewSnapshot: () => originalEnglishHistoryView,
  cancelPending() {},
  lookup: (...args) => EnglishHistoryCalls.push(args),
  restoreView: view => restoredEnglishViews.push(view),
};
historyContext.lookupLanguage = 'en';
historyContext.showWorkspace('english');
historyContext.openHistory();
historyContext.openEnglishHistory({ kind:'word', query:'older' });
assert.deepEqual(EnglishHistoryCalls, [['older', false, true, true]], 'opening an older English record must mark it as history-only');
historyContext.returnFromEnglishHistory();
historyElement('histBack').click();
assert.deepEqual(restoredEnglishViews, [originalEnglishHistoryView], 'English history exit must restore the result that originally opened history');
console.log('Client syntax, audio resampling, and umlaut pinyin checks passed');

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
  englishLookupController: { handleRecognition: text => submitEvents.push(['english', text]) },
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
submitEvents.length = 0;
submitContext.rec.captureSeq = 9;
submitContext.cloudRecognize = () => Promise.resolve('I have 2 apples.');
submitContext.submitRecording(new Float32Array(1600), 9, 'en');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [
  ['state', 'recognize'],
  ['state', 'off'],
  ['english', 'I have 2 apples.'],
], 'English ASR must preserve I, numbers, spaces, and punctuation for lookup');
submitEvents.length = 0;
let releaseStaleEnglish;
submitContext.rec.captureSeq = 10;
submitContext.cloudRecognize = () => new Promise(resolve => { releaseStaleEnglish = resolve; });
submitContext.submitRecording(new Float32Array(1600), 10, 'en');
submitContext.rec.captureSeq = 11;
releaseStaleEnglish('I should not replace the newer result.');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(submitEvents, [['state', 'recognize']], 'stale English ASR must not replace a newer language or recording result');

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

const languageStart = html.indexOf('function setLookupLanguage(');
const languageEnd = html.indexOf('window.addEventListener("english-lookup-ready"', languageStart);
const languageHistory = { hidden:false };
const languageContext = vm.createContext({
  rec: { captureSeq:9, active:false, autoMode:false },
  cancelSpeech() {}, cancelAutoRec() {}, setRecState() {}, showWorkspace: page => { languageContext.workspace = page; },
  $: name => name === 'historyBtn' ? languageHistory : (name === 'recBtn' ? { setAttribute() {}, querySelector: () => null } : null),
});
vm.runInContext(html.slice(languageStart, languageEnd), languageContext);
languageContext.setLookupLanguage('en');
assert.equal(languageContext.rec.captureSeq, 10, 'Changing language must invalidate an ASR request even after recording stopped');
assert.equal(languageContext.workspace, 'english', 'English mode must keep the right-side result workspace active');
assert.equal(languageHistory.hidden, true, 'English mode must hide Chinese lookup history');
languageContext.setLookupLanguage('zh');
assert.equal(languageContext.workspace, null, 'Chinese mode must clear the English workspace selection');
assert.equal(languageHistory.hidden, false, 'Chinese mode must restore lookup history');

class TestNode {
  constructor(tag = 'div', text = '') {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this._text = text;
    this.classList = {
      add: name => { if (!this.className.split(/\s+/).includes(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(' '); },
    };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { if (this.listeners.click) this.listeners.click({}); }
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
const englishRoot = new TestNode();
const englishResponses = [
  { ok:true, json: async () => ({ kind:'sentence', translation:'我喜欢苹果。', source:{ name:'MyMemory', url:'https://mymemory.translated.net/' } }) },
  { ok:true, json: async () => ({ kind:'word', word:'apples', phonetic:"'æplz", meanings:[{ partOfSpeech:'n.', translation:'苹果' }], source:{ name:'ECDICT', url:'https://github.com/skywind3000/ECDICT' } }) },
  { ok:false, status:502, json: async () => ({ error:{ message:'词典暂时不可用' } }) },
];
const englishRequests = [];
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
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
englishController.handleRecognition('I like apples.');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[0], { url:'/api/english', body:{ text:'I like apples.' } }, 'recognized sentence must be sent unchanged');
const token = findByClass(englishRoot, 'english-token');
assert.equal(token.textContent, 'I', 'recognized sentence must render tappable words without an input');
let appleToken = findToken(englishRoot, 'apples');
assert.ok(appleToken, 'recognized sentence must keep each English word selectable');
appleToken.click();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[1], { url:'/api/english', body:{ text:'apples' } }, 'selected sentence word must be sent as the dictionary query');
assert.equal(findByClass(englishRoot, 'english-word').textContent, 'apples', 'sentence token must load its word result');
findByClass(englishRoot, 'english-back').click();
assert.ok(findByClass(englishRoot, 'english-sentence'), 'word back must restore the recognized sentence');
appleToken = findToken(englishRoot, 'apples');
assert.ok(appleToken, 'sentence back must preserve selectable words');
appleToken.click();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[2], { url:'/api/english', body:{ text:'apples' } }, 'failed dictionary query must preserve the selected word');
assert.ok(findByClass(englishRoot, 'english-error'), 'failed word query must display an error');
findByClass(englishRoot, 'english-back').click();
assert.ok(findByClass(englishRoot, 'english-sentence'), 'error back must restore the recognized sentence');
console.log('Client syntax, audio resampling, and umlaut pinyin checks passed');

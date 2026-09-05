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
  showWorkspace: page => submitEvents.push(['workspace', page]),
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
  ['workspace', 'english'],
  ['english', 'I have 2 apples.'],
], 'English ASR from history must return to the English workspace and preserve I, numbers, spaces, and punctuation');
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
const languageWorkspaceHistory = { classList: { contains: () => false } };
const languageContext = vm.createContext({
  rec: { captureSeq:9, active:false, autoMode:false },
  cancelSpeech() {}, cancelAutoRec() {}, setRecState() {}, showWorkspace: page => { languageContext.workspace = page; },
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
  onHistoryBack: () => { englishHistoryBacks++; },
  prefetchTTS: () => Promise.resolve(),
  speak() {},
});
englishController.handleRecognition('I like apples.');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(englishRequests[0], { url:'/api/english', body:{ text:'I like apples.' } }, 'recognized sentence must be sent unchanged');
assert.equal(englishHistoryRecords.length, 1, 'successful English sentence must notify history exactly once');
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
findByClass(englishRoot, 'english-back').click();
assert.ok(findByClass(englishRoot, 'english-sentence'), 'error back must restore the recognized sentence');

englishResponses.push({ ok:true, json: async () => ({ kind:'word', word:'apple', meanings:[], source:{ name:'ECDICT', url:'https://github.com/skywind3000/ECDICT' } }) });
englishController.lookup('apple', false, true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(englishHistoryRecords.length, 2, 'reopening an English history record must not save it again or reorder the list');
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

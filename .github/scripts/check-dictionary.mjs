import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "../..");
const page = fs.readFileSync(path.join(root, "char-dict.html"), "utf8");
const sourceLock = JSON.parse(fs.readFileSync(path.join(root, "models/dictionary/source-lock.json"), "utf8"));

assert.equal(sourceLock.unihan.version, "17.0.0", "Unihan source version must be pinned");
assert.equal(sourceLock.cjk_radicals.version, "17.0.0", "CJK radicals source version must be pinned");
assert.match(sourceLock.unihan.sha256, /^[0-9a-f]{64}$/, "Unihan checksum is missing");
assert.match(sourceLock.cjk_radicals.sha256, /^[0-9a-f]{64}$/, "CJK radicals checksum is missing");
assert.match(sourceLock.hanzi_writer.commit, /^[0-9a-f]{40}$/, "Hanzi Writer commit is missing");
assert.match(sourceLock.hanzi_writer.all_json_sha256, /^[0-9a-f]{64}$/, "Hanzi Writer data checksum is missing");

function readInlineObject(name) {
  const match = page.match(new RegExp(`var ${name}\\s*=\\s*(\\{.*?\\});`, "s"));
  assert.ok(match, `missing inline ${name}`);
  return vm.runInNewContext(`(${match[1]})`);
}

function pinyinKey(value) {
  return value.normalize("NFD").replace(/u\u0308/g, "v").replace(/[\u0300-\u036f]/g, "");
}

const baseDict = readInlineObject("DICT");
const basePinyin = readInlineObject("PINYIN");
const baseRadicals = readInlineObject("RADICALS");
const extensionContext = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "models/dictionary/character-data.js"), "utf8"), extensionContext);
const ext = extensionContext.CHARACTER_DATA;
assert.ok(ext && ext.chars && ext.pinyin && ext.radicals && typeof ext.strokeChars === "string", "invalid generated extension");
assert.ok(Object.keys(ext.chars).length >= 8105, "dictionary coverage is below the required floor");
assert.ok([...ext.strokeChars].length >= 9000, "local stroke coverage is below 9000 characters");
assert.ok(!page.includes("models/strokes/stroke_data.json"), "page must not prefetch the legacy full stroke bundle");
assert.equal(pinyinKey("lǚ"), "lv", "umlaut pinyin must not collapse into lu");
assert.equal(pinyinKey("nǚ"), "nv", "umlaut pinyin must not collapse into nu");
for (const [ch, data] of Object.entries(ext.chars)) {
  const readings = Array.isArray(data.p) ? data.p : [data.p];
  assert.ok(readings.every(Boolean), `missing generated pinyin for ${ch}`);
  assert.deepEqual(JSON.parse(JSON.stringify(data.w)), [], `generated words are not allowed for ${ch}`);
  for (const reading of readings) assert.ok(ext.pinyin[pinyinKey(reading)]?.includes(ch), `broken generated pinyin index for ${ch}`);
}
for (const [ch, radical] of Object.entries(ext.radicals)) {
  assert.ok(radical.r && radical.kind === "kangxi" && Number.isInteger(radical.s) && Number.isInteger(radical.ts) && radical.s <= radical.ts, `invalid trusted radical for ${ch}`);
}
const localStrokeFiles = new Set(fs.readdirSync(path.join(root, "models/strokes/data")).filter(file => file.endsWith(".json")));
assert.equal(localStrokeFiles.size, [...ext.strokeChars].length, "local stroke file count diverges from metadata");
for (const ch of ext.strokeChars) assert.ok(localStrokeFiles.has(`${ch.codePointAt(0).toString(16).toUpperCase()}.json`), `missing local stroke file for ${ch}`);

const mergeStart = page.indexOf("var characterStrokeChars");
const mergeEnd = page.indexOf("\nvar mode", mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, "missing dictionary merge block");
const mergeContext = {
  DICT: structuredClone(baseDict),
  PINYIN: structuredClone(basePinyin),
  RADICALS: structuredClone(baseRadicals),
  CHARACTER_DATA: ext,
};
vm.runInNewContext(page.slice(mergeStart, mergeEnd), mergeContext);

for (const [ch, expected] of Object.entries({
  馨: { p: "xīn", r: { r: "香", s: 9, ts: 20, kind: "kangxi" } },
  曦: { p: "xī", r: { r: "日", s: 4, ts: 20, kind: "kangxi" } },
  麒: { p: "qí", r: { r: "鹿", s: 11, ts: 19, kind: "kangxi" } },
  璐: { p: "lù", r: { r: "玉", s: 5, ts: 17, kind: "kangxi" } },
  鑫: { p: "xīn", r: { r: "金", s: 8, ts: 24, kind: "kangxi" } },
  龘: { p: "dá", r: { r: "龍", s: 16, ts: 48, kind: "kangxi" } },
})) {
  assert.equal(mergeContext.DICT[ch].p, expected.p, `wrong pinyin for ${ch}`);
  assert.deepEqual(JSON.parse(JSON.stringify(mergeContext.RADICALS[ch])), expected.r, `wrong radical for ${ch}`);
  assert.ok(mergeContext.PINYIN[pinyinKey(expected.p)].includes(ch), `missing pinyin index for ${ch}`);
}

for (const ch of ["啰", "嚼", "翼"]) {
  assert.deepEqual(JSON.parse(JSON.stringify(mergeContext.DICT[ch])), JSON.parse(JSON.stringify(baseDict[ch])), `existing record changed for ${ch}`);
}
assert.deepEqual(JSON.parse(JSON.stringify(mergeContext.RADICALS.龙)), JSON.parse(JSON.stringify(baseRadicals.龙)), "existing New Chinese Dictionary radical changed for 龙");
assert.ok(mergeContext.PINYIN.lv.includes("吕"), "吕 must be indexed under lv");
assert.ok(mergeContext.PINYIN.nv.includes("女"), "女 must be indexed under nv");

const strokeDir = path.join(root, "models/strokes/data");
for (const ch of ["馨", "曦", "麒", "璐", "鑫", "龍", "龙"]) {
  assert.ok(mergeContext.characterStrokeChars.includes(ch), `missing local stroke declaration for ${ch}`);
  const data = JSON.parse(fs.readFileSync(path.join(strokeDir, `${ch.codePointAt(0).toString(16).toUpperCase()}.json`), "utf8"));
  assert.equal(data.strokes.length, data.medians.length, `invalid local stroke data for ${ch}`);
  assert.equal(data.strokes.length, mergeContext.RADICALS[ch].ts, `stroke count mismatch for ${ch}`);
}
assert.ok(!mergeContext.characterStrokeChars.includes("龘"), "龘 must state that it has no local stroke path");

const loaderStart = page.indexOf("var cleanups = []");
const loaderEnd = page.indexOf("\n// 按容器宽度", loaderStart);
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, "missing stroke loader");
const requests = [];
const loaderContext = {
  characterStrokeChars: mergeContext.characterStrokeChars,
  fetchJSON(url, ok, fail) {
    requests.push(url);
    loaderContext.pending.push({ ok, fail });
  },
  pending: [],
};
vm.runInNewContext(page.slice(loaderStart, loaderEnd), loaderContext);
const loaded = [];
loaderContext.preloadStrokeData("馨", (data, error) => loaded.push({ data, error }));
loaderContext.preloadStrokeData("馨", (data, error) => loaded.push({ data, error }));
assert.equal(requests.length, 1, "same character must share one in-flight local stroke request");
assert.equal(requests[0], "models/strokes/data/99A8.json", "loader must request the local single-character path");
loaderContext.pending.shift().ok(JSON.parse(fs.readFileSync(path.join(root, requests[0]), "utf8")));
loaderContext.preloadStrokeData("龘", (data, error) => loaded.push({ data, error }));
loaderContext.preloadStrokeData("龘", (data, error) => loaded.push({ data, error }));
assert.equal(loaded.length, 4, "all stroke callbacks must complete");
assert.equal(loaded[0].error, null, "local stroke success must not include an error");
assert.equal(loaded[2].data, null, "missing local path must resolve explicitly as no data");
assert.equal(loaded[2].error, null, "missing local path must not be reported as a transport error");
assert.equal(loaded[3].error, null, "missing local path must be cached as no data");
assert.equal(requests.length, 1, "missing local path must not issue a request");

const failed = [];
loaderContext.fetchJSON = (url, ok, fail) => failed.push({ url, ok, fail });
const failures = [];
loaderContext.preloadStrokeData("曦", (data, error) => failures.push({ data, error }));
failed.shift().fail(new Error("network"));
assert.equal(failures[0].data, null, "network failure must not return stroke data");
assert.match(failures[0].error.message, /network/, "network failure must be explicit");
loaderContext.preloadStrokeData("曦", (data, error) => failures.push({ data, error }));
failed.shift().ok({ strokes: [], medians: [] });
assert.equal(failures[1].data, null, "invalid stroke data must not return stroke data");
assert.match(failures[1].error.message, /格式/, "invalid stroke data must be explicit");
loaderContext.preloadStrokeData("曦", (data, error) => failures.push({ data, error }));
failed.shift().ok(JSON.parse(fs.readFileSync(path.join(strokeDir, "66E6.json"), "utf8")));
assert.ok(failures[2].data, "a later successful retry must return stroke data");
assert.equal(failures[2].error, null, "a later successful retry must clear the error");

const fetchStart = page.indexOf("function fetchJSON(");
const fetchEnd = page.indexOf("\nfunction renderWords", fetchStart);
assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, "missing JSON fetch helper");
class FailedXHR {
  open() {}
  send() {
    this.readyState = 4;
    this.status = 500;
    this.onreadystatechange();
    this.onerror();
    this.ontimeout();
  }
}
const fetchContext = { XMLHttpRequest: FailedXHR };
vm.runInNewContext(page.slice(fetchStart, fetchEnd), fetchContext);
let fetchFailures = 0;
fetchContext.fetchJSON("missing.json", () => assert.fail("failed XHR must not succeed"), () => { fetchFailures++; });
assert.equal(fetchFailures, 1, "XHR failure events must settle only once");

console.log(`dictionary regression ok: ${Object.keys(ext.chars).length} characters, ${[...ext.strokeChars].length} local stroke files`);

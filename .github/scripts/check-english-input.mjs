import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const scriptPath = resolve(root, 'english-input.js');
assert.ok(existsSync(scriptPath), 'English photo input must be available before a child can select a textbook word');
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(scriptPath, 'utf8'), context);
const { wordsFromText, learningForWord } = context.window.EnglishInput;
const tokens = text => Array.from(wordsFromText(text));
assert.deepEqual(tokens('Apple apple BOOK. book\nI like apples!'), ['Apple', 'BOOK', 'I', 'like', 'apples'], 'photo words must be distinct ignoring case while preserving spelling and order');
assert.deepEqual(tokens("Don't, mother-in-law; it’s. 中文 123"), ["Don't", 'mother-in-law', 'it’s'], 'apostrophes and hyphens must not split a dictionary word');
assert.deepEqual(tokens('123 中文 !!!'), [], 'a picture without English must not fabricate words');
assert.deepEqual(tokens('Ａｐｐｌｅ'), ['Apple'], 'full-width Latin text must remain usable');
assert.throws(() => wordsFromText(null), /识别/, 'a malformed OCR response must fail explicitly');

const learning = JSON.parse(readFileSync(resolve(root, 'data/english-learning.json'), 'utf8'));
const apple = learningForWord('APPLE', learning);
assert.equal(apple.meaning, '苹果');
assert.equal(apple.example, 'I eat an apple.');
assert.equal(apple.translation, '我吃一个苹果。');
assert.equal(learningForWord('constructor', learning), null, 'object prototype names are not teaching data');
assert.equal(learningForWord('qzxunknown', learning), null, 'unknown words must not receive invented examples');
assert.equal(learningForWord('apple', { apple: { meaning:'苹果', example:'', translation:'苹果' } }), null, 'incomplete examples must not be presented as valid teaching data');
for (const [word, entry] of Object.entries(learning)) {
  assert.ok(learningForWord(word, learning), `${word}: all teaching entries must contain a meaning, English example and Chinese translation`);
  assert.ok(tokens(entry.example).some(token => token.toLowerCase().replace('’', "'") === word), `${word}: example must contain the actual dictionary word`);
  assert.ok(entry.example.length <= 100, `${word}: an example should fit a short child-facing sentence`);
}
console.log(`English input token and teaching-data checks passed (${Object.keys(learning).length} words)`);

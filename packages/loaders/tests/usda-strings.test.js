// Static readUSDA reads strings as OpenUSD does (TfEscapeString), not as JSON (KB-USDA-S1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readUSDA } from '../dist/index.js';

const read = (body) => readUSDA(`#usda 1.0\n${body}`);
const attr = (body, name = 's') => read(`def Xform "A" {\n ${body}\n}`).prims.get('/A').attrs.get(name);

test('USDA strings decode hex, octal and C escapes as OpenUSD does (KB-USDA-S1)', () => {
  // The row's repro: a hex escape was a JSON syntax error.
  assert.equal(attr(String.raw`string s = "a\x41"`), 'aA');
  assert.equal(attr(String.raw`string s = "\101\102"`), 'AB');
  assert.equal(attr(String.raw`string s = "\a\b\f\n\r\t\v"`), '\x07\b\f\n\r\t\v');
  // Any other escaped character stands for itself.
  assert.equal(attr(String.raw`string s = "\q\"\\\/"`), 'q"\\/');
  // A run of byte escapes is one UTF-8 sequence.
  assert.equal(attr(String.raw`string s = "caf\xc3\xa9 \342\202\254"`), 'café €');
  // One or two hex digits, one to three octal ones.
  assert.equal(attr(String.raw`string s = "\x4G\1012"`), '\x04GA2');
});

test('USDA single-quoted and triple-quoted strings read like double-quoted ones (KB-USDA-S1)', () => {
  assert.equal(attr(String.raw`string s = 'it\'s \x41'`), "it's A");
  assert.equal(attr(String.raw`string s = '"quoted"'`), '"quoted"');
  assert.equal(
    attr(String.raw`string s = """two
lines \x41"""`),
    'two\nlines A',
  );
  assert.equal(attr(String.raw`string s = '''a 'b' \t'''`), "a 'b' \t");
  const layer = read(String.raw`def Xform 'Single' ( doc = 'a \x41' ) {
 token[] t = ['x', "y"]
}`);
  const prim = layer.prims.get('/Single');
  assert.equal(prim.metadata.get('doc'), 'a A');
  assert.deepEqual(prim.attrs.get('t'), ['x', 'y']);
});

test('USDA relocates is a named unsupported error, not an invalid token (KB-USDA-S1)', () => {
  assert.throws(
    () => read('def Xform "A" (\n relocates = { <a>: <b> }\n) {\n}'),
    (error) => error.code === 'unsupported' && /relocates/.test(error.message),
  );
});

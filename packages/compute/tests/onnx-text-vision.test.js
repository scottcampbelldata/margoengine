import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

const f32 = (values, shape = [values.length]) => new OnnxTensor('float32', Float32Array.from(values), shape);
const i64 = (values, shape = [values.length]) => new OnnxTensor('int64', BigInt64Array.from(values, BigInt), shape);
const strings = (values, shape = [values.length]) => new OnnxTensor('string', values, shape);
const stringAttr = (name, values) => p.message(p.field(1, name), p.field(20, 8), ...values.map((v) => p.field(9, v)));
const floatsAttr = (name, values) =>
  p.message(p.field(1, name), p.field(20, 6), p.field(7, new Uint8Array(Float32Array.from(values).buffer)));
async function run(op, values, attrs = [], version = 22) {
  const names = values.map((v, j) => (v === null ? '' : `x${j}`));
  const info = (name) => p.field(1, name);
  using model = await loadOnnx(
    p.model(p.graph([p.node(op, names, ['y'], attrs)], names.filter(Boolean).map(info), [info('y')]), version),
  );
  const persistentBytes = model.work.liveBytes;
  const result = await model.run(Object.fromEntries(values.flatMap((v, j) => (v === null ? [] : [[names[j], v]]))));
  assert.equal(model.work.liveBytes, persistentBytes);
  return result.y;
}

test('RegexFullMatch matches whole strings only and keeps the input shape', async () => {
  const x = strings(['abc', 'xabc', 'abcx', 'ABC', '', 'abbbc'], [2, 3]);
  const y = await run('RegexFullMatch', [x], [p.attr('pattern', 'a(?:b+)c')], 20);
  assert.equal(y.dtype, 'bool');
  assert.deepEqual(y.shape, [2, 3]);
  assert.deepEqual([...y.data], [1, 0, 0, 0, 0, 1]);
  await assert.rejects(run('RegexFullMatch', [x], [p.attr('pattern', '(a')], 20), /unclosed group/);
  await assert.rejects(run('RegexFullMatch', [x], [p.attr('pattern', 'a')], 19), /RegexFullMatch/);
  await assert.rejects(run('RegexFullMatch', [f32([1])], [p.attr('pattern', 'a')], 20), /string/);
});

const matching = async (pattern, texts) => [
  ...(await run('RegexFullMatch', [strings(texts)], [p.attr('pattern', pattern)], 20)).data,
];

test('the RE2 syntax table: classes, flags, anchors, repetition and escapes', async () => {
  const cases = [
    ['', [''], ['a']],
    ['a*', ['', 'aaaa'], ['b']],
    ['a+?b?', ['a', 'aab'], ['', 'b']],
    ['ab{2,3}', ['abb', 'abbb'], ['ab', 'abbbb']],
    ['a{2}', ['aa'], ['a', 'aaa']],
    ['a{2,}', ['aaaaa'], ['a']],
    ['a{', ['a{'], ['a']],
    ['x|yz|', ['x', 'yz', ''], ['y']],
    ['.', ['a', 'é', '😀'], ['\n', 'ab']],
    ['(?s).', ['\n'], []],
    ['[a-c^]+', ['abc^'], ['d']],
    ['[^a-c]', ['d', '\n'], ['a']],
    ['[]a]+', [']a'], ['b']],
    ['[a-]+', ['a-'], ['b']],
    ['\\d\\D\\s\\S\\w\\W', ['1a b_-'], ['1a\vb_-', '١a b_-']],
    ['[\\d\\s]+', ['1 \t2'], ['a']],
    ['[^\\D]', ['7'], ['x']],
    ['[[:alpha:][:digit:]]+', ['ab12'], ['é', '_']],
    ['[[:^alpha:]]', ['1'], ['a']],
    ['\\p{L}+\\pN', ['éß٣'], ['é-1']],
    ['\\p{Greek}+', ['αβγ'], ['abc']],
    ['\\P{Greek}', ['a'], ['α']],
    ['[^\\p{Lu}]', ['a'], ['A']],
    ['(?i)straße[a-z]+', ['STRAẞEabc', 'straßeABC'], ['strasse']],
    ['a(?i)b|c', ['aB', 'C'], ['Ab']],
    ['(?i:a)b', ['Ab'], ['aB']],
    ['(?i)a(?-i)b', ['Ab'], ['AB']],
    ['(?U)a*(?P<n>b)(?<m>c)', ['aabc'], ['ab']],
    ['^a$', ['a'], ['a\n']],
    ['(?m)a$\\n^b', ['a\nb'], ['ab']],
    ['\\Aa\\z', ['a'], []],
    ['a\\b \\bb', ['a b'], []],
    ['a\\bb', [], ['ab']],
    ['a\\Bb', ['ab'], []],
    ['\\Q.*+\\E+', ['.*++'], ['abc']],
    ['\\.\\x41\\x{1F600}\\101\\012\\0\\t', ['.A😀A\n\0\t'], []],
    ['(a|b){3}c{0}', ['aba'], ['abac']],
    ['(a*)*b', ['b', 'aaab'], ['a']],
  ];
  for (const [pattern, yes, no] of cases)
    assert.deepEqual(
      await matching(pattern, [...yes, ...no]),
      [...yes.map(() => 1), ...no.map(() => 0)],
      JSON.stringify(pattern),
    );
  for (const bad of [
    '*a',
    'a**',
    'a{2}{2}',
    'a)',
    '[a',
    '[z-a]',
    '(?=a)',
    '(?!a)',
    '(?<=a)',
    '(a)\\1',
    '\\y',
    '\\Z',
    '\\p{Nothing}',
    'a{1001}',
    'a{3,2}',
    '[[:nothing:]]',
    '\\',
    '((a{1000}){1000})',
    '(?i)*',
  ])
    await assert.rejects(matching(bad, ['a']), /RegexFullMatch pattern/, bad);
});

test('RegexFullMatch work stays linear on patterns that make a backtracking matcher exponential', async () => {
  assert.deepEqual(await matching('(a|a)*(a+)+b', ['a'.repeat(20000)]), [0]);
  assert.deepEqual(await matching(`${'('.repeat(150)}${'){1}'.repeat(150)}x`, ['x']), [1]);
});

test('TfIdfVectorizer counts skip n-grams per row and weights them by mode', async () => {
  const attrs = (mode, extra = []) => [
    p.attr('min_gram_length', 1),
    p.attr('max_gram_length', 2),
    p.attr('max_skip_count', 1),
    p.attr('mode', mode),
    p.intsAttr('ngram_counts', [0, 2]),
    p.intsAttr('ngram_indexes', [0, 1, 2, 3]),
    // 1-grams 1 and 2; 2-grams (1, 2) and (2, 2).
    p.intsAttr('pool_int64s', [1, 2, 1, 2, 2, 2]),
    ...extra,
  ];
  // Tokens 1 1 2 2: (1, 2) adjacent once, with one skip twice more; (2, 2) once.
  const x = i64([1, 1, 2, 2, 9, 9, 9, 9], [2, 4]);
  let y = await run('TfIdfVectorizer', [x], attrs('TF'), 9);
  assert.deepEqual(y.shape, [2, 4]);
  assert.deepEqual([...y.data], [2, 2, 3, 1, 0, 0, 0, 0]);
  const weights = floatsAttr('weights', [10, 20, 30, 40]);
  y = await run('TfIdfVectorizer', [i64([1, 1, 2, 2])], attrs('TFIDF', [weights]), 9);
  assert.deepEqual(y.shape, [4]);
  assert.deepEqual([...y.data], [20, 40, 90, 40]);
  y = await run('TfIdfVectorizer', [i64([1, 1, 2, 2])], attrs('IDF', [weights]), 9);
  assert.deepEqual([...y.data], [10, 20, 30, 40]);
  y = await run(
    'TfIdfVectorizer',
    [strings(['the', 'cat', 'the', 'hat'])],
    [
      p.attr('min_gram_length', 2),
      p.attr('max_gram_length', 2),
      p.attr('max_skip_count', 5),
      p.attr('mode', 'TF'),
      p.intsAttr('ngram_counts', [0, 0]),
      p.intsAttr('ngram_indexes', [3, 1]),
      stringAttr('pool_strings', ['the', 'hat', 'cat', 'sat']),
    ],
    9,
  );
  assert.deepEqual([...y.data], [0, 0, 0, 2]);
  await assert.rejects(run('TfIdfVectorizer', [strings(['a'])], attrs('TF'), 9), /pool_strings/);
});

test('DeformConv equals convolution at zero offsets and samples shifted, masked and outside positions', async () => {
  const x = f32([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);
  const w = f32([1, 1, 1, 1], [1, 1, 2, 2]);
  const zero = Array(32).fill(0);
  let y = await run('DeformConv', [x, w, f32(zero, [1, 8, 2, 2])]);
  assert.deepEqual(y.shape, [1, 1, 2, 2]);
  assert.deepEqual([...y.data], [12, 16, 24, 28]);
  // One weight sample per output: offsets (row, column) move it by fractions.
  const single = f32([1], [1, 1, 1, 1]);
  const offsets = Array(18).fill(0);
  offsets[0] = 0.5; // output (0,0) row +0.5: between 1 and 4
  offsets[9 + 1] = 0.25; // output (0,1) column +0.25: between 2 and 3
  offsets[8] = 1; // output (2,2) row +1: outside, so zero
  offsets[9 + 0] = -0.5; // output (0,0) column -0.5: half outside
  y = await run('DeformConv', [x, single, f32(offsets, [1, 2, 3, 3])]);
  assert.deepEqual([...y.data], [1.25, 2.25, 3, 4, 5, 6, 7, 8, 0]);
  const mask = f32([2, 1, 1, 1, 1, 1, 1, 1, 0.5], [1, 1, 3, 3]);
  y = await run('DeformConv', [x, single, f32(Array(18).fill(0), [1, 2, 3, 3]), f32([100]), mask]);
  assert.deepEqual([...y.data], [102, 102, 103, 104, 105, 106, 107, 108, 104.5]);
  // Two channels in two offset groups: each channel follows its own offsets.
  const two = f32([1, 2, 3, 4], [1, 2, 1, 2]);
  const depth = f32([1, 1], [2, 1, 1, 1]);
  const shift = f32([0, 0, 0, 0, 0, 0, 0, -1], [1, 4, 1, 2]);
  y = await run('DeformConv', [two, depth, shift], [p.attr('group', 2), p.attr('offset_group', 2)]);
  assert.deepEqual([...y.data], [1, 2, 3, 3]);
  // Three spatial axes with padding and stride.
  const cube = f32([1, 2, 3, 4, 5, 6, 7, 8], [1, 1, 2, 2, 2]);
  y = await run(
    'DeformConv',
    [cube, f32([1], [1, 1, 1, 1, 1]), f32([1, 1, 1], [1, 3, 1, 1, 1])],
    [p.intsAttr('strides', [2, 2, 2])],
  );
  assert.deepEqual([...y.data], [8]);
  await assert.rejects(run('DeformConv', [x, w, f32(zero.slice(0, 8), [1, 8, 1, 1])]), /offset shape/);
  await assert.rejects(run('DeformConv', [x, w, f32(zero, [1, 8, 2, 2])], [], 18), /opset/);
});

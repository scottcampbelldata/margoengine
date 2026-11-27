// Old operator-set conformance: each case is the form docs/Changelog.md of ONNX
// (https://github.com/onnx/onnx/blob/main/docs/Changelog.md) gives an operator version, with hand-worked results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

const f32 = (values, shape = [values.length]) => new OnnxTensor('float32', Float32Array.from(values), shape);
const i64 = (values, shape = [values.length]) => new OnnxTensor('int64', BigInt64Array.from(values, BigInt), shape);
const bool = (values, shape = [values.length]) => new OnnxTensor('bool', Uint8Array.from(values), shape);
const info = (name) => p.field(1, name);

async function run(version, op, values, attrs = [], outputs = 1) {
  const names = values.map((v, j) => (v === null ? '' : `x${j}`));
  const out = Array.from({ length: outputs }, (_, i) => `y${i}`);
  using model = await loadOnnx(
    p.model(p.graph([p.node(op, names, out, attrs)], names.filter(Boolean).map(info), out.map(info)), version),
  );
  const live = model.work.liveBytes;
  const result = await model.run(Object.fromEntries(values.flatMap((v, j) => (v === null ? [] : [[names[j], v]]))));
  assert.equal(model.work.liveBytes, live);
  return out.map((name) => result[name]);
}
const values = (t) => Array.from(t.data, Number);
const broadcast = p.attr('broadcast', 1);
const hint = p.intsAttr('consumed_inputs', [0]);

test('opsets 1 to 5 accept the consumed_inputs hint', async () => {
  for (const [op, expected] of [
    ['Relu', [0, 2]],
    ['Neg', [3, -2]],
    ['Abs', [3, 2]],
  ])
    assert.deepEqual(values((await run(1, op, [f32([-3, 2])], [hint]))[0]), expected);
  assert.deepEqual(values((await run(5, 'Sum', [f32([1]), f32([2])], [hint]))[0]), [3]);
  await assert.rejects(run(6, 'Relu', [f32([1])], [hint]), /consumed_inputs/);
});

test('arithmetic before opset 7 broadcasts the second operand by broadcast and axis', async () => {
  const a = f32([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [2, 3, 2]);
  const add = async (b, attrs = []) => values((await run(6, 'Add', [a, b], attrs))[0]);
  const plus = (f) => Array.from({ length: 12 }, (_, i) => i + f(Math.floor(i / 6), Math.floor(i / 2) % 3, i % 2));
  assert.deepEqual(
    await add(f32([10, 20, 30]), [broadcast, p.attr('axis', 1)]),
    plus((_, j) => [10, 20, 30][j]),
  );
  assert.deepEqual(
    await add(f32([100, 200]), [broadcast, p.attr('axis', 0)]),
    plus((i) => [100, 200][i]),
  );
  assert.deepEqual(
    await add(f32([10, 20]), [broadcast]),
    plus((_, __, k) => [10, 20][k]),
  );
  assert.deepEqual(
    await add(f32([5], [1, 1]), [broadcast]),
    plus(() => 5),
  );
  assert.deepEqual(
    await add(a),
    plus((i, j, k) => i * 6 + j * 2 + k),
  );
  await assert.rejects(add(f32([10, 20])), /broadcast=1/);
  await assert.rejects(add(f32([10, 20, 30]), [broadcast]), /contiguous run/);
  const b = f32([1, 4]);
  const x = f32([1, 2, 3, 4], [2, 2]);
  const columns = [broadcast, p.attr('axis', 0)];
  assert.deepEqual(values((await run(6, 'Equal', [x, b], columns))[0]), [1, 0, 0, 1]);
  assert.deepEqual(values((await run(6, 'Less', [x, b], columns))[0]), [0, 0, 1, 0]);
  assert.deepEqual(values((await run(6, 'Greater', [x, b], [broadcast]))[0]), [0, 0, 1, 0]);
  const truth = bool([1, 1, 0, 0], [2, 2]);
  assert.deepEqual(values((await run(1, 'And', [truth, bool([1, 0])], columns))[0]), [1, 1, 0, 0]);
  assert.deepEqual(values((await run(1, 'Xor', [truth, bool([1, 0])], [broadcast]))[0]), [0, 1, 1, 0]);
});

test('Gemm, PRelu and BatchNormalization read their old attributes', async () => {
  const identity = f32([1, 0, 0, 1], [2, 2]);
  const x = f32([1, 2, 3, 4], [2, 2]);
  const [y] = await run(6, 'Gemm', [x, identity, f32([10, 20])], [broadcast]);
  assert.deepEqual(values(y), [11, 22, 13, 24]);
  // Two channels, width two: a slope vector is per channel (axis 1), not per last-axis element.
  const [r] = await run(6, 'PRelu', [f32([-1, -2, -3, -4], [1, 2, 2]), f32([10, 100])]);
  assert.deepEqual(values(r), [-10, -20, -300, -400]);
  await assert.rejects(run(6, 'PRelu', [f32([-1, -2], [1, 2]), f32([1, 2, 3])]), /per channel/);
  const features = f32([2, 4, 6, 8], [1, 2, 2]);
  const ones = f32([1, 1, 1, 1], [2, 2]);
  const mean = f32([1, 2, 3, 4], [2, 2]);
  const [n] = await run(
    7,
    'BatchNormalization',
    [features, ones, f32([0, 0, 0, 0], [2, 2]), mean, ones],
    [p.attr('spatial', 0), p.floatAttr('epsilon', 0)],
  );
  assert.deepEqual(values(n), [1, 2, 3, 4]);
});

test('Cast, Pad, Reshape, Tile and Split read their first forms', async () => {
  const [c] = await run(1, 'Cast', [f32([1.7, -2.2])], [p.attr('to', 'INT32')]);
  assert.equal(c.dtype, 'int32');
  assert.deepEqual(values(c), [1, -2]);
  await assert.rejects(run(1, 'Cast', [f32([1])], [p.attr('to', 'int33')]), /destination type/);
  const [pad] = await run(1, 'Pad', [f32([1, 2], [1, 2])], [p.intsAttr('paddings', [0, 1, 0, 0])]);
  assert.deepEqual(
    [pad.shape, values(pad)],
    [
      [1, 3],
      [0, 1, 2],
    ],
  );
  const [shaped] = await run(1, 'Reshape', [f32([1, 2, 3, 4])], [p.intsAttr('shape', [2, -1]), hint]);
  assert.deepEqual(shaped.shape, [2, 2]);
  const x = f32([1, 2, 3, 4], [2, 2]);
  const [t] = await run(1, 'Tile', [x, i64([2], []), i64([1], [])]);
  assert.deepEqual(
    [t.shape, values(t)],
    [
      [2, 4],
      [1, 2, 1, 2, 3, 4, 3, 4],
    ],
  );
  const parts = await run(1, 'Split', [f32([1, 2, 3, 4]), f32([1, 3])], [p.attr('axis', 0)], 2);
  assert.deepEqual(parts.map(values), [[1], [2, 3, 4]]);
});

test('LpPool takes the float p of opset 1', async () => {
  const x = f32([3, 4], [1, 1, 2]);
  const attrs = [p.intsAttr('kernel_shape', [2]), p.floatAttr('p', 2)];
  assert.deepEqual(values((await run(1, 'LpPool', [x], attrs))[0]), [5]);
  assert.deepEqual(values((await run(1, 'GlobalLpPool', [x], [p.floatAttr('p', 1)]))[0]), [7]);
});

test('recurrent operators before opset 7 accept output_sequence', async () => {
  const x = f32([1], [1, 1, 1]);
  const w = f32([1], [1, 1, 1]);
  for (const [op, gates] of [
    ['RNN', 1],
    ['GRU', 3],
    ['LSTM', 4],
  ]) {
    const weights = f32(Array(gates).fill(0), [1, gates, 1]);
    const [y] = await run(1, op, [x, weights, weights], [p.attr('hidden_size', 1), p.attr('output_sequence', 1)]);
    assert.equal(y.shape.at(-1), 1, op);
  }
  assert.deepEqual(w.shape, [1, 1, 1]);
});

test('Scan opset 8 runs each batch to its own length', async () => {
  const inside = p.graph(
    [p.node('Add', ['sum', 'item'], ['next']), p.node('Identity', ['next'], ['seen'])],
    [info('sum'), info('item')],
    [info('next'), info('seen')],
  );
  const body = p.message(p.field(1, 'body'), p.field(20, 5), p.field(6, inside));
  const items = i64([1, 2, 3, 10, 20, 30], [2, 3]);
  for (const [directions, seen] of [
    [[0], [1, 3, 6, 110, 130]],
    [[1], [3, 5, 6, 120, 130]],
  ]) {
    const attrs = [body, p.attr('num_scan_inputs', 1), p.intsAttr('directions', directions)];
    const [last, all] = await run(8, 'Scan', [i64([3, 2]), i64([0, 100]), items], attrs, 2);
    assert.deepEqual(values(last), [6, 130]);
    assert.deepEqual(all.shape, [2, 3]);
    // The third step of the second batch is past its length: ONNX leaves it undefined.
    assert.deepEqual(values(all).slice(0, 5), seen);
  }
  const attrs = [body, p.attr('num_scan_inputs', 1)];
  const [whole] = await run(8, 'Scan', [null, i64([0, 100]), items], attrs, 2);
  assert.deepEqual(values(whole), [6, 160]);
  await assert.rejects(run(8, 'Scan', [i64([4, 1]), i64([0, 0]), items], attrs, 2), /sequence_lens/);
});

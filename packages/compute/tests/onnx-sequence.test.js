import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

// Expected values come from the operator formulas at https://onnx.ai/onnx/operators/, worked here in plain loops.
const f32 = (values, shape = [values.length]) => new OnnxTensor('float32', Float32Array.from(values), shape);
const i64 = (values, shape = [values.length]) => new OnnxTensor('int64', BigInt64Array.from(values, BigInt), shape);
const bool = (values, shape = [values.length]) => new OnnxTensor('bool', Uint8Array.from(values), shape);
const floatAttr = (name, value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  // AttributeProto field 2 is a 32-bit float (wire type 5).
  return p.concat(p.field(1, name), p.field(20, 1), p.varint(2 * 8 + 5), bytes);
};
async function run(op, values, attrs = [], outputs = 1, version = 28) {
  const names = values.map((v, j) => (v === null ? '' : `x${j}`));
  const out = Array.from({ length: outputs }, (_, j) => `y${j}`);
  const info = (name) => p.field(1, name);
  using model = await loadOnnx(
    p.model(p.graph([p.node(op, names, out, attrs)], names.filter(Boolean).map(info), out.map(info)), version),
  );
  const persistentBytes = model.work.liveBytes;
  const result = await model.run(Object.fromEntries(values.flatMap((v, j) => (v === null ? [] : [[names[j], v]]))));
  assert.equal(model.work.liveBytes, persistentBytes);
  return out.map((name) => result[name]);
}
function close(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  [...actual].forEach((v, j) =>
    assert.ok(Math.abs(v - expected[j]) <= tolerance, `element ${j}: ${v} vs ${expected[j]}`),
  );
}
const softmax = (scores) => {
  const largest = Math.max(...scores);
  if (largest === -Infinity) return scores.map(() => 0);
  const raised = scores.map((s) => Math.exp(s - largest));
  const sum = raised.reduce((a, b) => a + b, 0);
  return raised.map((s) => s / sum);
};
/** Attention of one head over rows of q, k and v, hiding the keys `allowed` refuses. */
function attend(q, k, v, allowed = () => true) {
  const scale = 1 / Math.sqrt(k[0].length);
  return q.flatMap((row, i) => {
    const scores = k.map((key, j) => (allowed(i, j) ? scale * (row[0] * key[0] + row[1] * key[1]) : -Infinity));
    const weights = softmax(scores);
    return v[0].map((_, d) => weights.reduce((sum, w, j) => sum + w * v[j][d], 0));
  });
}
const Q = [
  [1, 0],
  [0, 2],
];
const K = [
  [1, 1],
  [2, 0],
];
const V = [
  [1, 2],
  [3, 4],
];
const q = f32(Q.flat(), [1, 1, 2, 2]);
const k = f32(K.flat(), [1, 1, 2, 2]);
const v = f32(V.flat(), [1, 1, 2, 2]);

test('Attention applies scale, causal and boolean masks and zeroes a query that sees no key', async () => {
  let [y] = await run('Attention', [q, k, v]);
  assert.deepEqual(y.shape, [1, 1, 2, 2]);
  close(y.data, attend(Q, K, V));
  [y] = await run('Attention', [q, k, v], [p.attr('is_causal', 1)], 1, 23);
  close(
    y.data,
    attend(Q, K, V, (i, j) => j <= i),
  );
  const [masked, , , weights] = await run(
    'Attention',
    [q, k, v, bool([0, 0, 1, 1], [2, 2])],
    [p.attr('qk_matmul_output_mode', 3)],
    4,
  );
  close(masked.data, [0, 0, ...attend(Q, K, V).slice(2)]);
  close(weights.data.slice(0, 2), [0, 0]);
  [y] = await run('Attention', [q, k, v, f32([0, -Infinity], [1, 2])]);
  close(y.data, [1, 2, 1, 2]);
  // A shorter last mask axis hides the keys past it (opset 24); length 1 broadcasts.
  [y] = await run('Attention', [q, k, v, bool([1, 0], [2, 1])]);
  close(y.data, [...attend(Q, K, V).slice(0, 2), 0, 0]);
  [y] = await run('Attention', [q, k, v], [p.attr('left_window_size', 0), p.attr('right_window_size', 0)]);
  close(y.data, [1, 2, 3, 4]);
  await assert.rejects(run('Attention', [q, k, v], [p.attr('left_window_size', 0)], 1, 24), /left_window_size/);
});

test('Attention packs 3-D heads, shares grouped heads, keeps a key cache and honours nonpad lengths', async () => {
  const packed = (rows) => f32(rows.flat(), [1, rows.length, 2]);
  let [y] = await run(
    'Attention',
    [f32([1, 0, 0, 2, 0, 2, 1, 0], [1, 2, 4]), packed(K), packed(V)],
    [p.attr('q_num_heads', 2), p.attr('kv_num_heads', 1)],
  );
  assert.deepEqual(y.shape, [1, 2, 4]);
  const first = attend(Q, K, V);
  const second = attend([Q[1], Q[0]], K, V);
  close(y.data, [...first.slice(0, 2), ...second.slice(0, 2), ...first.slice(2), ...second.slice(2)]);
  const one = f32(Q[1], [1, 1, 1, 2]);
  const [out, key, value] = await run(
    'Attention',
    [one, f32(K[1], [1, 1, 1, 2]), f32(V[1], [1, 1, 1, 2]), null, f32(K[0], [1, 1, 1, 2]), f32(V[0], [1, 1, 1, 2])],
    [p.attr('is_causal', 1)],
    3,
  );
  close(out.data, attend([Q[1]], K, V));
  assert.deepEqual(key.shape, [1, 1, 2, 2]);
  assert.deepEqual([...key.data], K.flat());
  assert.deepEqual([...value.data], V.flat());
  [y] = await run('Attention', [one, k, v, null, null, null, i64([1])], [p.attr('is_causal', 1)]);
  close(y.data, [1, 2]);
  [y] = await run('Attention', [q, k, v], [floatAttr('scale', 2), floatAttr('softcap', 1)]);
  const capped = Q.flatMap((row) => {
    const w = softmax(K.map((entry) => Math.tanh(2 * (row[0] * entry[0] + row[1] * entry[1]))));
    return [w[0] * 1 + w[1] * 3, w[0] * 2 + w[1] * 4];
  });
  close(y.data, capped);
});

test('RotaryEmbedding rotates halves or interleaved pairs by cached angles', async () => {
  const x = f32([1, 2, 3, 4], [1, 1, 4]);
  const heads = p.attr('num_heads', 1);
  const cos = f32([0, 0.6], [1, 1, 2]);
  const sin = f32([1, 0.8], [1, 1, 2]);
  let [y] = await run('RotaryEmbedding', [x, cos, sin], [heads]);
  close(y.data, [-3, 0.6 * 2 - 0.8 * 4, 1, 0.8 * 2 + 0.6 * 4]);
  [y] = await run('RotaryEmbedding', [x, cos, sin], [heads, p.attr('interleaved', 1)]);
  close(y.data, [-2, 1, 0.6 * 3 - 0.8 * 4, 0.8 * 3 + 0.6 * 4]);
  [y] = await run(
    'RotaryEmbedding',
    [f32([1, 2, 3, 4], [1, 1, 1, 4]), f32([1, 0], [2, 1]), f32([0, 1], [2, 1]), i64([1], [1, 1])],
    [p.attr('rotary_embedding_dim', 2)],
  );
  close(y.data, [-2, 1, 3, 4]);
  await assert.rejects(run('RotaryEmbedding', [x, cos, sin]), /num_heads/);
});

test('TensorScatter writes each batch at its index, linearly or around the ring', async () => {
  const past = f32(Array(8).fill(0), [2, 4, 1]);
  const update = f32([1, 2, 3, 4], [2, 2, 1]);
  let [y] = await run('TensorScatter', [past, update, i64([1, 2])]);
  assert.deepEqual([...y.data], [0, 1, 2, 0, 0, 0, 3, 4]);
  [y] = await run('TensorScatter', [past, update]);
  assert.deepEqual([...y.data], [1, 2, 0, 0, 3, 4, 0, 0]);
  [y] = await run('TensorScatter', [past, update, i64([3, -1])], [p.attr('mode', 'circular')]);
  assert.deepEqual([...y.data], [2, 0, 0, 1, 4, 0, 0, 3]);
  await assert.rejects(run('TensorScatter', [past, update, i64([3, 0])]), /inside the cache/);
});

test('CausalConvWithState continues across chunks exactly as over the whole sequence', async () => {
  const weight = f32([1, 10], [1, 1, 2]);
  const [whole] = await run('CausalConvWithState', [f32([1, 2, 3, 4], [1, 1, 4]), weight], [], 2, 27);
  assert.deepEqual([...whole.data], [10, 21, 32, 43]);
  const [head, state] = await run('CausalConvWithState', [f32([1, 2], [1, 1, 2]), weight], [], 2, 27);
  const [tail] = await run('CausalConvWithState', [f32([3, 4], [1, 1, 2]), weight, null, state], [], 2, 27);
  assert.deepEqual([...head.data, ...tail.data], [...whole.data]);
  const [silu] = await run(
    'CausalConvWithState',
    [f32([2], [1, 1, 1]), f32([1], [1, 1, 1]), f32([-1])],
    [p.attr('activation', 'silu')],
    1,
    27,
  );
  close(silu.data, [1 / (1 + Math.exp(-1))]);
});

test('LinearAttention runs each update rule as the sequential recurrence', async () => {
  const T = 3;
  const query = [1, 0.5, -1, 0.25, 2, 1];
  const key = [0.5, 0.5, 1, 0, 0, 1];
  const value = [2, -1, 0.5];
  const decay = [-0.5, -0.1, -1];
  const beta = [0.5, 0.25, 1];
  const heads = [p.attr('q_num_heads', 1), p.attr('kv_num_heads', 1)];
  for (const rule of ['linear', 'gated', 'delta', 'gated_delta']) {
    const gated = rule.startsWith('gated');
    const delta = rule.endsWith('delta');
    const state = [0, 0];
    const expected = [];
    for (let t = 0; t < T; t++) {
      if (gated) state.forEach((s, i) => (state[i] = Math.exp(decay[t]) * s));
      const k2 = key.slice(2 * t, 2 * t + 2);
      const u = delta ? beta[t] * (value[t] - (state[0] * k2[0] + state[1] * k2[1])) : value[t];
      state.forEach((s, i) => (state[i] = s + k2[i] * u));
      expected.push((query[2 * t] * state[0] + query[2 * t + 1] * state[1]) / Math.SQRT2);
    }
    const inputs = [f32(query, [1, T, 2]), f32(key, [1, T, 2]), f32(value, [1, T, 1]), null];
    inputs.push(gated ? f32(decay, [1, T, 1]) : null, delta ? f32(beta, [1, T, 1]) : null);
    const [y, present] = await run('LinearAttention', inputs, [...heads, p.attr('update_rule', rule)], 2, 27);
    close(y.data, expected);
    assert.deepEqual(present.shape, [1, 1, 2, 1]);
    close(present.data, state);
  }
  const unit = f32([1], [1, 1, 1]);
  await assert.rejects(run('LinearAttention', [unit, unit, unit], heads, 2, 27), /decay/);
});

test('the 6-bit floats pack as a bit stream, cast with saturation and load both payload forms', async () => {
  // E3M2 codes: 1.0 is 0x0c, 24 is 0x1e, the maximum 28 is 0x1f, -1.0 is 0x2c.
  const [y] = await run('Cast', [f32([1, 25, 1000, -1])], [p.attr('to', 28)]);
  assert.equal(y.dtype, 'float6e3m2');
  const codes = [0x0c, 0x1e, 0x1f, 0x2c];
  const stream = codes.reduce((bits, code, j) => bits | (code << (6 * j)), 0);
  assert.deepEqual([...y.data], [stream & 255, (stream >> 8) & 255, (stream >> 16) & 255]);
  const [back] = await run('Cast', [y], [p.attr('to', 1)]);
  assert.deepEqual([...back.data], [1, 24, 28, -1]);
  const [moved] = await run('Gather', [y, i64([3, 1])]);
  const pair = 0x2c | (0x1e << 6);
  assert.deepEqual([...moved.data], [pair & 255, pair >> 8]);
  const initializer = p.message(
    p.field(1, 4),
    p.field(2, 28),
    p.field(8, 'w'),
    p.field(5, p.concat(...codes.map((c) => p.varint(c)))),
  );
  using model = await loadOnnx(
    p.model(p.graph([p.node('Identity', ['w'], ['y'])], [], [p.field(1, 'y')], [initializer]), 28),
  );
  assert.deepEqual([...(await model.run({})).y.data], [...y.data]);
  await assert.rejects(run('Cast', [f32([1])], [p.attr('to', 29)]), /element type 29/);
});

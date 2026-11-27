import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

// Expected values are worked by hand from the operator formulas at https://onnx.ai/onnx/operators/.
const KINDS = { float32: 1, float16: 10, complex64: 14, float8e4m3fn: 17, int4: 22, float4e2m1: 23, int2: 26 };
const f32 = (values, shape = [values.length]) => new OnnxTensor('float32', Float32Array.from(values), shape);
const u8 = (values, shape = [values.length]) => new OnnxTensor('uint8', Uint8Array.from(values), shape);
const s8 = (values, shape = [values.length]) => new OnnxTensor('int8', Int8Array.from(values), shape);
const i32 = (values, shape = [values.length]) => new OnnxTensor('int32', Int32Array.from(values), shape);
const raw = (dtype, bytes, shape) => new OnnxTensor(dtype, Uint8Array.from(bytes), shape);
const one = (dtype) => (value) =>
  dtype === 'float32' ? f32([value], []) : dtype === 'uint8' ? u8([value], []) : s8([value], []);
const float = one('float32');
async function run(op, values, attrs = [], outputs = 1, version = 25) {
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
const values = async (...args) => {
  const [y] = await run(...args);
  return [...y.data];
};

test('QuantizeLinear rounds ties to even, adds the zero point and saturates', async () => {
  const [y] = await run('QuantizeLinear', [f32([0, 2, 3, 1000, -254, -1000]), float(2), u8([128], [])]);
  assert.equal(y.dtype, 'uint8');
  assert.deepEqual([...y.data], [128, 129, 130, 255, 1, 0]);
  assert.deepEqual(await values('QuantizeLinear', [f32([-1, 2.5, 3.5]), float(1)]), [0, 2, 4]);
  assert.deepEqual(
    await values('QuantizeLinear', [f32([2, 5, 8, -100], [2, 2]), f32([2, 4]), s8([0, 10])], [p.attr('axis', 0)]),
    [1, 2, 12, -15],
  );
  assert.deepEqual(
    await values('QuantizeLinear', [f32([1, 2, 3, 4]), f32([1, 2])], [p.attr('axis', 0), p.attr('block_size', 2)]),
    [1, 2, 2, 2],
  );
  const [nibbles] = await run('QuantizeLinear', [f32([-100, -1.5, 0.5, 100]), float(1), raw('int4', [0], [])]);
  assert.equal(nibbles.dtype, 'int4');
  assert.deepEqual([...nibbles.data], [0xe8, 0x70]);
  const [crumbs] = await run('QuantizeLinear', [f32([-9, -1, 0, 9]), float(1)], [p.attr('output_dtype', KINDS.int2)]);
  assert.deepEqual([...crumbs.data], [0b01_00_11_10]);
  const zero = raw('float8e4m3fn', [0], []);
  assert.deepEqual(await values('QuantizeLinear', [f32([1e6, 1]), float(1), zero], [], 1, 19), [0x7e, 0x38]);
  assert.deepEqual(
    await values('QuantizeLinear', [f32([1e6, 1]), float(1), zero], [p.attr('saturate', 0)], 1, 19),
    [0x7f, 0x38],
  );
  await assert.rejects(run('QuantizeLinear', [f32([1]), float(1), raw('int4', [0], [])], [], 1, 19), /opset/);
  await assert.rejects(run('QuantizeLinear', [f32([1, 2]), f32([1, 2])], [], 1, 12), /opset 13/);
  await assert.rejects(run('QuantizeLinear', [f32([1, 2]), float(1), s8([0, 1])]), /shape/);
});

test('DequantizeLinear subtracts the zero point, scales, and types its output by scale or output_dtype', async () => {
  const [y] = await run('DequantizeLinear', [u8([0, 3, 128, 255]), float(2), u8([128], [])]);
  assert.equal(y.dtype, 'float32');
  assert.deepEqual([...y.data], [-256, -250, 0, 254]);
  assert.deepEqual(await values('DequantizeLinear', [raw('int4', [0xe8, 0x70], [4]), float(0.5)]), [-4, -1, 0, 3.5]);
  assert.deepEqual(
    await values('DequantizeLinear', [s8([1, 2, 3, 4], [2, 2]), f32([10, 100])], [p.attr('axis', 1)]),
    [10, 200, 30, 400],
  );
  assert.deepEqual(await values('DequantizeLinear', [i32([-3, 7]), float(3)]), [-9, 21]);
  const [half] = await run('DequantizeLinear', [u8([3]), new OnnxTensor('float16', Uint16Array.of(0x3c00), [])]);
  assert.equal(half.dtype, 'float16');
  assert.deepEqual([...half.data], [0x4200]);
  const [wide] = await run('DequantizeLinear', [u8([3]), float(1)], [p.attr('output_dtype', KINDS.float16)]);
  assert.deepEqual([...wide.data], [0x4200]);
  await assert.rejects(run('DequantizeLinear', [i32([1]), float(1), i32([1], [])]), /zero zero point/);
  await assert.rejects(run('DequantizeLinear', [raw('int2', [0], [4]), float(1)], [], 1, 21), /opset/);
});

test('DynamicQuantizeLinear derives scale and zero point from a range that includes zero', async () => {
  const [y, scale, zero] = await run('DynamicQuantizeLinear', [f32([-1, 0, 4])], [], 3);
  assert.equal(scale.data[0], Math.fround(5 / 255));
  assert.deepEqual([...zero.data], [51]);
  assert.deepEqual([...y.data], [0, 51, 255]);
  const [, flat] = await run('DynamicQuantizeLinear', [f32([0, 0])], [], 3);
  assert.equal(flat.data[0], 1);
});

test('MatMulInteger and ConvInteger accumulate exact int32 from centered inputs', async () => {
  const a = u8([1, 2, 3, 4], [2, 2]);
  const b = s8([1, -1], [2, 1]);
  let [y] = await run('MatMulInteger', [a, b, u8([1], [])]);
  assert.equal(y.dtype, 'int32');
  assert.deepEqual([...y.data], [-1, -1]);
  assert.deepEqual(await values('MatMulInteger', [a, b, u8([1, 3])]), [-1, -1]);
  assert.deepEqual(await values('MatMulInteger', [a, b, u8([1, 3], [2, 1]), s8([1], [1, 1])]), [-2, -2]);
  const x = u8([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);
  const w = u8([1, 1, 1, 1], [1, 1, 2, 2]);
  [y] = await run('ConvInteger', [x, w, u8([1], [])]);
  assert.deepEqual(y.shape, [1, 1, 2, 2]);
  assert.deepEqual([...y.data], [8, 12, 20, 24]);
  assert.deepEqual(
    await values('ConvInteger', [x, u8([3, 3, 3, 3], [1, 1, 2, 2]), u8([1], []), u8([2])]),
    [8, 12, 20, 24],
  );
  await assert.rejects(run('ConvInteger', [f32([1], [1, 1, 1]), f32([1], [1, 1, 1])]), /int8 or uint8/);
});

test('QLinearConv and QLinearMatMul requantize with per-line scales', async () => {
  const x = u8([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 3, 3]);
  const w = u8([1, 1, 1, 1], [1, 1, 2, 2]);
  const inputs = [x, float(0.5), u8([1], []), w, float(0.5), u8([0], []), float(1), u8([10], []), i32([4])];
  assert.deepEqual(await values('QLinearConv', inputs), [13, 14, 16, 17]);
  inputs[6] = float(0.01);
  assert.deepEqual(await values('QLinearConv', inputs), [255, 255, 255, 255]);
  const a = s8([1, 2, 3, 4], [2, 2]);
  const identity = s8([1, 0, 0, 1], [2, 2]);
  const z = s8([0], []);
  const run1 = (as, bs, ys = float(1)) => values('QLinearMatMul', [a, as, z, identity, bs, z, ys, z]);
  assert.deepEqual(await run1(float(1), f32([2, 3])), [2, 6, 6, 12]);
  assert.deepEqual(await run1(f32([1, 10]), f32([2, 3])), [2, 6, 60, 120]);
  assert.deepEqual(await run1(f32([1, 100], [2, 1]), f32([2, 3], [1, 2])), [2, 6, 127, 127]);
  const e = (bytes, shape) => raw('float8e4m3fn', bytes, shape);
  // 0x38 is 1.0 and 0x40 is 2.0 in E4M3FN; the product 2.0 stores as 0x40.
  const [float8] = await run('QLinearMatMul', [
    e([0x38], [1, 1]),
    float(1),
    e([0], []),
    e([0x40], [1, 1]),
    float(1),
    e([0], []),
    float(1),
    e([0], []),
  ]);
  assert.deepEqual([...float8.data], [0x40]);
  await assert.rejects(run('QLinearMatMul', [a, f32([1, 2, 3]), z, identity, float(1), z, float(1), z]), /per row/);
});

test('Cast converts the low-precision types with saturate, round_mode and packed storage', async () => {
  const to = (kind, ...more) => [p.attr('to', kind), ...more];
  assert.deepEqual(await values('Cast', [f32([-9.5, -1.5, 2.5, 17])], to(KINDS.int4)), [0xe6, 0x12]);
  assert.deepEqual(await values('Cast', [f32([1e6, -1e6])], to(KINDS.float8e4m3fn)), [0x7e, 0xfe]);
  assert.deepEqual(
    await values('Cast', [f32([1e6, -1e6])], to(KINDS.float8e4m3fn, p.attr('saturate', 0))),
    [0x7f, 0xff],
  );
  assert.deepEqual(await values('Cast', [f32([5])], to(24)), [130]);
  assert.deepEqual(await values('Cast', [f32([5])], to(24, p.attr('round_mode', 'down'))), [129]);
  assert.deepEqual(await values('Cast', [f32([2.5, -7])], to(KINDS.float4e2m1)), [0xf4]);
  assert.deepEqual(await values('Cast', [raw('int2', [0b01_00_11_10], [4])], to(1)), [-2, -1, 0, 1]);
  assert.deepEqual(await values('Cast', [raw('float8e5m2', [0x3c, 0x7c, 0xfd], [3])], to(1)), [1, Infinity, NaN]);
  await assert.rejects(run('Cast', [f32([1])], to(KINDS.complex64)), /complex/);
  await assert.rejects(run('Cast', [f32([1])], to(1, p.attr('saturate', 0)), 1, 13), /saturate/);
  await assert.rejects(run('BitCast', [raw('int4', [1], [2])], to(KINDS.int2), 1, 26), /bit widths/);
});

test('complex and low-precision tensors move without conversion and reject arithmetic', async () => {
  const z = new OnnxTensor('complex64', Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8), [2, 2]);
  const [t] = await run('Transpose', [z]);
  assert.equal(t.dtype, 'complex64');
  assert.deepEqual([...t.data], [1, 2, 5, 6, 3, 4, 7, 8]);
  const [g] = await run('Gather', [z, new OnnxTensor('int64', BigInt64Array.of(1n), [1])]);
  assert.deepEqual([...g.data], [5, 6, 7, 8]);
  const wide = new OnnxTensor('complex128', Float64Array.of(1, -1), [1]);
  assert.deepEqual(await values('Concat', [wide, wide], [p.attr('axis', 0)]), [1, -1, 1, -1]);
  for (const op of ['Add', 'Pad', 'ReduceSum'])
    await assert.rejects(run(op, op === 'ReduceSum' ? [z] : [z, z]), /complex|expects|attribute/);
  const f8 = raw('float8e4m3fn', [0x38, 0x40], [2]);
  assert.deepEqual(await values('Reshape', [f8, new OnnxTensor('int64', BigInt64Array.of(2n, 1n), [2])]), [0x38, 0x40]);
  await assert.rejects(run('Add', [f8, f8]), /Cast or DequantizeLinear/);
  const pairs = raw('int2', [0b01_00_11_10, 0b01], [5]);
  const [flip] = await run('Gather', [pairs, new OnnxTensor('int64', BigInt64Array.of(4n, 0n), [2])]);
  assert.deepEqual([...flip.data], [0b10_01]);
});

test('typed protobuf payloads of the new element types load as onnx.proto packs them', async () => {
  const typed = (kind, count, field, entries) =>
    p.message(p.field(1, count), p.field(2, kind), p.field(8, 'w'), p.field(field, entries));
  const floats = (list) => new Uint8Array(Float32Array.from(list).buffer);
  for (const [kind, count, field, payload, expected] of [
    [17, 2, 5, p.concat(p.varint(0x38), p.varint(0x40)), [0x38, 0x40]],
    [26, 5, 5, p.concat(p.varint(0x4e), p.varint(1)), [0x4e, 1]],
    [23, 3, 5, p.concat(p.varint(0x21), p.varint(3)), [0x21, 3]],
    [14, 1, 4, floats([1.5, -2]), [1.5, -2]],
  ]) {
    const graph = p.graph(
      [p.node('Identity', ['w'], ['y'])],
      [],
      [p.field(1, 'y')],
      [typed(kind, count, field, payload)],
    );
    using model = await loadOnnx(p.model(graph, 25));
    const { y } = await model.run({});
    assert.deepEqual([...y.data], expected, `element type ${kind}`);
  }
});

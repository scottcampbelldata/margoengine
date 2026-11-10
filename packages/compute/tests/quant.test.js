import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { quantize, quantizedTensor, quantizedMatmul, quantizedConv2d } from '@margoengine/compute/quant';
import { quantCases } from './quant-cases.js';

test('CPU async inference snapshots output parameters and bias before yielding', { timeout: 30000 }, async () => {
  using c = await createCompute({ backend: 'cpu' });
  using a = quantizedTensor(c, new Int8Array([2]), [1, 1], { scale: 1 });
  using b = quantizedTensor(c, new Int8Array([3]), [1, 1], { scale: 1 });
  const output = { scale: 1, zeroPoint: 0 },
    bias = new Int32Array([1]);
  const pending = quantizedMatmul(a, b, { output, bias });
  output.scale = 2;
  output.zeroPoint = 100;
  bias[0] = 50;
  using y = await pending;
  assert.deepEqual([...(await y.read())], [7]);
  assert.deepEqual([...(await y.dequantize())], [7]);
});

test('int8 CPU contractions agree with independent float64 reference and error bound', {
  timeout: 120000,
}, async () => {
  using c = await createCompute({ backend: 'cpu' });
  assert.ok((await quantCases(c)) > 1000);
});

test('quantization validates parameters, shapes, accumulation, context, disposal and cancellation', {
  timeout: 30000,
}, async () => {
  using c = await createCompute({ backend: 'cpu' });
  using other = await createCompute({ backend: 'cpu' });
  const make = (shape = [2, 2], q = { scale: 1 }) =>
    quantizedTensor(c, new Int8Array(shape.reduce((a, b) => a * b, 1)), shape, q);
  for (const q of [
    { scale: 0 },
    { scale: Infinity },
    { scale: 1e-50 },
    { scale: 1, zeroPoint: 128 },
    { scale: [1, 2] },
    { scale: [1], axis: 2 },
    { scale: [1], zeroPoint: [0, 0] },
  ])
    assert.throws(() => make([1], q), RangeError);
  assert.throws(() => quantize(c, [NaN], [1], { scale: 1 }), RangeError);
  assert.throws(() => quantize(c, [1], [-1], { scale: 1 }), RangeError);
  assert.throws(() => quantizedTensor(c, [1], [1], { scale: 1 }), TypeError);
  assert.throws(() => quantizedTensor(c, new Int8Array([1]), [2], { scale: 1 }), RangeError);
  using a = make();
  using b = make();
  using wrong = quantizedTensor(other, new Int8Array(4), [2, 2], { scale: 1 });
  await assert.rejects(quantizedMatmul(a, wrong, { output: { scale: 1 } }), (e) => e.code === 'state');
  await assert.rejects(quantizedMatmul(a, b, { output: { scale: 1, axis: 0 } }), RangeError);
  await assert.rejects(quantizedMatmul(a, b, { output: { scale: 1 }, bias: new Int32Array([1]) }), RangeError);
  using badInner = make([3, 2]);
  await assert.rejects(quantizedMatmul(a, badInner, { output: { scale: 1 } }), RangeError);
  using axis = make([2, 2], { scale: [1, 1], axis: 1 });
  await assert.rejects(quantizedMatmul(axis, b, { output: { scale: 1 } }), RangeError);
  using bigA = make([1, 33026], { scale: 1, zeroPoint: -128 });
  using bigB = make([33026, 1], { scale: 1, zeroPoint: -128 });
  await assert.rejects(quantizedMatmul(bigA, bigB, { output: { scale: 1 } }), /overflow/);
  using input = make([1, 2, 3, 3]);
  using weights = make([2, 1, 2, 2]);
  for (const opts of [
    { groups: 0 },
    { groups: 3 },
    { stride: 0 },
    { dilation: [1] },
    { padding: [-1, 0] },
    { padding: 'unknown' },
  ])
    await assert.rejects(quantizedConv2d(input, weights, { output: { scale: 1 }, ...opts }), RangeError);
  const controller = new AbortController();
  controller.abort(new Error('cancel quant'));
  await assert.rejects(quantizedMatmul(a, b, { output: { scale: 1 }, signal: controller.signal }), /cancel quant/);
  await assert.rejects(a.read({ signal: controller.signal }), /cancel quant/);
  const scale = [0.25, 0.5],
    zeroPoint = [1, 2],
    data = new Int8Array([3, 4]);
  using snapshot = quantizedTensor(c, data, [2], { scale, zeroPoint, axis: 0 });
  scale[0] = 10;
  zeroPoint[0] = 100;
  data[0] = 127;
  assert.deepEqual([...(await snapshot.dequantize())], [0.5, 1]);
  a.dispose();
  a.dispose();
  await assert.rejects(quantizedMatmul(a, b, { output: { scale: 1 } }), (e) => e.code === 'disposed');
});

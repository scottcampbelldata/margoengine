import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { LineBatch, LineBatches, MAX_BATCH_SEGMENTS } from '../dist/batch.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig({ samples = 1, maxBufferSize } = {}) {
  const gpu = mockGPU(),
    batches = new LineBatches(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  if (maxBufferSize) gpu.device.limits.maxBufferSize = maxBufferSize;
  camera.update(1, true);
  batches.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } });
  const run = passes(batches);
  return {
    gpu,
    batches,
    frame: () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: samples } },
        }),
      ),
  };
}
const two = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0];
const end = (batch, segment, which) =>
  Array.from(new Float32Array(batch.data, segment * 32 + which * 16, 3));
const colour = (batch, segment, which) =>
  Array.from(new Uint8Array(batch.data, segment * 32 + which * 16 + 12, 4));
const draws = (log) => log.filter((e) => e[0] === 'pass.draw');
const writes = (log, size) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === size * 2);

test('segments pack as two ends of position and rgba8, white by default', () => {
  const batch = new LineBatch({ positions: two });
  assert.equal(batch.count, 2);
  assert.equal(batch.data.byteLength, 64);
  assert.deepEqual(end(batch, 1, 0), [2, 0, 0]);
  assert.deepEqual(end(batch, 1, 1), [3, 0, 0]);
  assert.deepEqual(colour(batch, 0, 1), [255, 255, 255, 255]);
});

test('indices share points, and colours run per point or per segment, sRGB encoded', () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0],
    batch = new LineBatch({ positions, indices: [0, 1, 1, 2], colors: [1, 0, 0, 0, 1, 0, 0, 0, 0.5] });
  assert.deepEqual(end(batch, 1, 0), [1, 0, 0]);
  assert.deepEqual(end(batch, 1, 1), [1, 1, 0]);
  assert.deepEqual(colour(batch, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(colour(batch, 1, 0), [0, 255, 0, 255]);
  assert.deepEqual(colour(batch, 1, 1), [0, 0, 188, 255], 'linear 0.5 encodes to 188');
  const perSegment = new LineBatch({ positions: two, colors: [1, 0, 0, 0.5, 0, 1, 0, 1] });
  assert.deepEqual(colour(perSegment, 0, 1), [255, 0, 0, 128]);
  assert.deepEqual(colour(perSegment, 1, 0), [0, 255, 0, 255]);
  const perPoint = new LineBatch({ positions: two, colors: new Array(12).fill(1) });
  assert.deepEqual(colour(perPoint, 1, 1), [255, 255, 255, 255]);
});

test('one draw of 6 vertices per batch, instanced on a 32-byte vertex buffer', () => {
  const { batches, frame } = rig();
  batches.add(new LineBatch({ positions: two }));
  const log = frame();
  assert.deepEqual(draws(log).map((e) => [e[1], e[2]]), [[6, 2]]);
  const pipeline = log.find((e) => e[0] === 'renderPipeline')[2];
  assert.equal(pipeline.vertex.buffers[0].arrayStride, 32);
  assert.equal(pipeline.vertex.buffers[0].stepMode, 'instance');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.deepEqual(batches.stats, { batches: 1, segments: 2, drawCalls: 1 });
  assert.equal(writes(log, 64).length, 1, 'the data goes up once');
  assert.equal(writes(frame(), 64).length, 0, 'a steady frame uploads nothing');
});

test('a batch past maxBufferSize splits into one draw per buffer', () => {
  const { batches, frame } = rig({ maxBufferSize: 64 }),
    positions = new Float32Array(5 * 6);
  batches.add(new LineBatch({ positions }));
  const log = frame();
  assert.deepEqual(draws(log).map((e) => e[2]), [2, 2, 1]);
  assert.equal(log.filter((e) => e[0] === 'pass.setVertexBuffer').length, 3);
  assert.equal(batches.stats.drawCalls, 3);
});

test('updateSegments uploads only its run, across buffers too', () => {
  const { batches, frame } = rig({ maxBufferSize: 64 }),
    batch = batches.add(new LineBatch({ positions: new Float32Array(5 * 6) }));
  frame();
  batch.updateSegments(1, new Float32Array(2 * 6).fill(1));
  const log = frame(),
    data = log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 64);
  assert.equal(data.length, 2, 'one 32-byte write into each of two buffers');
  assert.deepEqual(end(batch, 2, 1), [1, 1, 1]);
  assert.deepEqual(colour(batch, 1, 0), [255, 255, 255, 255], 'colours stay');
  assert.throws(() => batch.updateSegments(4, new Float32Array(12)), RangeError);
  assert.throws(() => batch.updateSegments(-1, new Float32Array(6)), RangeError);
});

test('same-count setSegments keeps the buffers; a new count remakes them', () => {
  const { batches, frame, gpu } = rig(),
    batch = batches.add(new LineBatch({ positions: two }));
  frame();
  const data = batch.data;
  batch.setSegments(two.map((v) => v + 1));
  assert.equal(batch.data, data);
  const same = frame();
  assert.equal(same.filter((e) => e[0] === 'buffer').length, 0);
  batch.setSegments([0, 0, 0, 1, 1, 1]);
  const next = frame();
  assert.ok(next.some((e) => e[0] === 'buffer'));
  assert.ok(next.some((e) => e[0] === 'destroy'));
  assert.ok(gpu);
});

test('onTop batches draw after depth-tested ones; hidden and empty batches draw nothing', () => {
  const { batches, frame } = rig();
  batches.add(new LineBatch({ positions: two, onTop: true }));
  batches.add(new LineBatch({ positions: [0, 0, 0, 1, 0, 0] }));
  batches.add(new LineBatch({ positions: two, visible: false }));
  batches.add(new LineBatch());
  const log = frame(),
    made = log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2].depthStencil.depthCompare);
  assert.deepEqual(made, ['greater-equal', 'always']);
  assert.deepEqual(draws(log).map((e) => e[2]), [1, 2]);
});

test('a restored device refills every batch from the CPU copy', () => {
  const { batches, frame, gpu } = rig(),
    batch = batches.add(new LineBatch({ positions: two }));
  frame();
  batches.onDeviceRestored({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } });
  assert.equal(writes(frame(), 64).length, 1);
  batches.dispose();
  assert.ok(batches.batches.has(batch), 'batches stay registered');
});

test('data and style are checked', () => {
  assert.throws(() => new LineBatch({ positions: [0, 0] }), RangeError);
  assert.throws(() => new LineBatch({ positions: [0, 0, 0] }), RangeError);
  assert.throws(() => new LineBatch({ positions: [0, 0, 0, 0, 0, NaN] }), RangeError);
  assert.throws(() => new LineBatch({ positions: two, colors: [1, 1] }), RangeError);
  assert.throws(() => new LineBatch({ positions: two, indices: [0] }), RangeError);
  assert.throws(() => new LineBatch({ positions: two, indices: [0, 4] }), RangeError);
  assert.throws(() => new LineBatch({ positions: two, indices: [0, 0.5] }), RangeError);
  assert.throws(() => new LineBatch({ colors: [1, 1, 1] }), TypeError);
  assert.throws(() => new LineBatch({ width: 0 }), RangeError);
  assert.throws(() => new LineBatch({ opacity: 2 }), RangeError);
  assert.throws(() => new LineBatch({ onTop: 1 }), TypeError);
  assert.throws(() => new LineBatches().add({}), TypeError);
  assert.equal(MAX_BATCH_SEGMENTS, 67108864);
  const one = new LineBatches(),
    other = new LineBatches(),
    batch = one.add(new LineBatch());
  assert.throws(() => other.add(batch), /already belongs/);
  batch.dispose();
  assert.equal(one.batches.size, 0);
  other.add(batch);
});

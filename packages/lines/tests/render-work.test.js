import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Lines, Line, SkeletonHelper, VERTICES_PER_SEGMENT } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

test('line frames reuse exact uniform bytes across views and resource restoration', () => {
  const gpu = mockGPU(), lines = new Lines();
  const camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] });
  camera.update(1, true);
  const engine = { backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } };
  lines.setup(engine);
  const line = lines.add(new Line({ mode: 'segments', cap: 'butt', positions: [-1, 0, 0, 1, 0, 0] }));
  const matrices = new Float32Array(32);
  matrices[28] = 1;
  lines.add(new SkeletonHelper({ parents: [-1, 0], matrices }));
  const view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  const context = {
    backend: 'webgpu', device: gpu.device, encoder: gpu.encoder, camera,
    width: 64, height: 64, format: 'rgba8unorm', color: view, depth: view,
    descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
  };
  const run = passes(lines), frame = () => gpu.record(() => run(context));
  const writes = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 224);
  const check = () => {
    const log = frame(), expected = new Float32Array(28);
    expected.set(camera.matrix);
    expected.set([context.width, context.height,
      engine.canvas.clientWidth ? context.width / engine.canvas.clientWidth : 1,
      (0.5 * context.height) / Math.tan((camera.fov * Math.PI) / 360),
      context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1], 16);
    expected.set([1, 1, 0, 0], 24);
    assert.deepEqual(writes(log).map((e) => e[3]), [Buffer.from(expected.buffer).toString('hex')]);
    return log;
  };
  check();
  const repeated = frame();
  assert.equal(writes(repeated).length, 0);
  assert.deepEqual(repeated.filter((e) => e[0] === 'pass.draw').map((e) => e.slice(1, 3)), [[6, 1], [6, 1]]);
  lines.frameValid = false;
  assert.deepEqual(check().filter((e) => !writes([e]).length), repeated);
  for (let i = 0; i < 100; i++) assert.equal(writes(frame()).length, 0);
  // Live pose and point changes still upload and draw; camera data stays resident.
  matrices[28] = 2;
  line.setPositions([-2, 0, 0, 2, 0, 0]);
  assert.equal(writes(frame()).length, 0);
  for (const width of [32, 64, 32, 64]) { context.width = width; check(); }
  context.format = 'rgba8unorm-srgb'; check();
  context.height = 32; check();
  context.width = 32; check();
  engine.canvas.clientWidth = 0; check();
  camera.position[0] = 2; camera.update(1, true); check();
  camera.matrix[1] = -0; check();
  camera.matrix[1] = 0; check();
  lines.onDeviceRestored(engine); check();
  assert.equal(writes(frame()).length, 0);
  lines.dispose();
});

test('only independent non-round segments omit the two degenerate fan blocks', () => {
  const lines = new Lines();
  for (const mode of ['segments', 'strip', 'loop'])
    for (const cap of ['butt', 'square', 'round']) {
      const line = new Line({ mode, cap, positions: [0, 0, 0, 1, 0, 0, 1, 1, 0] });
      assert.equal(lines.vertexCount(line), mode === 'segments' && cap !== 'round' ? 6 : VERTICES_PER_SEGMENT);
      line.extension = { key: 'custom' };
      assert.equal(lines.vertexCount(line), VERTICES_PER_SEGMENT, 'custom shader keeps its vertex contract');
    }
});

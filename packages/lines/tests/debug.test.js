import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugLines, ArcLine, arcPositions } from '../dist/debug.js';
import { Camera } from '@margoengine/core';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
test('planar arc hits its endpoints and midpoint height, including vertical chords and tilt', () => {
  const p = arcPositions([-2, 0, 0], [2, 0, 0], { segments: 4, height: 2 });
  assert.deepEqual([...p.slice(0, 3)], [-2, 0, 0]);
  assert.deepEqual([...p.slice(-3)], [2, 0, 0]);
  assert.deepEqual([...p.slice(6, 9)], [0, 2, 0]);
  const tilted = arcPositions([-2, 0, 0], [2, 0, 0], { segments: 4, height: 2, tilt: Math.PI / 2 });
  near(tilted[7], 0);
  near(tilted[8], 2);
  assert.ok([...arcPositions([0, -2, 0], [0, 2, 0])].every(Number.isFinite));
  const line = new ArcLine([-2, 0, 0], [2, 0, 0], { segments: 4, width: 3 });
  assert.equal(line.count, 5);
  assert.equal(line.material.width, 3);
  line.setArc([0, 0, 0], [0, 2, 0], { segments: 8 });
  assert.equal(line.count, 9);
});
test('great circles retain radius and stable coincident, near-antipodal and antipodal directions', () => {
  for (const end of [
    [0, 0, 2],
    [-2, 0, 0],
    [-2, 1e-8, 0],
    [2, 0, 0],
  ]) {
    const p = arcPositions([2, 0, 0], end, { greatCircle: true, segments: 64 });
    for (let i = 0; i < p.length; i += 3) near(Math.hypot(...p.slice(i, i + 3)), 2);
    assert.deepEqual([...p.slice(0, 3)], [2, 0, 0]);
    for (let j = 0; j < 3; j++) near(p[p.length - 3 + j], end[j]);
  }
  const p = arcPositions([3, 0, 0], [1, 2, 0], { greatCircle: true, center: [1, 0, 0], height: 1, segments: 4 });
  near(Math.hypot(p[6] - 1, p[7], p[8]), 3);
  for (const options of [
    { segments: 1 },
    { segments: 8193 },
    { height: NaN },
    { up: [0, 0, 0] },
    { tilt: Infinity },
    { greatCircle: 1 },
  ])
    assert.throws(() => arcPositions([1, 0, 0], [0, 1, 0], options));
  assert.throws(() => arcPositions([0, 0, 0], [0, 1, 0], { greatCircle: true }), RangeError);
});

function rig() {
  const gpu = mockGPU(),
    debug = new DebugLines(),
    camera = new Camera(),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  debug.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } });
  const execute = passes(debug);
  const context = {
    backend: 'webgpu',
    device: gpu.device,
    encoder: gpu.encoder,
    camera,
    width: 64,
    height: 64,
    format: 'rgba8unorm',
    color: view,
    depth: view,
    descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
  };
  return {
    gpu,
    debug,
    view: () => gpu.record(() => execute(context)),
    frame: () => {
      debug.onPreUpdate();
      return gpu.record(() => execute(context));
    },
  };
}
test('immediate queues batch colours, clear on the next zero-delta frame, and survive extra views/pick preparation', () => {
  const { debug, frame, view } = rig();
  debug.drawLine([0, 0, 0], [1, 0, 0], { color: '#ff0000' }).drawLine([0, 1, 0], [1, 1, 0], { color: '#00ff00' });
  debug.onPreUpdate(); // a pick may prepare but does not execute frame passes
  frame();
  assert.equal(debug.stats.segments, 2);
  assert.equal(debug.stats.drawCalls, 1);
  const batch = [...debug.batches][0],
    data = batch.data;
  view();
  assert.equal(debug.stats.segments, 2, 'a second view or target retains the frame');
  debug.drawLine([0, 0, 0], [1, 0, 0]);
  debug.drawLine([0, 1, 0], [1, 1, 0]);
  frame();
  assert.equal([...debug.batches][0].data, data, 'same-sized frames reuse the packed buffer');
  frame();
  assert.equal(debug.stats.segments, 0);
  assert.equal(debug.batches.size, 0);
});
test('arc queues, style separation, limits and disposal', () => {
  const { debug, frame } = rig();
  debug.drawArc([-2, 0, 0], [2, 0, 0], { segments: 8, width: 2, color: '#ff0000', endColor: '#0000ff' });
  debug.drawLine([0, 0, 0], [1, 0, 0], { depthTest: false });
  frame();
  assert.equal(debug.stats.segments, 9);
  assert.equal(debug.stats.drawCalls, 2);
  assert.throws(() => debug.drawLine([0, 0, 0], [1, 0, 0], { width: NaN }), RangeError);
  const limited = new DebugLines({ maxSegments: 1 });
  limited.drawLine([0, 0, 0], [1, 0, 0]);
  assert.throws(() => limited.drawLine([0, 0, 0], [1, 0, 0]), RangeError);
  assert.throws(() => debug.drawLines([1, 2, 3]), RangeError);
  assert.throws(() => debug.drawLine([NaN, 0, 0], [0, 0, 0]), RangeError);
  debug.clear();
  assert.equal(debug.batches.size, 0);
  debug.dispose();
});

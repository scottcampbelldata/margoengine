import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows, cascadeSplits, fitCascades } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// A world point's texel coordinate on one axis of one cascade: the local point (world less origin) through the
// float32 light matrix, in texels. Two fits put the point on the same world texel phase when these differ by whole texels.
const texelAt = (m, offset, axis, local, resolution) =>
  ((m[offset + axis] * local[0] + m[offset + 4 + axis] * local[1] + m[offset + 8 + axis] * local[2] + m[offset + 12 + axis]) *
    resolution) /
  2;
const phase = (a, b) => Math.abs(a - b - Math.round(a - b));
// 32 origins about 1e5 from zero, each a few tens of metres and a fraction of a texel from the camera.
const origins = (world) =>
  Array.from({ length: 32 }, (_, k) => [
    world[0] - 40 + ((k * 7.31) % 80),
    world[1] - 3 + ((k * 0.77) % 6),
    world[2] - 40 + ((k * 13.17) % 80),
  ]);

test('anchored cascade fits keep a world point on the same texel phase across 32 origin shifts at 1e5', () => {
  const world = [123456.789, 12.3, -98765.4321],
    target = [world[0] + 3, world[1] - 1, world[2] + 2],
    point = [world[0] + 5, 0.5, world[2] + 7],
    light = [-0.3, -1, -0.45],
    resolution = 1024,
    splits = cascadeSplits(0.1, 200, 0.5, new Float32Array(4), 4);
  const fit = (origin, anchored) => {
    const camera = {
      position: world.map((v, i) => v - origin[i]),
      target: target.map((v, i) => v - origin[i]),
      fov: 60,
      near: 0.1,
      far: 200,
    };
    const m = new Float32Array(64);
    fitCascades(camera, 16 / 9, light, resolution, splits, m, new Float32Array(4), 100, undefined, 4, anchored ? origin : undefined);
    return { m, local: point.map((v, i) => v - origin[i]) };
  };
  let worstAnchored = 0,
    worstLocal = 0;
  const firstA = fit(origins(world)[0], true),
    firstL = fit(origins(world)[0], false);
  for (const origin of origins(world)) {
    const a = fit(origin, true),
      l = fit(origin, false);
    for (let c = 0; c < 4; c++)
      for (const axis of [0, 1]) {
        worstAnchored = Math.max(
          worstAnchored,
          phase(texelAt(a.m, c * 16, axis, a.local, resolution), texelAt(firstA.m, c * 16, axis, firstA.local, resolution)),
        );
        worstLocal = Math.max(
          worstLocal,
          phase(texelAt(l.m, c * 16, axis, l.local, resolution), texelAt(firstL.m, c * 16, axis, firstL.local, resolution)),
        );
      }
  }
  assert.ok(worstAnchored < 0.01, `anchored phase moved ${worstAnchored} texels`);
  // The local snap the anchor replaces moves edges by a sizeable part of a texel at the same shifts.
  assert.ok(worstLocal > 0.1, `local snap moved only ${worstLocal} texels`);
  // No anchor and a zero anchor are the same fit, bit for bit.
  const zero = [0, 0, 0],
    camera = { position: [3, 2, 1], target: [0, 0, 0], fov: 50, near: 0.1, far: 200 },
    plain = fitCascades(camera, 1.5, light, resolution, splits).matrices,
    zeroed = fitCascades(camera, 1.5, light, resolution, splits, undefined, undefined, 100, undefined, 4, zero).matrices;
  assert.deepEqual([...zeroed], [...plain]);
});

test('Shadows floatingOrigin validates, follows rebases for bounds fits and unsubscribes on dispose', () => {
  for (const value of [null, {}, { origin: [0, 0], onRebase() {} }, { origin: [0, NaN, 0], onRebase() {} }])
    assert.throws(() => new Shadows({ floatingOrigin: value }), /floatingOrigin/);
  const world = { min: [100000.3, -0.35, -99998.45], max: [100003.4, 2, -99995.3] },
    start = [100001, 0, -99997.2],
    listeners = new Set(),
    origin = {
      origin: start,
      onRebase(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    local = (at) => ({ min: world.min.map((v, i) => v - at[i]), max: world.max.map((v, i) => v - at[i]) }),
    gpu = mockGPU(),
    engine = { gpu: gpu.device, lighting: { direction: new Float32Array([-3, 3.5, 2.5, 4]) }, removePlugin() {} },
    resolution = 512,
    shadows = new Shadows({ bounds: local(start), resolution, casterMargin: 0.1, floatingOrigin: origin }),
    view = context(gpu, { shader: 'let linear=direct*vec3f(1);' }),
    run = passes(shadows),
    point = [100001.7, 0.4, -99996.1];
  assert.equal(listeners.size, 1);
  shadows.setup(engine);
  let frame = 0;
  const draw = (at) => {
    shadows.options.bounds = local(at);
    view.begin(frame++);
    view.c.shader = 'let linear=direct*vec3f(1);';
    run(view.c);
    const p = point.map((v, i) => v - at[i]);
    return [0, 1].map((axis) => texelAt(shadows.matrices, 0, axis, p, resolution));
  };
  try {
    const first = draw(start);
    let worst = 0;
    for (let k = 1; k < 32; k++) {
      const at = [start[0] + k * 0.137, start[1] + k * 0.05, start[2] - k * 0.291];
      for (const listener of listeners) listener([0, 0, 0], at);
      const now = draw(at);
      for (const axis of [0, 1]) worst = Math.max(worst, phase(now[axis], first[axis]));
    }
    assert.ok(worst < 0.01, `bounds phase moved ${worst} texels across rebases`);
  } finally {
    shadows.dispose();
  }
  assert.equal(listeners.size, 0, 'dispose unsubscribes from the floating origin');
});

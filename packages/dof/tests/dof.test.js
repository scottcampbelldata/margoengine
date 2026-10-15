import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';

test('DOF validates the thin lens at float32 precision and rejects WebGL', () => {
  for (const options of [
    { focalDistance: 0 },
    { focalLength: 0 },
    { focalLength: 1e-50 },
    { aperture: 0 },
    { aperture: 1e-50 },
    { focalLength: 5, focalDistance: 5 },
    { focalDistance: Infinity },
    { maxRadius: 33 },
    { maxRadius: 0 },
    { enabled: 1 },
  ])
    assert.throws(() => new DOF(options), /options/);
  assert.throws(() => new DOF().setup({ gpu: null }), /WebGPU/);
});

test('DOF runs three compute passes, restores attachments, and reuses all steady-state resources', () => {
  const h = gpuHarness(),
    dof = DOF.attach(h.engine, { focalDistance: 5, focalLength: 0.05, aperture: 2 });
  h.frame();
  assert.equal(h.counts.compute, 3);
  assert.equal(h.counts.render, 4);
  assert.equal(h.context.color, h.originalColor);
  assert.equal(h.context.depth, h.originalDepth);
  assert.equal(h.context.format, 'bgra8unorm');
  assert.equal(dof.outputTexture.format, 'rgba16float');
  assert.equal(dof.depthTexture.format, 'depth32float');
  const scale = (0.05 * 96) / (4 * 2 * (5 - 0.05) * Math.tan(Math.PI / 6));
  assert.ok(Math.abs(h.writes[6] - scale) < 1e-6);
  assert.ok(scale * (1 - 5 / 3) < 0);
  assert.equal(scale * (1 - 5 / 5), 0);
  assert.ok(scale * (1 - 5 / 10) > 0);
  const before = { ...h.counts },
    descriptor = h.context.presentation,
    output = dof.outputTexture,
    depth = dof.depthTexture;
  const F32 = globalThis.Float32Array,
    U32 = globalThis.Uint32Array;
  let allocations = 0;
  globalThis.Float32Array = new Proxy(F32, {
    construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    },
  });
  globalThis.Uint32Array = new Proxy(U32, {
    construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    },
  });
  try {
    for (let i = 0; i < 120; i++) h.frame();
  } finally {
    globalThis.Float32Array = F32;
    globalThis.Uint32Array = U32;
  }
  assert.equal(allocations, 0);
  for (const key of ['buffers', 'textures', 'views', 'groups']) assert.equal(h.counts[key], before[key]);
  assert.equal(h.context.presentation, descriptor);
  assert.equal(dof.outputTexture, output);
  dof.enabled = false;
  h.frame();
  assert.equal(h.writes[7], 0);
  h.context.width = 256;
  h.frame();
  assert.ok(output.destroyed && depth.destroyed);
  assert.equal(dof.outputTexture.width, 256);
  const resized = dof.outputTexture;
  dof.onDeviceRestored(h.engine);
  assert.ok(resized.destroyed);
  h.frame();
  dof.destroy();
  dof.destroy();
  assert.equal(h.engine.hasPlugin('dof'), false);
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.equal(dof.outputTexture, undefined);
  const dispatches = h.counts.compute;
  h.frame();
  assert.equal(h.counts.compute, dispatches);
});

test('DOF rejects conflicting capture and validates edited controls before rendering', () => {
  const h = gpuHarness();
  h.engine.use({ name: 'ssao', setup() {}, registerPasses() {}, dispose() {} });
  assert.throws(() => DOF.attach(h.engine), /capture/);
  assert.equal(h.engine.hasPlugin('dof'), false);
  h.engine.removePlugin('ssao');
  const dof = DOF.attach(h.engine);
  dof.options.aperture = -1;
  assert.throws(h.frame, /options/);
  dof.destroy();
});

test('DOF under an orthographic camera: linear depth from the clip matrix and a circle of confusion linear in defocus', () => {
  const h = gpuHarness(),
    dof = DOF.attach(h.engine, { focalDistance: 5, focalLength: 0.05, aperture: 2 });
  const camera = new Camera({ position: [0, 2, 10], target: [0, 0, 0], fov: 60 }),
    projection = new CameraProjection({ height: 4, near: -2, far: 40 });
  projection.attach(camera);
  const frame = () => {
    camera.update(h.context.width / h.context.height, true);
    Object.assign(h.context.camera, {
      matrix: camera.matrix,
      position: camera.position,
      near: camera.near,
      far: camera.far,
      fov: camera.fov,
    });
    h.frame();
    return h.writes.slice(0, 12);
  };
  try {
    const v = frame();
    assert.equal(v[8], 1);
    assert.ok(Math.abs(v[4] + 2) < 1e-4 && Math.abs(v[5] - 40) < 1e-4, 'near/far from the clip matrix');
    // Mirror of cocShader: reversed-Z depth d is linear, 1 at near and 0 at far; radius is scale*(z-focus)/focus.
    const coc = (d) => {
      const z = v[5] + d * (v[4] - v[5]);
      return { z, radius: Math.max(-v[3], Math.min(v[3], (v[6] * (z - v[0])) / v[0])) };
    };
    assert.ok(Math.abs(coc(1).z + 2) < 1e-4 && Math.abs(coc(0).z - 40) < 1e-4);
    const focus = (v[5] - 5) / (v[5] - v[4]);
    assert.ok(Math.abs(coc(focus).radius) < 1e-5, 'sharp at the focal distance');
    assert.ok(coc(focus + 0.05).radius < 0 && coc(focus - 0.05).radius > 0, 'near blur is negative, far blur positive');
    // Scale matches a perspective lens at the focal distance with the same pixel size: 1/tan(fov/2) becomes P[5]*focus.
    // Height 4 gives P[5]=2/4 (96/4 = 24 px per unit).
    assert.ok(Math.abs(v[6] - (0.05 * 96 * (2 / 4) * 5) / (4 * 2 * (5 - 0.05))) < 1e-5);
    // Zooming in by 2 doubles the blur in pixels.
    projection.zoom = 2;
    assert.ok(Math.abs(frame()[6] - 2 * v[6]) < 1e-5);
    projection.dispose();
    const perspective = frame();
    assert.equal(perspective[8], 0);
    assert.equal(perspective[4], Math.fround(camera.near));
  } finally {
    dof.destroy();
  }
});

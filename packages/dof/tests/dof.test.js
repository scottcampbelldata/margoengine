import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';
import { DOFLens } from '../dist/lens.js';
import { Autofocus } from '../dist/autofocus.js';
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

test('DOF runs three compute passes, restores attachments, and reuses all steady-state resources', async () => {
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
  await null;
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

test('DOF scales the circle of confusion by the height of the view being drawn', () => {
  const h = gpuHarness(),
    dof = DOF.attach(h.engine, { focalDistance: 5, focalLength: 0.05, aperture: 2 });
  h.context.view = { id: 'top', camera: h.context.camera, viewport: [0, 0, 128, 48], index: 0, count: 2 };
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {}, setScissorRect() {} });
  h.frame();
  const scale = (0.05 * 48) / (4 * 2 * (5 - 0.05) * Math.tan(Math.PI / 6));
  assert.ok(Math.abs(h.writes[6] - scale) < 1e-6, 'half-height view, half the scale');
  dof.dispose();
});

test('DOF alone on the WebGL2 layer shows the sharp scene, as outputTexture too, until its route has loaded', async () => {
  // Regression: while it waited for its route, DOF skipped capture and presentation too, so outputTexture stayed
  // undefined and Tonemap with source: () => dof.outputTexture threw on the first frames (modern-postfx-tests --compat).
  const h = gpuHarness();
  h.engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  const dof = DOF.attach(h.engine, { focalDistance: 5, focalLength: 0.05, aperture: 2 });
  h.frame();
  assert.equal(h.counts.compute, 0, 'no CoC or blur kernel before the route');
  const sharp = dof.outputTexture;
  assert.ok(sharp, 'outputTexture is the captured scene while waiting');
  assert.deepEqual([sharp.width, sharp.height, sharp.format, sharp.sampleCount], [128, 96, 'rgba16float', 1]);
  assert.ok(sharp.usage & GPUTextureUsage.TEXTURE_BINDING);
  assert.equal(h.context.presentation.colorAttachments[0].view, h.originalColor, 'presented to the canvas');
  assert.equal(h.context.color, h.originalColor);
  assert.equal(h.context.depth, h.originalDepth);
  h.frame();
  assert.equal(dof.outputTexture, sharp, 'steady while waiting');
  for (let i = 0; i < 50 && h.counts.compute === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    h.frame();
  }
  assert.ok(h.counts.compute > 0, 'the route blurs once loaded');
  assert.ok(sharp.destroyed);
  assert.notEqual(dof.outputTexture, dof.depthTexture);
  assert.equal(dof.outputTexture.usage & GPUTextureUsage.STORAGE_BINDING, GPUTextureUsage.STORAGE_BINDING);
  dof.dispose();
});

const shaderCodes = (h) => h.pipelines.map((p) => p.compute?.module.code).filter(Boolean);
test('without a lens DOF builds the plain kernels and leaves the three free uniform slots at zero', () => {
  const h = gpuHarness();
  DOF.attach(h.engine, { focalDistance: 5 });
  h.frame();
  const codes = shaderCodes(h);
  assert.equal(codes.length, 3);
  for (const code of codes) assert.ok(!code.includes('fn shape'));
  assert.ok(codes[0].includes('1.0-p.lens.x/z'));
  assert.deepEqual([h.writes[9], h.writes[10], h.writes[11]], [0, 0, 0]);
});

test('DOFLens validates its options, edits every kernel it should, and writes the tilt per clip unit each frame', () => {
  for (const options of [
    { blades: 2 },
    { blades: 17 },
    { blades: 4.5 },
    { bladeRotation: NaN },
    { tilt: 1.6 },
    { tiltDirection: [0, 0] },
  ])
    assert.throws(() => new DOFLens(options), RangeError);
  const h = gpuHarness(),
    lens = new DOFLens({ blades: 6, tilt: Math.PI / 4, tiltDirection: [3, 4] });
  DOF.attach(h.engine, { focalDistance: 5, lens });
  const [coc, bokeh, coarse] = shaderCodes(h);
  assert.ok(coc.includes('let focus=max('));
  assert.ok(!coc.includes('1.0-p.lens.x/z,'));
  for (const code of [bokeh, coarse])
    assert.ok(code.includes('fn shape(a:f32)') && code.includes('*shape(angle)*vec2f'));
  assert.ok(bokeh.includes('radius*shape(f32(i)*2.39996323)'));
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]);
  h.context.camera.position = [0, 0, 0];
  h.frame();
  const half = Math.tan(Math.PI / 6);
  assert.ok(Math.abs(h.writes[9] - 0.6 * half * (128 / 96)) < 1e-5);
  assert.ok(Math.abs(h.writes[10] - 0.8 * half) < 1e-5);
  lens.tilt = 2;
  assert.throws(() => h.frame(), RangeError);
});

test('a lens whose shaders do not match its DOF refuses to build', () => {
  const lens = new DOFLens();
  assert.throws(
    () => lens.shaders({ cocShader: 'changed', coarseShader: '', bokehShader: '', groupMax: '' }),
    /update both together/,
  );
});

test('Autofocus maps its read in a later frame, never waits, and leaves the focus alone on the sky', async () => {
  const h = gpuHarness();
  globalThis.GPUMapMode = { READ: 1 };
  globalThis.GPUBufferUsage.MAP_READ = 1;
  let copies = 0,
    maps = 0,
    depth = 0.25,
    finish;
  h.context.encoder.copyTextureToBuffer = () => copies++;
  const create = h.engine.gpu.createBuffer.bind(h.engine.gpu);
  h.engine.gpu.createBuffer = (descriptor) =>
    Object.assign(create(descriptor), {
      mapAsync() {
        maps++;
        return new Promise((done) => (finish = done));
      },
      getMappedRange: () => new Float32Array([depth]).buffer,
      unmap() {},
    });
  h.engine.canvas = { clientWidth: 128, clientHeight: 96, width: 128, height: 96 };
  const dof = DOF.attach(h.engine, { focalDistance: 5 }),
    focus = Autofocus.attach(h.engine, dof, { smoothing: 0, point: [10, 20] });
  h.frame();
  assert.deepEqual([copies, maps], [1, 0], 'the first frame copies and cannot map yet');
  h.frame();
  assert.deepEqual([copies, maps], [1, 1], 'the next frame maps without copying over it');
  h.frame();
  assert.deepEqual([copies, maps], [1, 1], 'a slow map holds no frame and starts no second read');
  finish();
  await new Promise(setImmediate);
  const z = (0.1 * 100) / (0.1 + 0.25 * (100 - 0.1));
  assert.ok(Math.abs(dof.options.focalDistance - z) < 1e-4);
  depth = 0;
  h.frame();
  h.frame();
  finish();
  await new Promise(setImmediate);
  assert.ok(Math.abs(dof.options.focalDistance - z) < 1e-4, 'the sky keeps the focus');
  focus.dispose();
  assert.equal(h.engine.hasPlugin('dof-autofocus'), false);
  assert.throws(() => new Autofocus(), /Expected a DOF/);
});

test('Autofocus on a world point uses its distance along the view with no read', () => {
  const h = gpuHarness();
  h.engine.canvas = { clientWidth: 128, clientHeight: 96, width: 128, height: 96 };
  let copies = 0;
  h.context.encoder.copyTextureToBuffer = () => copies++;
  const dof = DOF.attach(h.engine, { focalDistance: 5 });
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 0]);
  h.context.camera.position = [0, 0, 0];
  Autofocus.attach(h.engine, dof, { smoothing: 0, target: [0, 0, -8] });
  h.frame();
  assert.ok(Math.abs(dof.options.focalDistance - 8) < 1e-6);
  assert.equal(copies, 0);
});

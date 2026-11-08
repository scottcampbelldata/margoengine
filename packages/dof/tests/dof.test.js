import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';
import { DOFLens } from '../dist/lens.js';
import { Autofocus } from '../dist/autofocus.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection, fovToLens } from '../../cameras/dist/index.js';

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

// A disk image of `size` pixels whose open part is where `open(x, y)` holds, x and y from -1 to 1 (y down).
const apertureImage = (size, open) => {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (open(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1))
        data.fill(255, (y * size + x) * 4, (y * size + x) * 4 + 4);
  return { width: size, height: size, data };
};
const tables = (code) =>
  Object.fromEntries(
    [...code.matchAll(/var<private> taps(\d+):array<vec3f,\d+>=array<vec3f,\d+>\((.*?)\);/g)].map(([, n, body]) => [
      n,
      [...body.matchAll(/vec3f\(([^)]*)\)/g)].map(([, v]) => v.split(',').map(Number)),
    ]),
  );

test('DOFLens aperture image: taps spread over the mirrored shape, the near gather weighs by the mask', () => {
  for (const bad of [
    { width: 0, height: 1, data: [] },
    { width: 2, height: 2, data: new Uint8Array(15) },
    apertureImage(8, () => false),
  ])
    assert.throws(() => new DOFLens({ aperture: bad }), RangeError);
  assert.throws(() => new DOFLens({ blades: 5, aperture: apertureImage(8, () => true) }), RangeError);
  // Left half open: a far tap at s takes a neighbour whose bokeh covers this pixel only when -s is open, so x >= 0,
  // give or take the mask's softening: a cell of 1/16 the diameter straddling the edge, then bilinear to the next.
  const lens = new DOFLens({ aperture: apertureImage(64, (x) => x < 0) });
  const h = gpuHarness();
  DOF.attach(h.engine, { focalDistance: 5, lens });
  const [, bokeh, coarse] = shaderCodes(h);
  for (const code of [bokeh, coarse]) assert.ok(code.includes('fn aperture(v:vec2f)->f32'));
  const taps = tables(bokeh);
  assert.deepEqual(Object.keys(taps).sort(), ['16', '32', '64']);
  for (const [n, list] of Object.entries(taps)) {
    assert.equal(list.length, +n);
    for (const [x, y, w] of list) {
      assert.ok(Math.hypot(x, y) <= 1 && x > -3 / 32, `tap ${x},${y} lies on the mirrored half`);
      assert.ok(w > 0 && w <= 1);
    }
    // Spread over the half disk, not bunched: the mean lies near the half disk's centroid 4 / (3 pi).
    const mx = list.reduce((s, [x]) => s + x, 0) / list.length;
    assert.ok(Math.abs(mx - 4 / (3 * Math.PI)) < 0.12, `taps ${n} centroid ${mx}`);
  }
  // The mean transmission over the disk, about 0.5 for a half: the rim cells lose a little to the mask's softening.
  const mean = +/\*aperture\(-vec2f\(nearOffset\)\/radius\)\/([0-9.]+);/.exec(bokeh)[1];
  assert.ok(mean > 0.45 && mean < 0.55, `near weight over a half disk divides by about 0.5, got ${mean}`);
  assert.ok(bokeh.includes('farWeight+=farTap.z;'));
  assert.ok(!bokeh.includes('round(spiral(i,16.0)*center.x)'));
});

test('filmGauge takes the focal length from the camera field of view, as a lens on that sensor gives it', () => {
  for (const options of [{ filmGauge: 0 }, { filmGauge: NaN }, { filmGauge: 36, sensorFit: 'diagonal' }])
    assert.throws(() => new DOF(options), RangeError);
  const h = gpuHarness(),
    dof = DOF.attach(h.engine, { focalDistance: 5, aperture: 2, filmGauge: 36 });
  assert.equal(dof.focalLength, 0.05, 'before a frame: the default focal length');
  h.context.camera.fov = 40;
  h.frame();
  // A 128 x 96 view spans the 36 mm gauge horizontally: f = 36 mm / (2 tan(20 degrees) * 4 / 3).
  const tan = Math.tan((20 * Math.PI) / 180),
    f = 0.036 / (2 * tan * (128 / 96));
  assert.ok(Math.abs(h.writes[1] - f) < 1e-7 && Math.abs(dof.focalLength - h.writes[1]) < 1e-9);
  // The CoC scale is the thin lens's with that focal length: f * height / (4 N (d - f) tan(fov / 2)).
  assert.ok(Math.abs(h.writes[6] - (f * 96) / (4 * 2 * (5 - f) * tan)) < 1e-4 * h.writes[6]);
  // Zooming in (half the field of view) lengthens the lens; a vertical fit spans the 96 px side instead.
  h.context.camera.fov = 20;
  h.frame();
  assert.ok(Math.abs(h.writes[1] - 0.036 / (2 * Math.tan((10 * Math.PI) / 180) * (128 / 96))) < 1e-7);
  dof.options.sensorFit = 'vertical';
  h.frame();
  assert.ok(Math.abs(h.writes[1] - 0.036 / (2 * Math.tan((10 * Math.PI) / 180))) < 1e-7);
  // Matches @margoengine/cameras: fovToLens gives the same millimetres.
  assert.ok(Math.abs(fovToLens(20, 128 / 96, { filmGauge: 36, sensorFit: 'vertical' }) / 1000 - h.writes[1]) < 1e-7);
  // A focus inside the focal length the camera gives is refused at the frame.
  dof.options.focalDistance = 0.1;
  assert.throws(() => h.frame(), RangeError);
});

test('temporal DOF gathers at half size with turning taps and a half maxRadius, and allocates nothing in steady frames', () => {
  assert.throws(() => new DOF({ temporal: 'yes' }), RangeError);
  const h = gpuHarness(),
    dof = DOF.attach(h.engine, { focalDistance: 5, maxRadius: 16, temporal: true });
  h.frame();
  const codes = shaderCodes(h);
  assert.equal(codes.length, 5, 'CoC, bokeh, coarse, halve and join kernels');
  const find = (text) => codes.find((code) => code.includes(text)),
    bokeh = find('nearOffset'),
    coarse = find('coarse:texture_storage_2d'),
    halve = find('halfScene'),
    join = find('blurred');
  for (const code of [bokeh, coarse]) assert.ok(code.includes('(f32(i)*2.39996323+p.ortho.w)'));
  assert.ok(bokeh.includes('vec4f(color,coverage)') && halve.includes('halfCoc') && join.includes('smoothstep'));
  // The half image's CoC, scene, tiles and gather output at 64 x 48 for a 128 x 96 view; its 2x2 blocks at 32 x 24.
  const live = h.resources.filter((r) => r.width !== undefined && !r.destroyed && r.sampleCount === 1),
    sized = (w, hh, format) => live.filter((r) => r.width === w && r.height === hh && r.format === format).length;
  assert.equal(sized(64, 48, 'rg32float'), 1);
  assert.equal(sized(64, 48, 'rgba16float'), 2);
  assert.equal(sized(8, 6, 'r32float'), 1);
  assert.equal(sized(32, 24, 'rgba16float'), 1);
  assert.equal(sized(128, 96, 'rgba16float'), 2, 'full-size scene capture and output');
  // The half gather's uniform (written last): maxRadius halved, the turn moving by the golden angle each frame.
  assert.equal(h.writes[3], 8);
  const made = ({ buffers, textures, views, groups }) => ({ buffers, textures, views, groups }),
    first = h.writes[11],
    counts = made(h.counts);
  h.frame();
  assert.ok(Math.abs(((h.writes[11] - first + 2 * Math.PI) % (2 * Math.PI)) - 2.39996323) < 1e-5);
  assert.deepEqual(made(h.counts), counts, 'a steady frame creates nothing');
  dof.dispose();
  assert.ok(h.resources.filter((r) => r.width !== undefined).every((r) => r.destroyed));
});

test('DOFLens catEye and anamorphic: validated, baked into every gather, and combined with blades and temporal', () => {
  for (const options of [
    { catEye: -0.1 },
    { catEye: 1.6 },
    { anamorphic: 0.9 },
    { anamorphic: 5 },
    { anamorphic: NaN },
  ])
    assert.throws(() => new DOFLens(options), RangeError);
  const open = { width: 1, height: 1, data: [255, 255, 255, 255] };
  assert.throws(() => new DOFLens({ aperture: open, catEye: 0.5 }), RangeError);
  assert.throws(() => new DOFLens({ aperture: open, anamorphic: 2 }), RangeError);
  for (const blades of [undefined, 6])
    for (const temporal of [false, true]) {
      const h = gpuHarness();
      DOF.attach(h.engine, { focalDistance: 5, temporal, lens: new DOFLens({ blades, catEye: 1, anamorphic: 2 }) });
      h.frame();
      const codes = shaderCodes(h),
        bokeh = codes.find((code) => code.includes('nearOffset')),
        coarse = codes.find((code) => code.includes('coarse:texture_storage_2d'));
      for (const code of [bokeh, coarse]) {
        assert.ok(code.includes('fn barrel(pixel:vec2i)') && code.includes('farWeight+=w;'));
        assert.ok(code.includes('vec2f(cos(angle)/2.000000,sin(angle))'), 'far taps squeezed across');
      }
      // Near taps keep the whole disk; each foreground disk is tested as its oval, weighed by squeeze over shared area.
      assert.ok(bokeh.includes('return vec2f(s.x*2.000000,s.y);'));
      assert.ok(bokeh.includes('length(vec2f(nearOffset)*vec2f(2.000000,1.0))<=radius'));
      assert.ok(bokeh.includes('*2.000000*eye(-vec2f(nearOffset)/radius,pixel)/lensArea(pixel);'));
      assert.equal(bokeh.includes('shape(atan2(f32(nearOffset.y),f32(nearOffset.x)*2.000000))'), blades !== undefined);
    }
});

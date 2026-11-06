import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const shader = 'let linear=direct*vec3f(1);';
const frustum = () => ({ position: [1, 5, 2], left: -2, right: 3, bottom: -1, top: 4, near: 0.5, far: 9 });
function rig(options, direction = [1, 2, 0.5]) {
  const gpu = mockGPU(),
    engine = { gpu: gpu.device, lighting: { direction: new Float32Array([...direction, 4]) }, removePlugin() {} },
    shadows = new Shadows(options),
    view = context(gpu, { shader }),
    run = passes(shadows);
  shadows.setup(engine);
  let frame = 0;
  return {
    gpu,
    engine,
    shadows,
    view,
    frame() {
      view.begin(frame++);
      run(view.c);
    },
  };
}
const project = (m, p) =>
  [0, 1, 2, 3].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);

test('resolution takes one integer or [width, height] powers of two; frustum takes finite ordered extents', () => {
  for (const resolution of [[512], [512, 300], [8, 16], [16.5, 16], [16, 2 ** 31 + 1], 'x', { 0: 16, 1: 16 }])
    assert.throws(() => new Shadows({ resolution }), /Invalid shadow resolution/, JSON.stringify(resolution));
  for (const resolution of [15, 16.5]) assert.throws(() => new Shadows({ resolution }), /Invalid shadow options/);
  for (const resolution of [16, 1000, [16, 2048], [1024, 512]]) assert.doesNotThrow(() => new Shadows({ resolution }));
  for (const edit of [
    { left: 3 },
    { bottom: 4 },
    { near: 9 },
    { far: NaN },
    { right: Infinity },
    { top: undefined },
    { position: [0, 0] },
    { position: [0, NaN, 0] },
  ])
    assert.throws(() => new Shadows({ frustum: { ...frustum(), ...edit } }), /frustum/i, JSON.stringify(edit));
  assert.throws(() => new Shadows({ frustum: null }), TypeError);
  assert.throws(
    () => new Shadows({ frustum: frustum(), bounds: { min: [0, 0, 0], max: [1, 1, 1] } }),
    /bounds and frustum/,
  );
  assert.doesNotThrow(() => new Shadows({ frustum: { ...frustum(), near: -4 } }));
  // A frustum is one map like bounds: the two swap live.
  const shadows = new Shadows({ frustum: frustum() });
  shadows.options.frustum = undefined;
  shadows.options.bounds = { min: [0, 0, 0], max: [1, 1, 1] };
  assert.doesNotThrow(() => shadows.setup({ gpu: mockGPU().device, removePlugin() {} }));
  shadows.dispose();
});

test('the frustum matrix maps the shadow camera box, looking along the light with +Y up, onto the whole map', () => {
  const { shadows, frame, engine } = rig({ frustum: frustum(), resolution: [1024, 256] });
  try {
    frame();
    // The shadow camera, derived independently: forward is the light's travel, right = forward x up, up = right x forward.
    const l = engine.lighting.direction,
      n = Math.hypot(l[0], l[1], l[2]),
      f = [-l[0] / n, -l[1] / n, -l[2] / n],
      r0 = [-f[2], 0, f[0]],
      rn = Math.hypot(...r0),
      r = r0.map((v) => v / rn),
      u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]],
      { position, left, right, bottom, top, near, far } = frustum(),
      at = (x, y, d) => position.map((p, i) => p + r[i] * x + u[i] * y + f[i] * d),
      m = shadows.matrices;
    const ndc = (x, y, d) => project(m, at(x, y, d));
    close(ndc((left + right) / 2, (bottom + top) / 2, 1)[0], 0, 'centre x');
    close(ndc((left + right) / 2, (bottom + top) / 2, 1)[1], 0, 'centre y');
    close(Math.abs(ndc(left, 0, 1)[0]), 1, 'left edge');
    close(Math.abs(ndc(right, 0, 1)[0]), 1, 'right edge');
    close(ndc(left, 0, 1)[0], -ndc(right, 0, 1)[0], 'left and right are opposite edges');
    close(ndc(0, bottom, 1)[1], -1, 'bottom edge');
    close(ndc(0, top, 1)[1], 1, 'top edge');
    close(ndc(0, 0, near)[2], 0, 'near depth');
    close(ndc(0, 0, far)[2], 1, 'far depth');
    close(ndc(0, 0, far)[3], 1, 'orthographic w');
    // Moving along the light changes only depth; across it, only x/y.
    close(ndc(1, 2, near)[0], ndc(1, 2, far)[0], 'depth-independent x');
    assert.ok(Math.abs(project(m, at(right + 0.1, 0, 1))[0]) > 1, 'outside the box is outside the map');
    assert.deepEqual([...shadows.splits], [500, 500, 500, 500], 'every receiver takes layer 0');
    close(m[16], 0, 'one map');
    // Rows scale per axis: 2 / (right - left) and 2 / (top - bottom), not a shared radius.
    close(Math.hypot(m[0], m[4], m[8]), 2 / (right - left), 'x row');
    close(Math.hypot(m[1], m[5], m[9]), 2 / (top - bottom), 'y row');
    // Live edit: next frame's matrix follows.
    shadows.options.frustum.right = 7;
    frame();
    close(Math.hypot(m[0], m[4], m[8]), 2 / (7 - left), 'edited x row');
  } finally {
    shadows.dispose();
  }
});

test('non-square maps allocate width x height, copy that size, and reallocate only when the size changes', () => {
  const { gpu, shadows, frame } = rig({ bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, resolution: [1024, 256] });
  try {
    const log = gpu.record(() => frame()),
      copy = log.find((entry) => entry[0] === 'copyTextureToTexture');
    assert.deepEqual(copy[3], { depthOrArrayLayers: 1, height: 256, width: 1024 });
    const textures = (entries) =>
      entries.filter((entry) => entry[0] === 'texture' && entry[2].format === 'depth32float');
    assert.equal(textures(log).length, 0, 'steady frame allocates nothing');
    const binding = shadows.bindings()[1].resource;
    shadows.options.bias = 0.001;
    shadows.options.resolution = [1024, 256];
    assert.equal(textures(gpu.record(() => frame())).length, 0, 'same size, new array: no reallocation');
    assert.equal(shadows.bindings()[1].resource, binding);
    shadows.options.resolution = 2048;
    const resized = gpu.record(() => frame());
    assert.deepEqual(
      textures(resized).map((entry) => entry[2].size),
      [
        [2048, 2048, 1],
        [2048, 2048, 1],
      ],
    );
    assert.equal(resized.filter((entry) => entry[0] === 'destroy').length, 2, 'the old pair is released');
    assert.notEqual(shadows.bindings()[1].resource, binding, 'receivers see the new map');
    assert.equal(textures(gpu.record(() => frame())).length, 0);
    shadows.options.resolution = 16384;
    assert.throws(() => frame(), /exceeds device limit/);
  } finally {
    shadows.dispose();
  }
});

test('receivers take the per-axis filter only for a non-square map or a frustum', () => {
  const square = new Shadows({ resolution: [512, 512] }),
    plain = new Shadows({ resolution: 512 }),
    wide = new Shadows({ resolution: [1024, 512] }),
    framed = new Shadows({ frustum: frustum() });
  const anisotropic = /lightNormal\.x\/length\(rowX\)/;
  for (const filter of ['soft', 'pcf', 'hard']) {
    for (const s of [square, plain, wide, framed]) s.options.filter = filter;
    assert.equal(square.shader(shader), plain.shader(shader), `${filter}: a square tuple is today's map`);
    assert.equal(square.pbr(2).declarations, plain.pbr(2).declarations);
    assert.doesNotMatch(plain.shader(shader), anisotropic);
    for (const s of [wide, framed]) {
      assert.match(s.shader(shader), anisotropic, filter);
      assert.match(s.pbr(2).declarations, anisotropic, filter);
    }
  }
  framed.options.filter = 'soft';
  const soft = framed.shader(shader);
  assert.match(soft, /let search=max\(texel,.*vec2f\(length\(rowX\),length\(rowY\)\)\*0\.5\)/);
  assert.match(soft, /clamp\(penumbra,texel,vec2f\(0\.1\)\)/);
  assert.doesNotMatch(soft, /texel\.x|length\(rowX\)\*0\.5/);
  // Live: dropping the frustum for bounds returns the receivers to today's text.
  framed.options.frustum = undefined;
  framed.options.bounds = { min: [0, 0, 0], max: [1, 1, 1] };
  plain.options.filter = 'soft';
  assert.equal(framed.shader(shader), plain.shader(shader));
});

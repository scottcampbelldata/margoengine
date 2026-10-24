// Instance motion intervals: checks, TRS packets and storage. A recording device captures uploads; no WGSL runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelPathTracer } from '../dist/index.js';
import { composeMatrix } from '@margoengine/math/mat4';
import { interpolateQuaternions } from '@margoengine/math/quat';
import { fakeDevice, fakeEngine, materials, model, settle, translate } from './support.js';

const diagonal = (x, y = 1, z = 1) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const rotationY = (angle, scale = [1, 1, 1], translation = [0, 0, 0]) => {
  const clean = (v) => (Math.abs(v) < 1e-15 ? 0 : v);
  const c = clean(Math.cos(angle)),
    s = clean(Math.sin(angle));
  return [c * scale[0], 0, -s * scale[0], 0, 0, scale[1], 0, 0, s * scale[2], 0, c * scale[2], 0, ...translation, 1];
};
const scene = (matrix, previousMatrix, motionInterpolation, size = [10, 1, 1]) => ({
  revision: 1,
  models: [model('m', size, () => 1)],
  materials: materials([1]),
  instances: [
    {
      id: 'moving',
      modelId: 'm',
      matrix,
      previousMatrix,
      ...(motionInterpolation === undefined ? {} : { motionInterpolation }),
    },
  ],
});
const attach = (source, options = {}, harness = fakeEngine()) => ({
  ...harness,
  tracer: VoxelPathTracer.attach(harness.engine, { scene: source, ...options }),
});
const point = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const near = (a, b, epsilon = 1e-5) =>
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= epsilon, `${i}: ${x} != ${b[i]}`));

for (const [label, matrix] of [
  ['180 degree rotation tangent', rotationY(Math.PI)],
  ['two interior roots with equal endpoint determinant signs', diagonal(-2, -0.5)],
  ['off-centre tangent', diagonal(-3, -3)],
  ['opposite handedness', diagonal(-1)],
  ['nearly dependent columns', [1, 1, 0, 0, 1, 1 + 1e-8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
]) {
  test(`matrix motion refuses ${label} before GPU allocation when the shutter is open`, () => {
    const harness = fakeEngine();
    assert.throws(() => attach(scene(matrix, translate(0, 0, 0)), { shutter: 0.5 }, harness), {
      name: 'RangeError',
      message: /motion interval/,
    });
    assert.equal(harness.device.buffers.length, 0);
    assert.equal(harness.engine.plugins.size, 0);
  });
}

test('a singular interval loads with the shutter closed and is refused when it opens', async () => {
  const h = attach(scene(rotationY(Math.PI), translate(0, 0, 0)));
  await h.tracer.ready;
  assert.throws(() => h.tracer.setOptions({ shutter: 1 }), { name: 'RangeError', message: /motion interval/ });
  assert.equal(h.tracer.options.shutter, 0);
  h.tracer.dispose();
});

test('hidden instances are not checked', () => {
  const source = scene(rotationY(Math.PI), translate(0, 0, 0));
  source.instances[0].visible = false;
  assert.doesNotThrow(() => attach(source, { shutter: 1 }).tracer.dispose());
});

test('unknown interpolation is refused even without previousMatrix', () => {
  for (const mode of ['quaternion', null, 1, {}])
    assert.throws(() => attach(scene(translate(0, 0, 0), undefined, mode)), {
      name: 'TypeError',
      message: /motionInterpolation/,
    });
});

test('TRS refuses shear and changing handedness instead of silently falling back', () => {
  const shear = translate(0, 0, 0);
  shear[4] = 0.25;
  for (const matrix of [shear, diagonal(-1)])
    assert.throws(() => attach(scene(matrix, translate(0, 0, 0), 'trs'), { shutter: 1 }), {
      name: 'RangeError',
      message: /TRS|trs|handedness/,
    });
});

test('failed motion setScene keeps the old scene, image and uploads', async () => {
  const h = attach(scene(translate(0, 0, 0)), { shutter: 1 });
  await h.tracer.ready;
  h.frame();
  await settle();
  h.frame();
  const stats = h.tracer.stats,
    hit = h.tracer.raycast([0.5, 4, 0.5], [0, -1, 0]),
    bytes = h.device.buffers.map((b) => new Uint8Array(b.data).slice());
  const invalid = scene(rotationY(Math.PI), translate(0, 0, 0));
  invalid.revision = 2;
  assert.throws(() => h.tracer.setScene(invalid), RangeError);
  assert.deepEqual(h.tracer.stats, stats);
  assert.deepEqual(h.tracer.raycast([0.5, 4, 0.5], [0, -1, 0]), hit);
  h.device.buffers.forEach((b, i) => assert.deepEqual(new Uint8Array(b.data), bytes[i]));
  h.tracer.dispose();
});

test('static affine shear/reflection and safe default matrix motion retain endpoint behavior', async () => {
  const shear = diagonal(-2, 3, 0.5);
  shear[4] = 0.25;
  const source = scene(shear);
  const h = attach(source);
  await h.tracer.ready;
  assert.ok(h.tracer.raycast([-0.5, 10, 0.25], [0, -1, 0]));
  const shifted = shear.slice();
  shifted[12] = 2;
  h.tracer.setScene(scene(shifted, shear));
  assert.ok(h.tracer.raycast([1.5, 10, 0.25], [0, -1, 0]));
  h.tracer.dispose();
});

async function uploaded(source) {
  const h = attach(source, { shutter: 1 });
  await h.tracer.ready;
  h.frame();
  await settle();
  h.frame();
  const group = h.device.groups.findLast((g) => g.entries.some((e) => e.binding === 3 && e.resource.buffer));
  const buffer = group.entries.find((e) => e.binding === 3).resource.buffer;
  const frame = h.device.buffers.findLast((b) => b.size === 800 && !b.destroyed);
  const uniform = new Uint32Array(frame.data),
    floats = new Float32Array(buffer.data),
    words = new Uint32Array(buffer.data);
  return { ...h, words, floats, base: uniform[45], node: uniform[46] };
}

for (const angle of [Math.PI / 2, Math.PI]) {
  test(`TRS ${(angle / Math.PI) * 180} degree native packet preserves radius, exact endpoints and swept arc`, async () => {
    const size = [10, 1, 1],
      matrix = rotationY(angle),
      previous = translate(0, 0, 0);
    const h = await uploaded(scene(matrix, previous, 'trs', size));
    const { floats: f, words: w, base: b, node } = h;
    assert.equal(node - b, 40, 'one 160-byte instance record');
    assert.equal(w[b + 37] & 9, 9, 'moving and explicit TRS flags');
    const p = w[b + 39];
    assert.ok(p >= node, 'TRS packet after the hierarchy nodes');
    const rows = (at) => Array.from({ length: 12 }, (_, i) => f[at + i]);
    near(
      rows(b + 12),
      [
        matrix[0],
        matrix[4],
        matrix[8],
        matrix[12],
        matrix[1],
        matrix[5],
        matrix[9],
        matrix[13],
        matrix[2],
        matrix[6],
        matrix[10],
        matrix[14],
      ],
      0,
    );
    near(rows(b + 24), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 0);
    const q0 = f.slice(p, p + 4),
      q1 = f.slice(p + 4, p + 8),
      s0 = f.slice(p + 8, p + 11),
      s1 = f.slice(p + 12, p + 15);
    const box = [f[node], f[node + 1], f[node + 2], f[node + 4], f[node + 5], f[node + 6]];
    for (let k = 0; k <= 64; k++) {
      const time = k / 64,
        q = interpolateQuaternions(q0, q1, time, 0.9995);
      const actual = composeMatrix(
        [0, 0, 0],
        q,
        s0.map((v, a) => v * (1 - time) + s1[a] * time),
        new Float64Array(16),
      );
      const expected = rotationY(angle * time);
      near(point(actual, [1, 0, 0]), point(expected, [1, 0, 0]));
      assert.ok(Math.abs(Math.hypot(...point(actual, [1, 0, 0])) - 1) < 1e-5);
      for (let corner = 0; corner < 8; corner++) {
        const p = point(
          expected,
          size.map((v, a) => (corner & (1 << a) ? v : 0)),
        );
        p.forEach((v, a) => assert.ok(v >= box[a] && v <= box[a + 3], 'analytic arc outside packed BVH'));
      }
    }
    h.tracer.dispose();
  });
}

test('TRS reflected nonuniform scales, translation and shortest-angle wrap retain the analytic path', async () => {
  const from = (179 * Math.PI) / 180,
    to = (-179 * Math.PI) / 180;
  const openScale = [-1, 2, 0.5],
    closeScale = [-2, 1, 1.5],
    openT = [-2, 0, 1],
    closeT = [3, 2, -1];
  const h = await uploaded(scene(rotationY(to, closeScale, closeT), rotationY(from, openScale, openT), 'trs'));
  const { floats: f, words: w, base: b, node } = h,
    p = w[b + 39];
  const q0 = f.slice(p, p + 4),
    q1 = f.slice(p + 4, p + 8);
  const box = [f[node], f[node + 1], f[node + 2], f[node + 4], f[node + 5], f[node + 6]];
  assert.ok(f[p + 8] < 0 && f[p + 12] < 0);
  for (let k = 0; k <= 128; k++) {
    const t = k / 128,
      s = openScale.map((v, a) => v * (1 - t) + closeScale[a] * t),
      position = openT.map((v, a) => v * (1 - t) + closeT[a] * t);
    const m = composeMatrix(position, interpolateQuaternions(q0, q1, t, 0.9995), s, new Float64Array(16));
    const expected = rotationY(from + t * ((2 * Math.PI) / 180), s, position);
    near([...m], expected, 3e-6);
    for (let corner = 0; corner < 8; corner++)
      point(
        expected,
        [10, 1, 1].map((v, a) => (corner & (1 << a) ? v : 0)),
      ).forEach((v, a) => assert.ok(v >= box[a] && v <= box[a + 3]));
  }
  h.tracer.dispose();
});

test('default and explicit safe matrix motion have identical row/payload bytes and retain shear', async () => {
  const previous = diagonal(-2, 3, 0.5);
  previous[4] = 0.25;
  const current = previous.slice();
  current[12] = 4;
  const a = await uploaded(scene(current, previous)),
    b = await uploaded(scene(current, previous, 'matrix'));
  assert.equal(a.node - a.base, 40);
  assert.deepEqual(a.words.slice(a.base, a.base + 40), b.words.slice(b.base, b.base + 40));
  assert.equal(a.words[a.base + 37] & 8, 0);
  assert.equal(a.words[a.base + 39], 0, 'no TRS packet');
  assert.equal(a.floats[a.base + 25], 0.25);
  a.tracer.dispose();
  b.tracer.dispose();
});

test('storage refusal is exact at the device limit', async () => {
  const source = scene(translate(0, 0, 0));
  source.instances = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    modelId: 'm',
    matrix: translate(i * 12, 0, 0),
  }));
  const first = await uploaded(source);
  assert.equal(first.node - first.base, 200 * 40);
  const group = first.device.groups.findLast((g) => g.entries.some((e) => e.binding === 3 && e.resource.buffer));
  const actual = group.entries.find((e) => e.binding === 3).resource.buffer.size;
  // buildSnapshot reserves 32 words for the existing maximum glass/mirror deflector table even when unused.
  const certified = actual + 32 * 4;
  first.tracer.dispose();
  for (const delta of [0, -1]) {
    const harness = fakeEngine(fakeDevice({ maxStorageBufferBindingSize: certified + delta }));
    const h = attach(scene(translate(0, 0, 0)), {}, harness);
    await h.tracer.ready;
    if (delta === 0) assert.doesNotThrow(() => h.tracer.setScene(source));
    else
      assert.throws(() => h.tracer.setScene(source), {
        name: 'RangeError',
        message: /records, textures and light tables/,
      });
    h.tracer.dispose();
  }
});

test('attach and device restore check storage before allocating buffers', async () => {
  const source = scene(translate(0, 0, 0));
  source.instances = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    modelId: 'm',
    matrix: translate(i * 12, 0, 0),
  }));
  const initial = await uploaded(source);
  const group = initial.device.groups.findLast((g) => g.entries.some((e) => e.binding === 3 && e.resource.buffer));
  const actual = group.entries.find((e) => e.binding === 3).resource.buffer.size;
  const limit = actual + 32 * 4 - 1;
  const device = fakeDevice({ maxStorageBufferBindingSize: limit });
  const harness = fakeEngine(device);
  assert.throws(() => attach(source, {}, harness), {
    name: 'RangeError',
    message: /records, textures and light tables/,
  });
  assert.equal(device.buffers.length, 0);
  assert.equal(harness.engine.plugins.size, 0);
  const replacement = fakeDevice({ maxStorageBufferBindingSize: limit });
  initial.engine.gpu = replacement;
  assert.throws(() => initial.tracer.onDeviceRestored(initial.engine), {
    name: 'RangeError',
    message: /records, textures and light tables/,
  });
  assert.equal(replacement.buffers.length, 0);
  initial.tracer.dispose();
});

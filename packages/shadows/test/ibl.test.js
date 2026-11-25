import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '@margoengine/bvh';
import { IBLShadows, environmentDirections, environmentDistribution } from '../dist/ibl.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4 };
const bvh = MeshBVH.build({ positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]), indices: [0, 1, 2] });

// An equirect: a dim sky, a dimmer ground and one bright patch, RGBA.
const image = (width, height, patch = [40, 8], bright = 400) => {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        sky = y < height / 2 ? 0.5 : 0.1,
        hot = Math.abs(x - patch[0]) <= 1 && Math.abs(y - patch[1]) <= 1 ? bright : 0;
      data.set([sky + hot, sky * 0.9 + hot, sky * 0.7 + hot, 1], i);
    }
  return { width, height, data };
};
// @margoengine/environment's lookup of a world direction (ibl.ts rotation, shader-common.ts equirectUv), restated.
const texelOf = (d, rotation, width, height) => {
  const c = Math.cos(rotation),
    s = Math.sin(rotation),
    e = [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]],
    u = 0.5 + Math.atan2(e[0], -e[2]) / (2 * Math.PI),
    v = Math.acos(Math.min(1, Math.max(-1, e[1]))) / Math.PI;
  return [Math.min(width - 1, Math.floor(u * width)), Math.min(height - 1, Math.floor(v * height))];
};
const lum = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

test('directions land on texels in proportion to luminance times solid angle, at any rotation', () => {
  const img = image(16, 8, [5, 2], 40),
    dist = environmentDistribution(img),
    n = 40000;
  for (const rotation of [0, 1.1, -2.5]) {
    const dirs = environmentDirections(dist, n, { rotation }),
      counts = new Float64Array(16 * 8);
    for (let k = 0; k < n; k++) {
      const d = [dirs[k * 4], dirs[k * 4 + 1], dirs[k * 4 + 2]];
      assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-6, 'unit directions');
      const [x, y] = texelOf(d, rotation, 16, 8);
      counts[y * 16 + x]++;
    }
    let total = 0;
    const share = new Float64Array(16 * 8);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 16; x++)
        total += share[y * 16 + x] = lum(img.data, (y * 16 + x) * 4) * Math.sin((Math.PI * (y + 0.5)) / 8);
    for (let i = 0; i < share.length; i++) {
      const expected = (share[i] / total) * n;
      // Halton points stratify, so the count is within a few of the expectation (Poisson would allow far more).
      assert.ok(Math.abs(counts[i] - expected) <= 3 + 0.02 * expected, `texel ${i}: ${counts[i]} vs ${expected}`);
    }
  }
});

test('the ratio estimator converges to a brute-force reference of occluded environment light', () => {
  // Receiver at the origin facing +y; a 1 x 4 roof (long in z) at height 1. V(w) is exact: the ray meets the roof square.
  const occluded = (d) => d[1] > 0 && Math.abs(d[0] / d[1]) <= 0.5 && Math.abs(d[2] / d[1]) <= 2;
  const reference = (img, rotation) => {
    // 8 x 8 points per texel, each weighted by radiance, cos and its solid angle.
    let lit = 0,
      all = 0;
    const { width, height, data } = img,
      c = Math.cos(rotation),
      s = Math.sin(rotation);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const L = lum(data, (y * width + x) * 4);
        for (let j = 0; j < 8; j++)
          for (let i = 0; i < 8; i++) {
            const theta = (Math.PI * (y + (j + 0.5) / 8)) / height,
              phi = 2 * Math.PI * ((x + (i + 0.5) / 8) / width - 0.5),
              ex = Math.sin(theta) * Math.sin(phi),
              ez = -Math.sin(theta) * Math.cos(phi),
              d = [c * ex + s * ez, Math.cos(theta), -s * ex + c * ez],
              w = L * Math.max(0, d[1]) * Math.sin(theta);
            all += w;
            if (!occluded(d)) lit += w;
          }
      }
    return lit / all;
  };
  const estimate = (dist, rotation, n) => {
    const dirs = environmentDirections(dist, n, { rotation });
    let lit = 0,
      all = 0;
    for (let k = 0; k < n; k++) {
      const d = [dirs[k * 4], dirs[k * 4 + 1], dirs[k * 4 + 2]],
        w = Math.max(0, d[1]) * dirs[k * 4 + 3];
      all += w;
      if (!occluded(d)) lit += w;
    }
    return lit / all;
  };
  // The bright patch, 50 degrees from the zenith toward -z, sits behind the roof; a quarter turn moves it off the roof.
  const img = image(64, 32, [32, 8]),
    dist = environmentDistribution(img),
    rows = [];
  for (const rotation of [0, Math.PI / 2]) {
    const want = reference(img, rotation),
      got = estimate(dist, rotation, 8192);
    rows.push([want, got]);
    assert.ok(Math.abs(got - want) < 0.01, `rotation ${rotation}: ${got} vs reference ${want}`);
  }
  assert.ok(rows[0][0] < 0.5 && rows[1][0] > rows[0][0] + 0.2, `the patch casts the roof's shadow: ${rows}`);
});

test('a black image gives zero weights; malformed images and options throw', () => {
  const black = environmentDistribution({ width: 4, height: 2, data: new Float32Array(24) });
  assert.equal(black.total, 0);
  assert.ok(environmentDirections(black, 8).every((v, i) => i % 4 !== 3 || v === 0));
  assert.throws(() => environmentDistribution({ width: 4, height: 2, data: new Float32Array(5) }), TypeError);
  assert.throws(() => environmentDistribution({ width: 1.5, height: 2, data: new Float32Array(9) }), TypeError);
  const bad = new Float32Array(32).fill(1);
  bad[4] = Number.NaN;
  assert.throws(() => environmentDistribution({ width: 4, height: 2, data: bad }), RangeError);
  bad[4] = -1;
  assert.throws(() => environmentDistribution({ width: 4, height: 2, data: bad }), RangeError);
  const img = image(8, 4, [2, 1]);
  assert.throws(() => new IBLShadows(undefined, img), TypeError);
  for (const options of [
    { rays: 0 },
    { rays: 33 },
    { rays: 2.5 },
    { history: 0 },
    { history: 257 },
    { blur: 5 },
    { strength: 1.5 },
    { bias: 0 },
    { far: Infinity },
    { rotation: Number.NaN },
    { enabled: 1 },
  ])
    assert.throws(
      () => new IBLShadows(bvh, img, options),
      'enabled' in options ? TypeError : RangeError,
      JSON.stringify(options),
    );
  const live = new IBLShadows(bvh, img);
  live.options.rays = 64;
  assert.throws(() => live.draw({}, undefined, {}), RangeError, 'options are checked again every frame');
});

const device = (limits = {}) => {
  const made = [];
  return {
    made,
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxStorageBufferBindingSize: 1 << 27,
      maxBufferSize: 1 << 28,
      ...limits,
    },
    createBuffer(d) {
      const b = {
        ...d,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      made.push(b);
      return b;
    },
    queue: { writeBuffer() {} },
  };
};

test('setup checks the stack and the device; a device restore frees the old buffers; dispose is idempotent', () => {
  const img = image(8, 4, [2, 1]);
  const loose = new IBLShadows(bvh, img);
  assert.throws(() => loose.setup({ gpu: device() }), { code: 'state' });
  const effect = new IBLShadows(bvh, img);
  effect.joinStack({});
  assert.throws(() => effect.joinStack({}), { code: 'attached' });
  assert.throws(() => effect.setup({ gpu: device({ maxStorageBuffersInFragmentStage: 0 }) }), { code: 'unsupported' });
  assert.throws(() => effect.setup({ gpu: null }), { code: 'unsupported' });
  const first = device(),
    second = device();
  effect.setup({ gpu: first, sceneOf: () => undefined });
  assert.ok(first.made.length >= 7, 'tree, settings and directions');
  effect.onDeviceRestored({ gpu: second, sceneOf: () => undefined });
  assert.ok(
    first.made.every((b) => b.destroyed),
    'the lost device keeps nothing',
  );
  effect.dispose();
  effect.dispose();
  assert.ok(second.made.every((b) => b.destroyed));
  assert.throws(() => effect.setup({ gpu: device() }), { code: 'disposed' });
});

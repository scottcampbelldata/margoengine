// bakeGlobalLightmap({ bounceMode: 'path' }): per-texel path-traced bounces. Bounds: a closed furnace has an exact
// geometric series per bounce; an emitting strip's first bounce is checked against a numerical form-factor integral.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeGlobalLightmap } from '../dist/global.js';

/** A quad centred at `c` spanning 2 * `a` and 2 * `b`, wound so its normal faces `inward` (or away from c). */
function face(c, a, b, toward) {
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  if (n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] < 0) [a, b] = [b, a];
  const at = (s, t) => [0, 1, 2].map((k) => c[k] + s * a[k] + t * b[k]);
  return [...at(-1, -1), ...at(1, -1), ...at(1, 1), ...at(-1, 1)];
}

/** The six inward faces of the cube from -1 to 1. */
const cube = () => {
  const out = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const c = [0, 0, 0],
        a = [0, 0, 0],
        b = [0, 0, 0];
      c[axis] = side;
      a[(axis + 1) % 3] = 1;
      b[(axis + 2) % 3] = 1;
      out.push(
        ...face(
          c,
          a,
          b,
          c.map((v) => -v),
        ),
      );
    }
  return new Float32Array(out);
};

/** Decoded lightmap values of chart `k`, channel 0, with each texel's centre. */
function texels(out, positions, k) {
  const c = out.charts[k],
    q = positions.subarray(k * 12, k * 12 + 12),
    list = [];
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const s = (x + 0.5) / c.width,
        t = (y + 0.5) / c.height;
      list.push({
        value: (out.textures.lightmap[((c.y + y) * out.width + c.x + x) * 4] / 255) * out.lightmapScale,
        point: [0, 1, 2].map((a) => q[a] + (q[3 + a] - q[a]) * s + (q[9 + a] - q[a]) * t),
      });
    }
  return list;
}
const average = (list) => list.reduce((sum, t) => sum + t.value, 0) / list.length;

test('a closed furnace: eight path bounces give the exact geometric series on every texel', async () => {
  const positions = cube(),
    rho = 0.5,
    quads = {
      positions,
      albedo: new Float32Array(24).fill(rho).map((v, i) => (i % 4 === 3 ? 1 : v)),
      emission: new Float32Array(18).fill(1),
    },
    options = { texelsPerUnit: 2, padding: 1, aoRays: 1, bounces: 8, bounceRays: 4, bounceMode: 'path' };
  // Every path hits a wall that emits 1 and reflects rho: radiance sum_{k<8} rho^k, irradiance pi times that.
  const series = (1 - rho ** 8) / (1 - rho);
  for (const [radiometry, expected] of [
    ['physical', Math.PI * series],
    ['legacy', series],
  ]) {
    const out = await bakeGlobalLightmap(quads, { ...options, radiometry });
    for (let k = 0; k < 6; k++)
      for (const t of texels(out, positions, k))
        assert.ok(Math.abs(t.value - expected) < 1e-4 * expected, `${t.value}`);
  }
  // Quad radiosity agrees where it can: two bounces either way.
  const two = (1 + rho) * Math.PI,
    path = await bakeGlobalLightmap(quads, { ...options, bounces: 2, radiometry: 'physical' }),
    quad = await bakeGlobalLightmap(quads, { ...options, bounces: 2, bounceMode: 'quad', radiometry: 'physical' });
  for (const out of [path, quad]) assert.ok(Math.abs(average(texels(out, positions, 0)) - two) < 1e-4 * two);
});

test('emissive lights plus path bounces count the emission once', async () => {
  const positions = cube(),
    rho = 0.6,
    quads = {
      positions,
      albedo: new Float32Array(24).fill(rho).map((v, i) => (i % 4 === 3 ? 1 : v)),
      emission: new Float32Array(18).fill(1),
    },
    options = {
      texelsPerUnit: 4,
      padding: 1,
      aoRays: 1,
      emissiveLights: true,
      areaSamples: 16,
      bounceRays: 8,
      bounceMode: 'path',
      radiometry: 'physical',
      maxRays: 67_108_864,
    },
    mean = (out) => {
      let all = 0;
      for (let k = 0; k < 6; k++) all += average(texels(out, positions, k)) / 6;
      return all;
    },
    // The same seed samples the same direct light; the walls then reflect rho of it per bounce, never the emission
    // again (the rectangles already carried it).
    direct = mean(await bakeGlobalLightmap(quads, { ...options, bounces: 0 })),
    bounced = mean(await bakeGlobalLightmap(quads, { ...options, bounces: 3 })),
    expected = direct * (1 + rho + rho ** 2 + rho ** 3);
  assert.ok(Math.abs(bounced - expected) < 0.02 * expected, `${bounced} expected ${expected}`);
  // The direct term itself: five walls fill the hemisphere, pi; sampled with 16 rays per wall, within 10%.
  assert.ok(Math.abs(direct - Math.PI) < 0.1 * Math.PI, `${direct}`);
});

test('path bounces follow light across a quad; quad means smear it', async () => {
  // A 4 x 4 floor whose strip x < -1.5 emits 1, and two walls 2 high at x = -2 and x = 2 facing each other.
  const floor = face([0, 0, 0], [2, 0, 0], [0, 0, 2], [0, 1, 0]),
    near = face([-2, 1, 0], [0, 1, 0], [0, 0, 2], [1, 0, 0]),
    far = face([2, 1, 0], [0, 1, 0], [0, 0, 2], [-1, 0, 0]),
    positions = new Float32Array([...floor, ...near, ...far]),
    surface = (t) => ({ emission: t.quad === 0 && t.position[0] < -1.5 ? [1, 1, 1] : [0, 0, 0] }),
    options = {
      texelsPerUnit: 8,
      padding: 1,
      aoRays: 1,
      bounces: 1,
      bounceRays: 32,
      radiometry: 'physical',
      surface,
      seed: 7,
    },
    path = await bakeGlobalLightmap({ positions }, { ...options, bounceMode: 'path' }),
    quad = await bakeGlobalLightmap({ positions }, options);
  // Reference: E(P) = integral over the strip of cos_w cos_s / r^2 dA (radiance 1), midpoint rule 64 x 512.
  const reference = (point, normal) => {
    let sum = 0;
    const nx = 64,
      nz = 512,
      dx = 0.5 / nx,
      dz = 4 / nz;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        const d = [-2 + (i + 0.5) * dx - point[0], -point[1], -2 + (j + 0.5) * dz - point[2]],
          r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2],
          cosW = (d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]) / Math.sqrt(r2),
          cosS = point[1] / Math.sqrt(r2);
        if (cosW > 0) sum += (cosW * cosS * dx * dz) / r2;
      }
    return sum;
  };
  const check = (out, k, normal) => {
    const list = texels(out, positions, k);
    return { baked: average(list), truth: list.reduce((s, t) => s + reference(t.point, normal), 0) / list.length };
  };
  const nearPath = check(path, 1, [1, 0, 0]),
    farPath = check(path, 2, [-1, 0, 0]),
    nearQuad = check(quad, 1, [1, 0, 0]),
    farQuad = check(quad, 2, [-1, 0, 0]);
  // 512 texels x 32 rays per wall: the near wall's mean is within 5%, the far wall's (fewer hits) within 15%.
  assert.ok(Math.abs(nearPath.baked - nearPath.truth) < 0.05 * nearPath.truth, JSON.stringify(nearPath));
  assert.ok(Math.abs(farPath.baked - farPath.truth) < 0.15 * farPath.truth, JSON.stringify(farPath));
  // The quad mean spreads the strip's light over the whole floor: the near wall gets too little, the far too much.
  assert.ok(nearQuad.baked < 0.75 * nearQuad.truth, JSON.stringify(nearQuad));
  assert.ok(farQuad.baked > 2 * farQuad.truth, JSON.stringify(farQuad));
});

test('path mode checks its options and is seeded', async () => {
  const positions = cube(),
    options = { texelsPerUnit: 1, padding: 1, aoRays: 1, bounces: 3, bounceRays: 2, bounceMode: 'path', seed: 9 },
    quads = { positions, emission: new Float32Array(18).fill(1), albedo: new Float32Array(24).fill(0.5) };
  await assert.rejects(bakeGlobalLightmap(quads, { ...options, bounces: 9 }), /bounces must be an integer from 0 to 8/);
  await assert.rejects(
    bakeGlobalLightmap(quads, { ...options, bounces: 3, bounceMode: 'quad' }),
    /bounces must be an integer from 0 to 2/,
  );
  await assert.rejects(bakeGlobalLightmap(quads, { ...options, bounces: 1, bounceMode: 'paths' }), /bounceMode/);
  await assert.rejects(bakeGlobalLightmap(quads, { ...options, maxRays: 10 }), /maxRays/);
  const a = await bakeGlobalLightmap(quads, options),
    b = await bakeGlobalLightmap(quads, options);
  assert.deepEqual(a.textures.lightmap, b.textures.lightmap);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeGlobalLightmap } from '../dist/global.js';
import { bakeLightmap, lightingAsset } from '../dist/index.js';

const floor = (half = 0.5, y = 0) => [-half, y, -half, -half, y, half, half, y, half, half, y, -half];
const ceiling = (half = 0.5, y = 2) => [-half, y, -half, half, y, -half, half, y, half, -half, y, half];
const base = { texelsPerUnit: 2, padding: 1, maxAtlasSize: 64, aoRays: 1, seed: 3 };
/** Mean decoded irradiance of a chart's texels, per channel. */
const mean = (out, chart = 0) => {
  const c = out.charts[chart],
    sum = [0, 0, 0];
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      for (let k = 0; k < 3; k++) sum[k] += out.textures.lightmap[((c.y + y) * out.width + c.x + x) * 4 + k];
  return sum.map((v) => (v / 255 / (c.width * c.height)) * out.lightmapScale);
};
const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} expected ${expected} ± ${tolerance}`);
const panel = (y = 2, size = 1, intensity = 1) => ({
  position: [0, y, 0],
  direction: [0, -1, 0],
  width: size,
  height: size,
  intensity,
});

test('a rectangle light matches the closed-form irradiance and ignores receiver albedo', async () => {
  // Unit radiance square of half-width a at height h above the receiver: E = 4 k atan(k), k = a / hypot(a, h).
  const k = 0.5 / Math.hypot(0.5, 2),
    expected = 4 * k * Math.atan(k),
    options = { ...base, texelsPerUnit: 16, radiometry: 'physical', areaLights: [panel()], areaSamples: 16 },
    white = await bakeGlobalLightmap({ positions: new Float32Array(floor(0.125)) }, options),
    grey = await bakeGlobalLightmap(
      { positions: new Float32Array(floor(0.125)), albedo: new Float32Array([0.5, 0.5, 0.5, 1]) },
      options,
    );
  near(mean(white)[0], expected, 0.01 * expected, 'physical');
  assert.deepEqual(mean(grey), mean(white));
  const legacy = await bakeGlobalLightmap(
    { positions: new Float32Array(floor(0.125)) },
    { ...options, radiometry: 'legacy' },
  );
  near(mean(legacy)[0], expected / Math.PI, 0.01 * expected, 'legacy keeps its 1/pi');
  // A one-sided light facing away gives nothing.
  const away = await bakeGlobalLightmap(
    { positions: new Float32Array(floor()) },
    {
      ...base,
      areaLights: [{ ...panel(), direction: [0, 1, 0] }],
    },
  );
  assert.equal(mean(away)[0], 0);
});

test('transmission drops alpha quads from area shadows but not opaque ones', async () => {
  const positions = new Float32Array([...floor(), ...ceiling(0.5, 1)]),
    options = { ...base, areaLights: [panel(2, 1, 4)] },
    blocked = await bakeGlobalLightmap({ positions, albedo: new Float32Array(8).fill(1) }, options),
    alpha = new Float32Array([1, 1, 1, 1, 1, 1, 1, 0.5]),
    passing = await bakeGlobalLightmap({ positions, albedo: alpha }, { ...options, transmission: true }),
    opaque = await bakeGlobalLightmap({ positions, albedo: alpha }, options);
  assert.equal(mean(blocked)[0], 0);
  assert.equal(mean(opaque)[0], 0);
  assert.ok(mean(passing)[0] > 0.1);
});

test('emissive quads light the others, through omitted alpha quads and not through opaque ones', async () => {
  const away = [20, 0, 0, 20, 0, 1, 21, 0, 1, 21, 0, 0],
    options = { ...base, emissiveLights: true, transmission: true },
    bake = (cover) =>
      bakeGlobalLightmap(
        {
          positions: new Float32Array([...away, ...floor(), ...ceiling(), ...(cover ? ceiling(0.5, 1) : [])]),
          albedo: new Float32Array([1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, ...(cover ? [1, 1, 1, 1] : [])]),
          emission: new Float32Array([0, 0, 0, 0, 0, 0, 5, 5, 5, ...(cover ? [0, 0, 0] : [])]),
        },
        options,
      );
  assert.ok(mean(await bake(false), 1)[0] > 0.1);
  assert.equal(mean(await bake(true), 1)[0], 0, 'the opaque cover blocks, with face ids shifted by the omitted quad');
});

test('callback emission makes each emitting texel a light at its own place, within maxRays', async () => {
  // The ceiling emits only over x < 0; the floor below that half receives more.
  const positions = new Float32Array([...floor(2), ...ceiling(2, 1)]),
    options = {
      ...base,
      texelsPerUnit: 1,
      radiometry: 'physical',
      emissiveLights: true,
      surface: ({ quad, position }) => ({ emission: quad === 1 && position[0] < 0 ? [10, 10, 10] : [0, 0, 0] }),
    },
    out = await bakeGlobalLightmap({ positions }, options),
    c = out.charts[0],
    // Chart rows follow the floor's second edge, p0 -> p3, which runs along +x.
    row = (y) => out.textures.lightmap[((c.y + y) * out.width + c.x + 1) * 4];
  assert.ok(row(0) > 2 * row(3), `the half under the emitting texels is brighter: ${row(0)} vs ${row(3)}`);
  // 32 texels, 8 of them emitting, 2 x 2 shadow rays each: counted before any per-texel light is built.
  await assert.rejects(
    () => bakeGlobalLightmap({ positions }, { ...options, maxRays: out.rays }),
    /need 1024 more rays, over maxRays/,
  );
});

// Independent ray/plane oracle for three horizontal sheets: it follows the bake's seeded cosine rays and counts
// which sheet each hits, misses included.
function sheetCounts(seed, rays, orders) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sheets = [
    { y: 0, half: 4, normal: 1 },
    { y: 2, half: 1, normal: -1 },
    { y: 1, half: 0.125, normal: 1 },
  ];
  return Array.from({ length: orders }, () =>
    sheets.map((sheet) => {
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < rays; i++) {
        const u = random(),
          phi = 2 * Math.PI * random(),
          dx = Math.sqrt(u) * Math.cos(phi),
          dy = sheet.normal * Math.sqrt(1 - u),
          dz = -sheet.normal * Math.sqrt(u) * Math.sin(phi),
          originY = sheet.y + sheet.normal * 0.001;
        let nearest = Infinity,
          seen = 3;
        sheets.forEach((target, q) => {
          const distance = (target.y - originY) / dy;
          if (
            dy * target.normal < 0 &&
            distance >= 0.001 &&
            distance < nearest &&
            Math.abs(dx * distance) <= target.half &&
            Math.abs(dz * distance) <= target.half
          ) {
            nearest = distance;
            seen = q;
          }
        });
        counts[seen]++;
      }
      return counts;
    }),
  );
}
const sheets = {
  positions: new Float32Array([...floor(4, 0), ...ceiling(1, 2), ...floor(0.125, 1)]),
  albedo: new Float32Array([0, 0, 0, 1, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1]),
};
const oneTexel = { texelsPerUnit: 0.125, padding: 1, maxAtlasSize: 32, aoRays: 1 };

test('bounces relay light quad to quad, and missed rays count as zero', async () => {
  // Order one: the ceiling gathers the emitting floor; order two: the small sheet gathers the ceiling.
  for (const seed of [0, 1, 3]) {
    const counts = sheetCounts(seed, 32, 2),
      expected = ((counts[0][1][0] / 32) * 0.5 * counts[1][2][1]) / 32,
      out = await bakeGlobalLightmap(
        { ...sheets, emission: new Float32Array([1, 1, 1, 0, 0, 0, 0, 0, 0]) },
        { ...oneTexel, seed, bounceRays: 32, bounces: 2 },
      );
    assert.ok(counts[0][1][3] > 0, 'some ceiling rays miss');
    near(mean(out, 2)[0], expected, out.lightmapScale / 510 + 1e-7, `seed ${seed}`);
  }
  // A black emitter reflects nothing into a second order.
  const input = {
      positions: new Float32Array([...floor(4, 0), ...ceiling(0.5, 2)]),
      albedo: new Float32Array([0, 0, 0, 1, 1, 1, 1, 1]),
      emission: new Float32Array([1, 1, 1, 0, 0, 0]),
    },
    one = await bakeGlobalLightmap(input, { ...oneTexel, bounceRays: 1, bounces: 1 }),
    two = await bakeGlobalLightmap(input, { ...oneTexel, bounceRays: 1, bounces: 2 });
  assert.equal(mean(one, 1)[0], 1);
  assert.equal(mean(two, 1)[0], 1);
  assert.equal(two.rays - one.rays, two.samples);
});

test('HDR emission bounces stay finite', async () => {
  const counts = sheetCounts(0, 32, 2),
    expected = ((counts[0][1][0] / 32) * 0.5 * counts[1][2][1]) / 32,
    out = await bakeGlobalLightmap(sheets, {
      ...oneTexel,
      seed: 0,
      bounceRays: 32,
      bounces: 2,
      surface: ({ quad }) => ({ emission: quad === 0 ? [1e308, 5e307, 0] : [0, 0, 0] }),
    });
  assert.ok(Number.isFinite(out.lightmapScale));
  near(mean(out, 2)[0] / 1e308, expected, out.lightmapScale / 1e308 / 510 + 1e-7);
});

// Glass: a floor under a closed box from y = low to high (x and z from -1 to 2), lit straight down.
const box = (low = 1, high = 2) =>
  [
    [-1, low, -1, 2, low, -1, 2, low, 2, -1, low, 2],
    [-1, high, -1, -1, high, 2, 2, high, 2, 2, high, -1],
    [-1, low, -1, -1, low, 2, -1, high, 2, -1, high, -1],
    [2, low, -1, 2, high, -1, 2, high, 2, 2, low, 2],
    [-1, low, -1, -1, high, -1, 2, high, -1, 2, low, -1],
    [-1, low, 2, 2, low, 2, 2, high, 2, -1, high, 2],
  ].flat();
const unitFloor = [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0];
const glass = (offset = 1, more = {}) => ({
  quads: [0, 1, 2, 3, 4, 5].map((i) => offset + i),
  attenuationColor: [0.25, 0.5, 1],
  attenuationDistance: 1,
  ior: 1,
  ...more,
});
const sun = { ...base, texelsPerUnit: 1, aoDistance: 0.01, lights: [{ type: 'directional', direction: [0, 1, 0] }] };
const lit = (out) => mean(out).map((v) => Math.round(v * 100) / 100);

test('glass casts coloured shadows: Beer absorption over the path, Fresnel at each boundary', async () => {
  for (const thickness of [1, 2]) {
    const out = await bakeGlobalLightmap(
      { positions: new Float32Array([...unitFloor, ...box(1, 1 + thickness)]) },
      { ...sun, glassVolumes: [glass()] },
    );
    assert.deepEqual(
      lit(out),
      [0.25 ** thickness, 0.5 ** thickness, 1].map((v) => Math.round(v * 100) / 100),
    );
  }
  const fresnel = await bakeGlobalLightmap(
    { positions: new Float32Array([...unitFloor, ...box()]) },
    { ...sun, glassVolumes: [glass(1, { attenuationColor: [1, 1, 1], factor: 0.8, ior: 1.5 })] },
  );
  near(mean(fresnel)[0], 0.8 * 0.96 ** 2, 0.006);
  // Two volumes multiply; an opaque quad under the glass still blocks fully.
  const two = await bakeGlobalLightmap(
    { positions: new Float32Array([...unitFloor, ...box(), ...box(3, 4)]) },
    { ...sun, glassVolumes: [glass(), glass(7)] },
  );
  assert.deepEqual(lit(two), [0.06, 0.25, 1]);
  const covered = await bakeGlobalLightmap(
    {
      positions: new Float32Array([
        ...unitFloor,
        ...box(),
        ...ceiling(0.5, 0.5).map((v, i) => (i % 3 === 1 ? v : v + 0.5)),
      ]),
    },
    { ...sun, glassVolumes: [glass()] },
  );
  assert.deepEqual(lit(covered), [0, 0, 0]);
});

test('a light inside glass absorbs only its own path; black channels stay black on short paths', async () => {
  const out = await bakeGlobalLightmap(
    { positions: new Float32Array([...unitFloor, ...box(1, 2)]) },
    {
      ...sun,
      radiometry: 'physical',
      lights: [{ type: 'point', position: [0.5, 1.5, 0.5], decay: 0 }],
      glassVolumes: [glass(1, { attenuationColor: [0, 0.5, 1], attenuationDistance: 1e-30 })],
    },
  );
  const [r, , b] = mean(out);
  assert.equal(r, 0);
  assert.ok(b > 0);
});

test('glass volumes must be closed, convex, outward and own their quads', async () => {
  const positions = new Float32Array([...unitFloor, ...box()]);
  for (const [volumes, pattern] of [
    [[glass(1, { quads: [1, 2, 3, 4, 5] })], /closed/],
    [[{ ...glass(), quads: [1, 2, 3, 4, 5, 9] }], /quad indices/],
    [[glass(), glass()], /one volume/],
    [[glass(1, { ior: 0.5 })], /IOR/],
  ])
    await assert.rejects(() => bakeGlobalLightmap({ positions }, { ...sun, glassVolumes: volumes }), pattern);
  // Every quad reversed: still closed, but wound inward.
  const quads = box(),
    inward = [];
  for (let q = 0; q < 6; q++)
    for (const c of [0, 3, 2, 1]) inward.push(...quads.slice(q * 12 + c * 3, q * 12 + c * 3 + 3));
  await assert.rejects(
    () =>
      bakeGlobalLightmap(
        { positions: new Float32Array([...unitFloor, ...inward]) },
        { ...sun, glassVolumes: [glass()] },
      ),
    /convex with outward winding/,
  );
});

test('budgets cover the extra pass, options are checked, and lightingAsset records the terms', async () => {
  await assert.rejects(() => bakeGlobalLightmap({ positions: new Float32Array(floor()) }, { bounces: 3 }), /bounces/);
  await assert.rejects(
    () => bakeGlobalLightmap({ positions: new Float32Array(floor()) }, { areaLights: [{ ...panel(), width: 0 }] }),
    RangeError,
  );
  await assert.rejects(
    () =>
      bakeGlobalLightmap({ positions: new Float32Array(floor()) }, { areaLights: [{ ...panel(), height: Infinity }] }),
    /width and height must be finite and positive/,
  );
  const plain = await bakeGlobalLightmap({ positions: new Float32Array(floor()) }, { ...base, areaLights: [panel()] });
  await assert.rejects(
    () =>
      bakeGlobalLightmap(
        { positions: new Float32Array(floor()) },
        { ...base, areaLights: [panel()], maxRays: plain.rays - 1 },
      ),
    /maxRays/,
  );
  // lightingAsset lives on the plain entry and describes any bake.
  const physical = await bakeLightmap({ positions: new Float32Array(floor()) }, { ...base, radiometry: 'physical' });
  assert.deepEqual(lightingAsset(physical, { area: true }), {
    lightmapScale: 1,
    emissionScale: 1,
    width: physical.width,
    height: physical.height,
    radiometry: 'physical',
    response: 'lambertian',
    terms: { direct: true, occlusion: false, indirect: false, emissive: false, area: true, transmission: false },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => bakeGlobalLightmap({ positions: new Float32Array(floor()) }, { signal: controller.signal }),
    /abort/i,
  );
});

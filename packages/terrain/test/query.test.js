import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainQuery } from '../dist/query.js';

// A seeded rough grid: hills plus per-texel noise, so cells are twisted (bilinear, not planar) and the tree has work.
function grid(columns, rows, seed = 1) {
  let s = seed >>> 0;
  const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const heights = new Float32Array(columns * rows);
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < columns; x++)
      heights[z * columns + x] = 0.3 * Math.sin(x * 0.21) * Math.cos(z * 0.17) + 0.08 * random();
  return { heights, random };
}
const options = { origin: [-40, 25], size: [96, 72], heightScale: 30, heightOffset: -4 };

// The shader's height (shader.ts `height`), written out again here: bilinear, texel 0 at origin, last at origin + size.
function shaderHeight(q, x, z) {
  const c = q.columns,
    r = q.rows,
    px = Math.min(Math.max((x - options.origin[0]) / options.size[0], 0), 1) * (c - 1),
    pz = Math.min(Math.max((z - options.origin[1]) / options.size[1], 0), 1) * (r - 1),
    x0 = Math.floor(px),
    z0 = Math.floor(pz),
    x1 = Math.min(x0 + 1, c - 1),
    z1 = Math.min(z0 + 1, r - 1),
    h = (i, j) => q.heights[j * c + i],
    a = h(x0, z0) * (1 - (px - x0)) + h(x1, z0) * (px - x0),
    b = h(x0, z1) * (1 - (px - x0)) + h(x1, z1) * (px - x0);
  return (a * (1 - (pz - z0)) + b * (pz - z0)) * options.heightScale + options.heightOffset;
}

// Brute force first hit: f(t) = ray y - height, sampled every 1 mm along the ray, then bisected. Independent of the
// tree and of the quadratic solve.
function bruteForce(q, o, d, max) {
  const length = Math.hypot(...d),
    v = d.map((c) => c / length),
    inside = (t) => {
      const x = o[0] + v[0] * t,
        z = o[2] + v[2] * t;
      return (
        x >= options.origin[0] &&
        x <= options.origin[0] + options.size[0] &&
        z >= options.origin[1] &&
        z <= options.origin[1] + options.size[1]
      );
    },
    f = (t) => o[1] + v[1] * t - shaderHeight(q, o[0] + v[0] * t, o[2] + v[2] * t),
    step = 0.001;
  let previous = 0,
    prev = inside(0) ? f(0) : NaN;
  for (let t = step; t <= max; t += step) {
    if (!inside(t)) {
      prev = NaN;
      previous = t;
      continue;
    }
    const value = f(t);
    if (!Number.isNaN(prev) && Math.sign(value) !== Math.sign(prev)) {
      let a = previous,
        b = t;
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2;
        if (Math.sign(f(m)) === Math.sign(prev)) a = m;
        else b = m;
      }
      return (a + b) / 2;
    }
    prev = value;
    previous = t;
  }
  return undefined;
}

test('height is the bilinear surface the vertex shader samples, undefined outside the map', () => {
  const { heights, random } = grid(49, 37),
    q = new TerrainQuery(heights, 49, 37, options);
  // Texels exactly: texel (i, j) sits at origin + (i, j) * size / (count - 1).
  for (const [i, j] of [
    [0, 0],
    [48, 36],
    [17, 9],
    [48, 0],
  ]) {
    const x = options.origin[0] + (i * options.size[0]) / 48,
      z = options.origin[1] + (j * options.size[1]) / 36;
    assert.ok(Math.abs(q.height(x, z) - (heights[j * 49 + i] * 30 - 4)) < 1e-9);
  }
  for (let k = 0; k < 500; k++) {
    const x = options.origin[0] + random() * options.size[0],
      z = options.origin[1] + random() * options.size[1];
    assert.ok(Math.abs(q.height(x, z) - shaderHeight(q, x, z)) < 1e-9);
  }
  assert.equal(q.height(options.origin[0] - 0.01, 30), undefined);
  assert.equal(q.height(0, options.origin[1] + options.size[1] + 0.01), undefined);
  assert.equal(q.normal(-1000, 0), undefined);
});

test('normal follows the shader: central differences one texel either way, clamped at the edges', () => {
  const { heights, random } = grid(33, 33, 7),
    q = new TerrainQuery(heights, 33, 33, options),
    sx = options.size[0] / 32,
    sz = options.size[1] / 32;
  for (let k = 0; k < 200; k++) {
    const x = options.origin[0] + random() * options.size[0],
      z = options.origin[1] + random() * options.size[1],
      n = [
        (shaderHeight(q, x - sx, z) - shaderHeight(q, x + sx, z)) / (2 * sx),
        1,
        (shaderHeight(q, x, z - sz) - shaderHeight(q, x, z + sz)) / (2 * sz),
      ],
      length = Math.hypot(...n),
      got = q.normal(x, z);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - n[c] / length) < 1e-9);
  }
  // A plane's normal is the plane's.
  const plane = new Float32Array(16 * 16);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) plane[z * 16 + x] = x * 0.1;
  const p = new TerrainQuery(plane, 16, 16, { size: [15, 15], heightScale: 10 }),
    n = p.normal(7.3, 4.1);
  assert.ok(Math.abs(n[0] + 1 / Math.SQRT2) < 1e-6 && Math.abs(n[1] - 1 / Math.SQRT2) < 1e-6 && Math.abs(n[2]) < 1e-9);
});

test('raycast finds the first hit a brute-force march finds, from any angle', () => {
  const { heights, random } = grid(49, 37, 3),
    q = new TerrainQuery(heights, 49, 37, options);
  let hits = 0,
    misses = 0;
  for (let k = 0; k < 120; k++) {
    // Rays from above the hills at shallow to steep angles, some starting outside the map.
    const o = [options.origin[0] - 10 + random() * 106, 2 + random() * 30, options.origin[1] - 10 + random() * 82],
      d = [random() * 2 - 1, -0.15 - random() * 0.8, random() * 2 - 1],
      max = 140,
      want = bruteForce(q, o, d, max),
      got = q.raycast(o, d, max);
    if (want === undefined) {
      assert.equal(got, null, `ray ${k} should miss`);
      misses++;
      continue;
    }
    assert.ok(got, `ray ${k} should hit at ${want}`);
    assert.ok(Math.abs(got.distance - want) < 2e-3, `ray ${k}: ${got.distance} against ${want}`);
    // On the surface: the hit's height is the terrain's height there.
    assert.ok(Math.abs(got.position[1] - q.height(got.position[0], got.position[2])) < 1e-6);
    hits++;
  }
  assert.ok(hits > 60 && misses > 3, `${hits} hits, ${misses} misses`);
});

test('raycast straight down lands on height(x, z); from below it hits the underside; maxDistance and the map clip it', () => {
  const { heights, random } = grid(65, 65, 11),
    q = new TerrainQuery(heights, 65, 65, options);
  for (let k = 0; k < 200; k++) {
    const x = options.origin[0] + random() * options.size[0],
      z = options.origin[1] + random() * options.size[1],
      hit = q.raycast([x, 100, z], [0, -1, 0]);
    assert.ok(Math.abs(hit.position[1] - q.height(x, z)) < 1e-9);
    assert.ok(Math.abs(hit.distance - (100 - q.height(x, z))) < 1e-9);
    const up = q.raycast([x, -200, z], [0, 1, 0]);
    assert.ok(Math.abs(up.position[1] - q.height(x, z)) < 1e-9);
  }
  assert.equal(q.raycast([0, 100, 50], [0, -1, 0], 10), null);
  assert.equal(q.raycast([-500, 100, 50], [0, -1, 0]), null);
  assert.equal(q.raycast([0, 100, 50], [0, 1, 0]), null);
  // A horizontal ray at a height between the hills hits the first one it meets.
  const flat = new Float32Array(9 * 9);
  flat[4 * 9 + 6] = 1;
  const f = new TerrainQuery(flat, 9, 9, { size: [8, 8], heightScale: 4 }),
    side = f.raycast([0.5, 1, 4], [1, 0, 0]);
  // The bump at texel (6, 4) rises linearly from x = 5 to 6 along z = 4: height 4 (x - 5), so y = 1 at x = 5.25.
  assert.ok(Math.abs(side.position[0] - 5.25) < 1e-9, side.position);
});

test('the hit is a FootIK GroundHit, and an out hit is reused with no new object', () => {
  const { heights } = grid(17, 17),
    q = new TerrainQuery(heights, 17, 17, options),
    out = { distance: 0, position: [0, 0, 0], normal: [0, 0, 0] },
    raycast = (origin, direction) => q.raycast(origin, direction);
  const hit = raycast([0, 50, 50], [0, -1, 0]);
  assert.equal(hit.position.length, 3);
  assert.ok(Math.abs(Math.hypot(...hit.normal) - 1) < 1e-12 && hit.normal[1] > 0);
  assert.equal(q.raycast([0, 50, 50], [0, -1, 0], Infinity, out), out);
  assert.deepEqual(out.position, hit.position);
});

test('refresh rebuilds the tree after heights change in place; without it a raised cell is skipped', () => {
  const heights = new Float32Array(257 * 257),
    q = new TerrainQuery(heights, 257, 257, { size: [256, 256], heightScale: 1 });
  // A tower at texels (200..201, 40..41): a ray that passes 5 m above flat ground meets it only if the tree knows.
  for (const [x, z] of [
    [200, 40],
    [201, 40],
    [200, 41],
    [201, 41],
  ])
    heights[z * 257 + x] = 10;
  assert.equal(q.raycast([0, 5, 40.5], [1, 0, 0]), null, 'stale tree: the edit is not seen');
  q.refresh(200, 40, 2, 2);
  const hit = q.raycast([0, 5, 40.5], [1, 0, 0]);
  assert.ok(hit && hit.position[0] > 199 && hit.position[0] < 200.5, hit?.position);
  heights[40 * 257 + 200] = NaN;
  assert.throws(() => q.refresh(200, 40, 1, 1), /not finite/);
});

test('a large map answers rays through few cells', () => {
  const { heights, random } = grid(1025, 1025, 5),
    q = new TerrainQuery(heights, 1025, 1025, { size: [1024, 1024], heightScale: 30 });
  // Diagnostic timing on this machine only; the assertion is on correctness against a downward probe.
  for (let k = 0; k < 2000; k++) {
    // Starts far enough from the +X and +Z edges that the ray meets the ground before it leaves the map.
    const x = random() * 1000,
      z = random() * 1000,
      hit = q.raycast([x, 60, z], [0.3, -1, 0.2]);
    assert.ok(hit && Math.abs(hit.position[1] - q.height(hit.position[0], hit.position[2])) < 1e-6);
  }
});

test('invalid grids, options and rays throw', () => {
  assert.throws(() => new TerrainQuery([0, 0, 0, 0], 2, 2, { size: [1, 1] }), RangeError);
  assert.throws(() => new TerrainQuery(new Float32Array(4), 1, 4, { size: [1, 1] }), RangeError);
  assert.throws(() => new TerrainQuery(new Float32Array(4), 2, 2, { size: [0, 1] }), RangeError);
  assert.throws(() => new TerrainQuery(new Float32Array([0, NaN, 0, 0]), 2, 2, { size: [1, 1] }), /not finite/);
  const q = new TerrainQuery(new Float32Array(4), 2, 2, { size: [1, 1] });
  assert.throws(() => q.raycast([0, 1, 0], [0, 0, 0]), TypeError);
  assert.throws(() => q.raycast([NaN, 1, 0], [0, -1, 0]), TypeError);
  assert.ok(q.raycast([0.5, 1, 0.5], [0, -1, 0]));
});

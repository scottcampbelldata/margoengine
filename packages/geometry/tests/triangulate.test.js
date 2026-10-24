import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triangulate } from '../dist/index.js';

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/triangulate-vectors.json', import.meta.url), 'utf8'),
).triangulate;

// ---------- helpers (first principles, independent of the package) ----------

const point = (data, dim, i) => [data[i * dim], data[i * dim + 1]];
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const ringArea = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
};
/** Rings of a flat polygon: outer then holes. */
function rings(data, holes = [], dim = 2) {
  const n = Math.floor(data.length / dim),
    starts = [0, ...holes, n],
    out = [];
  for (let r = 0; r + 1 < starts.length; r++) {
    const ring = [];
    for (let i = starts[r]; i < starts[r + 1]; i++) ring.push(point(data, dim, i));
    out.push(ring);
  }
  return out;
}
/** Winding number of a ring around p (p not on the ring). */
function winding(ring, p) {
  let w = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && cross(a, b, p) > 0) w++;
    } else if (b[1] <= p[1] && cross(a, b, p) < 0) w--;
  }
  return w;
}
/** Sum of triangle areas, the number of triangles that are not counter-clockwise, and the vertices used. */
function measure(data, indices, dim = 2) {
  let area = 0,
    notCCW = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a =
      cross(point(data, dim, indices[t]), point(data, dim, indices[t + 1]), point(data, dim, indices[t + 2])) / 2;
    if (!(a > 0)) notCCW++;
    area += a;
  }
  return { area, notCCW, used: new Set(indices).size, triangles: indices.length / 3 };
}
/** Every triangle centroid lies in the region: inside the outer ring and outside every hole. */
function allInside(data, holes, indices) {
  const [outer, ...inner] = rings(data, holes);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => point(data, 2, indices[t + k])),
      g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    if (Math.abs(winding(outer, g)) !== 1) return false;
    for (const h of inner) if (h.length > 2 && winding(h, g) !== 0) return false;
  }
  return true;
}
const relClose = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: expected ${b}, got ${a}`);

// Park-Miller minimal standard generator (as in the recorded vectors).
const parkMiller = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function noisyPolygon() {
  const rnd = parkMiller(7),
    data = [],
    holes = [];
  for (let i = 0; i < 300; i++) {
    const a = (i / 300) * Math.PI * 2,
      r = 10 + rnd() * 2;
    data.push(r * Math.cos(a), r * Math.sin(a));
  }
  for (let k = 0; k < 6; k++) {
    holes.push(data.length / 2);
    const cx = Math.cos(k) * 5,
      cy = Math.sin(k) * 5;
    for (let i = 0; i < 20; i++) {
      const a = (-i / 20) * Math.PI * 2,
        r = 1 + rnd() * 0.3;
      data.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  return { data, holes };
}

// ---------- recorded vectors ----------

const bindingCounts = new Set([
  'square',
  'square clockwise',
  'concave arrow',
  'square with two holes (one each orientation)',
  'dim 3 square',
  'steiner point hole',
]);

test('recorded vectors: area equals the polygon minus its holes, every triangle counter-clockwise', () => {
  for (const [name, c] of Object.entries(vectors)) {
    if (!Array.isArray(c.data)) continue;
    const indices = triangulate(c.data, c.holes, c.dim),
      m = measure(c.data, indices, c.dim);
    assert.equal(m.notCCW, 0, `${name}: clockwise or flat triangle`);
    assert.ok(
      indices.every((i) => Number.isInteger(i) && i >= 0 && i < c.data.length / c.dim),
      `${name}: indices`,
    );
    if (name === 'self-intersecting bowtie') continue; // best effort only: it must terminate
    relClose(m.area, c.polygonAreaMinusHoles, 1e-9, `${name} area`);
    if (bindingCounts.has(name)) assert.equal(m.triangles, c.triangles, `${name} triangle count`);
    if (c.polygonAreaMinusHoles === 0) assert.deepEqual(indices, [], `${name}: degenerate input gives []`);
  }
});

test('a one-point hole is a Steiner vertex: b + 2i - 2 triangles using every vertex', () => {
  const c = vectors['steiner point hole'],
    indices = triangulate(c.data, c.holes);
  assert.equal(indices.length / 3, 4 + 2 - 2);
  assert.equal(new Set(indices).size, 5);
  // On an interior edge as well: the two triangles beside it split in two each.
  const onDiagonal = triangulate([0, 0, 2, 0, 2, 2, 0, 2, 1, 1], [4]);
  assert.equal(onDiagonal.length / 3, 4);
  relClose(measure([0, 0, 2, 0, 2, 2, 0, 2, 1, 1], onDiagonal).area, 4, 1e-12, 'Steiner on a diagonal');
});

test('noisy 300-gon with six holes: n - 2 + 2h triangles, exact area, all inside', () => {
  const { data, holes } = noisyPolygon(),
    indices = triangulate(data, holes),
    m = measure(data, indices);
  assert.equal(m.triangles, 420 - 2 + 2 * 6);
  assert.equal(m.used, 420);
  assert.equal(m.notCCW, 0);
  const expected = rings(data, holes).reduce((s, r, i) => s + (i ? -1 : 1) * Math.abs(ringArea(r)), 0);
  relClose(m.area, expected, 1e-9, 'area');
  relClose(m.area, vectors['noisy 300-gon with 6 holes (Park-Miller seed 7)'].area, 1e-8, 'recorded area');
  assert.ok(allInside(data, holes, indices));
});

test('a 20,000-vertex ring triangulates exactly in well under a second', () => {
  const n = 20000,
    data = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n,
      r = 10 + 2 * Math.sin(37 * a);
    data.push(r * Math.cos(a), r * Math.sin(a));
  }
  triangulate(data); // warm up
  const start = performance.now(),
    indices = triangulate(data),
    ms = performance.now() - start,
    m = measure(data, indices);
  assert.equal(m.triangles, n - 2);
  assert.equal(m.used, n);
  assert.equal(m.notCCW, 0);
  relClose(m.area, Math.abs(ringArea(rings(data)[0])), 1e-9, 'area');
  // About 40 ms in Node on the development laptop; the budget leaves room for slow CI machines.
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

test('bad dim and hole boundaries throw RangeError before any work', () => {
  for (const dim of [0, -1, 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null])
    assert.throws(() => triangulate([0, 0, 1, 0, 0, 1], [], dim), RangeError);
  for (const holes of [[-1], [1.5], [5], [3, 2], [Number.NaN], [Number.POSITIVE_INFINITY]])
    assert.throws(() => triangulate([0, 0, 1, 0, 1, 1, 0, 1], holes), RangeError);
  // Equal hole starts (an empty hole) and a hole start at the very end are allowed.
  assert.equal(triangulate([0, 0, 1, 0, 1, 1, 0, 1], [4, 4]).length, 6);
  // A huge but invalid array-like is rejected at its first entry.
  assert.throws(() => triangulate([0, 0, 1, 0, 0, 1], { length: 1e12 }), RangeError);
});

// ---------- properties on generated polygons ----------

test('random star polygons with holes: exact area, CCW, every vertex used, nothing outside', () => {
  const rnd = parkMiller(12345);
  for (let trial = 0; trial < 200; trial++) {
    const n = 5 + Math.floor(rnd() * 200),
      data = [],
      holes = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI,
        r = 8 + rnd() * 4;
      data.push(r * Math.cos(a), r * Math.sin(a));
    }
    const count = Math.floor(rnd() * 6);
    for (let k = 0; k < count; k++) {
      holes.push(data.length / 2);
      const cx = ((k % 3) - 1) * 3,
        cy = (Math.floor(k / 3) - 0.5) * 3,
        m = 3 + Math.floor(rnd() * 8),
        turn = rnd() < 0.5 ? 1 : -1;
      for (let i = 0; i < m; i++) {
        const a = (i / m) * 2 * Math.PI * turn,
          r = 1 + rnd() * 0.4;
        data.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    }
    const indices = triangulate(data, holes),
      m = measure(data, indices),
      expected = rings(data, holes).reduce((s, r, i) => s + (i ? -1 : 1) * Math.abs(ringArea(r)), 0);
    relClose(m.area, expected, 1e-9, `trial ${trial} area`);
    assert.equal(m.notCCW, 0, `trial ${trial} orientation`);
    assert.equal(m.used, data.length / 2, `trial ${trial} vertices used`);
    assert.equal(m.triangles, data.length / 2 - 2 + 2 * count, `trial ${trial} n - 2 + 2h`);
    assert.ok(allInside(data, holes, indices), `trial ${trial} triangle outside`);
  }
});

test('holes touching each other and the outer ring (shared sides, shared corners, T-junctions) tile exactly', () => {
  const rnd = parkMiller(99);
  for (let trial = 0; trial < 400; trial++) {
    const size = 4 + Math.floor(rnd() * 8),
      used = new Set(),
      data = [0, 0, size, 0, size, size, 0, size],
      holes = [];
    let holeArea = 0;
    const tries = Math.floor(rnd() * 20);
    for (let t = 0; t < tries; t++) {
      // Unit or 2x2 square holes on the integer grid; they may share sides or corners, or sit on the outer side.
      const k = 1 + Math.floor(rnd() * 2),
        x = 1 + Math.floor(rnd() * (size - 1 - k)),
        y = Math.floor(rnd() * (size - k + 1));
      if (x < 0) continue;
      let free = true;
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (used.has(`${x + i},${y + j}`)) free = false;
      if (!free) continue;
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) used.add(`${x + i},${y + j}`);
      const ring = [
        [x, y],
        [x + k, y],
        [x + k, y + k],
        [x, y + k],
      ];
      if (rnd() < 0.5) ring.reverse();
      holes.push(data.length / 2);
      data.push(...ring.flat());
      holeArea += k * k;
    }
    const m = measure(data, triangulate(data, holes));
    relClose(m.area, size * size - holeArea, 1e-12, `trial ${trial} area`);
    assert.equal(m.notCCW, 0, `trial ${trial} orientation`);
  }
});

test('hand-made touching cases tile exactly', () => {
  const sq = [0, 0, 4, 0, 4, 4, 0, 4],
    cases = [
      ['hole vertex on an outer side', [...sq, 2, 0, 3, 1, 1, 1], [4], 15],
      ['hole side along an outer side', [...sq, 1, 0, 3, 0, 2, 1], [4], 15],
      ['hole in a corner', [...sq, 0, 0, 2, 0, 2, 2, 0, 2], [4], 12],
      ['two holes touching each other and the outer ring', [...sq, 0, 0, 2, 0, 1, 1, 2, 0, 4, 0, 3, 1], [4, 7], 14],
      [
        'four holes meeting at one corner',
        [...sq, 1, 1, 2, 1, 2, 2, 1, 2, 2, 2, 3, 2, 3, 3, 2, 3, 2, 1, 3, 1, 3, 2, 2, 2, 1, 2, 2, 2, 2, 3, 1, 3],
        [4, 8, 12, 16],
        12,
      ],
    ];
  for (const [name, data, holes, area] of cases) {
    const indices = triangulate(data, holes),
      m = measure(data, indices);
    relClose(m.area, area, 1e-12, name);
    assert.equal(m.notCCW, 0, name);
    assert.ok(allInside(data, holes, indices), `${name}: triangle outside`);
  }
});

test('holes outside the outer ring and empty holes are ignored', () => {
  const sq = [0, 0, 2, 0, 2, 2, 0, 2];
  assert.equal(measure([...sq, 5, 5, 6, 5, 6, 6], triangulate([...sq, 5, 5, 6, 5, 6, 6], [4])).area, 4);
  assert.equal(measure(sq, triangulate(sq, [4, 4, 4])).area, 4);
});

test('invalid and non-finite input terminates and stays deterministic', () => {
  const rnd = parkMiller(2024);
  for (let trial = 0; trial < 100; trial++) {
    const n = 3 + Math.floor(rnd() * 200),
      data = Array.from({ length: 2 * n }, () => Math.floor(rnd() * 20)),
      holes = rnd() < 0.5 ? [Math.floor(n / 2)] : [];
    const first = triangulate(data, holes);
    assert.deepEqual(triangulate(data, holes), first, 'same input, same output');
    assert.equal(measure(data, first).notCCW, 0, 'still counter-clockwise');
  }
  assert.ok(Array.isArray(triangulate([0, 0, Number.NaN, 1, 1, 1, 0, Number.POSITIVE_INFINITY, 2, 2])));
  assert.ok(Array.isArray(triangulate(new Float32Array([0, 0, 2, 2, 2, 0, 0, 2]))));
});

test('typed arrays and plain arrays give the same triangles', () => {
  const { data, holes } = noisyPolygon();
  assert.deepEqual(triangulate(Float64Array.from(data), Uint32Array.from(holes)), triangulate(data, holes));
});

/** Best of three wall-clock runs, in ms. */
function bestTime(data) {
  let best = Infinity,
    out;
  for (let k = 0; k < 3; k++) {
    const start = performance.now();
    out = triangulate(data);
    best = Math.min(best, performance.now() - start);
  }
  return { ms: best, out };
}
/** n points on the unit circle, starting at angle `phase`. */
function circle(n, phase = 0) {
  const data = [];
  for (let i = 0; i < n; i++)
    data.push(Math.cos(phase + (i / n) * 2 * Math.PI), Math.sin(phase + (i / n) * 2 * Math.PI));
  return data;
}

test('a 100k-point circle and a 65,536-gon cut as fast as a noisy 100k ring (no fan of slivers)', () => {
  const n = 100_000,
    noisy = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2,
      r = 1 + (0.3 * Math.sin(i * 0.7) * ((i * 7919) % 13)) / 13;
    noisy.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  const reference = bestTime(noisy).ms;
  for (const data of [circle(n), circle(65_536, 0.3)]) {
    const { ms, out } = bestTime(data),
      count = data.length / 2;
    assert.equal(out.length / 3, count - 2);
    let area = 0;
    for (let t = 0; t < out.length; t += 3) {
      const c = cross(point(data, 2, out[t]), point(data, 2, out[t + 1]), point(data, 2, out[t + 2]));
      assert.ok(c > 0);
      area += c / 2;
    }
    const expected = (count / 2) * Math.sin((2 * Math.PI) / count);
    assert.ok(Math.abs(area - expected) < 1e-9, `area ${area} vs ${expected}`);
    // Was about 12x the noisy ring (5.2 s against 0.42 s) when ears were ranked by shape alone.
    assert.ok(
      ms < 2.5 * reference + 50,
      `${count} points: ${ms.toFixed(0)} ms vs noisy ring ${reference.toFixed(0)} ms`,
    );
  }
});

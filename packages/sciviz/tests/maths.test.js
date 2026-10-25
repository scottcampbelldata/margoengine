import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ticks,
  niceNumber,
  formatTick,
  caseTriangles,
  cubeTables,
  EDGES,
  CORNERS,
  MAX_TRIANGLES,
} from '@margoengine/sciviz/maths';

test('niceNumber gives 1, 2, 5 or 10 times a power of ten (Heckbert 1990)', () => {
  assert.equal(niceNumber(97, false), 100);
  assert.equal(niceNumber(97, true), 100);
  assert.equal(niceNumber(23, true), 20);
  assert.equal(niceNumber(0.031, true), 0.05, 'fraction 3.1 rounds to 5');
  assert.equal(niceNumber(0.025, true), 0.02, 'fraction 2.5 rounds to 2');
  assert.equal(niceNumber(4.4, true), 5);
  assert.equal(niceNumber(0, true), 0);
});

test('ticks stay inside the range at nice steps, with labels that show the step', () => {
  assert.deepEqual(ticks(0, 97).values, [0, 20, 40, 60, 80]);
  assert.deepEqual(ticks(-1, 1).values, [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(ticks(-1, 1).labels, ['−1.0', '−0.5', '0', '0.5', '1.0']);
  // Range 0.25 -> nice 0.5, / 5 -> step 0.1: no float drift in 0.1 * 3.
  assert.deepEqual(ticks(0.1, 0.35, 6).values, [0.1, 0.2, 0.3]);
  assert.deepEqual(ticks(5, 5).values, [5]);
  assert.deepEqual(ticks(10, 0).values, ticks(0, 10).values, 'reversed ranges');
  assert.equal(formatTick(2.5e7, 5e6), '2.5e7');
  assert.equal(formatTick(0.00002, 0.00001), '2e-5');
  assert.throws(() => ticks(0, Infinity), RangeError);
});

// CPU marching cubes with the derived table, for checking the table itself.
function extract(field, n, level) {
  const triangles = [],
    at = (x, y, z) => field[(z * n + y) * n + x];
  for (let z = 0; z < n - 1; z++)
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++) {
        let mask = 0;
        CORNERS.forEach(([cx, cy, cz], c) => {
          if (at(x + cx, y + cy, z + cz) > level) mask |= 1 << c;
        });
        for (const tri of caseTriangles(mask))
          triangles.push(
            tri.map((e) => {
              const [a, b] = EDGES[e],
                pa = CORNERS[a].map((v, k) => v + [x, y, z][k]),
                pb = CORNERS[b].map((v, k) => v + [x, y, z][k]),
                va = at(...pa),
                vb = at(...pb),
                t = (level - va) / (vb - va);
              // Vertices are keyed by the grid edge they lie on, so shared vertices compare exactly.
              const key = [...pa, ...pb].join(',');
              return {
                key: pa.join() < pb.join() ? key : [...pb, ...pa].join(','),
                p: pa.map((v, k) => v + t * (pb[k] - v)),
              };
            }),
          );
      }
  return triangles;
}

const closedAndOriented = (triangles) => {
  const directed = new Map();
  for (const tri of triangles)
    for (let k = 0; k < 3; k++) {
      const a = tri[k].key,
        b = tri[(k + 1) % 3].key,
        id = `${a}|${b}`;
      directed.set(id, (directed.get(id) ?? 0) + 1);
    }
  // Closed and consistently wound: every directed edge is used once, and its reverse once.
  for (const [id, uses] of directed) {
    const [a, b] = id.split('|');
    if (uses !== 1 || directed.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
};

const signedVolume = (triangles) =>
  triangles.reduce((v, [a, b, c]) => {
    const [p, q, r] = [a.p, b.p, c.p];
    return (
      v +
      (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6
    );
  }, 0);

test('the derived marching cubes table: every case closes into loops; a sphere comes out closed, outward and of the right volume', () => {
  const tables = cubeTables();
  assert.equal(tables.counts[0], 0);
  assert.equal(tables.counts[255], 0);
  assert.equal(tables.counts[1], 1, 'one inside corner: one triangle');
  assert.equal(tables.counts[3], 2, 'two adjacent corners: a quad');
  assert.ok(MAX_TRIANGLES >= 4 && MAX_TRIANGLES <= 6, `at most ${MAX_TRIANGLES} triangles per case`);
  // Complementary cases cut the same edges.
  for (let m = 0; m < 256; m++) {
    const edges = (k) => new Set(caseTriangles(k).flat());
    assert.deepEqual([...edges(m)].sort(), [...edges(255 - m)].sort(), `case ${m} and its complement`);
  }
  const n = 24,
    r = 8.3,
    field = new Float32Array(n * n * n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) field[(z * n + y) * n + x] = r - Math.hypot(x - 11.5, y - 11.2, z - 11.7);
  const sphere = extract(field, n, 0);
  assert.ok(closedAndOriented(sphere), 'closed, consistently wound');
  const volume = signedVolume(sphere);
  assert.ok(Math.abs(volume / ((4 / 3) * Math.PI * r ** 3) - 1) < 0.02, `outward and close to the sphere: ${volume}`);
});

test('random fields (every ambiguous face configuration) still give closed, consistently wound surfaces', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5;
  for (let trial = 0; trial < 5; trial++) {
    const n = 12,
      field = new Float32Array(n * n * n);
    for (let i = 0; i < field.length; i++) field[i] = random();
    // Padding the border with outside values closes the surface.
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          if (!x || !y || !z || x === n - 1 || y === n - 1 || z === n - 1) field[(z * n + y) * n + x] = -1;
    const surface = extract(field, n, 0);
    assert.ok(surface.length > 100 && closedAndOriented(surface), `trial ${trial}`);
    assert.ok(signedVolume(surface) > 0, 'encloses the inside');
  }
});

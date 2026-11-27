import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  // A lone tick has no step: its label is the value's shortest exact text, not three padded decimals.
  assert.deepEqual(ticks(5, 5).labels, ['5']);
  assert.deepEqual(ticks(-0.1, -0.1).labels, ['−0.1']);
  assert.deepEqual(ticks(1.2345678, 1.2345678).labels, ['1.2345678']);
  assert.deepEqual(ticks(3e9, 3e9).labels, ['3e9']);
  assert.equal(formatTick(2.5e-7, 0), '2.5e-7');
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
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32 - 0.5;
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

// Runs `expression` (with ticks and dateTicks in scope) in a child process under a time limit, so a loop that never
// ends fails the test instead of hanging the run.
const finishes = (expression) => {
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { ticks, dateTicks } from '@margoengine/sciviz/maths'; console.log(JSON.stringify(${expression}));`,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(run.status, 0, `${expression} did not finish in 10 s: ${run.signal ?? run.stderr}`);
  return JSON.parse(run.stdout);
};

test('ticks finish at any magnitude: a step below one unit in the last place, a span past the largest double', () => {
  // Nanosecond timestamps: a 256 ns span at 1e18 asks for a step (100) below the doubles' spacing there (128).
  assert.deepEqual(finishes('ticks(1e18, 1.0000000000000003e18).values'), [1e18, 1.0000000000000003e18]);
  // max - min is Infinity: the step is found at a tenth of the scale.
  assert.deepEqual(finishes('ticks(-1e308, 1e308).values'), [-1e308, -5e307, 0, 5e307, 1e308]);
  assert.deepEqual(ticks(0, 1.5e308).values, [0, 5e307, 1e308, 1.5e308], 'a nice span past the largest double');
});

test('ticks of tiny ranges keep their values: below 1e-20 and down to the smallest subnormal', () => {
  assert.deepEqual(ticks(0, 1e-25).values, [0, 2e-26, 4e-26, 6e-26, 8e-26, 1e-25]);
  assert.deepEqual(ticks(1e-30, 3e-30).values, [1e-30, 1.5e-30, 2e-30, 2.5e-30, 3e-30]);
  assert.deepEqual(ticks(0, 5e-324).values, [0, 5e-324]);
  assert.equal(niceNumber(5e-324, false), 5e-324);
  assert.equal(niceNumber(1e-320, true), 1e-320);
  assert.deepEqual(ticks(0, 0.7, 8).values, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], 'decimal values, not 0.1 x 3');
});

test('every non-empty range gets ticks, and labels tell neighbouring ticks apart', () => {
  // No multiple of the nice step (0.1) falls inside: the ends are the ticks.
  assert.deepEqual(ticks(0.31, 0.39, 2).values, [0.31, 0.39]);
  for (const [min, max] of [
    [1.6e9, 1.6000000001e9],
    [1e18, 1.0000000000000003e18],
    [123456.789, 123456.78900001],
  ]) {
    const { labels } = ticks(min, max);
    assert.equal(new Set(labels).size, labels.length, `labels over [${min}, ${max}]: ${labels.join(' ')}`);
  }
});

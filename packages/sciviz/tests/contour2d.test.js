import assert from 'node:assert/strict';
import test from 'node:test';
import { contour2D, scatteredContour2D, contourSVG } from '../dist/contour2d.js';
import { delaunay2D } from '../src/contour2d-triangulate.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const grid = (values) => ({ x: [0, 1], y: [0, 1], values });
const area = (rings) =>
  rings.reduce(
    (sum, r) => sum + Math.abs(r.slice(1).reduce((a, p, i) => a + r[i][0] * p[1] - p[0] * r[i][1], 0)) / 2,
    0,
  );

test('frozen NOAA and ERA5 reductions retain source hashes and produce vector bands', async () => {
  const base = new URL('../../../examples/assets/sciviz/contour2d/', import.meta.url);
  const source = JSON.parse(readFileSync(new URL('source.json', base)));
  for (const s of source.sources) {
    const bytes = readFileSync(new URL(s.file, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), s.sha256);
    const data = JSON.parse(bytes),
      values = data.values.map((v) => (v === null ? NaN : v));
    const levels = s.file === 'oisst.json' ? [5, 10, 15, 20, 25, 30] : [48000, 50000, 52000, 54000, 56000, 58000];
    const r = await contour2D({ ...data, values }, { levels });
    assert.ok(r.lines.length > 5);
    assert.equal(r.bands.length, 5);
    assert.ok(r.bands.some((b) => b.rings.length > 5));
    assert.ok(!contourSVG(r).includes('<image'));
  }
});

test('all 16 squares produce correct crossings and closed polygon boundaries', async () => {
  for (let mask = 0; mask < 16; mask++) {
    const v = [0, 1, 3, 2].map((i) => (mask >> i) & 1),
      r = await contour2D(grid(v), { levels: [-1, 0.5, 2] });
    const high = v.reduce((a, b) => a + b, 0),
      lines = r.lines.filter((l) => l.level === 0.5);
    assert.equal(lines.length, high === 0 || high === 4 ? 0 : mask === 5 || mask === 10 ? 2 : 1);
    for (const l of lines)
      for (const [x, y] of l.points) {
        near((1 - x) * (1 - y) * v[0] + x * (1 - y) * v[1] + (1 - x) * y * v[2] + x * y * v[3], 0.5);
      }
    for (const b of r.bands) for (const p of b.rings) assert.deepEqual(p[0], p.at(-1));
  }
});

test('asymptotic decider uses saddle value rather than mean or fixed diagonal', async () => {
  // Bilinear corner order 0,1,2,3: [4,-2,1,-2], determinant at 0 is zero.
  for (const t of [-0.1, 0.1]) {
    const r = await contour2D(grid([4, -2, -2, 1]), { levels: [t] });
    const bottom = r.lines.find((l) => l.points.some((p) => p[1] === 0));
    assert.equal(
      bottom.points.some((p) => p[0] === 1),
      t < 0,
    );
  }
});

test('stitching spans cells, descending nonuniform axes and masked holes', async () => {
  const r = await contour2D(
    { x: [3, 1, 0], y: [4, 2, 0], values: [3, 1, 0, 3, 1, 0, 3, 1, 0] },
    { levels: [0.5, 1.5, 2.5] },
  );
  assert.equal(r.lines.length, 3);
  for (const l of r.lines) {
    assert.equal(l.points.length, 3);
    for (const p of l.points) near(p[0], l.level);
  }
  const masked = await contour2D(
    { x: [0, 1, 2], y: [0, 1, 2], values: [0, 1, 2, 0, NaN, 2, 0, 1, 2] },
    { levels: [0, 1, 2] },
  );
  assert.equal(masked.lines.length, 0);
  assert.equal(masked.bands[0].rings.length, 0);
  const band = await contour2D(grid([0, 1, 0, 1]), { levels: [0.25, 0.75] });
  // Superlevel lower area minus the nested upper ring area.
  near(area([band.bands[0].rings[0]]) - area([band.bands[0].rings[1]]), 0.5);
});

test('closed isolines, exact-level vertices and constant fields have finite geometry', async () => {
  const r = await contour2D(
    { x: [-1, 0, 1], y: [-1, 0, 1], values: [2, 1, 2, 1, 0, 1, 2, 1, 2] },
    { levels: [0.5, 1, 1.5] },
  );
  assert.ok(r.lines.some((l) => l.closed));
  for (const l of r.lines) for (const p of l.points) assert.ok(p.every(Number.isFinite));
  const c = await contour2D(grid([1, 1, 1, 1]), { levels: [0, 1, 2] });
  assert.equal(c.lines.length, 0);
  near(area(c.bands[1].rings), 1);
});

test('Delaunay covers thin, cocircular and collinear hull-edge sites without supertriangle gaps', async () => {
  const sets = [
    [
      [0, 0],
      [1, 0],
      [0.5, 1e-12],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.5, 0.5],
      [0.5, 0],
    ],
    Array.from({ length: 24 }, (_, i) => [Math.cos(i), Math.sin(i)]),
    Array.from({ length: 60 }, (_, i) => [((i * 217) % 997) / 997, ((i * 331) % 991) / 991]),
  ];
  for (const p of sets) {
    const t = await delaunay2D(p.map(([x, y]) => ({ x, y })));
    assert.equal(new Set(t.flat()).size, p.length);
    for (const [ia, ib, ic] of t) {
      const [a, b, c] = [p[ia], p[ib], p[ic]];
      assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0);
      for (let k = 0; k < p.length; k++)
        if (![ia, ib, ic].includes(k)) {
          const [x, y] = [a[0] - p[k][0], a[1] - p[k][1]],
            [u, v] = [b[0] - p[k][0], b[1] - p[k][1]],
            [s, z] = [c[0] - p[k][0], c[1] - p[k][1]];
          assert.ok(
            (x * x + y * y) * (u * z - v * s) - (u * u + v * v) * (x * z - y * s) + (s * s + z * z) * (x * v - y * u) <
              1e-12,
            'empty circumcircle',
          );
        }
    }
  }
});

test('scattered affine contours interpolate exactly with owned output', async () => {
  const p = [
    [0, 0, 0],
    [1, 0, 1],
    [1, 1, 3],
    [0, 1, 2],
    [0.4, 0.3, 1],
  ];
  const r = await scatteredContour2D(p, { levels: [0.4, 1.3, 2.5] });
  assert.equal(r.lines.length, 3);
  for (const l of r.lines) for (const [x, y] of l.points) near(x + 2 * y, l.level);
  const svg = contourSVG(r, { title: '<unsafe>', colors: ['" onload="x'] });
  assert.match(svg, /&lt;unsafe&gt;/);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /rotate\(/);
  assert.ok(!svg.includes('fill="" onload='));
});

test('argument validation, cancellation during work and snapshot semantics', async () => {
  for (const x of [
    [0, 0],
    [0, NaN],
    [0, 1, 0],
  ])
    await assert.rejects(contour2D({ x, y: [0, 1], values: new Array(x.length * 2).fill(0) }, { levels: [0] }));
  for (const levels of [[], [1, 0], [0, Infinity], [1, 1]])
    await assert.rejects(contour2D(grid([0, 1, 0, 1]), { levels }));
  await assert.rejects(
    scatteredContour2D(
      [
        [0, 0, 0],
        [0, 0, 1],
        [1, 1, 2],
      ],
      { levels: [1] },
    ),
  );
  await assert.rejects(
    scatteredContour2D(
      [
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
      ],
      { levels: [1] },
    ),
  );
  const controller = new AbortController(),
    reason = new Error('cancel contour');
  const p = contour2D(grid([0, 1, 0, 1]), { levels: [0.5], signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(p, (e) => e === reason);
  const v = [0, 1, 0, 1],
    levels = [0.5],
    work = contour2D(grid(v), { levels });
  v.fill(99);
  levels[0] = 98;
  assert.equal((await work).lines[0].level, 0.5);
});

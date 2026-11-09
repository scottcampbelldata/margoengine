import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry } from '../../core/dist/index.js';
import { Spline } from '../../splines/dist/index.js';
import { heightfieldGeometry } from '../../terrain/dist/index.js';
import { road } from '../dist/index.js';
import { bankedRoad } from '../dist/banking.js';
import { fitTerrain } from '../dist/terrain.js';
import { repairRoad } from '../dist/repair.js';

const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`);
const loop = () =>
  new Spline(
    [
      [0, 0, 0],
      [30, 0, 0],
      [30, 0, 30],
      [0, 0, 30],
    ],
    { closed: true },
  );

test('zero shoulder contains the oblique review triangle and every interior heightfield sample', async () => {
  const g = road(
    new Spline([
      [0, 2, 0],
      [17, 2, 23],
    ]),
    {
      segments: 1,
      crossSection: [
        [-3, 0],
        [3, 0],
      ],
    },
  ).geometry;
  const h = await fitTerrain(g, { base: () => -10, shoulder: 0 });
  near(h(13.5, 23), 2, 'review point');
  const ground = heightfieldGeometry(h, { size: [30, 30], origin: [-5, -5], resolution: 60 });
  const v = g.vertices,
    [ai, bi, ci] = g.indices,
    a = [v[ai * 6], v[ai * 6 + 2]],
    b = [v[bi * 6], v[bi * 6 + 2]],
    c = [v[ci * 6], v[ci * 6 + 2]];
  const edge = (p, q, x, z) => (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (x - p[0]);
  let inside = 0, reviewInside = 0;
  for (let i = 0; i < ground.positions.length; i += 3) {
    const x = ground.positions[i],
      z = ground.positions[i + 2];
    const signs = [edge(a, b, x, z), edge(b, c, x, z), edge(c, a, x, z)];
    if(signs.every(n=>n>1e-5)||signs.every(n=>n< -1e-5)) reviewInside++;
    if (signs.every((n) => n > 0) || signs.every((n) => n < 0)) {
      inside++;
      near(ground.positions[i + 1], 2, 'heightfield interior');
    }
  }
  assert.equal(reviewInside, 342);
  assert.equal(inside, 343);
  // Exact edge and representably outside: containment must not expand the footprint by an epsilon.
  const flat = await fitTerrain(
    road(
      new Spline([
        [0, 2, 0],
        [0, 2, 20],
      ]),
      {
        segments: 1,
        crossSection: [
          [-3, 0],
          [3, 0],
        ],
      },
    ).geometry,
    { base: () => -10, shoulder: 0 },
  );
  assert.equal(flat(3, 10), 2);
  assert.equal(flat(3 + Number.EPSILON * 4, 10), -10);
});

test('terrain uses the lower envelope of banked curbs at every longitudinal row and in either face order', async () => {
  for (const bank of [Math.PI / 4, -Math.PI / 4]) {
    const g = (
      await bankedRoad(
        new Spline([
          [0, 0, 0],
          [0, 0, 20],
        ]),
        { bank, segments: 4 },
      )
    ).geometry;
    const reversed = g.indices.slice();
    for (let i = 0; i < g.indices.length; i += 3)
      reversed.set(g.indices.subarray(g.indices.length - i - 3, g.indices.length - i), i);
    for (const geometry of [g, { vertices: g.vertices, indices: reversed }]) {
      const h = await fitTerrain(geometry);
      for (const x of [2.05, 2.1])
        for (const z of [1, 5, 9, 10, 15, 19]) near(h(Math.sign(bank) * x, z), x, 'driving surface');
      const deep = await fitTerrain(geometry, { base: () => 10, shoulder: 0, depth: 0.25 });
      near(deep(Math.sign(bank) * 2.1, 5), 1.85, 'bed depth');
    }
  }
  // The envelope also applies to an arbitrary triangulated overlap, not just named curb strips.
  const p = new Float32Array([-3, 2, 0, 3, 2, 0, 0, 2, 20, -3, 4, 0, 3, 4, 0, 0, 4, 20]);
  const g = new Geometry(p, new Float32Array(p.length), new Uint32Array([3, 4, 5, 0, 1, 2]));
  near((await fitTerrain(g))(0, 5), 2, 'lower overlapping triangle');
});

test('repair rejects grades hidden between chord endpoints for every cubic basis and coarse arc lookup', async () => {
  const review = new Spline([
    [0, 0, 0],
    [10, 10, 0],
    [20, 0, 0],
  ]);
  assert.equal(review.at(0.5, new Float64Array(3))[1], 10);
  await assert.rejects(repairRoad(review, { segments: 1, width: 4 }), { code: 'unsupported' });
  const cases = [
    new Spline(
      [
        [0, 0, 0],
        [10, 10, 0],
        [20, 0, 0],
      ],
      { divisions: 2 },
    ),
    new Spline(
      [
        [0, 0, 0],
        [6, 9, 0],
        [14, -9, 0],
        [20, 0, 0],
      ],
      { kind: 'bezier', divisions: 2 },
    ),
    new Spline(
      [
        [0, 0, 0],
        [20, 0, 0],
      ],
      {
        kind: 'hermite',
        tangents: [
          [20, 9, 0],
          [20, 9, 0],
        ],
        divisions: 2,
      },
    ),
    new Spline(
      [
        [0, 0, 0],
        [10, 10, 0],
        [20, 0, 0],
      ],
      { kind: 'bspline', divisions: 2 },
    ),
    new Spline(
      [
        [0, 0, 0],
        [10, 10, 0],
        [20, 0, 0],
      ],
      { kind: 'kochanek-bartels', divisions: 2 },
    ),
    new Spline(
      [
        [0, 0, 0],
        [20, 10, 0],
        [20, 0, 20],
        [0, 0, 20],
      ],
      { closed: true, divisions: 2 },
    ),
  ];
  for (const curve of cases)
    await assert.rejects(repairRoad(curve, { segments: 1, width: 4 }), { code: 'unsupported' });
  for (const kind of ['catmull-rom', 'bezier', 'hermite', 'bspline', 'kochanek-bartels']) {
    const curve = new Spline(
      [
        [0, 3, 0],
        [6, 3, 0],
        [14, 3, 0],
        [20, 3, 0],
      ],
      {
        kind,
        tangents: [
          [6, 0, 0],
          [6, 0, 0],
          [6, 0, 0],
          [6, 0, 0],
        ],
        divisions: 2,
      },
    );
    near((await repairRoad(curve, { segments: 1, width: 4 })).area, 80, kind);
  }
});

function seam(result, segments) {
  const v = result.geometry.vertices,
    row = (result.section.length - 1) * 2,
    last = segments * row;
  for (let i = 0; i < row; i++)
    for (let k = 0; k < 6; k++) assert.equal(v[i * 6 + k], v[(last + i) * 6 + k], `seam vertex ${i} component ${k}`);
  assert.ok(result.uvs[last * 2 + 1] > result.uvs[1], 'UV distance retains the terminal row');
  return { v, row, last };
}

test('closed road and bankedRoad review loop has exact seam positions and joined end normals', async () => {
  seam(road(loop()), 128);
  const { v, row, last } = seam(await bankedRoad(loop(), { bank: 0.2 }), 128);
  // A curb's adjacent strips remain hard, even at the periodic normal join.
  assert.ok(Math.hypot(v[1 * 6 + 3] - v[2 * 6 + 3], v[1 * 6 + 4] - v[2 * 6 + 4], v[1 * 6 + 5] - v[2 * 6 + 5]) > 1);
  // Independently accumulate the corner-angle normals incident on the joined driving vertex.
  const result = await bankedRoad(loop(), { bank: [0.2, -0.1, 0.2] });
  seam(result, 128);
  const p = result.geometry.vertices,
    indices = result.geometry.indices,
    target = 6,
    sums = [0, 0, 0];
  for (let f = 0; f < indices.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const id = indices[f + k];
      if (id !== target && id !== last + target) continue;
      const b = indices[f + ((k + 1) % 3)],
        c = indices[f + ((k + 2) % 3)];
      const u = [0, 1, 2].map((a) => p[b * 6 + a] - p[id * 6 + a]),
        w = [0, 1, 2].map((a) => p[c * 6 + a] - p[id * 6 + a]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(...n),
        angle = Math.atan2(
          len,
          u.reduce((sum, x, a) => sum + x * w[a], 0),
        );
      for (let a = 0; a < 3; a++) sums[a] += (n[a] / len) * angle;
    }
  const size = Math.hypot(...sums);
  for (let a = 0; a < 3; a++) near(p[target * 6 + 3 + a], sums[a] / size, 'joined corner-angle normal');
  assert.equal(row, 14);
  for (const bank of [
    [0, 0.2],
    [0.2, 0.1, 0],
  ])
    await assert.rejects(bankedRoad(loop(), { bank }), { code: 'failed' });
  const graded = new Spline(
    [
      [0, 0, 0],
      [30, 3, 0],
      [30, 1, 30],
      [0, -2, 30],
    ],
    { closed: true },
  );
  seam(road(graded, { segments: 64 }), 64);
  seam(await bankedRoad(graded, { segments: 64, bank: 0.2 }), 64);
});

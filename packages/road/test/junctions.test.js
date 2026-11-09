import test from 'node:test';
import assert from 'node:assert/strict';
import { junctions } from '../dist/junctions.js';

const crossing = [
  {
    points: [
      [-10, 0],
      [10, 0],
    ],
    width: 4,
  },
  {
    points: [
      [0, -10],
      [0, 10],
    ],
    width: 4,
  },
];

function areaAndCoverage(g, x, z) {
  let area = 0,
    coverage = 0;
  const v = g.vertices;
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = Array.from(g.indices.subarray(i, i + 3), (n) => [v[n * 6], v[n * 6 + 2]]);
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const signed = cross(a, b, c);
    assert.ok(signed < 0, 'every nondegenerate face must face +Y');
    area -= signed / 2;
    // Half-open edge ownership counts a shared diagonal exactly once. The uncertainty bound
    // follows the two products and subtraction in the orientation test, in float64.
    const inside = (p, q) => {
      const dx = q[0] - p[0],
        dz = q[1] - p[1],
        side = cross(p, q, [x, z]);
      const bound = 8 * Number.EPSILON * (Math.abs(dx * (z - p[1])) + Math.abs(dz * (x - p[0])));
      return side < -bound || (Math.abs(side) <= bound && (dz > 0 || (dz === 0 && dx < 0)));
    };
    if (inside(a, b) && inside(b, c) && inside(c, a)) coverage++;
  }
  return { area, coverage };
}

test('crossings and T junctions form one tiled surface, with analytic area and no double coverage', async () => {
  for (const [roads, expected] of [
    [crossing, 144],
    [
      [
        crossing[0],
        {
          points: [
            [0, 0],
            [0, 10],
          ],
          width: 4,
        },
      ],
      112,
    ],
  ]) {
    const { geometry: g, uvs, area } = await junctions(roads, { elevation: 7, uvMeters: 2 });
    assert.equal(area, expected);
    assert.equal(areaAndCoverage(g, 0.37, 0.61).area, expected);
    for (let i = 0; i < g.vertices.length; i += 6) {
      assert.equal(g.vertices[i + 1], 7);
      assert.deepEqual(Array.from(g.vertices.subarray(i + 3, i + 6)), [0, 1, 0]);
      assert.equal(uvs[i / 3], g.vertices[i] / 2);
      assert.equal(uvs[i / 3 + 1], -g.vertices[i + 2] / 2);
    }
    for (let x = -10.13; x < 10; x += 0.71)
      for (let z = -10.27; z < 10; z += 0.83) {
        const inside = roads.some((r) =>
          r.points[0][0] === r.points[1][0]
            ? Math.abs(x) < 2 && z > r.points[0][1] && z < r.points[1][1]
            : Math.abs(z) < 2 && x > -10 && x < 10,
        );
        assert.equal(areaAndCoverage(g, x, z).coverage, inside ? 1 : 0, `${x},${z}`);
      }
  }
});

test('a closed road network keeps its courtyard hole and results own their arrays', async () => {
  const roads = [
    {
      points: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
        [-5, -5],
      ],
      width: 2,
    },
  ];
  const a = await junctions(roads),
    saved = a.geometry.vertices.slice();
  assert.equal(areaAndCoverage(a.geometry, 0.13, 0.19).coverage, 0);
  assert.equal(areaAndCoverage(a.geometry, 4.89, 0.19).coverage, 1);
  await junctions(crossing);
  assert.deepEqual(a.geometry.vertices, saved);
});

test('hostile inputs and cancelled loads fail with a coded help-linked error; load snapshots input', async () => {
  for (const roads of [
    [],
    Array(65).fill(crossing[0]),
    [{ points: [] }],
    [
      {
        points: [
          [0, 0],
          [0, 0],
        ],
      },
    ],
    [
      {
        points: [
          [0, 0],
          [NaN, 1],
        ],
      },
    ],
    [
      {
        points: [
          [0, 0],
          [1e300, 1],
        ],
      },
    ],
    [{ ...crossing[0], width: 0 }],
    [{ ...crossing[0], width: Infinity }],
    [{ points: Array(4097).fill([0, 0]) }],
  ]) {
    await assert.rejects(junctions(roads), (e) => e.code === 'failed' && /https:\/\//.test(e.message));
  }
  for (const options of [{ elevation: NaN }, { elevation: 1e300 }, { uvMeters: 0 }, { uvMeters: NaN }])
    await assert.rejects(junctions(crossing, options), { code: 'failed' });
  const c = new AbortController();
  c.abort('stop');
  await assert.rejects(junctions(crossing, { signal: c.signal }), (e) => e === 'stop');
  const mutable = structuredClone(crossing),
    pending = junctions(mutable);
  mutable[0].points[0][0] = 999;
  assert.equal((await pending).area, 144);
  const during = new AbortController(),
    stopped = junctions(crossing, { signal: during.signal });
  during.abort('during');
  await assert.rejects(stopped, (e) => e === 'during');
  const extreme = await junctions(
    [
      {
        points: [
          [-1e6, 0],
          [1e6, 0],
        ],
        width: 1000,
      },
    ],
    { elevation: 1e6 },
  );
  assert.equal(extreme.area, 2e9);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { NavVolume } from '../dist/volume.js';

/** Adds a closed box to a triangle soup. These generated levels are stand-ins. */
function box(level, [x0, y0, z0], [x1, y1, z1]) {
  const { positions, indices } = level,
    base = positions.length / 3;
  for (const y of [y0, y1]) positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  for (const [a, b, c, d] of [
    [0, 1, 2, 3],
    [7, 6, 5, 4],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}
const level = (...boxes) => {
  const out = { positions: [], indices: [] };
  for (const [a, b] of boxes) box(out, a, b);
  return out;
};
const build = ({ positions, indices }, options) => new NavVolume(positions, indices, options);
const length = (points) =>
  points.reduce(
    (sum, p, i) =>
      i ? sum + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1], p[2] - points[i - 1][2]) : sum,
    0,
  );
/** Distance from a point to an axis box. */
const toBox = (p, [a, b]) => Math.hypot(...[0, 1, 2].map((i) => Math.max(a[i] - p[i], 0, p[i] - b[i])));
/** Asserts a path keeps `radius` clear of every box. */
function assertClear(path, boxes, radius) {
  for (let i = 1; i < path.length; i++)
    for (let t = 0; t <= 1; t += 1 / 64) {
      const p = [0, 1, 2].map((k) => path[i - 1][k] + (path[i][k] - path[i - 1][k]) * t);
      for (const b of boxes) assert.ok(toBox(p, b) >= radius - 1e-6, `${p} is ${toBox(p, b)} from a box`);
    }
}
// A wall in x = 9..10 across the 16 m cross-section, with a hole.
const wall = ([y0, y1, z0, z1]) => [
  [
    [9, 0, 0],
    [10, y0, 16],
  ],
  [
    [9, y1, 0],
    [10, 16, 16],
  ],
  [
    [9, y0, 0],
    [10, y1, z0],
  ],
  [
    [9, y0, z1],
    [10, y1, 16],
  ],
];
const bounds = { min: [0, 0, 0], max: [20, 16, 16] };

test('open air: one straight line, and the tree stays sparse', () => {
  const pillar = [
      [9, 0, 9],
      [10, 2, 10],
    ],
    volume = build(level(pillar), { voxelSize: 0.5, radius: 0.5, min: [0, 0, 0], max: [64, 64, 64] }),
    path = volume.path([2, 30, 2], [60, 40, 60]);
  assert.equal(path.length, 2);
  const voxels = 128 ** 3;
  assert.ok(volume.nodeCount * 64 < voxels / 4, `${volume.nodeCount} nodes`);
  assert.ok(volume.byteLength < voxels / 8, 'under one bit per voxel');
});

test('every free voxel is at least the radius from a solid', () => {
  const boxes = [
      [
        [3, 3, 3],
        [5, 6, 7],
      ],
      [
        [8.3, 1.1, 2.7],
        [9.1, 7.7, 3.3],
      ],
    ],
    radius = 0.75,
    volume = build(level(...boxes), { voxelSize: 0.25, radius, min: [0, 0, 0], max: [12, 12, 12] });
  let seed = 7,
    free = 0,
    near = 0;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 20000; i++) {
    const p = [next() * 12, next() * 12, next() * 12],
      gap = Math.min(...boxes.map((b) => toBox(p, b)));
    if (volume.isFree(p)) {
      free++;
      // A point inside a closed box is a sealed pocket, as the class says.
      if (gap > 0) assert.ok(gap >= radius, `${p} is ${gap} from a solid`);
    } else {
      near++;
      // Blocked only within the radius plus a voxel's diagonal, twice: the grid costs no more than that.
      assert.ok(gap <= radius + 2 * 0.25 * Math.sqrt(3), `${p} blocked at ${gap}`);
    }
  }
  assert.ok(free > 1000 && near > 100);
});

test('a route goes through the hole in a wall, clear by the radius', () => {
  const parts = wall([6, 10, 6, 10]),
    volume = build(level(...parts), { voxelSize: 0.5, radius: 0.5, ...bounds }),
    path = volume.path([3, 8, 8], [16, 8, 8]);
  assert.ok(path);
  assert.deepEqual(path[0], [3, 8, 8]);
  assert.deepEqual(path.at(-1), [16, 8, 8]);
  assert.ok(length(path) < 14, 'straight through');
  assertClear(path, parts, 0.5);
  const off = volume.path([3, 2, 2], [16, 13, 13]);
  assert.ok(off);
  assertClear(off, parts, 0.5);
  assert.ok(off.length >= 3, 'turns at the hole');
  // The straight line is 18.8 m and goes through the wall; the taut way by the hole is close to it.
  assert.ok(length(off) < 21, `${length(off)}`);
});

test('a hole under the body width is shut, and a sealed room has no way out', () => {
  const parts = wall([7.7, 8.3, 7.7, 8.3]),
    shut = build(level(...parts), { voxelSize: 0.25, radius: 0.5, ...bounds }),
    around = shut.path([3, 8, 8], [16, 8, 8]);
  // The volume's cube runs past the wall's edge, so the flyer may go round it, never through.
  if (around) assertClear(around, parts, 0.5);
  const walls = [
      [
        [4, 4, 4],
        [12, 5, 12],
      ],
      [
        [4, 11, 4],
        [12, 12, 12],
      ],
      [
        [4, 5, 4],
        [5, 11, 12],
      ],
      [
        [11, 5, 4],
        [12, 11, 12],
      ],
      [
        [5, 5, 4],
        [11, 11, 5],
      ],
      [
        [5, 5, 11],
        [11, 11, 12],
      ],
    ],
    volume = build(level(...walls), { voxelSize: 0.5, radius: 0.25, min: [0, 0, 0], max: [16, 16, 16] });
  assert.equal(volume.path([8, 8, 8], [14, 14, 14]), null);
  assert.ok(volume.path([8, 8, 8], [9, 9, 7]));
});

test('routes match or beat a shortest walk on the voxel grid', () => {
  const parts = [
      ...wall([3, 6, 3, 6]),
      [
        [14, 0, 0],
        [15, 10, 16],
      ],
    ],
    size = 0.5,
    volume = build(level(...parts), { voxelSize: size, radius: 0.5, ...bounds }),
    a = [2, 12, 12],
    b = [18, 13, 4],
    path = volume.path(a, b);
  assert.ok(path);
  assertClear(path, parts, 0.5);
  // Breadth first over voxel centres, six ways: the plain grid answer, with no octree.
  const at = (i) => (i + 0.5) * size,
    cell = (p) => p.map((v) => Math.floor(v / size)),
    name = ([x, y, z]) => (z * 64 + y) * 64 + x,
    from = cell(a),
    goal = name(cell(b)),
    seen = new Map([[name(from), 0]]);
  let queue = [from];
  while (queue.length && !seen.has(goal)) {
    const next = [];
    for (const c of queue)
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ]) {
        const d = [c[0] + dx, c[1] + dy, c[2] + dz];
        if (d.some((v) => v < 0 || v >= 64) || seen.has(name(d))) continue;
        if (!volume.isFree(d.map(at))) continue;
        seen.set(name(d), seen.get(name(c)) + 1);
        next.push(d);
      }
    queue = next;
  }
  assert.ok(seen.has(goal));
  assert.ok(length(path) <= seen.get(goal) * size + 1);
});

test('a line of sight stops at a solid and at the edge of the volume', () => {
  const volume = build(
    level([
      [9, 0, 0],
      [10, 16, 16],
    ]),
    {
      voxelSize: 0.5,
      radius: 0.5,
      min: [0, 0, 0],
      max: [16, 16, 16],
    },
  );
  assert.equal(volume.lineOfSight([2, 8, 8], [14, 8, 8]), false);
  assert.equal(volume.lineOfSight([2, 2, 2], [7, 14, 14]), true);
  assert.equal(volume.lineOfSight([14, 2, 2], [12, 14, 14]), true);
  assert.equal(volume.lineOfSight([2, 2, 2], [2, 2, 2]), true);
  assert.equal(volume.lineOfSight([2, 8, 8], [-5, 8, 8]), false);
});

test('ends that are not free: no path, and closestFree finds the way out', () => {
  const volume = build(
      level([
        [4, 0, 4],
        [6, 2, 6],
      ]),
      {
        voxelSize: 0.5,
        radius: 0.5,
        min: [0, 0, 0],
        max: [16, 16, 16],
      },
    ),
    against = [3.9, 1, 5];
  assert.equal(volume.isFree(against), false);
  assert.equal(volume.path(against, [10, 10, 10]), null);
  const out = volume.closestFree(against);
  assert.ok(volume.isFree(out));
  assert.ok(volume.path(out, [10, 10, 10]));
  assert.deepEqual(volume.closestFree([10, 10, 10]), [10, 10, 10]);
  assert.equal(volume.closestFree([-100, 0, 0]), null);
});

test('options and points are checked', () => {
  const { positions, indices } = level([
      [0, 0, 0],
      [1, 1, 1],
    ]),
    bad = (options) => assert.throws(() => new NavVolume(positions, indices, options), RangeError);
  bad({ voxelSize: 0 });
  bad({ radius: -1 });
  bad({ padding: Number.NaN });
  bad({ min: [0, 0, 0], max: [0, 1, 1] });
  bad({ voxelSize: 1e-4, padding: 100 });
  const volume = new NavVolume(positions, indices);
  assert.throws(() => volume.path([0, 0], [1, 1, 1]), RangeError);
  assert.throws(() => volume.isFree([Number.NaN, 0, 0]), RangeError);
});

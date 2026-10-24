import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';

const L = () =>
  new NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 7],
    ],
  );
const close = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - expected[i][k]) <= 1e-9, label)));
};

test('funnel paths through the L corridor are the unique shortest paths', () => {
  const mesh = L();
  for (const [start, end, expected] of [
    [
      [0.5, 0, 1],
      [3.5, 0, 1],
      [
        [0.5, 0, 1],
        [3.5, 0, 1],
      ],
    ],
    [
      [0.5, 0, 0.5],
      [3, 0, 3.5],
      [
        [0.5, 0, 0.5],
        [2, 0, 2],
        [3, 0, 3.5],
      ],
    ],
    [
      [0.1, 0, 1.9],
      [3.9, 0, 3.9],
      [
        [0.1, 0, 1.9],
        [2, 0, 2],
        [3.9, 0, 3.9],
      ],
    ],
    [
      [1, 0, 1],
      [1.5, 0, 1.5],
      [
        [1, 0, 1],
        [1.5, 0, 1.5],
      ],
    ],
  ])
    close(mesh.path(start, end), expected, `${start} -> ${end}`);
  assert.equal(mesh.path([-1, 0, 0], [3, 0, 3]), null);
  // Reversed polygon winding gives the same paths (portals are oriented from the source polygon).
  const flipped = new NavMesh(L().vertices, [
    [3, 2, 1, 0],
    [2, 5, 4, 1],
    [7, 6, 5, 2],
  ]);
  close(
    flipped.path([0.5, 0, 0.5], [3, 0, 3.5]),
    [
      [0.5, 0, 0.5],
      [2, 0, 2],
      [3, 0, 3.5],
    ],
    'flipped',
  );
  close(
    mesh.path([3, 0, 3.5], [0.5, 0, 0.5]),
    [
      [3, 0, 3.5],
      [2, 0, 2],
      [0.5, 0, 0.5],
    ],
    'reverse direction',
  );
});

test('a U-shaped corridor bends at both inner corners', () => {
  const mesh = new NavMesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 3],
      [0, 0, 3],
      [1, 0, 4],
      [0, 0, 4],
      [3, 0, 3],
      [3, 0, 4],
      [4, 0, 3],
      [4, 0, 4],
      [3, 0, 0],
      [4, 0, 0],
    ],
    [
      [0, 1, 2, 3],
      [3, 2, 4, 5],
      [2, 6, 7, 4],
      [6, 8, 9, 7],
      [10, 11, 8, 6],
    ],
  );
  const path = mesh.path([0.5, 0, 0.5], [3.5, 0, 0.5]);
  close(
    path,
    [
      [0.5, 0, 0.5],
      [1, 0, 3],
      [3, 0, 3],
      [3.5, 0, 0.5],
    ],
    'U',
  );
  for (let i = 1; i < path.length; i++)
    for (let t = 0; t <= 1; t += 0.05)
      assert.ok(mesh.locate(path[i].map((v, k) => v * t + path[i - 1][k] * (1 - t))) >= 0);
});

test('a straight line through several portals and grazing a vertex emits no corner', () => {
  const mesh = L();
  // The segment from (0.5, 0.5) to (3.5, 3.5) passes exactly through the corner vertex (2, 2).
  const path = mesh.path([0.5, 0, 0.5], [3.5, 0, 3.5]);
  close(
    path,
    [
      [0.5, 0, 0.5],
      [3.5, 0, 3.5],
    ],
    'grazing',
  );
});

test('returned points are fresh arrays and the end is not repeated', () => {
  const mesh = L(),
    start = [0.5, 0, 0.5],
    end = [2, 0, 2];
  const path = mesh.path(start, end);
  assert.notEqual(path[0], start);
  assert.notEqual(path.at(-1), end);
  close(path, [start, end], 'end on a portal vertex');
  path[0][0] = 42;
  path.at(-1)[0] = 42;
  assert.deepEqual(mesh.vertices[2], [2, 0, 2]);
  const same = mesh.path([1, 0, 1], [1, 0, 1]);
  close(
    same,
    [
      [1, 0, 1],
      [1, 0, 1],
    ],
    'same polygon, same point',
  );
});

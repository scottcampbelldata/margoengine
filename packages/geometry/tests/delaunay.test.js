// Delaunay triangulation against its definition: empty circles by brute force, Euler's count, and every outline point
// kept. Inputs are the ones that break float code: grids, points on a circle, near-collinear runs and extreme scales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { delaunayTriangulate, triangulateConstrained } from '../dist/delaunay.js';

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const triangleArea = (p, a, b, c) =>
  ((p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0])) / 2;

function totalArea(points, indices) {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) sum += triangleArea(points, indices[t], indices[t + 1], indices[t + 2]);
  return sum;
}

function assertCounterClockwise(points, indices) {
  for (let t = 0; t < indices.length; t += 3) {
    const area = triangleArea(points, indices[t], indices[t + 1], indices[t + 2]);
    assert.ok(area > 0, `triangle ${t / 3} runs counter-clockwise (${area})`);
  }
}

/** Every edge once or twice, opposite ways when twice: the triangles form a clean surface. */
function assertManifold(indices) {
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = `${indices[t + k]}>${indices[t + ((k + 1) % 3)]}`;
      assert.ok(!edges.has(key), `edge ${key} used once in each direction`);
      edges.set(key, true);
    }
  return edges;
}

const hasEdge = (edges, a, b) => edges.has(`${a}>${b}`) || edges.has(`${b}>${a}`);

function hullSize(points) {
  const sorted = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]),
    half = (list) => {
      const out = [];
      for (const p of list) {
        while (out.length > 1 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
        out.push(p);
      }
      return out.length - 1;
    };
  return half(sorted) + half(sorted.slice().reverse());
}

function assertEmptyCircles(points, indices) {
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [points[indices[t]], points[indices[t + 1]], points[indices[t + 2]]];
    for (let i = 0; i < points.length; i++) {
      if (i === indices[t] || i === indices[t + 1] || i === indices[t + 2]) continue;
      const d = points[i],
        ax = a[0] - d[0],
        ay = a[1] - d[1],
        bx = b[0] - d[0],
        by = b[1] - d[1],
        cx = c[0] - d[0],
        cy = c[1] - d[1],
        det =
          (ax * ax + ay * ay) * (bx * cy - cx * by) +
          (bx * bx + by * by) * (cx * ay - ax * cy) +
          (cx * cx + cy * cy) * (ax * by - bx * ay);
      assert.ok(det <= 1e-9, `point ${i} is inside the circle of triangle ${t / 3} (${det})`);
    }
  }
}

test('random points: every circumcircle is empty and the triangle count matches Euler', () => {
  for (const [seed, count] of [
    [1, 3],
    [2, 4],
    [3, 5],
    [4, 17],
    [5, 100],
    [6, 400],
  ]) {
    const next = random(seed),
      points = Array.from({ length: count }, () => [next() * 10, next() * 10]),
      indices = delaunayTriangulate(points);
    assertCounterClockwise(points, indices);
    assertManifold(indices);
    assertEmptyCircles(points, indices);
    assert.equal(indices.length / 3, 2 * count - 2 - hullSize(points), `${count} points`);
  }
});

test('a square grid, all of it cocircular fours, fills exactly', () => {
  const points = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) points.push([x, y]);
  const indices = delaunayTriangulate(points);
  assertCounterClockwise(points, indices);
  assertManifold(indices);
  assert.equal(indices.length / 3, 2 * 23 * 23);
  assert.equal(totalArea(points, indices), 23 * 23);
});

test('points on one circle give n - 2 triangles', () => {
  const points = Array.from({ length: 64 }, (_, i) => [
    Math.cos((i / 64) * Math.PI * 2),
    Math.sin((i / 64) * Math.PI * 2),
  ]);
  const indices = delaunayTriangulate(points);
  assert.equal(indices.length / 3, 62);
  assertCounterClockwise(points, indices);
});

test('collinear runs: none at all when all are on a line, every point used otherwise', () => {
  assert.equal(
    delaunayTriangulate([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]).length,
    0,
  );
  assert.equal(
    delaunayTriangulate([
      [0, 0],
      [1, 1],
    ]).length,
    0,
  );
  assert.equal(delaunayTriangulate([]).length, 0);
  // A flat start with the first point off the line on either side.
  for (const apex of [1, -1]) {
    const points = [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [4, apex],
      ],
      indices = delaunayTriangulate(points);
    assertCounterClockwise(points, indices);
    assert.deepEqual([...new Set(indices)].sort(), [0, 1, 2, 3, 4]);
    assert.equal(totalArea(points, indices), 1.5);
  }
  // A vertical run swept last sees the hull from straight on.
  const points = [
      [0, 0],
      [5, -1],
      [5, 0],
      [5, 1],
      [5, 2],
    ],
    indices = delaunayTriangulate(points);
  assertCounterClockwise(points, indices);
  assert.equal(indices.length / 3, 3);
});

test('repeated points map to their first copy', () => {
  const indices = delaunayTriangulate([
    [0, 0],
    [1, 0],
    [0, 0],
    [0, 1],
    [1, 0],
  ]);
  assert.deepEqual([...indices].sort(), [0, 1, 3]);
});

test('points a hair off a line are told apart exactly', () => {
  const tiny = 2 ** -50,
    points = [
      [0, 0],
      [0.5, 0.5 + tiny],
      [1, 1],
      [2, 2],
      [0.25, 0.25 - tiny],
    ],
    indices = delaunayTriangulate(points),
    used = new Set(indices);
  assert.equal(used.size, 5);
  for (let t = 0; t < indices.length; t += 3)
    assert.notDeepEqual([indices[t], indices[t + 1], indices[t + 2]].sort(), [0, 2, 3], 'no flat triangle');
});

test('huge and tiny coordinates keep the same answer, without overflow or underflow', () => {
  const next = random(9),
    base = Array.from({ length: 40 }, () => [Math.floor(next() * 1024), Math.floor(next() * 1024)]),
    unique = [...new Map(base.map((p) => [p.join(), p])).values()],
    want = [...delaunayTriangulate(unique)];
  for (const scale of [2 ** 500, 2 ** -500, 2 ** -1060]) {
    const got = [...delaunayTriangulate(unique.map(([x, y]) => [x * scale, y * scale]))];
    assert.deepEqual(got, want, `scale ${scale}`);
  }
  const big = 1e150,
    square = delaunayTriangulate([
      [0, 0],
      [big, 0],
      [big, big],
      [0, big],
    ]);
  assert.equal(square.length, 6);
  const small = 1e-150;
  assert.equal(
    delaunayTriangulate([
      [0, 0],
      [small, 0],
      [small, small],
      [0, small],
    ]).length,
    6,
  );
});

test('constraint edges are kept, and a constraint through collinear points passes through them', () => {
  const next = random(12),
    points = Array.from({ length: 60 }, () => [next() * 10, next() * 10]);
  points.push([0, 5], [10, 5.5]);
  const indices = delaunayTriangulate(points, { edges: [[60, 61]] }),
    edges = assertManifold(indices);
  assert.ok(hasEdge(edges, 60, 61));
  assertCounterClockwise(points, indices);

  const line = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [1.5, 1],
      [1.5, -1],
    ],
    through = assertManifold(delaunayTriangulate(line, { edges: [[0, 3]] }));
  assert.ok(hasEdge(through, 0, 1) && hasEdge(through, 1, 2) && hasEdge(through, 2, 3));
  // Edges on the hull exist in one direction only, and are found.
  const hullEdges = delaunayTriangulate(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    {
      edges: [
        [0, 1],
        [1, 0],
        [3, 0],
      ],
    },
  );
  assert.equal(hullEdges.length, 6);
});

test('crossing constraints are refused', () => {
  const square = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert.throws(
    () =>
      delaunayTriangulate(square, {
        edges: [
          [0, 2],
          [1, 3],
        ],
      }),
    /edges cross/,
  );
});

test('a polygon keeps every outline point, collinear ones included', () => {
  // A square with extra points along each side: ear clipping style cleanups would drop them.
  const contour = [];
  for (let i = 0; i < 8; i++) contour.push([i, 0]);
  for (let i = 0; i < 8; i++) contour.push([8, i]);
  for (let i = 0; i < 8; i++) contour.push([8 - i, 8]);
  for (let i = 0; i < 8; i++) contour.push([0, 8 - i]);
  const { indices } = triangulateConstrained(contour);
  assert.equal(new Set(indices).size, contour.length);
  assert.equal(totalArea(contour, indices), 64);
  assertCounterClockwise(contour, indices);
  const edges = assertManifold(indices);
  for (let i = 0; i < contour.length; i++) assert.ok(hasEdge(edges, i, (i + 1) % contour.length), `outline edge ${i}`);
});

test('holes work in any winding, and the area is what the rings enclose', () => {
  const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    hole = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
    ],
    other = [
      [6, 6],
      [8, 6],
      [8, 8],
      [6, 8],
    ].reverse();
  for (const ring of [outer, outer.slice().reverse()]) {
    const shape = triangulateConstrained(ring, [hole, other]),
      all = [...ring, ...hole, ...other];
    assert.equal(totalArea(all, shape.indices), 92);
    assertCounterClockwise(all, shape.indices);
    assert.equal(new Set(shape.indices).size, 12);
  }
});

test('a concave comb fills only its teeth', () => {
  const contour = [
    [0, 0],
    [9, 0],
  ];
  for (let i = 4; i >= 0; i--) {
    contour.push([i * 2 + 1, 5], [i * 2 + 1, 1]);
    if (i) contour.push([i * 2, 1], [i * 2, 5]);
  }
  contour.push([0, 5]);
  const { indices } = triangulateConstrained(contour);
  assertCounterClockwise(contour, indices);
  // Area from the shoelace formula of the same ring.
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const [ax, ay] = contour[i],
      [bx, by] = contour[(i + 1) % contour.length];
    area += (ax * by - bx * ay) / 2;
  }
  assert.equal(totalArea(contour, indices), Math.abs(area));
});

test('a hole touching the outline along a side or at a corner cuts the shape as drawn', () => {
  const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    side = [
      [4, 0],
      [6, 0],
      [6, 2],
      [4, 2],
    ],
    one = triangulateConstrained(outer, [side]);
  assert.equal(totalArea([...outer, ...side], one.indices), 96);
  const corner = [
      [10, 10],
      [8, 10],
      [8, 8],
      [10, 8],
    ],
    two = triangulateConstrained(outer, [corner]);
  assert.equal(totalArea([...outer, ...corner], two.indices), 96);
  const point = [
      [5, 0],
      [6, 2],
      [4, 2],
    ],
    three = triangulateConstrained(outer, [point]);
  assert.equal(totalArea([...outer, ...point], three.indices), 98);
});

test('inner points and inner edges are kept inside a polygon', () => {
  const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    shape = triangulateConstrained(outer, [], {
      points: [
        [3, 3],
        [7, 7],
        [5, 2],
      ],
      edges: [
        [4, 5],
        [0, 6],
      ],
    }),
    all = [...outer, ...shape.points],
    edges = assertManifold(shape.indices);
  assert.ok(hasEdge(edges, 4, 5) && hasEdge(edges, 0, 6));
  assert.equal(new Set(shape.indices).size, 7);
  assert.equal(totalArea(all, shape.indices), 100);
});

test('the smallest angle is never worse than the default triangulator, and better on a wavy outline', async () => {
  const { triangulateShape } = await import('../dist/index.js');
  const wavy = Array.from({ length: 120 }, (_, i) => {
      const a = (i / 120) * Math.PI * 2,
        r = 5 + Math.sin(a * 5) * 1.5 + Math.cos(a * 3);
      return [Math.cos(a) * r, Math.sin(a) * r];
    }),
    ellipse = Array.from({ length: 80 }, (_, i) => [
      Math.cos((i / 80) * Math.PI * 2) * 10,
      Math.sin((i / 80) * Math.PI * 2) * 2,
    ]);
  const smallest = (points, indices) => {
    let least = Math.PI;
    for (let t = 0; t < indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const o = points[indices[t + k]],
          a = points[indices[t + ((k + 1) % 3)]],
          b = points[indices[t + ((k + 2) % 3)]],
          u = [a[0] - o[0], a[1] - o[1]],
          v = [b[0] - o[0], b[1] - o[1]];
        least = Math.min(least, Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]));
      }
    return least;
  };
  const best = (contour) => {
    const ear = triangulateShape(contour, []),
      ours = triangulateConstrained(contour);
    return [smallest(ours.contour, ours.indices), smallest(ear.contour, ear.indices)];
  };
  const [ours, ear] = best(wavy);
  assert.ok(ours > ear * 1.2, `${ours} against ${ear}`);
  const [flatOurs, flatEar] = best(ellipse);
  assert.ok(flatOurs >= flatEar - 1e-12);
});

test('a repeated closing point and copies of the input are handled', () => {
  const ring = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
    shape = triangulateConstrained(ring);
  assert.equal(shape.indices.length, 6);
  assert.notEqual(shape.contour[0], ring[0]);
});

test('invalid input is refused with the fix in the message', () => {
  assert.throws(() => delaunayTriangulate([[0, NaN]]), /finite/);
  assert.throws(
    () =>
      delaunayTriangulate(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        { edges: [[0, 9]] },
      ),
    /past 3 points/,
  );
  assert.throws(
    () =>
      delaunayTriangulate(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        { edges: [[0, 0.5]] },
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      triangulateConstrained([
        [0, 0],
        [1, 1],
      ]),
    /at least 3/,
  );
  assert.throws(
    () =>
      triangulateConstrained([
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
      ]),
    /edges cross/,
  );
  assert.throws(
    () =>
      triangulateConstrained([
        [0, 0],
        [1, 0],
        [0, Infinity],
      ]),
    /finite/,
  );
});

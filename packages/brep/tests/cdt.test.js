// Constrained Delaunay triangulation of trimmed faces in parameter space. Runs the TypeScript source directly (Node
// strips the types): internal modules are not built into dist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incircle, interiorEdges, orient2d, triangulate } from '../src/mesh/cdt.ts';

const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Signed shoelace area of a loop. */
function loopArea(xy, loop) {
  let s = 0;
  for (let k = 0; k < loop.length; k++) {
    const i = loop[k],
      j = loop[(k + 1) % loop.length];
    s += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1];
  }
  return s / 2;
}

/** Undirected edges of a triangle list, as 'a-b' strings with a < b. */
function edgeSet(triangles) {
  const edges = new Set();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k],
        b = triangles[t + ((k + 1) % 3)];
      edges.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
  return edges;
}

/**
 * Triangulates and checks every invariant: triangles use the first index of duplicate points, are counter-clockwise
 * with positive area and never overlap along an edge; their areas sum to `area`; every loop edge is in the output
 * (as a chain through the points lying on it); every boundary edge of the output lies on a loop; every other edge has
 * an empty circumcircle; interiorEdges reports exactly those other edges; and a second run gives the same output.
 */
function check(xy, loops, area) {
  const triangles = triangulate(xy, loops);
  const n = xy.length / 2,
    at = (i) => [xy[2 * i], xy[2 * i + 1]],
    key = (a, b) => (a < b ? a * n + b : b * n + a);
  const first = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${xy[2 * i]},${xy[2 * i + 1]}`;
    if (!first.has(k)) first.set(k, i);
  }
  const rep = (i) => first.get(`${xy[2 * i]},${xy[2 * i + 1]}`);
  assert.ok(triangles instanceof Uint32Array);
  assert.equal(triangles.length % 3, 0);

  const directed = new Set(),
    sides = new Map(); // undirected edge -> [from, to, opposite] per triangle
  let total = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const tri = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (const v of tri) assert.ok(v < n && rep(v) === v, `vertex ${v} is the first index of its point`);
    const [a, b, c] = tri.map(at);
    assert.ok(orient2d(...a, ...b, ...c) > 0, `triangle ${tri} is counter-clockwise with positive area`);
    total += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    for (let k = 0; k < 3; k++) {
      const u = tri[k],
        w = tri[(k + 1) % 3];
      assert.ok(!directed.has(u * n + w), `half-edge ${u}-${w} appears once`);
      directed.add(u * n + w);
      const list = sides.get(key(u, w)) ?? [];
      list.push([u, w, tri[(k + 2) % 3]]);
      sides.set(key(u, w), list);
    }
  }
  assert.ok(Math.abs(total - area) <= 1e-9 * Math.abs(area), `area ${total}, expected ${area}`);

  // Loop edges, split where output vertices lie on them.
  const used = [...new Set(triangles)],
    constraint = new Set();
  for (const loop of loops)
    for (let k = 0; k < loop.length; k++) {
      const u = rep(loop[k]),
        w = rep(loop[(k + 1) % loop.length]);
      if (u === w) continue;
      let chain = [u, w];
      if (!sides.has(key(u, w))) {
        const [ux, uy] = at(u),
          [wx, wy] = at(w);
        chain = used
          .filter((v) => {
            const [vx, vy] = at(v);
            return (
              orient2d(ux, uy, wx, wy, vx, vy) === 0 &&
              Math.min(ux, wx) <= vx &&
              vx <= Math.max(ux, wx) &&
              Math.min(uy, wy) <= vy &&
              vy <= Math.max(uy, wy)
            );
          })
          .sort((p, q) => (at(p)[0] - at(q)[0]) * (wx - ux) + (at(p)[1] - at(q)[1]) * (wy - uy));
        assert.equal(chain[0], u, `loop edge ${u}-${w} starts at ${u}`);
        assert.equal(chain[chain.length - 1], w, `loop edge ${u}-${w} ends at ${w}`);
      }
      for (let i = 0; i + 1 < chain.length; i++) {
        assert.ok(sides.has(key(chain[i], chain[i + 1])), `loop edge ${u}-${w} is in the output`);
        constraint.add(key(chain[i], chain[i + 1]));
      }
    }

  const interior = [];
  for (const [edge, list] of sides) {
    assert.ok(list.length <= 2, 'an edge borders at most two triangles');
    if (list.length === 1) {
      assert.ok(constraint.has(edge), `boundary edge ${list[0][0]}-${list[0][1]} lies on a loop`);
      continue;
    }
    if (constraint.has(edge)) continue;
    interior.push(edge);
    const [[a, b, c], [, , d]] = list;
    assert.ok(incircle(...at(a), ...at(b), ...at(c), ...at(d)) <= 0, `edge ${a}-${b} has an empty circumcircle`);
  }
  const reported = interiorEdges(triangles, loops),
    got = [];
  for (let i = 0; i < reported.length; i += 2) {
    assert.ok(reported[i] < reported[i + 1]);
    got.push(key(reported[i], reported[i + 1]));
  }
  assert.deepEqual(
    got.sort((p, q) => p - q),
    interior.sort((p, q) => p - q),
  );

  assert.deepEqual(triangulate(xy, loops), triangles, 'deterministic');
  return triangles;
}

test('a square: two triangles', () => {
  assert.equal(check([0, 0, 1, 0, 1, 1, 0, 1], [[0, 1, 2, 3]], 1).length, 6);
});

test('a loop given clockwise', () => {
  assert.equal(check([0, 0, 1, 0, 1, 1, 0, 1], [[0, 3, 2, 1]], 1).length, 6);
});

test('a square with a square hole, and an island inside the hole (even-odd)', () => {
  const xy = [0, 0, 4, 0, 4, 4, 0, 4, 1, 1, 3, 1, 3, 3, 1, 3];
  assert.equal(
    check(
      xy,
      [
        [0, 1, 2, 3],
        [7, 6, 5, 4],
      ],
      12,
    ).length / 3,
    8,
  );
  const nested = [0, 0, 8, 0, 8, 8, 0, 8, 2, 2, 6, 2, 6, 6, 2, 6, 3, 3, 5, 3, 5, 5, 3, 5];
  check(
    nested,
    [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ],
    64 - 16 + 4,
  );
});

test('an L-shape', () => {
  assert.equal(check([0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2], [[0, 1, 2, 3, 4, 5]], 3).length / 3, 4);
});

test('a 64-gon with a 10 x 10 grid of free points: cocircular quadruples, points outside ignored', () => {
  const xy = [],
    loop = [];
  for (let k = 0; k < 64; k++) {
    loop.push(k);
    xy.push(Math.cos((2 * Math.PI * k) / 64), Math.sin((2 * Math.PI * k) / 64));
  }
  let inside = 0;
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 10; j++) {
      // multiples of 3/32: exact in binary, so every grid square is exactly cocircular
      const u = (i - 4.5) * 0.1875,
        v = (j - 4.5) * 0.1875;
      xy.push(u, v);
      if (u * u + v * v < 0.99) inside++; // the others lie outside the circle (radius > 1.06)
    }
  const triangles = check(xy, [loop], loopArea(xy, loop));
  assert.equal(new Set(triangles).size, 64 + inside);
  assert.equal(triangles.length / 3, 64 + 2 * inside - 2);
});

test('a 1000:1 strip with collinear boundary points and a row of free points', () => {
  const xy = [],
    loop = [];
  for (let i = 0; i <= 1000; i++) {
    loop.push(xy.length / 2);
    xy.push(i / 1000, 0);
  }
  for (let i = 1000; i >= 0; i--) {
    loop.push(xy.length / 2);
    xy.push(i / 1000, 0.001);
  }
  for (let i = 0; i < 1000; i++) xy.push((i + 0.5) / 1000, 0.0005);
  const triangles = check(xy, [loop], loopArea(xy, loop));
  assert.equal(triangles.length / 3, 2002 + 2 * 1000 - 2);
});

test('duplicate points merge into the first index; repeated consecutive indices count once', () => {
  // 4 repeats corner 1, 6 repeats the free point 5, 7 repeats corner 0
  const xy = [0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0.5, 0.5, 0.5, 0.5, 0, 0];
  const triangles = check(xy, [[7, 4, 2, 2, 3]], 1);
  assert.deepEqual(
    [...new Set(triangles)].sort((a, b) => a - b),
    [0, 1, 2, 3, 5],
  );
  assert.equal(triangles.length / 3, 4);
});

test('a point on a loop edge splits the constraint', () => {
  const triangles = check([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0, 0.25, 0.5], [[0, 1, 2, 3]], 1);
  const edges = edgeSet(triangles);
  assert.ok(edges.has('0-4') && edges.has('1-4') && !edges.has('0-1'));
});

test('loops that touch at a vertex, and a hole touching the outer loop', () => {
  // squares sharing corner 2 by index, and corner (2, 2) by a duplicate point (7 repeats 5)
  const xy = [0, 0, 1, 0, 1, 1, 0, 1, 2, 1, 2, 2, 1, 2, 2, 2, 3, 2, 3, 3, 2, 3];
  check(
    xy,
    [
      [0, 1, 2, 3],
      [2, 4, 5, 6],
      [7, 8, 9, 10],
    ],
    3,
  );
  // a triangular hole whose corner (2, 0) lies on the outer loop's bottom edge
  const pinched = check(
    [0, 0, 4, 0, 4, 4, 0, 4, 2, 0, 3, 2, 1, 2],
    [
      [0, 1, 2, 3],
      [4, 5, 6],
    ],
    16 - 2,
  );
  const edges = edgeSet(pinched);
  assert.ok(edges.has('0-4') && edges.has('1-4') && !edges.has('0-1'));
});

test('two disjoint islands', () => {
  const xy = [0, 0, 1, 0, 1, 1, 0, 1, 5, 5, 7, 5, 7, 7, 5, 7];
  assert.equal(
    check(
      xy,
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ],
      5,
    ).length / 3,
    4,
  );
});

test('a wavy 200-gon with 2000 random free points, some outside', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const xy = [],
    loop = [];
  for (let k = 0; k < 200; k++) {
    const angle = (2 * Math.PI * k) / 200,
      r = 1 + 0.3 * Math.sin(5 * angle);
    loop.push(k);
    xy.push(r * Math.cos(angle), r * Math.sin(angle));
  }
  for (let i = 0; i < 2000; i++) xy.push(random() * 2.8 - 1.4, random() * 2.8 - 1.4);
  check(xy, [loop], loopArea(xy, loop));
});

test('a 150 x 150 grid face: 22,500 points, every square cocircular', () => {
  const N = 150,
    xy = [],
    loop = [],
    id = (i, j) => j * N + i;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) xy.push(i, j);
  for (let i = 0; i < N - 1; i++) loop.push(id(i, 0));
  for (let j = 0; j < N - 1; j++) loop.push(id(N - 1, j));
  for (let i = N - 1; i > 0; i--) loop.push(id(i, N - 1));
  for (let j = N - 1; j > 0; j--) loop.push(id(0, j));
  assert.equal(check(xy, [loop], (N - 1) ** 2).length / 3, 2 * (N - 1) ** 2);
});

test('a loop of collinear points bounds nothing', () => {
  assert.equal(triangulate([0, 0, 1, 0, 2, 0], [[0, 1, 2]]).length, 0);
  assert.equal(triangulate([0, 0, 1, 0, 1, 1], []).length, 0);
});

test('bad input throws instead of hanging', () => {
  const square = [0, 0, 1, 0, 1, 1, 0, 1];
  // a bow-tie: its two diagonals cross
  assert.throws(() => triangulate([0, 0, 1, 1, 1, 0, 0, 1], [[0, 1, 2, 3]]), { name: 'TypeError', message: /cross/ });
  // two overlapping squares
  const overlap = [0, 0, 2, 0, 2, 2, 0, 2, 1, 1, 3, 1, 3, 3, 1, 3];
  assert.throws(
    () =>
      triangulate(overlap, [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ]),
    { name: 'TypeError', message: /cross/ },
  );
  // fewer than 3 distinct points, also after merging duplicates (4 repeats 1)
  assert.throws(() => triangulate(square, [[0, 1]]), { name: 'TypeError', message: /at least 3/ });
  assert.throws(() => triangulate(square, [[0, 1, 1, 0]]), { name: 'TypeError', message: /at least 3/ });
  assert.throws(() => triangulate([...square, 1, 0], [[0, 4, 1]]), { name: 'TypeError', message: /at least 3/ });
  assert.throws(() => triangulate([0, 0, 1, 0, Number.NaN, 1, 0, 1], [[0, 1, 2, 3]]), {
    name: 'TypeError',
    message: /finite/,
  });
  assert.throws(() => triangulate([0, 0, 1, 0, Number.POSITIVE_INFINITY, 1], [[0, 1, 2]]), TypeError);
  assert.throws(() => triangulate([0, 0, 1, 0, 1], [[0, 1, 2]]), TypeError);
  assert.throws(() => triangulate(square, [[0, 1, 4]]), RangeError);
  assert.throws(() => triangulate(square, [[0, 1, 2.5]]), TypeError);
});

// Every double is an integer multiple of 2^-1074: scaled by 2^1074 it is an exact BigInt.
const view = new DataView(new ArrayBuffer(8));
function exact(v) {
  view.setFloat64(0, v);
  const hi = view.getUint32(0),
    lo = view.getUint32(4),
    e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e > 0) m = (m | (1n << 52n)) << BigInt(e - 1);
  return hi >>> 31 ? -m : m;
}
const bigSign = (v) => (v > 0n ? 1 : v < 0n ? -1 : 0);
function orientExact(ax, ay, bx, by, cx, cy) {
  const [Ax, Ay, Bx, By, Cx, Cy] = [ax, ay, bx, by, cx, cy].map(exact);
  return bigSign((Ax - Cx) * (By - Cy) - (Ay - Cy) * (Bx - Cx));
}
function incircleExact(ax, ay, bx, by, cx, cy, dx, dy) {
  const [Ax, Ay, Bx, By, Cx, Cy, Dx, Dy] = [ax, ay, bx, by, cx, cy, dx, dy].map(exact);
  const adx = Ax - Dx,
    ady = Ay - Dy,
    bdx = Bx - Dx,
    bdy = By - Dy,
    cdx = Cx - Dx,
    cdy = Cy - Dy;
  return bigSign(
    (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) +
      (bdx * bdx + bdy * bdy) * (cdx * ady - adx * cdy) +
      (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady),
  );
}

test('the predicates agree with exact rational arithmetic on near-degenerate input', () => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let k = 0; k < 2000; k++) {
    // c on the line through a and b, rounded: collinear or within an ulp of it
    const ax = random() * 10 - 5,
      ay = random() * 10 - 5,
      bx = random() * 10 - 5,
      by = random() * 10 - 5,
      t = random() * 3 - 1,
      cx = ax + t * (bx - ax),
      cy = ay + t * (by - ay);
    assert.equal(sgn(orient2d(ax, ay, bx, by, cx, cy)), orientExact(ax, ay, bx, by, cx, cy));
    assert.equal(sgn(orient2d(cx, cy, ax, ay, bx, by)), orientExact(cx, cy, ax, ay, bx, by));
    // four points on a circle, rounded: cocircular or within an ulp of it
    const ox = random() * 4 - 2,
      oy = random() * 4 - 2,
      r = 0.01 + random() * 3,
      p = [0, 1, 2, 3].flatMap((i) => {
        const angle = ((i + random()) * Math.PI) / 2;
        return [ox + r * Math.cos(angle), oy + r * Math.sin(angle)];
      });
    assert.equal(sgn(incircle(...p)), incircleExact(...p));
  }
  // exactly degenerate: collinear and cocircular on binary grids, at small and large magnitudes
  for (const s of [2 ** -30, 0.375, 1, 3, 2 ** 20]) {
    assert.equal(sgn(orient2d(0, 0, s, 2 * s, 3 * s, 6 * s)), 0);
    assert.equal(sgn(orient2d(s, s, 2 * s, 2 * s, 7 * s, 7 * s)), 0);
    assert.equal(sgn(incircle(0, 0, s, 0, s, s, 0, s)), 0);
    assert.equal(sgn(incircle(1, 1, 1 + s, 1, 1 + s, 1 + s, 1, 1 + s)), 0);
    assert.equal(sgn(incircle(-2 * s, 0, 2 * s, 0, 0, 2 * s, 0, -2 * s)), 0);
    assert.equal(sgn(incircle(-2 * s, 0, 2 * s, 0, 0, 2 * s, 0, s)), 1);
    assert.equal(sgn(incircle(-2 * s, 0, 2 * s, 0, 0, 2 * s, 0, -3 * s)), -1);
  }
});

// Shape casts, point projections and point and shape overlaps on the own solver against Rapier (the root entry, as a
// black box) on the same random scene of every shape. The per-shape casts and walks are proved against brute force in
// kernel/tests/cast.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const random = (seed) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const unitQuat = (next) => {
  const q = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5],
    l = Math.hypot(...q);
  return q.map((v) => v / l);
};
const heights = Float32Array.from({ length: 25 }, (_, i) => 0.3 * ((i * 7) % 5));
const hullPoints = Float32Array.from([0, 1, 0, 1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, -1, 0, -1, 0]);
/** Every shape both solvers hold. */
const sceneShapes = [
  { shape: 'sphere', radius: 0.6 },
  { shape: 'box', halfExtents: [0.5, 0.3, 0.8] },
  { shape: 'capsule', radius: 0.3, halfHeight: 0.6 },
  { shape: 'convexHull', points: hullPoints },
  { shape: 'trimesh', vertices: Float32Array.from([-1, 0, -1, 1, 0, -1, 0, 0.5, 1, 0, -0.5, 0]), indices: Uint32Array.from([0, 1, 2, 0, 3, 1]) },
  { shape: 'heightfield', rows: 4, columns: 4, heights, scale: [3, 1, 3] },
  { shape: 'voxels', cells: Int32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1]), size: [0.4, 0.4, 0.4] },
  { shape: 'compound', parts: [{ shape: 'box', halfExtents: [0.3, 0.3, 0.3] }, { shape: 'sphere', radius: 0.4, offset: [0.8, 0, 0] }] },
];
/** The shapes placed and turned at random, each on its own body. */
const scene = (physics) => {
  const next = random(29),
    at = () => [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
    bodies = [];
  for (let i = 0; i < 32; i++) {
    // Fixed and kinematic bodies only, so shapes placed overlapping are not pushed apart differently by the two solvers.
    const colliders = { ...sceneShapes[i % sceneShapes.length], sensor: i % 9 === 4 };
    bodies.push(physics.addBody(null, { type: i % 2 ? 'kinematicPosition' : 'fixed', position: at(), rotation: unitQuat(next), colliders }));
  }
  physics instanceof Physics ? physics.step() : physics.update(1 / 60);
  return bodies;
};
const queryShapes = [
  { shape: 'sphere', radius: 0.35 },
  { shape: 'box', halfExtents: [0.3, 0.2, 0.4] },
  { shape: 'capsule', radius: 0.2, halfHeight: 0.4 },
  { shape: 'convexHull', points: hullPoints.map((v) => v * 0.4) },
];
/** Turns `v` by the unit quaternion `q`, or back by it. */
const turn = (q, v, back) => {
  const [x, y, z] = back ? [-q[0], -q[1], -q[2]] : q,
    s = q[3],
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + s * tx + (y * tz - z * ty), v[1] + s * ty + (z * tx - x * tz), v[2] + s * tz + (x * ty - y * tx)];
};
/** The point of the scene's hull, the octahedron |x| + |y| + |z| <= 1, nearest `v`, in f64: Duchi, Shalev-Shwartz,
 * Singer and Chandra 2008, "Efficient Projections onto the l1-Ball for Learning in High Dimensions", their Figure 1. */
const octahedron = (v) => {
  const a = v.map(Math.abs);
  if (a[0] + a[1] + a[2] <= 1) return v;
  const u = [...a].sort((p, q) => q - p);
  let sum = 0,
    theta = 0;
  for (let j = 0; j < 3; j++) {
    sum += u[j];
    if (u[j] - (sum - 1) / (j + 1) > 0) theta = (sum - 1) / (j + 1);
  }
  return v.map((x) => Math.sign(x) * Math.max(Math.abs(x) - theta, 0));
};
const near = (a, b, tolerance, what) => assert.ok(Math.hypot(...a.map((v, k) => v - b[k])) <= tolerance, `${what}: ${a} against ${b}`);
const setup = () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null);
  return { own, rapier, ownBodies: scene(own), rapierBodies: scene(rapier) };
};

/** Vector helpers in f64 for the exact reference below. */
const sub = (a, b) => a.map((v, k) => v - b[k]),
  add = (a, b) => a.map((v, k) => v + b[k]),
  scale = (a, s) => a.map((v) => v * s),
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unitClamp = (x) => Math.max(0, Math.min(1, x));
/** The distance from point p to segment ab, in f64. */
const pointSegment = (p, a, b) => {
  const ab = sub(b, a),
    length = dot(ab, ab);
  return Math.hypot(...sub(p, add(a, scale(ab, length > 0 ? unitClamp(dot(sub(p, a), ab) / length) : 0))));
};
/** The distance from point p to triangle abc, in f64: to its plane inside its edges, else to its nearest edge. */
const pointTriangle = (p, [a, b, c]) => {
  const n = cross(sub(b, a), sub(c, a)),
    inside = [
      [a, b],
      [b, c],
      [c, a],
    ].every(([u, v]) => dot(cross(sub(v, u), sub(p, u)), n) >= 0);
  if (inside) return Math.abs(dot(sub(p, a), n)) / Math.hypot(...n);
  return Math.min(pointSegment(p, a, b), pointSegment(p, b, c), pointSegment(p, c, a));
};
/**
 * Calls `face(i, j, k, side)` for every three of `points` whose plane has every point on one side, `side(x)` being the
 * signed distance of x from that plane, at most `tolerance` at every point. Returns whether any such plane has points
 * off it, that is whether the hull is solid.
 */
const faces = (points, tolerance, face) => {
  let solid = false;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      for (let k = j + 1; k < points.length; k++) {
        const n = cross(sub(points[j], points[i]), sub(points[k], points[i])),
          length = Math.hypot(...n);
        if (length <= tolerance * tolerance) continue;
        const sides = points.map((p) => dot(n, sub(p, points[i])) / length),
          sign = sides.every((value) => value <= tolerance) ? 1 : sides.every((value) => value >= -tolerance) ? -1 : 0;
        if (!sign) continue;
        if (sides.some((value) => Math.abs(value) > tolerance)) solid = true;
        face(i, j, k, (x) => (sign * dot(n, sub(x, points[i]))) / length);
      }
  return solid;
};
/**
 * The distance from the origin to the convex hull of `points`, in f64, 0 inside. A solid hull's boundary is covered by
 * the triangles of its points on its face planes; a flat or straight one is the union of the triangles and segments of
 * all its points.
 */
const hullDistance = (points) => {
  const tolerance = 1e-12 * Math.max(1, ...points.map((p) => Math.hypot(...p))),
    origin = [0, 0, 0];
  let best = Math.min(...points.map((p) => Math.hypot(...p))),
    inside = true;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) best = Math.min(best, pointSegment(origin, points[i], points[j]));
  const solid = faces(points, tolerance, (i, j, k, side) => {
    best = Math.min(best, pointTriangle(origin, [points[i], points[j], points[k]]));
    if (side(origin) > tolerance) inside = false;
  });
  if (!solid)
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        for (let k = j + 1; k < points.length; k++) best = Math.min(best, pointTriangle(origin, [points[i], points[j], points[k]]));
  return solid && inside ? 0 : best;
};
/**
 * Where a ray from the origin along `unit` enters the convex hull of `points`, in f64, 0 when it starts inside, Infinity
 * when it misses: the ray clipped by the half-space of each face plane. For a solid hull only.
 */
const hullEntry = (points, unit) => {
  let enter = 0,
    leave = Infinity;
  faces(points, 1e-12 * Math.max(1, ...points.map((p) => Math.hypot(...p))), (i, j, k, side) => {
    // Along the ray t unit, the signed distance is start + t along.
    const start = side([0, 0, 0]),
      along = side(unit) - start;
    if (along === 0) {
      if (start > 0) leave = -Infinity;
    } else if (along < 0) enter = Math.max(enter, -start / along);
    else leave = Math.min(leave, -start / along);
  });
  return enter <= leave ? enter : Infinity;
};
const f32 = Math.fround;
/** The eight corners of a box of half extents `half` about `at`. */
const boxCorners = (half, at = [0, 0, 0]) =>
  [-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [-1, 1].map((k) => add(at, [i * f32(half[0]), j * f32(half[1]), k * f32(half[2])]))));
/** A shape as convex pieces in its frame, each the hull of its points grown by its radius, in the solvers' f32 sizes. */
const pieces = (shape) => {
  if (shape.shape === 'sphere') return [{ points: [[0, 0, 0]], radius: f32(shape.radius) }];
  if (shape.shape === 'capsule') {
    const half = f32(shape.halfHeight);
    return [
      {
        points: [
          [0, half, 0],
          [0, -half, 0],
        ],
        radius: f32(shape.radius),
      },
    ];
  }
  if (shape.shape === 'box') return [{ points: boxCorners(shape.halfExtents), radius: 0 }];
  if (shape.shape === 'convexHull') return [{ points: Array.from({ length: shape.points.length / 3 }, (_, i) => [...shape.points.slice(3 * i, 3 * i + 3)]), radius: 0 }];
  if (shape.shape === 'trimesh') {
    const at = (i) => [...shape.vertices.slice(3 * i, 3 * i + 3)];
    return Array.from({ length: shape.indices.length / 3 }, (_, t) => ({ points: [0, 1, 2].map((k) => at(shape.indices[3 * t + k])), radius: 0 }));
  }
  if (shape.shape === 'heightfield') {
    const { rows, columns, scale: size } = shape,
      at = (r, c) => [f32(-size[0] / 2 + (size[0] * c) / columns), f32(shape.heights[r + (rows + 1) * c] * size[1]), f32(-size[2] / 2 + (size[2] * r) / rows)],
      triangles = [];
    // Each cell is split along the diagonal from row r + 1, column c to row r, column c + 1, as Rapier's height field is.
    for (let c = 0; c < columns; c++)
      for (let r = 0; r < rows; r++) triangles.push({ points: [at(r, c), at(r + 1, c), at(r, c + 1)], radius: 0 }, { points: [at(r + 1, c), at(r + 1, c + 1), at(r, c + 1)], radius: 0 });
    return triangles;
  }
  if (shape.shape === 'voxels') {
    const half = shape.size.map((v) => f32(v) / 2);
    return Array.from({ length: shape.cells.length / 3 }, (_, i) => ({ points: boxCorners(half, half.map((h, k) => (2 * shape.cells[3 * i + k] + 1) * h)), radius: 0 }));
  }
  if (shape.shape === 'compound')
    return shape.parts.flatMap((part) => pieces(part).map(({ points, radius }) => ({ points: points.map((p) => add(p, part.offset ?? [0, 0, 0])), radius })));
  throw new Error(`No reference for the ${shape.shape} shape.`);
};
/**
 * The exact first touch of a cast of `shape` on scene body `index`, in f64, Infinity when it misses within maxDistance;
 * at maxDistance 0, whether the shape overlaps the body. Two convex pieces meet where the cast's ray enters their
 * Minkowski difference, the hull of the differences of their points, grown by both radii and the target distance. When
 * nothing grows it, the ray is clipped by its faces; else the cast moves by conservative advancement (Mirtich 1996): the
 * distance changes by at most the step along a straight cast, so each step by the gap left stays short of the touch.
 */
const reference = (body, index, shape, from, rotation, unit, options) => {
  const local = (v) => turn(body.rotation, sub(v, body.position), true),
    [query] = pieces(shape),
    at = query.points.map((v) => local(add(from, turn(rotation, v)))),
    along = turn(body.rotation, unit, true),
    reach = query.radius + (options.targetDistance ?? 0),
    touches = pieces(sceneShapes[index % sceneShapes.length]).map((piece) => {
      const points = piece.points.flatMap((b) => at.map((a) => sub(b, a))),
        grown = piece.radius + reach;
      if (grown === 0) return hullEntry(points, along);
      let t = 0;
      for (let step = 0; step < 100000 && t <= options.maxDistance; step++) {
        const left = hullDistance(points.map((p) => sub(p, scale(along, t)))) - grown;
        if (left < 1e-12) return t;
        t += left;
      }
      if (t <= options.maxDistance) throw new Error(`The reference cast on body ${index} did not settle.`);
      return Infinity;
    }),
    first = Math.min(...touches);
  return first <= options.maxDistance ? first : Infinity;
};
/** How far point `p` is from scene body `index` and from the query shape moved `t` along the cast, in f64. */
const gaps = (body, index, shape, from, rotation, unit, t, p) => {
  const inBody = turn(body.rotation, sub(p, body.position), true),
    inQuery = turn(rotation, sub(p, add(from, scale(unit, t))), true),
    distance = (list, x) => Math.min(...list.map((piece) => hullDistance(piece.points.map((v) => sub(v, x))) - piece.radius));
  return [distance(pieces(sceneShapes[index % sceneShapes.length]), inBody), distance(pieces(shape), inQuery)];
};
/**
 * Rapier's long casts stop early by up to about 1e-3 of their length (a capsule cast of 2.4 m stops 2.4 mm short of the
 * closed form, which the own cast meets to 3e-6), and even its short casts can stop 2e-4 off on a height field, so
 * where the two disagree the exact reference settles it: how far `distance` is from the true first touch on `index`.
 */
const confirmed = (rapierBodies, index, shape, from, rotation, unit, distance, options) =>
  Math.abs(reference(rapierBodies[index], index, shape, from, rotation, unit, options) - distance);

test('a shape cast stops on the same collider as Rapier, at the same distance and point', () => {
  const { own, rapier, ownBodies, rapierBodies } = setup(),
    next = random(7);
  let hits = 0,
    settled = 0,
    strayPoints = 0;
  for (let i = 0; i < 400; i++) {
    const shape = queryShapes[i % queryShapes.length],
      from = [next() * 24 - 12, next() * 10 - 5, next() * 24 - 12],
      to = [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
      rotation = unitQuat(next),
      direction = to.map((v, k) => v - from[k]),
      length = Math.hypot(...direction),
      unit = direction.map((v) => v / length),
      options = { maxDistance: 30, targetDistance: i % 5 === 0 ? 0.05 : 0, excludeSensors: i % 2 === 0 },
      mine = own.shapeCast(shape, from, rotation, direction, options),
      theirs = rapier.shapeCast(shape, from, rotation, direction, options);
    assert.equal(mine === null, theirs === null, `cast ${i}: ${mine?.distance} against ${theirs?.distance}`);
    if (!mine) continue;
    const index = ownBodies.indexOf(mine.body);
    if (index !== rapierBodies.indexOf(theirs.body) || Math.abs(mine.distance - theirs.distance) > 1e-4) {
      const off = confirmed(rapierBodies, index, shape, from, rotation, unit, mine.distance, options);
      assert.ok(off < 5e-5, `cast ${i}: Rapier puts the own touch on body ${index} at ${mine.distance} off by ${off}`);
      // Nor is Rapier's earlier stop a touch there.
      const other = rapierBodies.indexOf(theirs.body);
      if (theirs.distance < mine.distance - 1e-4)
        assert.ok(confirmed(rapierBodies, other, shape, from, rotation, unit, theirs.distance, options) > 5e-5, `cast ${i}: Rapier's touch on body ${other} at ${theirs.distance} is real`);
      settled++;
    }
    if (mine.distance > 0) {
      // The own point is on the collider, the target distance from the query at the touch. Where Rapier's is more than
      // 2 mm from it, either the touch is a patch and both points are on it, or Rapier's is off the query.
      const [body, query] = gaps(rapierBodies[index], index, shape, from, rotation, unit, mine.distance, mine.point);
      assert.ok(Math.abs(body) < 1e-5 && Math.abs(query - options.targetDistance) < 1e-5, `cast ${i} point ${mine.point}: ${body} from the collider, ${query} from the query`);
      if (index === rapierBodies.indexOf(theirs.body) && Math.hypot(...sub(mine.point, theirs.point)) > 2e-3) {
        const [rapierBody, rapierQuery] = gaps(rapierBodies[index], index, shape, from, rotation, unit, mine.distance, theirs.point);
        if (Math.abs(rapierBody) > 1e-4 || Math.abs(rapierQuery - options.targetDistance) > 1e-4) strayPoints++;
      }
      assert.ok(Math.abs(Math.hypot(...mine.normal) - 1) < 1e-5 && mine.normal.reduce((sum, v, k) => sum + v * unit[k], 0) <= 1e-5, `cast ${i} normal ${mine.normal}`);
      near(mine.queryNormal, mine.normal.map((v) => -v), 1e-6, `cast ${i} query normal`);
    }
    hits++;
  }
  assert.ok(hits > 80, `too few hits to mean anything: ${hits}`);
  assert.ok(settled < hits / 4, `Rapier settled ${settled} of ${hits}`);
  assert.ok(strayPoints < hits / 10, `Rapier's point was off the touch on ${strayPoints} of ${hits}`);
});

test('a point projects onto the same collider and point as in Rapier, solid or hollow', () => {
  const { own, rapier, ownBodies, rapierBodies } = setup(),
    next = random(11);
  for (let i = 0; i < 400; i++) {
    const point = [next() * 20 - 10, next() * 8 - 4, next() * 20 - 10],
      options = { solid: i % 2 === 0, excludeSensors: i % 3 === 0 },
      mine = own.projectPoint(point, options),
      theirs = rapier.projectPoint(point, options);
    assert.ok(mine && theirs, `point ${i}`);
    assert.ok(Math.abs(mine.distance - theirs.distance) < 1e-4, `point ${i}: ${mine.distance} against ${theirs.distance}`);
    const index = ownBodies.indexOf(mine.body);
    if (index === rapierBodies.indexOf(theirs.body)) {
      assert.equal(mine.inside, theirs.inside, `point ${i} inside`);
      // A projection onto a polyhedron from afar is well set in its distance but not along the surface, where Rapier's
      // point strays by up to 1e-3; the hull's is held to its f64 projection instead.
      if (index % 8 === 3 && !mine.inside) {
        const body = mine.body,
          local = turn(body.rotation, point.map((v, k) => v - body.position[k]), true),
          exact = turn(body.rotation, octahedron(local)).map((v, k) => v + body.position[k]);
        near(mine.point, exact, 1e-5, `point ${i} on the hull`);
        near(theirs.point, exact, 2e-3, `point ${i} Rapier on the hull`);
      } else near(mine.point, theirs.point, 1e-4, `point ${i}`);
    }
  }
});

test('point and shape overlaps find the same bodies as Rapier', () => {
  const { own, rapier, ownBodies, rapierBodies } = setup(),
    next = random(13),
    indices = (list, bodies) => list.map((body) => bodies.indexOf(body)).sort((a, b) => a - b);
  let found = 0,
    fields = 0,
    missed = 0;
  // A point or a small shape dropped at random meets one of the 32 bodies about one time in twelve, so 1,200 drops.
  for (let i = 0; i < 1200; i++) {
    const point = [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
      shape = queryShapes[i % queryShapes.length],
      rotation = unitQuat(next),
      mine = indices(own.intersectPoint(point), ownBodies),
      theirs = indices(rapier.intersectPoint(point), rapierBodies);
    assert.deepEqual(mine, theirs, `point ${i} at ${point}`);
    // Rapier's intersectShape finds a height field's overlaps with a ball only, never with a box, capsule or hull, though
    // its cast from there meets them at distance 0. So the own height-field overlaps are held to the exact reference, and
    // the own list may hold those, and only those, beyond Rapier's.
    const shapes = indices(own.intersectShape(shape, point, rotation), ownBodies),
      rapierShapes = indices(rapier.intersectShape(shape, point, rotation), rapierBodies),
      extra = shapes.filter((index) => !rapierShapes.includes(index));
    for (let index = 5; index < ownBodies.length; index += sceneShapes.length) {
      if (Math.hypot(...sub(point, rapierBodies[index].position)) > 3.5) continue;
      const exact = reference(rapierBodies[index], index, shape, point, rotation, [0, 1, 0], { maxDistance: 0 }) === 0;
      assert.equal(shapes.includes(index), exact, `shape ${i} at ${point}: the own overlap with height field ${index}`);
      if (exact) fields++;
    }
    for (const index of extra) {
      assert.ok(index % sceneShapes.length === 5 && shape.shape !== 'sphere', `shape ${i} at ${point}: an own overlap with body ${index} that Rapier does not find`);
      missed++;
    }
    assert.deepEqual(shapes.filter((index) => !extra.includes(index)), rapierShapes, `shape ${i} at ${point}`);
    found += mine.length + shapes.length;
  }
  assert.ok(found > 60, `too few overlaps to mean anything: ${found}`);
  // Rapier's count for this seed, pinned so the record stays exact: it misses every one of the height-field overlaps
  // with a box, capsule or hull. A change means Rapier changed; update the parity rows and this count with it.
  assert.deepEqual({ fields, missed }, { fields: 30, missed: 17 }, 'height-field overlaps found by the exact reference, and missed by Rapier');
});

test('stopAtPenetration and the filter act as Rapier documents them', () => {
  const own = new Physics(null),
    ball = own.addBody(null, { type: 'fixed', colliders: { shape: 'sphere', radius: 1 } }),
    far = own.addBody(null, { type: 'fixed', position: [5, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  own.step();
  const probe = { shape: 'sphere', radius: 0.5 },
    out = own.shapeCast(probe, [0.8, 0, 0], [0, 0, 0, 1], [1, 0, 0]);
  assert.equal(out.body, ball);
  assert.equal(out.distance, 0);
  near(out.normal, [1, 0, 0], 1e-4, 'normal at the start');
  // Leaving the ball it starts in, the cast goes on to the box.
  const on = own.shapeCast(probe, [0.8, 0, 0], [0, 0, 0, 1], [1, 0, 0], { stopAtPenetration: false });
  assert.equal(on.body, far);
  assert.ok(Math.abs(on.distance - 3.2) < 1e-4, `${on.distance}`);
  const bare = own.shapeCast(probe, [0.8, 0, 0], [0, 0, 0, 1], [1, 0, 0], { computeImpactGeometryOnPenetration: false });
  assert.deepEqual(bare.normal, [0, 0, 0]);
  assert.equal(own.shapeCast(probe, [0.8, 0, 0], [0, 0, 0, 1], [1, 0, 0], { exclude: ball }).body, far);
  assert.equal(own.shapeCast(probe, [0.8, 0, 0], [0, 0, 0, 1], [1, 0, 0], { predicate: (body) => body !== ball }).body, far);
  assert.equal(own.shapeCast(probe, [0.8, 0, 0], [0, 0, 0, 1], [1, 0, 0], { maxDistance: 3 }).body, ball);
  assert.deepEqual(own.intersectPoint([0.2, 0, 0]), [ball]);
  assert.deepEqual(own.intersectPoint([0.2, 0, 0], { excludeFixed: true }), []);
  assert.equal(own.projectPoint([2, 0, 0], { predicate: (body) => body === far }).body, far);
  assert.throws(() => own.shapeCast({ shape: 'trimesh', vertices: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]) }, [0, 0, 0], [0, 0, 0, 1], [1, 0, 0]), { code: 'unsupported' });
  assert.throws(() => own.shapeCast(probe, [0, 0, 0], [0, 0, 0, 1], [0, 0, 0]), RangeError);
});

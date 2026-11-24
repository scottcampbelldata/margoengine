// Cylinders and cones on the own solver, sharp and with a border (Rapier's roundCylinder and roundCone), held to Rapier
// (the root entry, as a black box) and to closed forms: mass, centre and inertia, rays, shape casts and rest. The
// support, parts, profile projection, rounded mass and manifolds are proved in kernel/tests/revolve.rs, the casts against
// a bisection in kernel/tests/cast.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} against ${expected}`);
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
const step = (physics) => (physics instanceof Physics ? physics.step() : physics.update(1 / 60));

/**
 * The volume of a cylinder's or cone's core grown by a ball of radius `b`, by a sum over a fine grid of its (rho, y)
 * profile, each cell weighted 2 pi rho: a point is inside when its distance to the core's profile, found by a plain
 * search over the profile's sides, is at most `b`. Independent of the kernel's and the entry's piecewise sums.
 */
function roundedVolume(cone, r, h, b) {
  const corners = cone
      ? [
          [0, -h],
          [r, -h],
          [0, h],
        ]
      : [
          [0, -h],
          [r, -h],
          [r, h],
          [0, h],
        ],
    toSide = (p, a, c) => {
      const d = [c[0] - a[0], c[1] - a[1]],
        t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])));
      return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]);
    },
    inside = (p) => {
      // Inside the convex profile: on the inner side of every side, counterclockwise.
      let all = true,
        nearest = Infinity;
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i],
          c = corners[(i + 1) % corners.length];
        if ((c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]) < 0) all = false;
        nearest = Math.min(nearest, toSide(p, a, c));
      }
      return all || nearest <= b;
    },
    n = 1200,
    top = r + b,
    low = -h - b,
    high = h + b,
    cell = [top / n, (high - low) / n];
  let sum = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p = [(i + 0.5) * cell[0], low + (j + 0.5) * cell[1]];
      if (inside(p)) sum += 2 * Math.PI * p[0];
    }
  return sum * cell[0] * cell[1];
}

test('a cylinder and a cone weigh what Rapier says, with the centre and inertia it gives', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null);
  for (const colliders of [
    { shape: 'cylinder', radius: 0.4, halfHeight: 0.7, density: 2 },
    { shape: 'cone', radius: 0.5, halfHeight: 0.6, density: 3 },
    { shape: 'cone', radius: 0.5, halfHeight: 0.6, offset: [0.3, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
  ]) {
    const a = own.addBody(null, { position: [0, 3, 0], colliders }),
      b = rapier.addBody(null, { position: [0, 3, 0], colliders });
    near(a.mass, b.mass, 1e-5 * b.mass, `${colliders.shape} mass`);
    for (let k = 0; k < 3; k++) near(a.centerOfMass[k], b.centerOfMass[k], 1e-5, `${colliders.shape} centre ${k}`);
    const ours = [...a.principalInertia].sort((x, y) => x - y),
      theirs = [...b.principalInertia].sort((x, y) => x - y);
    for (let k = 0; k < 3; k++) near(ours[k], theirs[k], 1e-5 * theirs[2], `${colliders.shape} principal moment ${k}`);
    // A mass given: the density follows from the volume, as on Rapier.
    near(own.addBody(null, { colliders: { ...colliders, density: undefined, mass: 7 } }).mass, 7, 7e-6, `${colliders.shape} mass option`);
  }
  own.dispose();
  rapier.dispose();
});

test('a round cylinder or cone weighs its border too, where Rapier weighs only its core', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null);
  for (const [shape, radius, halfHeight, borderRadius] of [
    ['cylinder', 0.4, 0.7, 0.1],
    ['cylinder', 0.2, 0.1, 0.3],
    ['cone', 0.5, 0.6, 0.1],
    ['cone', 0.9, 0.2, 0.25],
  ]) {
    const colliders = { shape, radius, halfHeight, borderRadius },
      rounded = roundedVolume(shape === 'cone', radius, halfHeight, borderRadius),
      core = shape === 'cone' ? (Math.PI * radius * radius * 2 * halfHeight) / 3 : Math.PI * radius * radius * 2 * halfHeight;
    near(own.addBody(null, { colliders }).mass, rounded, 2e-4 * rounded, `${shape} ${borderRadius}: the rounded solid's volume`);
    // Rapier's figure, pinned so a change in it shows: the core's alone (docs/rapier-parity.md, S-10).
    near(rapier.addBody(null, { colliders }).mass, core, 1e-5 * core, `${shape} ${borderRadius}: Rapier's mass`);
    // The entry's volume for a given mass is the kernel's to the last bits that matter.
    near(own.addBody(null, { colliders: { ...colliders, mass: 5 } }).mass, 5, 5e-6, `${shape} ${borderRadius}: mass option`);
  }
  own.dispose();
  rapier.dispose();
});

/** Vector helpers in f64 for the exact references below. */
const add = (a, b) => a.map((v, k) => v + b[k]),
  sub = (a, b) => a.map((v, k) => v - b[k]),
  scale = (a, s) => a.map((v) => v * s),
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Turns `v` by the unit quaternion `q`, or back by it. */
const turn = (q, v, back) => {
  const [x, y, z] = back ? [-q[0], -q[1], -q[2]] : q,
    s = q[3],
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + s * tx + (y * tz - z * ty), v[1] + s * ty + (z * tx - x * tz), v[2] + s * tz + (x * ty - y * tx)];
};

/**
 * The point of a cylinder's or cone's core nearest `p` (its frame), in f64: in the profile plane through `p`, the
 * nearest point of the profile's outer sides, or `p` itself inside.
 */
function nearestOnCore(shape, p) {
  const { radius: r, halfHeight: h } = shape,
    rho = Math.hypot(p[0], p[2]),
    [ux, uz] = rho > 0 ? [p[0] / rho, p[2] / rho] : [1, 0],
    q = [rho, p[1]],
    corners =
      shape.shape === 'cone'
        ? [
            [0, -h],
            [r, -h],
            [0, h],
          ]
        : [
            [0, -h],
            [r, -h],
            [r, h],
            [0, h],
          ];
  let inside = true,
    best = null,
    far = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i],
      c = corners[(i + 1) % corners.length],
      d = [c[0] - a[0], c[1] - a[1]];
    if (d[0] * (q[1] - a[1]) - d[1] * (q[0] - a[0]) < 0) inside = false;
    // The side on the axis is not surface.
    if (a[0] === 0 && c[0] === 0) continue;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]))),
      foot = [a[0] + t * d[0], a[1] + t * d[1]],
      distance = Math.hypot(q[0] - foot[0], q[1] - foot[1]);
    if (distance < far) [far, best] = [distance, foot];
  }
  return inside ? p : [best[0] * ux, best[1], best[0] * uz];
}

/** The support point, farthest along `d`, of a shape (as `addBody` takes its options) at a pose, in f64. */
const supportOf = (shape, position, rotation) => (d) => {
  const l = turn(rotation, d, true),
    n = Math.hypot(...l);
  let p = [0, 0, 0],
    grow = shape.borderRadius ?? 0;
  if (shape.shape === 'sphere') grow = shape.radius;
  else if (shape.shape === 'box') p = l.map((v, k) => (v >= 0 ? shape.halfExtents[k] : -shape.halfExtents[k]));
  else {
    const { radius: r, halfHeight: h } = shape,
      s = Math.hypot(l[0], l[2]),
      [ux, uz] = s > 0 ? [l[0] / s, l[2] / s] : [0, 0];
    if (shape.shape === 'cone') p = 2 * h * l[1] >= r * s ? [0, h, 0] : [r * ux, -h, r * uz];
    else p = [r * ux, l[1] >= 0 ? h : -h, r * uz];
  }
  if (grow > 0 && n > 0) p = add(p, scale(l, grow / n));
  return add(turn(rotation, p), position);
};

/** The closest point to the origin of a simplex of 1 to 4 points, and which points hold it, in f64 (Ericson's regions). */
function closest(s) {
  if (s.length === 1) return { point: s[0], kept: [0] };
  if (s.length === 2) {
    const t = sub(s[1], s[0]),
      u = -dot(s[0], t) / dot(t, t);
    if (u <= 0) return { point: s[0], kept: [0] };
    if (u >= 1) return { point: s[1], kept: [1] };
    return { point: add(s[0], scale(t, u)), kept: [0, 1] };
  }
  if (s.length === 3) {
    const [a, b, c] = s,
      ab = sub(b, a),
      ac = sub(c, a),
      d1 = -dot(ab, a),
      d2 = -dot(ac, a);
    if (d1 <= 0 && d2 <= 0) return { point: a, kept: [0] };
    const d3 = -dot(ab, b),
      d4 = -dot(ac, b);
    if (d3 >= 0 && d4 <= d3) return { point: b, kept: [1] };
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return { point: add(a, scale(ab, d1 / (d1 - d3))), kept: [0, 1] };
    const d5 = -dot(ab, c),
      d6 = -dot(ac, c);
    if (d6 >= 0 && d5 <= d6) return { point: c, kept: [2] };
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return { point: add(a, scale(ac, d2 / (d2 - d6))), kept: [0, 2] };
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
      return { point: add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))), kept: [1, 2] };
    const w = 1 / (va + vb + vc);
    return { point: add(a, add(scale(ab, vb * w), scale(ac, vc * w))), kept: [0, 1, 2] };
  }
  // The origin is inside when the volumes with it put in place of each vertex all have the sign of the whole. Each is a
  // face's area vector, from its two shorter edges, against its vertex nearest the origin: GJK on curves crowds vertices
  // into needles, whose plain determinants cancel to noise (Kahan 2014).
  const nearest = (...points) => points.reduce((m, p) => (dot(p, p) < dot(m, m) ? p : m)),
    area = (x, y, z) => {
      const e = [sub(y, x), sub(z, y), sub(x, z)],
        l = e.map((v) => dot(v, v));
      return l[0] >= l[1] && l[0] >= l[2] ? cross(e[1], e[2]) : l[1] >= l[2] ? cross(e[2], e[0]) : cross(e[0], e[1]);
    },
    volume = (x, y, z) => dot(nearest(x, y, z), area(x, y, z)),
    [a, b, c, d] = s,
    parts = [-volume(b, c, d), volume(a, c, d), -volume(a, b, d), volume(a, b, c)],
    whole = parts[0] + parts[1] + parts[2] + parts[3];
  if (parts.every((part) => (part > 0 && whole > 0) || (part < 0 && whole < 0))) return { point: [0, 0, 0], kept: [0, 1, 2, 3] };
  let best = null;
  for (const face of [
    [1, 2, 3],
    [0, 2, 3],
    [0, 1, 3],
    [0, 1, 2],
  ]) {
    const found = closest(face.map((k) => s[k]));
    if (!best || dot(found.point, found.point) < dot(best.point, best.point)) best = { point: found.point, kept: found.kept.map((m) => face[m]) };
  }
  return best;
}

/** The distance between two convex shapes given by their supports, 0 when they overlap: GJK in f64. */
function gap(a, b) {
  let simplex = [sub(a([1, 0, 0]), b([-1, 0, 0]))],
    v = simplex[0];
  for (let i = 0; i < 2000; i++) {
    const vv = dot(v, v);
    if (vv < 1e-30) return 0;
    const w = sub(a(scale(v, -1)), b(v));
    if (vv - dot(v, w) <= 1e-14 * vv || simplex.some((y) => y[0] === w[0] && y[1] === w[1] && y[2] === w[2])) break;
    const grown = [...simplex, w],
      { point, kept } = closest(grown);
    if (kept.length === 4) return 0;
    if (!(dot(point, point) < vv)) break;
    simplex = kept.map((k) => grown[k]);
    v = point;
  }
  return Math.sqrt(dot(v, v));
}

/**
 * The first time in [0, max] that `distance(t)`, convex in t, falls to `target`, in f64: a golden-section search for its
 * least value, then halving down to the first time at the target. Null when it never gets there.
 */
function firstTouch(distance, max, target) {
  if (distance(0) <= target) return 0;
  let [lo, hi] = [0, max];
  const g = 0.6180339887498949;
  for (let i = 0; i < 90; i++) {
    const [m1, m2] = [hi - g * (hi - lo), lo + g * (hi - lo)];
    if (distance(m1) < distance(m2)) hi = m2;
    else lo = m1;
  }
  if (distance(lo) > target) return null;
  let [a, b] = [0, lo];
  for (let i = 0; i < 70; i++) {
    const m = (a + b) / 2;
    if (distance(m) <= target) b = m;
    else a = m;
  }
  return b;
}

/** The last time in [0, max] that `distance(t)`, at most `target` at 0 and convex in t, is at most `target`, by halving. */
function lastInside(distance, max, target) {
  if (distance(max) <= target) return null;
  let [a, b] = [0, max];
  for (let i = 0; i < 70; i++) {
    const m = (a + b) / 2;
    if (distance(m) <= target) a = m;
    else b = m;
  }
  return a;
}

/** The first time before `inside`, where `distance` is 0, that it is 0: halving, as the set where it is 0 is one interval. */
function touchBefore(distance, inside) {
  if (distance(0) === 0) return 0;
  let [a, b] = [0, inside];
  for (let i = 0; i < 70; i++) {
    const m = (a + b) / 2;
    if (distance(m) === 0) b = m;
    else a = m;
  }
  return b;
}

/** Cylinders and cones, sharp and round, with a box and a ball, placed and turned at random, each on a fixed body. */
const revolvedShapes = [
  { shape: 'cylinder', radius: 0.5, halfHeight: 0.4 },
  { shape: 'cone', radius: 0.6, halfHeight: 0.5 },
  { shape: 'cylinder', radius: 0.3, halfHeight: 0.8, borderRadius: 0.1 },
  { shape: 'cone', radius: 0.4, halfHeight: 0.3, borderRadius: 0.15 },
  { shape: 'box', halfExtents: [0.5, 0.3, 0.8] },
  { shape: 'sphere', radius: 0.6 },
];
const scene = (physics) => {
  const next = random(41),
    bodies = [];
  for (let i = 0; i < 30; i++)
    bodies.push(
      physics.addBody(null, {
        type: 'fixed',
        position: [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
        rotation: unitQuat(next),
        colliders: revolvedShapes[i % revolvedShapes.length],
      }),
    );
  step(physics);
  return bodies;
};
/** The support of scene body `index` where the solver put it. */
const supportOfBody = (bodies, index) => supportOf(revolvedShapes[index % revolvedShapes.length], bodies[index].position, bodies[index].rotation);

test('a ray meets a cylinder or cone where the exact surface is, closer than Rapier, on the body Rapier names', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    ownBodies = scene(own),
    rapierBodies = scene(rapier),
    next = random(5),
    worst = { own: [0, 0], rapier: [0, 0] };
  let hits = 0;
  for (let i = 0; i < 1600; i++) {
    const origin = [next() * 24 - 12, next() * 10 - 5, next() * 24 - 12],
      target = [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
      direction = target.map((v, k) => v - origin[k]),
      unit = scale(direction, 1 / Math.hypot(...direction)),
      solid = i % 2 === 0,
      a = own.raycast(origin, direction, { solid, maxDistance: 30 }),
      b = rapier.raycast(origin, direction, { solid, maxDistance: 30 });
    assert.equal(!!a, !!b, `ray ${i}: hit or miss`);
    if (!a || a.distance === 0) continue;
    const index = ownBodies.indexOf(a.body),
      shape = revolvedShapes[index % revolvedShapes.length];
    assert.equal(index, rapierBodies.indexOf(b.body), `ray ${i}: the same body`);
    if (shape.shape !== 'cylinder' && shape.shape !== 'cone') continue;
    hits++;
    // The exact touch: the first time the ray's point is the border away from the core, and the outward normal there,
    // read from a point just outside so a sharp face has one. A hollow ray from inside meets the surface where it leaves,
    // with the normal turned in, as on Rapier. A ray that grazes the exact surface (passes it by less than the rounding of
    // its own start) has no touch; the gap it leaves at the hit is the measure, and no normal.
    const { position, rotation } = ownBodies[index],
      local = (t) => turn(rotation, sub(add(origin, scale(unit, t)), position), true),
      border = shape.borderRadius ?? 0,
      out = (t) => Math.hypot(...sub(local(t), nearestOnCore(shape, local(t)))),
      leaving = out(0) <= border,
      exact = leaving ? lastInside(out, 30, border) : firstTouch(out, 30, border),
      outside = local((exact ?? 0) + (leaving ? 1e-7 : -1e-7)),
      normal = scale(turn(rotation, sub(outside, nearestOnCore(shape, outside))), leaving ? -1 : 1),
      unitNormal = scale(normal, 1 / Math.hypot(...normal));
    for (const [who, hit] of [
      ['own', a],
      ['rapier', b],
    ]) {
      const off = exact === null ? out(hit.distance) - border : Math.abs(hit.distance - exact),
        tilt = exact === null ? 0 : Math.hypot(...sub(hit.normal, unitNormal));
      worst[who] = [Math.max(worst[who][0], off), Math.max(worst[who][1], tilt)];
      if (who === 'own') {
        assert.ok(off < 2e-5, `ray ${i} on the ${shape.shape} ${border}: ${hit.distance} against ${exact}`);
        assert.ok(tilt < 1e-4, `ray ${i} on the ${shape.shape} ${border}: normal ${hit.normal} against ${unitNormal}`);
      }
    }
  }
  assert.ok(hits > 150, `too few hits on cylinders and cones to mean anything: ${hits}`);
  assert.ok(worst.own[0] <= worst.rapier[0] && worst.own[1] <= worst.rapier[1], `own ${worst.own}, Rapier ${worst.rapier}`);
  own.dispose();
  rapier.dispose();
});

test('a cylinder or cone cast stops at the exact first touch, as close as Rapier or closer, on the body Rapier names', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    ownBodies = scene(own),
    rapierBodies = scene(rapier),
    next = random(9),
    queries = revolvedShapes.slice(0, 4).map((shape) => ({ ...shape, radius: shape.radius * 0.6, halfHeight: shape.halfHeight * 0.6 })),
    worst = { own: 0, rapier: 0 };
  let hits = 0;
  for (let i = 0; i < 600; i++) {
    const shape = queries[i % queries.length],
      from = [next() * 24 - 12, next() * 10 - 5, next() * 24 - 12],
      to = [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
      rotation = unitQuat(next),
      direction = to.map((v, k) => v - from[k]),
      unit = scale(direction, 1 / Math.hypot(...direction)),
      mine = own.shapeCast(shape, from, rotation, direction, { maxDistance: 30 }),
      theirs = rapier.shapeCast(shape, from, rotation, direction, { maxDistance: 30 });
    assert.equal(mine === null, theirs === null, `cast ${i}: ${mine?.distance} against ${theirs?.distance}`);
    if (!mine || mine.distance === 0) continue;
    hits++;
    const index = ownBodies.indexOf(mine.body);
    assert.equal(index, rapierBodies.indexOf(theirs.body), `cast ${i}: the same body`);
    // The gap left at each solver's touch, and the exact first touch, from GJK in f64 on the shapes where the solvers put
    // them.
    const body = supportOfBody(ownBodies, index),
      at = (t) => gap(supportOf(shape, add(from, scale(unit, t)), rotation), body),
      // A time just past either touch where the shapes overlap in f64; none for a graze, where the gap left is the measure.
      inside = [mine.distance, theirs.distance].flatMap((t) => Array.from({ length: 30 }, (_, k) => t + 1e-8 * 2 ** k)).find((t) => at(t) === 0),
      exact = inside === undefined ? null : touchBefore(at, inside);
    for (const [who, hit] of [
      ['own', mine],
      ['rapier', theirs],
    ]) {
      // Short of the touch, the gap left; past it, how deep.
      const off = exact === null || hit.distance <= exact ? at(hit.distance) : hit.distance - exact;
      worst[who] = Math.max(worst[who], off);
      if (who === 'own') assert.ok(off < 1e-5, `cast ${i} on the ${shape.shape}: ${hit.distance}, ${off} off the touch at ${exact}`);
    }
  }
  assert.ok(hits > 80, `too few hits to mean anything: ${hits}`);
  assert.ok(worst.own <= worst.rapier, `own ${worst.own}, Rapier ${worst.rapier}`);
  own.dispose();
  rapier.dispose();
});

test('a cylinder stands on its cap, lies without rolling, and a cone stands on its base, where Rapier rests them', () => {
  const cases = [
    // Shape, rotation, the closed form height of the body's origin above the floor.
    [{ shape: 'cylinder', radius: 0.4, halfHeight: 0.6 }, [0, 0, 0, 1], 0.6],
    [{ shape: 'cylinder', radius: 0.4, halfHeight: 0.6 }, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 0.4],
    [{ shape: 'cylinder', radius: 0.4, halfHeight: 0.6, borderRadius: 0.05 }, [Math.SQRT1_2, 0, 0, Math.SQRT1_2], 0.45],
    [{ shape: 'cone', radius: 0.5, halfHeight: 0.5 }, [0, 0, 0, 1], 0.5],
    [{ shape: 'cone', radius: 0.5, halfHeight: 0.5, borderRadius: 0.05 }, [0, 0, 0, 1], 0.55],
  ];
  for (const [colliders, rotation, height] of cases) {
    const rest = (PhysicsClass) => {
      const physics = new PhysicsClass(null);
      physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
      const body = physics.addBody(null, { position: [1, height + 0.3, -2], rotation, colliders });
      for (let i = 0; i < 240; i++) step(physics);
      const position = [...body.position];
      physics.dispose();
      return position;
    };
    const ours = rest(Physics),
      theirs = rest(RapierPhysics),
      what = `${colliders.shape} ${colliders.borderRadius ?? 0} at ${rotation}`;
    near(ours[1], height, 2e-3, `${what}: rest height`);
    near(ours[0], 1, 1e-3, `${what}: stays where it fell`);
    near(ours[2], -2, 1e-3, `${what}: stays where it fell`);
    for (let k = 0; k < 3; k++) near(ours[k], theirs[k], 0.01, `${what}: where Rapier rests it, ${k}`);
  }
});

test('cylinder and cone sizes and borders are checked, and the collider reads them back', () => {
  const own = new Physics(null),
    body = own.addBody(null, { colliders: { shape: 'cone', radius: 0.5, halfHeight: 0.6, borderRadius: 0.1 } }),
    [cone] = body.colliders;
  near(cone.radius(), 0.5, 1e-7, 'radius');
  near(cone.halfHeight(), 0.6, 1e-7, 'half height');
  near(cone.borderRadius(), 0.1, 1e-7, 'border');
  near(cone.boundingRadius, Math.hypot(0.5, 0.6) + 0.1, 1e-6, 'bounding radius');
  assert.equal(own.addBody(null, { colliders: { shape: 'cylinder', radius: 1, halfHeight: 1 } }).colliders[0].borderRadius(), 0);
  assert.throws(() => own.addBody(null, { colliders: { shape: 'cylinder', radius: 1, halfHeight: 1, borderRadius: -0.1 } }), RangeError);
  assert.throws(() => own.addBody(null, { colliders: { shape: 'cone', radius: 0, halfHeight: 1 } }), RangeError);
  assert.throws(() => own.kernel.addCollider(body.row, 'cylinder', [1, 1]), RangeError);
  own.dispose();
});

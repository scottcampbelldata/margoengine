// Rays on the own solver against Rapier (the root entry, as a black box) on the same random scenes: the first hit and
// every hit, distance, point and normal, with each filter option. The per-shape closed forms and walks are proved
// against brute force in kernel/tests/query.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

/** A small deterministic generator (xorshift32), the same scene on both solvers. */
const random = (seed) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const heights = Float32Array.from({ length: 25 }, (_, i) => 0.3 * ((i * 7) % 5));
/** Every shape the own solver holds, placed and turned at random, each on its own body of a random kind. */
const scene = (physics) => {
  const next = random(17),
    at = () => [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8],
    turn = () => {
      const q = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5],
        l = Math.hypot(...q);
      return q.map((v) => v / l);
    },
    shapes = [
      { shape: 'sphere', radius: 0.6 },
      { shape: 'box', halfExtents: [0.5, 0.3, 0.8] },
      { shape: 'capsule', radius: 0.3, halfHeight: 0.6 },
      { shape: 'convexHull', points: Float32Array.from([0, 1, 0, 1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, -1, 0, -1, 0]) },
      { shape: 'trimesh', vertices: Float32Array.from([-1, 0, -1, 1, 0, -1, 0, 0.5, 1, 0, -0.5, 0]), indices: Uint32Array.from([0, 1, 2, 0, 3, 1]) },
      { shape: 'heightfield', rows: 4, columns: 4, heights, scale: [3, 1, 3] },
      { shape: 'voxels', cells: Int32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1]), size: [0.4, 0.4, 0.4] },
    ],
    kinds = ['fixed', 'kinematicPosition', 'dynamic'],
    bodies = [];
  for (let i = 0; i < 28; i++) {
    const colliders = { ...shapes[i % shapes.length], sensor: i % 9 === 4 },
      type = colliders.shape === 'trimesh' || colliders.shape === 'heightfield' || colliders.shape === 'voxels' ? 'fixed' : kinds[i % 3];
    bodies.push(physics.addBody(null, { type, position: at(), rotation: turn(), gravityScale: 0, colliders }));
  }
  physics instanceof Physics ? physics.step() : physics.update(1 / 60);
  return bodies;
};
const rays = () => {
  const next = random(5),
    out = [];
  for (let i = 0; i < 600; i++) {
    const origin = [next() * 24 - 12, next() * 10 - 5, next() * 24 - 12],
      target = [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8];
    out.push([origin, target.map((v, k) => v - origin[k])]);
  }
  return out;
};
const close = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} against ${b}`);
/**
 * A hit the own solver finds and Rapier 0.21 does not is allowed only where Rapier itself confirms the surface: its ray
 * from 1 cm in front of the point, back along the normal, meets the same collider 1 cm on. Rapier misses some rays that
 * cross a height field's cells this way (docs/rapier-parity.md, Q-01).
 */
const confirmed = (rapier, rapierBodies, index, hit) => {
  const from = hit.point.map((v, k) => v + hit.normal[k] * 0.01),
    back = rapier.raycastAll(from, hit.normal.map((v) => -v), { maxDistance: 0.02, predicate: (body) => rapierBodies.indexOf(body) === index });
  return back.length === 1 && Math.abs(back[0].distance - 0.01) < 1e-4;
};
/** The own list without the hits Rapier misses but confirms; how many it dropped goes to `missed`. */
const agreed = (own, ownBodies, rapier, rapierBodies, theirs, missed) =>
  own.filter((hit) => {
    const index = ownBodies.indexOf(hit.body);
    if (theirs.some((other) => rapierBodies.indexOf(other.body) === index)) return true;
    assert.ok(confirmed(rapier, rapierBodies, index, hit), `own hit on body ${index} at ${hit.point} that Rapier does not confirm`);
    missed.count++;
    return false;
  });

test('raycast finds the hit Rapier finds on every shape: the body, distance, point and normal', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    ownBodies = scene(own),
    rapierBodies = scene(rapier),
    missed = { count: 0 };
  let hits = 0;
  for (const solid of [true, false])
    for (const [origin, direction] of rays()) {
      const b = rapier.raycast(origin, direction, { solid, maxDistance: 30 });
      let a = own.raycast(origin, direction, { solid, maxDistance: 30 });
      if (a && (!b || b.distance > a.distance + 1e-4) && confirmed(rapier, rapierBodies, ownBodies.indexOf(a.body), a)) {
        // Rapier missed this one; its next hit must be the own solver's next one.
        missed.count++;
        const index = ownBodies.indexOf(a.body);
        a = own.raycast(origin, direction, { solid, maxDistance: 30, predicate: (body) => ownBodies.indexOf(body) !== index });
      }
      assert.equal(!!a, !!b, `hit or miss from ${origin} along ${direction}`);
      if (!a) continue;
      hits++;
      assert.equal(ownBodies.indexOf(a.body), rapierBodies.indexOf(b.body), 'the same body');
      close(a.distance, b.distance, 1e-4, 'distance');
      for (let k = 0; k < 3; k++) close(a.point[k], b.point[k], 1e-3, 'point');
      // Rapier gives a solid start inside a ball the ray's reverse, and other shapes no normal; the own solver none.
      if (a.distance > 0) for (let k = 0; k < 3; k++) close(a.normal[k], b.normal[k], 1e-3, `normal of ${a.collider.shape ?? ''}`);
    }
  assert.ok(hits > 150, `enough hits to mean anything: ${hits}`);
  assert.ok(missed.count <= 4, `hits Rapier misses: ${missed.count}`);
});

test('raycastAll lists every collider on the ray, nearest first, as Rapier does, and stop ends the list', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    ownBodies = scene(own),
    rapierBodies = scene(rapier),
    missed = { count: 0 };
  let many = 0;
  for (const [origin, direction] of rays()) {
    const b = rapier.raycastAll(origin, direction),
      a = agreed(own.raycastAll(origin, direction), ownBodies, rapier, rapierBodies, b, missed);
    assert.deepEqual(
      a.map((hit) => ownBodies.indexOf(hit.body)),
      b.map((hit) => rapierBodies.indexOf(hit.body)),
      `bodies from ${origin}`,
    );
    a.forEach((hit, i) => close(hit.distance, b[i].distance, 1e-4, 'distance'));
    if (a.length > 1) {
      many++;
      assert.equal(own.raycastAll(origin, direction, { stop: () => false }).length, 1);
    }
  }
  assert.ok(many > 10, `rays with several hits: ${many}`);
  assert.ok(missed.count <= 4, `hits Rapier misses: ${missed.count}`);
});

test('the query filter leaves out what each option names, as on Rapier', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    ownBodies = scene(own),
    rapierBodies = scene(rapier),
    options = [
      { excludeSensors: true },
      { excludeFixed: true },
      { excludeKinematic: true },
      { excludeDynamic: true },
      { groups: 0x00010001 },
      { exclude: 0 },
      { predicate: (body) => body !== 3 },
    ];
  ownBodies[5].colliders[0].setCollisionGroups(0x00020002);
  rapierBodies[5].colliders[0].setCollisionGroups(0x00020002);
  for (const option of options) {
    const pick = (bodies) => {
      const out = { ...option };
      if ('exclude' in option) out.exclude = bodies[option.exclude];
      if (option.predicate) out.predicate = (body) => bodies.indexOf(body) !== 3;
      return out;
    };
    for (const [origin, direction] of rays()) {
      const b = rapier.raycastAll(origin, direction, pick(rapierBodies)),
        a = agreed(own.raycastAll(origin, direction, pick(ownBodies)), ownBodies, rapier, rapierBodies, b, { count: 0 });
      assert.deepEqual(
        a.map((hit) => ownBodies.indexOf(hit.body)),
        b.map((hit) => rapierBodies.indexOf(hit.body)),
        `${JSON.stringify(option)} from ${origin}`,
      );
      const first = own.raycast(origin, direction, pick(ownBodies)),
        all = own.raycastAll(origin, direction, pick(ownBodies));
      assert.equal(first ? ownBodies.indexOf(first.body) : -1, all.length ? ownBodies.indexOf(all[0].body) : -1, 'raycast is the first of raycastAll');
    }
  }
  // The flags Rapier has that the root entry does not name: solids out, and one kind only.
  const sensors = own.raycastAll([0, 0, -20], [0, 0, 1], { excludeSolids: true });
  assert.ok(sensors.every((hit) => hit.collider.isSensor()));
  for (const [flag, type] of [['onlyDynamic', 'dynamic'], ['onlyFixed', 'fixed'], ['onlyKinematic', 'kinematicPosition']])
    for (const [origin, direction] of rays().slice(0, 100))
      assert.ok(own.raycastAll(origin, direction, { [flag]: true }).every((hit) => hit.body.type === type), flag);
});

test('a ray refuses a zero or not finite direction', () => {
  const physics = new Physics(null);
  assert.throws(() => physics.raycast([0, 0, 0], [0, 0, 0]), RangeError);
  assert.throws(() => physics.raycast([0, Number.NaN, 0], [0, 1, 0]), RangeError);
  assert.equal(physics.raycast([0, 0, 0], [0, 1, 0]), null);
});

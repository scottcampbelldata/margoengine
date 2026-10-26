// Ropes, spring and rope joints, compound and convex-decomposition colliders, and ray-cast vehicles, against real Rapier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Physics, Rope, Vehicle } from '../dist/index.js';

const rapierDir = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/', import.meta.url));
const rapierEntry = resolve(rapierDir, 'dist/rapier.mjs');
let RAPIER = null;
if (existsSync(rapierEntry)) {
  RAPIER = (await import(pathToFileURL(rapierEntry).href)).default;
  const warn = console.warn;
  console.warn = () => {};
  await RAPIER.init();
  console.warn = warn;
}
const skip = RAPIER
  ? false
  : 'Rapier not found: set MARGOENGINE_RAPIER to an installed @dimforge/rapier3d-compat package';
const rtest = (name, fn) => test(name, { skip }, fn);

const create = (options = {}) => new Physics(null, { rapier: RAPIER, ...options });
const floor = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [100, 0.5, 100], friction: 1 },
  });
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
/** Records mesh writes: the minimal mesh surface the vehicle writes wheel poses to. */
const wheelMesh = () => ({
  disposed: false,
  position: null,
  quaternion: null,
  check() {
    if (this.disposed) throw new Error('Mesh is disposed');
  },
  setPosition(p) {
    this.position = [...p];
    return this;
  },
  setQuaternion(q) {
    this.quaternion = [...q];
    return this;
  },
});
const rotate = (q, v) => {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

rtest('rope joints cap the anchor distance and let the bodies come closer', () => {
  const physics = create();
  const hook = physics.addBody(null, { type: 'fixed', position: [0, 10, 0], colliders: [] });
  const weight = physics.addBody(null, { position: [0.5, 10, 0], colliders: { shape: 'sphere', radius: 0.1 } });
  physics.addJoint(hook, weight, { type: 'rope', length: 2 });
  let farthest = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    farthest = Math.max(farthest, distance(weight.position, [0, 10, 0]));
  }
  assert.ok(farthest < 2.02, `never stretches past its length (${farthest})`);
  near(distance(weight.position, [0, 10, 0]), 2, 0.02, 'hangs taut at its length');
  near(weight.position[1], 8, 0.05, 'hangs below the hook');
  physics.dispose();
});

rtest('spring joints settle at the rest length plus the static extension', () => {
  const physics = create();
  const hook = physics.addBody(null, { type: 'fixed', position: [0, 10, 0], colliders: [] });
  const weight = physics.addBody(null, {
    position: [0, 9, 0],
    colliders: { shape: 'sphere', radius: 0.1, mass: 2 },
  });
  const stiffness = 50;
  physics.addJoint(hook, weight, { type: 'spring', restLength: 1, stiffness, damping: 5 });
  steps(physics, 600);
  // A force spring (Hooke's law): the stretch under a 2 kg load is m g / k.
  near(10 - weight.position[1], 1 + (2 * 9.81) / stiffness, 0.01, 'equilibrium length');
  near(weight.linearVelocity[1], 0, 0.01, 'damped to rest');
  // Zero gravity: it returns to the rest length.
  physics.gravity = [0, 0, 0];
  steps(physics, 600);
  near(10 - weight.position[1], 1, 0.01, 'rest length without load');
  physics.dispose();
});

rtest('changing gravity wakes sleeping bodies (regression: they floated in the old field)', () => {
  const physics = create();
  floor(physics);
  const crate = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  steps(physics, 240);
  assert.ok(crate.sleeping, 'the crate fell asleep on the floor');
  physics.gravity = [0, 9.81, 0];
  steps(physics, 60);
  assert.ok(crate.position[1] > 2, `it falls upward once gravity flips (${crate.position[1]})`);
  physics.dispose();
});

rtest('ropes hang a chain that keeps its length, follows its pins and draws as a polyline', () => {
  const physics = create();
  const rope = new Rope(physics, {
    start: [0, 10, 0],
    end: [4, 10, 0],
    segments: 8,
    attachStart: 'fixed',
    damping: 1,
  });
  assert.ok(rope instanceof Rope);
  assert.equal(rope.segments.length, 8);
  near(rope.segmentLength, 0.5, 1e-9, 'segment length');
  const out = new Float32Array(27);
  assert.equal(rope.points(out), out, 'writes into the given buffer');
  near(out[24], 4, 1e-5, 'polyline ends at the end point');
  steps(physics, 1200);
  const points = rope.points();
  assert.equal(points.length, 27);
  near(distance([points[0], points[1], points[2]], [0, 10, 0]), 0, 0.02, 'start stays pinned');
  // Rigid links: every link keeps its length, so the hanging chain is 4 m long.
  for (let i = 0; i < 8; i++) {
    const a = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]],
      b = [points[i * 3 + 3], points[i * 3 + 4], points[i * 3 + 5]];
    near(distance(a, b), 0.5, 0.01, `link ${i} length`);
  }
  near(points[25], 6, 0.05, 'free end hangs 4 m below the pin');
  near(points[24], 0, 0.05, 'and straight down');

  // Both ends pinned: a fixed hook and a dynamic crate it carries.
  const crate = physics.addBody(null, {
    position: [10, 7, 0],
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2] },
  });
  const sling = new Rope(physics, {
    start: [10, 10, 0],
    end: [10, 7.2, 0],
    segments: 6,
    attachStart: 'fixed',
    attachEnd: crate,
  });
  steps(physics, 300);
  near(crate.position[1], 7, 0.05, 'the crate hangs from the rope');
  const before = physics.bodyCount;
  sling.remove();
  assert.equal(physics.bodyCount, before - 7, 'remove drops the segments and the fixed hook');
  assert.ok(crate.valid && !sling.valid, 'attached bodies stay');
  assert.throws(() => sling.points(), /new Rope/);
  steps(physics, 60);
  assert.ok(crate.position[1] < 6.5, 'the crate falls once the rope is gone');

  assert.throws(() => new Rope(physics, { start: [0, 0, 0], end: [0, 0, 0] }), RangeError);
  assert.throws(() => new Rope(physics, { start: [0, 0, 0], end: [1, 0, 0], segments: 0 }), RangeError);
  const count = physics.bodyCount;
  const removed = physics.addBody(null, { colliders: [] });
  removed.remove();
  assert.throws(() => new Rope(physics, { start: [0, 0, 0], end: [1, 0, 0], attachEnd: removed }), /physics.addBody/);
  assert.equal(physics.bodyCount, count, 'a failed rope keeps none of its bodies');
  physics.dispose();
  assert.ok(!rope.valid, 'dispose removes ropes');
});

rtest('compound colliders weld convex parts into one collider with one mass and one set of events', () => {
  const physics = create();
  floor(physics);
  const dumbbell = physics.addBody(null, {
    position: [0, 3, 0],
    colliders: {
      shape: 'compound',
      density: 1,
      parts: [
        { shape: 'sphere', radius: 0.5, offset: [-1, 0, 0] },
        { shape: 'sphere', radius: 0.5, offset: [1, 0, 0] },
        { shape: 'capsule', halfHeight: 0.5, radius: 0.1, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      ],
    },
  });
  assert.equal(dumbbell.colliders.length, 1, 'one collider');
  const ball = (4 / 3) * Math.PI * 0.125;
  assert.ok(dumbbell.mass > 2 * ball * 0.99, `mass counts every part (${dumbbell.mass})`);
  let contacts = 0;
  physics.on('contactstart', () => contacts++);
  steps(physics, 240);
  near(dumbbell.position[1], 0.5, 0.02, 'rests on its two spheres');
  near(dumbbell.position[0], 0, 0.05, 'without rolling off');
  assert.equal(contacts, 1, 'one contact pair for the whole compound');
  const hit = physics.raycast([1, 5, 0], [0, -1, 0]);
  assert.equal(hit?.body, dumbbell);
  near(hit.distance, 4, 0.02, 'ray hits the top of the right sphere');
  assert.equal(physics.raycast([0.5, 5, 0.3], [0, -1, 0])?.body === dumbbell, false, 'the gap between parts is empty');

  assert.throws(() => dumbbell.addCollider({ shape: 'compound', parts: [] }), RangeError);
  assert.throws(
    () => dumbbell.addCollider({ shape: 'compound', parts: [{ shape: 'trimesh', vertices: [], indices: [] }] }),
    /not convex/,
  );
  assert.throws(() => dumbbell.addCollider({ shape: 'compound', parts: [{ shape: 'box' }] }), /halfExtents/);
  physics.dispose();
});

/** A cup: open-top box with 0.1 m walls, 2 m wide, 1 m tall, as a closed triangle soup of five slabs. */
function cup() {
  const slabs = [
    [-1, 0, -1, 1, 0.1, 1],
    [-1, 0, -1, -0.9, 1, 1],
    [0.9, 0, -1, 1, 1, 1],
    [-1, 0, -1, 1, 1, -0.9],
    [-1, 0, 0.9, 1, 1, 1],
  ];
  const vertices = [],
    indices = [];
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  for (const [x0, y0, z0, x1, y1, z1] of slabs) {
    const base = vertices.length / 3;
    for (let i = 0; i < 8; i++) vertices.push(i & 4 ? x1 : x0, i & 2 ? y1 : y0, i & 1 ? z1 : z0);
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  return { vertices, indices };
}

rtest('convex decomposition keeps a dynamic cup hollow where a convex hull fills it', () => {
  const drop = (shape) => {
    const physics = create();
    floor(physics);
    const { vertices, indices } = cup();
    const body = physics.addBody(null, {
      position: [0, 0, 0],
      colliders: shape === 'convexHull' ? { shape, points: vertices } : { shape, vertices, indices },
    });
    const marble = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.2 } });
    steps(physics, 300);
    const result = { marble: marble.position[1], cup: body.position[1], mass: body.mass };
    physics.dispose();
    return result;
  };
  const hollow = drop('convexDecomposition'),
    filled = drop('convexHull');
  assert.ok(hollow.marble < 0.6, `the marble falls inside the decomposed cup (${hollow.marble})`);
  assert.ok(filled.marble > 1.1, `and rests on the lid of the hull (${filled.marble})`);
  assert.ok(hollow.mass < filled.mass * 0.6, 'the hollow cup weighs less than the filled hull');
  near(hollow.cup, 0, 0.05, 'the cup rests on the floor');

  const physics = create();
  const body = physics.addBody(null, { colliders: [] });
  assert.throws(
    () => body.addCollider({ shape: 'convexDecomposition', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] }),
    /indices/,
  );
  assert.throws(
    () => body.addCollider({ shape: 'convexDecomposition', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] }),
    /out of range/,
  );
  physics.dispose();
});

/** A 1,000 kg car on a 100 m floor: chassis 2 x 0.5 x 4 m, four 0.35 m wheels, front wheels steer. */
function car(physics, options = {}) {
  floor(physics);
  const chassis = physics.addBody(null, {
    position: [0, 1, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 },
    ...options.body,
  });
  const meshes = [0, 1, 2, 3].map(wheelMesh);
  const wheels = [
    [-0.9, 1.4, true],
    [0.9, 1.4, true],
    [-0.9, -1.4, false],
    [0.9, -1.4, false],
  ].map(([x, z, steer], i) => ({
    position: [x, -0.1, z],
    radius: 0.35,
    suspensionRestLength: 0.3,
    suspensionStiffness: 30,
    suspensionCompression: 4,
    suspensionRelaxation: 5,
    frictionSlip: 2,
    steer,
    mesh: meshes[i],
  }));
  const vehicle = new Vehicle(physics, chassis, { wheels, ...options.vehicle });
  return { chassis, vehicle, meshes };
}

rtest('vehicles rest on their suspension, drive forward, steer, brake and reverse', () => {
  const physics = create();
  const { chassis, vehicle, meshes } = car(physics);
  assert.ok(vehicle instanceof Vehicle);
  assert.equal(vehicle.wheelCount, 4);
  steps(physics, 60); // settled, before the parked chassis falls asleep
  for (let i = 0; i < 4; i++) assert.ok(vehicle.wheel(i).inContact, `wheel ${i} touches the ground`);
  const rest = chassis.position[1];
  assert.ok(rest > 0.4 && rest < 1, `chassis rides on the suspension (${rest})`);
  near(vehicle.speed, 0, 0.01, 'parked');
  const load = [0, 1, 2, 3].reduce((sum, i) => sum + vehicle.wheel(i).suspensionForce, 0);
  near(load, 1000 * 9.81, 1000 * 9.81 * 0.05, 'the four springs carry the weight');

  // Full throttle along +Z.
  vehicle.setInput({ throttle: 1 });
  steps(physics, 180);
  const z = chassis.position[2];
  assert.ok(z > 2, `drives forward along +Z (${z})`);
  assert.ok(vehicle.speed > 3, `gains speed (${vehicle.speed})`);
  near(vehicle.speed, chassis.linearVelocity[2], 0.05, 'speed is the forward velocity');
  near(chassis.position[0], 0, 0.05, 'straight ahead without steering');

  // Rolling without slipping: the wheel's bottom point stays put on the ground while the hub moves.
  const hub = [0, 0, 0],
    q0 = [0, 0, 0, 1],
    q1 = [0, 0, 0, 1];
  vehicle.wheelLocalPose(2, hub, q0);
  const z0 = chassis.position[2];
  physics.step();
  vehicle.wheelLocalPose(2, hub, q1);
  // The rim point at the bottom before the step, carried by the step's spin (q1 * inverse(q0)).
  const [ax, ay, az, aw] = q1,
    [bx, by, bz, bw] = [-q0[0], -q0[1], -q0[2], q0[3]],
    spin = [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  const travelled = chassis.position[2] - z0,
    bottom = rotate(spin, [0, -0.35, 0]);
  assert.ok(travelled > 0.05, 'moving');
  near(bottom[2], -0.35 * Math.sin(travelled / 0.35), travelled * 0.1, 'the wheel spins the way it rolls');

  // Steering left (positive) turns toward +X.
  vehicle.setInput({ throttle: 0.5, steer: 1 });
  steps(physics, 60);
  assert.ok(chassis.position[0] > 0.2, `turns toward +X (${chassis.position[0]})`);
  near(vehicle.wheel(0).steering, 0.5, 1e-6, 'front wheels at full lock');
  near(vehicle.wheel(2).steering, 0, 1e-6, 'rear wheels do not steer');

  // Brake to a stop.
  vehicle.setInput({ brake: 1 });
  steps(physics, 600);
  assert.ok(Math.abs(vehicle.speed) < 0.05, `brakes to a stop (${vehicle.speed})`);

  // Reverse.
  vehicle.setInput({ throttle: -1 });
  steps(physics, 120);
  assert.ok(vehicle.speed < -1, `reverses (${vehicle.speed})`);

  // Wheel meshes follow the local hub pose after every sync.
  physics.sync();
  const pose = vehicle.wheelLocalPose(1);
  for (let a = 0; a < 3; a++) near(meshes[1].position[a], pose.position[a], 1e-9, 'wheel mesh position');
  for (let a = 0; a < 4; a++) near(meshes[1].quaternion[a], pose.quaternion[a], 1e-9, 'wheel mesh rotation');
  near(pose.position[1], -0.1 - vehicle.wheel(1).suspensionLength, 1e-9, 'hub hangs on the suspension');
  // A disposed wheel mesh is let go instead of written.
  meshes[3].disposed = true;
  const last = meshes[3].position;
  physics.step();
  physics.sync();
  assert.equal(meshes[3].position, last, 'the disposed wheel mesh is no longer written');
  physics.dispose();
  assert.ok(!vehicle.valid, 'dispose removes vehicles');
});

rtest('vehicle misuse throws coded errors that name the fix; removing the chassis disposes the vehicle', () => {
  const physics = create();
  const fixed = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  const wheels = [{ position: [0, 0, 0], radius: 0.3 }];
  assert.throws(() => new Vehicle(physics, fixed, { wheels }), /dynamic body/);
  const bare = physics.addBody(null, { colliders: [] });
  assert.throws(() => new Vehicle(physics, bare, { wheels }), /collider/);
  const chassis = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.25, 2] } });
  assert.throws(() => new Vehicle(physics, chassis, { wheels: [] }), RangeError);
  assert.throws(() => new Vehicle(physics, chassis, { wheels: [{ position: [0, 0, 0], radius: 0 }] }), /radius/);
  assert.throws(() => new Vehicle(physics, chassis, { wheels: [{ ...wheels[0], axle: [0, 0, 0] }] }), /nonzero/);
  const other = create();
  assert.throws(() => new Vehicle(other, chassis, { wheels }), /physics.addBody/);
  other.dispose();
  const vehicle = new Vehicle(physics, chassis, { wheels });
  assert.throws(() => vehicle.wheel(1), RangeError);
  assert.throws(() => vehicle.setInput({ throttle: Number.NaN }), RangeError);
  vehicle.setInput({ throttle: 3, steer: -3, brake: 2 });
  assert.equal(vehicle.engineForce, vehicle.maxEngineForce, 'input is clamped');
  assert.equal(vehicle.steering, -vehicle.maxSteeringAngle);
  assert.equal(vehicle.brake, vehicle.maxBrakeForce);
  chassis.remove();
  assert.ok(!vehicle.valid, 'removing the chassis disposes the vehicle');
  assert.throws(
    () => vehicle.wheel(0),
    (error) => error.code === 'disposed' && /new Vehicle/.test(error.message),
  );
  physics.step();
  physics.dispose();
});

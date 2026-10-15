import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Geometry, box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Physics, CharacterController, collisionGroups, eulerToQuat, geometryPositions } from '../dist/index.js';

// Consumers keep Rapier optional; the monorepo installs it as a test dependency.
const rapierDir = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/', import.meta.url));
const rapierEntry = rapierDir && resolve(rapierDir, 'dist/rapier.mjs');
let RAPIER = null;
if (rapierEntry && existsSync(rapierEntry)) {
  RAPIER = (await import(pathToFileURL(rapierEntry).href)).default;
  // Silence the wasm-bindgen deprecation notice about init() arguments.
  const warn = console.warn;
  console.warn = () => {};
  await RAPIER.init();
  console.warn = warn;
}
const skip = RAPIER
  ? false
  : 'Rapier not found: set MARGOENGINE_RAPIER to an installed @dimforge/rapier3d-compat package folder to run the physics tests';
if (skip) console.log(skip);
const rtest = (name, fn) => test(name, { skip }, fn);

/** Minimal stand-in for a core Mesh: the public transform API plus the runtime fields `meshRuntime` exposes. */
let nextId = 0;
const parents = new Float32Array(256).fill(-1);
const fakeEngine = { store: { parents } };
function fakeMesh({ position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], geometry = null } = {}) {
  const ref = (values) => ({
    get x() {
      return values[0];
    },
    get y() {
      return values[1];
    },
    get z() {
      return values[2];
    },
    set(x, y, z) {
      values[0] = x;
      values[1] = y;
      values[2] = z;
      return this;
    },
  });
  const pos = [...position],
    rot = [...rotation],
    scl = [...scale];
  return {
    id: nextId++,
    engine: fakeEngine,
    geometry,
    disposed: false,
    quaternion: eulerToQuat(...rot),
    writes: 0,
    position: ref(pos),
    rotation: ref(rot),
    scale: ref(scl),
    check() {
      if (this.disposed) throw new Error('Mesh is disposed');
    },
    setPosition(v) {
      this.check();
      pos[0] = v[0];
      pos[1] = v[1];
      pos[2] = v[2];
      this.writes++;
      return this;
    },
    setQuaternion(q) {
      this.check();
      const l = Math.hypot(...q);
      this.quaternion = q.map((c) => c / l);
      return this;
    },
    dispose() {
      this.disposed = true;
    },
  };
}
const create = (options = {}) => new Physics(null, { rapier: RAPIER, ...options });
const ground = (physics, options = {}) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20], ...options },
  });
const run = (physics, seconds, delta = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += delta) physics.update(delta);
};
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
const angleAbout = (q, axis) => 2 * Math.atan2(q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2], q[3]);

test('requires an initialized Rapier module and is SSR safe', () => {
  for (const name of ['window', 'document', 'GPUBufferUsage', 'GPUTextureUsage'])
    assert.equal(globalThis[name], undefined, `${name} touched`);
  assert.throws(() => new Physics(null, {}), /initialized Rapier module/);
  assert.throws(() => new Physics(null, { rapier: {} }), /initialized Rapier module/);
});

test('rejected plugin attachment releases the new world and event queue', () => {
  const freed = [],
    failure = new TypeError('Invalid/attached plugin');
  const rapier = {
    ColliderDesc: {},
    World: class {
      free() {
        freed.push('world');
      }
    },
    EventQueue: class {
      free() {
        freed.push('queue');
      }
    },
  };
  assert.throws(
    () =>
      new Physics(
        {
          use() {
            throw failure;
          },
        },
        { rapier },
      ),
    (error) => error === failure,
  );
  assert.deepEqual(freed, ['queue', 'world']);
});

test('failed event queue creation releases its already allocated native world', () => {
  const freed = [],
    failure = new Error('EventQueue allocation failed');
  const rapier = {
    ColliderDesc: {},
    World: class {
      free() {
        freed.push('world');
      }
    },
    EventQueue: class {
      constructor() {
        throw failure;
      }
    },
  };
  assert.throws(
    () => new Physics(null, { rapier }),
    (error) => error === failure,
  );
  assert.deepEqual(freed, ['world']);
});

test('invalid character setup releases the native controller before rethrowing', () => {
  const raw = {},
    removed = [],
    body = { type: 'kinematicPosition', colliders: [{}] };
  const owner = {
    world: {
      createCharacterController() {
        return raw;
      },
      removeCharacterController(value) {
        removed.push(value);
      },
    },
    removeController() {
      throw new Error('Unregistered controller');
    },
  };
  assert.throws(() => new CharacterController(owner, body, { up: [NaN, 1, 0] }), /Up must be three finite numbers/);
  assert.deepEqual(removed, [raw]);
});

test('collisionGroups packs memberships and filters', () => {
  assert.equal(collisionGroups([0], [1, 2]), ((1 << 16) | 0b110) >>> 0);
  assert.equal(collisionGroups(0xffff, 0xffff), 0xffffffff);
  assert.equal(collisionGroups([15], 0), 0x80000000);
  assert.throws(() => collisionGroups([16]), /0\.\.15/);
});

test('geometryPositions reads stride-6 core geometry and packed raw arrays', () => {
  const geometry = box(2, 4, 6),
    points = geometryPositions(geometry, [1, 0.5, 2]);
  assert.equal(points.length, geometry.vertices.length / 2);
  assert.deepEqual(
    [
      Math.max(...points.filter((_, i) => i % 3 === 0)),
      Math.max(...points.filter((_, i) => i % 3 === 1)),
      Math.max(...points.filter((_, i) => i % 3 === 2)),
    ],
    [1, 1, 6],
  );
  assert.deepEqual([...geometryPositions({ vertices: [1, 2, 3, 4, 5, 6] })], [1, 2, 3, 4, 5, 6]);
});

rtest('trimesh indices reject fractional or wrapped values before native construction', () => {
  const physics = create(),
    vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  try {
    for (const invalid of [0.5, NaN, Infinity, -4294967296, 4294967296]) {
      assert.throws(
        () =>
          physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices, indices: [0, 1, invalid] } }),
        /Trimesh index/,
      );
      assert.equal(physics.bodyCount, 0, 'Rejected collider must roll back its body');
    }
    const body = physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'trimesh', vertices, indices: [0, 1, 2] },
    });
    assert.equal(body.colliders.length, 1);
  } finally {
    physics.dispose();
  }
});

test('geometry positions reject fractional or nonfinite strides', () => {
  for (const stride of [3.5, 0, Infinity, NaN])
    assert.throws(() => geometryPositions({ vertices: new Float32Array(stride === 3.5 ? 7 : 6), stride }), /stride/);
});

rtest('a dropped box comes to rest on the ground at the right height and the mesh follows', () => {
  const physics = create();
  ground(physics);
  const mesh = fakeMesh({ position: [0, 5, 0], rotation: [0.3, 0.2, 0.1], geometry: box(1, 1, 1) });
  const body = physics.addBody(mesh); // collider auto-fitted from the geometry
  assert.equal(body.colliders[0].halfExtents().y, 0.5);
  run(physics, 4);
  near(body.position[1], 0.5, 0.01, 'resting height');
  near(Math.abs(body.linearVelocity[1]), 0, 1e-3, 'vertical speed');
  assert.ok(body.sleeping, 'box should fall asleep');
  near(mesh.position.y, body.position[1], 1e-6, 'mesh height');
  // Resting box is face-down: its up axis is aligned with a world axis.
  const writes = mesh.writes;
  run(physics, 0.5);
  assert.equal(mesh.writes, writes, 'sleeping bodies are not rewritten every frame');
  physics.dispose();
});

rtest('restitution bounces and zero restitution does not', () => {
  const peak = (restitution) => {
    const physics = create();
    ground(physics, { restitution });
    const body = physics.addBody(null, {
      position: [0, 3, 0],
      colliders: { shape: 'sphere', radius: 0.5, restitution },
    });
    let bounced = false,
      best = 0,
      previous = 3;
    for (let i = 0; i < 240; i++) {
      physics.step();
      const y = body.position[1];
      if (!bounced && y > previous) bounced = true;
      if (bounced) best = Math.max(best, y);
      previous = y;
    }
    physics.dispose();
    return best;
  };
  const lively = peak(0.9),
    dead = peak(0);
  assert.ok(lively > 2, `restitution 0.9 should rebound high, peaked at ${lively}`);
  assert.ok(dead < 0.6, `restitution 0 should not rebound, peaked at ${dead}`);
});

rtest('fixed steps are deterministic: two runs give identical results', () => {
  const simulate = () => {
    const physics = create();
    ground(physics);
    const bodies = [];
    for (let i = 0; i < 24; i++)
      bodies.push(
        physics.addBody(null, {
          position: [(i % 3) * 0.3 - 0.3, 1 + i * 1.05, ((i * 7) % 5) * 0.1],
          rotation: eulerToQuat(i * 0.1, i * 0.2, 0),
          colliders: { shape: i % 2 ? 'box' : 'sphere', halfExtents: [0.5, 0.5, 0.5], radius: 0.5 },
        }),
      );
    // Irregular frame times exercise the accumulator.
    const deltas = [0.016, 0.017, 0.033, 0.008, 0.05, 0.1, 0.012];
    for (let frame = 0; frame < 240; frame++) physics.update(deltas[frame % deltas.length]);
    const state = bodies.flatMap((body) => [...body.position, ...body.rotation]);
    const result = { state, steps: physics.stepCount, alpha: physics.alpha };
    physics.dispose();
    return result;
  };
  const a = simulate(),
    b = simulate();
  assert.equal(a.steps, b.steps);
  assert.equal(a.alpha, b.alpha);
  assert.ok(
    a.state.every((value, i) => Object.is(value, b.state[i])),
    'states differ bit for bit',
  );
});

rtest('accumulator, max substeps and interpolation alpha', () => {
  const dt = 1 / 60,
    physics = create({ fixedTimestep: dt, maxSubsteps: 4 });
  const mesh = fakeMesh({ position: [0, 10, 0] });
  const body = physics.addBody(mesh, { colliders: { shape: 'sphere', radius: 0.5 } });
  assert.equal(physics.update(dt * 0.25), 0);
  near(physics.alpha, 0.25, 1e-9, 'alpha after a quarter step');
  assert.equal(mesh.position.y, 10, 'no step yet');
  assert.equal(physics.update(dt), 1);
  near(physics.alpha, 0.25, 1e-9, 'alpha carries the remainder');
  const pose = body.pose,
    expected = pose[1] + (pose[8] - pose[1]) * physics.alpha;
  assert.ok(pose[8] < pose[1], 'body fell');
  near(mesh.position.y, expected, 1e-5, 'mesh is interpolated between the last two steps');
  assert.ok(mesh.position.y > body.position[1], 'rendered pose lags the physics pose');
  assert.equal(physics.update(dt * 0.5), 0);
  near(physics.alpha, 0.75, 1e-9, 'alpha after another half step');
  near(mesh.position.y, pose[1] + (pose[8] - pose[1]) * 0.75, 1e-5, 'interpolated again with no new step');
  // A one second hitch runs at most maxSubsteps steps and drops the backlog.
  const before = physics.stepCount;
  assert.equal(physics.update(1), 4);
  assert.equal(physics.stepCount - before, 4);
  assert.ok(physics.pendingTime < dt);
  // Without interpolation the mesh shows the latest physics pose.
  physics.interpolate = false;
  physics.update(dt * 1.5);
  assert.equal(physics.alpha, 1);
  near(mesh.position.y, body.position[1], 1e-6, 'uninterpolated mesh');
  // Teleports do not streak.
  physics.interpolate = true;
  body.setPosition([3, 20, 0]);
  physics.update(dt * 0.5);
  assert.deepEqual([mesh.position.x, mesh.position.y], [3, 20]);
  // Paused worlds do not advance.
  physics.paused = true;
  const steps = physics.stepCount;
  physics.update(0.5);
  assert.equal(physics.stepCount, steps);
  physics.dispose();
});

rtest('rotation is interpolated with slerp and written as a quaternion', () => {
  const dt = 1 / 60,
    physics = create({ gravity: [0, 0, 0] });
  const mesh = fakeMesh();
  const body = physics.addBody(mesh, {
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    angularVelocity: [0, 3, 0],
    angularDamping: 0,
  });
  for (let i = 0; i < 10; i++) physics.update(dt);
  physics.update(dt * 0.5);
  // Ten steps at 3 rad/s, half a step of interpolation lag.
  near(angleAbout(body.rotation, [0, 1, 0]), 0.5, 1e-3, 'physics angle');
  near(angleAbout(mesh.quaternion, [0, 1, 0]), 0.5 - 3 * dt * 0.5, 1e-3, 'rendered angle');
  physics.dispose();
});

rtest('revolute joints respect limits and motors drive them', () => {
  const physics = create();
  const anchor = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] });
  const arm = physics.addBody(null, { position: [1, 5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.1, 0.1] } });
  const hinge = physics.addJoint(anchor, arm, {
    type: 'revolute',
    anchorA: [0, 0, 0],
    anchorB: [-1, 0, 0],
    axis: [0, 0, 1],
    limits: [-0.5, 0.5],
  });
  assert.deepEqual(hinge.limits, [-0.5, 0.5]);
  let lowest = 0;
  for (let i = 0; i < 180; i++) {
    physics.step();
    lowest = Math.min(lowest, angleAbout(arm.rotation, [0, 0, 1]));
  }
  near(lowest, -0.5, 0.02, 'arm hangs at the lower limit');
  // Anchor point stays attached.
  const [x, y] = arm.position,
    angle = angleAbout(arm.rotation, [0, 0, 1]);
  near(x, Math.cos(angle), 0.01, 'arm x');
  near(y, 5 + Math.sin(angle), 0.01, 'arm y');
  // A strong position motor lifts it to the upper limit.
  hinge.setMotor({ targetPosition: 1, stiffness: 1000, damping: 50 });
  for (let i = 0; i < 180; i++) physics.step();
  near(angleAbout(arm.rotation, [0, 0, 1]), 0.5, 0.02, 'motor pushes against the upper limit');
  physics.dispose();

  // Velocity motor in zero gravity spins a wheel at the target rate.
  const space = create({ gravity: [0, 0, 0] });
  const axle = space.addBody(null, { type: 'fixed', colliders: [] });
  const wheel = space.addBody(null, { colliders: { shape: 'cylinder', halfHeight: 0.1, radius: 1 } });
  space.addJoint(axle, wheel, { type: 'revolute', axis: [0, 1, 0], motor: { targetVelocity: 2, damping: 10 } });
  for (let i = 0; i < 60; i++) space.step();
  near(wheel.angularVelocity[1], 2, 0.05, 'motor speed');
  space.dispose();
});

rtest('prismatic joints respect limits and position motors', () => {
  const physics = create();
  const rail = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] });
  const slider = physics.addBody(null, {
    position: [0, 5, 0],
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2] },
  });
  const joint = physics.addJoint(rail, slider, { type: 'prismatic', axis: [0, 1, 0], limits: [-1, 0.5] });
  for (let i = 0; i < 120; i++) physics.step();
  near(slider.position[1], 4, 0.02, 'slides down to the lower limit');
  near(slider.position[0], 0, 1e-3, 'stays on the axis');
  joint.setMotor({ targetPosition: 0.25, stiffness: 2000, damping: 100 });
  for (let i = 0; i < 240; i++) physics.step();
  near(slider.position[1], 5.25, 0.03, 'motor holds the target offset');
  physics.dispose();
});

rtest('fixed and spherical joints hold their anchors', () => {
  const physics = create();
  const base = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] });
  const welded = physics.addBody(null, { position: [0, 4, 0], colliders: { shape: 'sphere', radius: 0.2 } });
  physics.addJoint(base, welded, { type: 'fixed', anchorA: [0, -1, 0] });
  const bob = physics.addBody(null, { position: [2, 5, 0], colliders: { shape: 'sphere', radius: 0.2 } });
  physics.addJoint(base, bob, { type: 'spherical', anchorB: [-2, 0, 0] });
  let lowest = Infinity;
  for (let i = 0; i < 120; i++) {
    physics.step();
    lowest = Math.min(lowest, bob.position[1]);
  }
  near(welded.position[1], 4, 0.01, 'welded body does not fall');
  near(Math.hypot(bob.position[0], bob.position[1] - 5, bob.position[2]), 2, 0.02, 'pendulum length');
  near(lowest, 3, 0.05, 'pendulum swung through the bottom');
  physics.dispose();
});

rtest('sensors fire intersection start and end events with the meshes involved', () => {
  const physics = create();
  const floorMesh = fakeMesh();
  physics.addBody(floorMesh, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const triggerMesh = fakeMesh({ position: [0, 3, 0] });
  const trigger = physics.addBody(triggerMesh, {
    type: 'fixed',
    colliders: { shape: 'box', halfExtents: [2, 0.25, 2], sensor: true },
  });
  const ballMesh = fakeMesh({ position: [0, 6, 0] });
  physics.addBody(ballMesh, { colliders: { shape: 'sphere', radius: 0.3 } });
  const log = [];
  for (const type of ['intersectionstart', 'intersectionend', 'contactstart', 'contactend'])
    physics.on(type, (event) =>
      log.push({ type, step: physics.stepCount, meshes: [event.meshA, event.meshB], sensor: event.sensor }),
    );
  let inside = false;
  for (let i = 0; i < 150; i++) {
    physics.update(1 / 60);
    if (
      log.some((entry) => entry.type === 'intersectionstart') &&
      !log.some((entry) => entry.type === 'intersectionend')
    )
      inside ||=
        physics.intersectPoint([0, 3, 0]).includes(trigger) || physics.touching(trigger, physics.bodyOf(ballMesh));
  }
  const enter = log.find((entry) => entry.type === 'intersectionstart'),
    exit = log.find((entry) => entry.type === 'intersectionend'),
    contact = log.find((entry) => entry.type === 'contactstart');
  assert.ok(enter && exit && contact, `events: ${log.map((entry) => entry.type).join(', ')}`);
  assert.ok(enter.step < exit.step && exit.step < contact.step, 'enter, exit, then land');
  assert.ok(enter.sensor && !contact.sensor);
  assert.ok(enter.meshes.includes(triggerMesh) && enter.meshes.includes(ballMesh));
  assert.ok(contact.meshes.includes(floorMesh) && contact.meshes.includes(ballMesh));
  assert.ok(inside, 'touching() reports the overlap while inside');
  assert.equal(log.filter((entry) => entry.type === 'intersectionstart').length, 1);
  physics.dispose();
});

rtest('raycasts, shape casts, point projection and intersection tests return bodies and meshes', () => {
  const physics = create();
  ground(physics);
  const meshes = [2, 5, 8].map((x) => fakeMesh({ position: [x, 0.5, 0], geometry: box(1, 1, 1) }));
  const bodies = meshes.map((mesh) => physics.addBody(mesh, { type: 'fixed' }));
  physics.step(); // queries see colliders after a step
  const hit = physics.raycast([0, 0.5, 0], [1, 0, 0]);
  assert.equal(hit.mesh, meshes[0]);
  assert.equal(hit.body, bodies[0]);
  near(hit.distance, 1.5, 1e-4, 'ray distance');
  near(hit.point[0], 1.5, 1e-4, 'hit point');
  assert.deepEqual(hit.normal.map(Math.round), [-1, 0, 0]);
  assert.equal(physics.raycast([0, 0.5, 0], [1, 0, 0], { maxDistance: 1 }), null);
  assert.equal(physics.raycast([0, 0.5, 0], [1, 0, 0], { exclude: bodies[0] }).mesh, meshes[1]);
  assert.equal(
    physics.raycast([0, 0.5, 0], [1, 0, 0], { predicate: (body) => body.mesh === meshes[2] }).mesh,
    meshes[2],
  );
  const all = physics.raycastAll([0, 0.5, 0], [2, 0, 0]);
  assert.deepEqual(
    all.map((h) => h.mesh),
    meshes,
  );
  assert.deepEqual(
    all.map((h) => Math.round(h.distance * 100) / 100),
    [1.5, 4.5, 7.5],
  );
  const down = physics.raycast([0, 10, 0], [0, -1, 0]);
  assert.equal(down.mesh, null);
  near(down.distance, 10, 1e-4, 'ground distance');
  const sweep = physics.shapeCast({ shape: 'sphere', radius: 0.5 }, [5, 10, 0], [0, 0, 0, 1], [0, -1, 0]);
  assert.equal(sweep.mesh, meshes[1]);
  near(sweep.distance, 8.5, 1e-3, 'shape cast distance');
  near(sweep.point[1], 1, 1e-3, 'shape cast contact point');
  near(sweep.normal[1], 1, 1e-3, 'shape cast normal');
  const projection = physics.projectPoint([5, 3, 0], { predicate: (body) => body.mesh !== null });
  assert.equal(projection.mesh, meshes[1]);
  near(projection.point[1], 1, 1e-4, 'projected point');
  near(projection.distance, 2, 1e-4, 'projection distance');
  assert.equal(physics.projectPoint([8, 0.5, 0]).inside, true);
  assert.deepEqual(physics.intersectPoint([8.2, 0.7, 0.1]), [bodies[2]]);
  const overlap = physics.intersectShape({ shape: 'box', halfExtents: [2, 0.2, 0.2] }, [3.5, 0.5, 0]);
  assert.deepEqual(new Set(overlap), new Set([bodies[0], bodies[1]]));
  assert.deepEqual(
    physics.intersectShape({ shape: 'box', halfExtents: [2, 0.2, 0.2] }, [3.5, 0.5, 0], undefined, {
      excludeFixed: true,
    }),
    [],
  );
  physics.dispose();
});

rtest('trimesh, convex hull and heightfield colliders support resting bodies', () => {
  const rest = (shape) => {
    const physics = create();
    physics.addBody(fakeMesh({ position: [0, -0.5, 0], geometry: box(20, 1, 20) }), {
      type: 'fixed',
      colliders: shape,
    });
    const ball = physics.addBody(null, { position: [0.3, 3, -0.2], colliders: { shape: 'sphere', radius: 0.5 } });
    run(physics, 3);
    const y = ball.position[1];
    physics.dispose();
    return y;
  };
  near(rest({ shape: 'trimesh' }), 0.5, 0.02, 'trimesh from mesh geometry');
  near(rest({ shape: 'trimesh', geometry: box(20, 1, 20) }), 0.5, 0.02, 'trimesh from explicit geometry');
  near(rest({ shape: 'convexHull' }), 0.5, 0.02, 'convex hull from mesh geometry');
  const plane = { vertices: [-10, 0.5, -10, 10, 0.5, -10, 10, 0.5, 10, -10, 0.5, 10], indices: [0, 2, 1, 0, 3, 2] };
  near(
    rest({ shape: 'trimesh', vertices: plane.vertices, indices: plane.indices }),
    0.5,
    0.02,
    'trimesh from raw arrays',
  );
  const heights = new Float32Array(5 * 5).fill(0.5);
  near(rest({ shape: 'heightfield', rows: 4, columns: 4, heights, scale: [20, 1, 20] }), 0.5, 0.02, 'heightfield');
  // Geometry-derived colliders take the mesh scale.
  const physics = create();
  const body = physics.addBody(
    fakeMesh({
      geometry: new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]),
      scale: [2, 3, 1],
    }),
    { type: 'fixed', colliders: { shape: 'trimesh' } },
  );
  assert.deepEqual([...body.colliders[0].vertices()], [0, 0, 0, 2, 0, 0, 0, 3, 0]);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'trimesh' } }), /needs a mesh with geometry/);
  assert.throws(
    () =>
      physics.addBody(null, {
        colliders: { shape: 'heightfield', rows: 2, columns: 2, heights: [0], scale: [1, 1, 1] },
      }),
    /\(rows \+ 1\)/,
  );
  assert.equal(physics.bodyCount, 1, 'a failed addBody leaves nothing behind');
  physics.dispose();
});

rtest('collider materials, mass, collision groups and contact filters', () => {
  const physics = create();
  ground(physics, { collisionGroups: collisionGroups([0], [0, 1]) });
  const heavy = physics.addBody(null, {
    position: [0, 1, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 4 },
  });
  near(heavy.mass, 4, 1e-4, 'density times volume');
  const ghost = physics.addBody(null, {
    position: [3, 2, 0],
    colliders: { shape: 'sphere', radius: 0.5, collisionGroups: collisionGroups([2], [2]) },
  });
  const fixedMass = physics.addBody(null, {
    position: [-3, 2, 0],
    colliders: { shape: 'sphere', radius: 0.5, mass: 7 },
  });
  near(fixedMass.mass, 7, 1e-4, 'explicit mass');
  run(physics, 1);
  assert.ok(ghost.position[1] < -1, 'group-filtered body falls through the ground');
  near(heavy.position[1], 0.5, 0.01, 'grouped body rests');
  physics.dispose();

  let filtered = 0;
  const filteredWorld = create({
    contactFilter: (a, b) => {
      filtered++;
      return !(a.userData === 'ghost' || b.userData === 'ghost');
    },
  });
  ground(filteredWorld);
  const passer = filteredWorld.addBody(null, {
    position: [0, 1, 0],
    userData: 'ghost',
    colliders: { shape: 'sphere', radius: 0.5 },
  });
  const lander = filteredWorld.addBody(null, { position: [2, 1, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  run(filteredWorld, 1);
  assert.ok(
    filtered > 0 && passer.position[1] < -1 && Math.abs(lander.position[1] - 0.5) < 0.02,
    'contact filter lets the ghost through',
  );
  filteredWorld.dispose();
});

rtest('forces, impulses, torques, velocities, gravity scale, sleeping and CCD', () => {
  const physics = create({ gravity: [0, 0, 0] });
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 2 }, canSleep: false });
  body.applyImpulse([4, 0, 0]);
  physics.step();
  near(body.linearVelocity[0], 2, 1e-4, 'impulse / mass');
  body.addForce([0, 2, 0]);
  for (let i = 0; i < 60; i++) physics.step();
  near(body.linearVelocity[1], 1, 0.02, 'force for one second');
  body.resetForces();
  body.setLinearVelocity([0, 0, 0]);
  body.applyTorqueImpulse([0, 1, 0]);
  physics.step();
  assert.ok(body.angularVelocity[1] > 0);
  body.setAngularVelocity([0, 0, 0]).addTorque([0, 0, 1]);
  physics.step();
  assert.ok(body.angularVelocity[2] > 0);
  physics.gravity = [0, -10, 0];
  assert.deepEqual(physics.gravity, [0, -10, 0]);
  body.resetForces();
  body.setLinearVelocity([0, 0, 0]);
  body.setAngularVelocity([0, 0, 0]);
  body.gravityScale = 0;
  physics.step();
  near(body.linearVelocity[1], 0, 1e-6, 'gravity scale 0');
  physics.dispose();

  // A fast bullet with CCD stops at a thin wall. (Rapier 0.21's speculative contacts already stop this
  // simple case without CCD, so only the CCD path is asserted.)
  const shoot = (ccd) => {
    const world = create({ gravity: [0, 0, 0] });
    world.addBody(null, { type: 'fixed', position: [5, 0, 0], colliders: { shape: 'box', halfExtents: [0.05, 2, 2] } });
    const bullet = world.addBody(null, {
      ccd,
      linearVelocity: [400, 0, 0],
      colliders: { shape: 'sphere', radius: 0.05 },
    });
    for (let i = 0; i < 10; i++) world.step();
    const x = bullet.position[0],
      enabled = bullet.ccd;
    world.dispose();
    return { x, enabled };
  };
  assert.equal(shoot(false).enabled, false);
  const fired = shoot(true);
  assert.ok(fired.enabled && fired.x < 5, 'with CCD the bullet stops at the wall');

  // Sleep and wake.
  const sleepy = create();
  ground(sleepy);
  const box1 = sleepy.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  box1.sleep();
  assert.ok(box1.sleeping);
  box1.applyImpulse([0, 5, 0]);
  assert.ok(!box1.sleeping, 'impulse wakes the body');
  sleepy.dispose();
});

rtest('kinematic bodies: position-based and velocity-based', () => {
  const physics = create();
  const mesh = fakeMesh();
  const platform = physics.addBody(mesh, {
    type: 'kinematicPosition',
    colliders: { shape: 'box', halfExtents: [1, 0.1, 1] },
  });
  platform.setNextPosition([0, 1, 0]);
  physics.update(1 / 60);
  near(platform.position[1], 1, 1e-6, 'kinematic position reached in one step');
  physics.update(1 / 60);
  near(mesh.position.y, 1, 1e-6, 'mesh follows');
  const mover = physics.addBody(null, {
    type: 'kinematicVelocity',
    colliders: { shape: 'box', halfExtents: [1, 0.1, 1] },
    linearVelocity: [1, 0, 0],
  });
  for (let i = 0; i < 60; i++) physics.step();
  near(mover.position[0], 1, 1e-4, 'kinematic velocity, gravity ignored');
  near(mover.position[1], 0, 1e-6, 'no gravity on kinematic');
  physics.dispose();
});

rtest('character controller climbs a step, stops at a wall and snaps to the ground', () => {
  const physics = create();
  ground(physics);
  physics.addBody(null, {
    type: 'fixed',
    position: [3, 0.1, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.1, 2] },
  }); // 0.2 high step from x = 2 to 4
  physics.addBody(null, { type: 'fixed', position: [6, 1, 0], colliders: { shape: 'box', halfExtents: [0.1, 1, 2] } }); // wall face at x = 5.9
  const radius = 0.3,
    halfHeight = 0.4;
  const character = physics.addBody(fakeMesh(), {
    type: 'kinematicPosition',
    position: [0, halfHeight + radius + 0.02, 0],
    colliders: { shape: 'capsule', halfHeight, radius },
  });
  const controller = physics.createCharacterController(character, {
    offset: 0.01,
    autostep: { maxHeight: 0.3, minWidth: 0.1, includeDynamicBodies: false },
    snapToGround: 0.3,
  });
  const speed = 2,
    dt = 1 / 60;
  let fall = 0,
    onStep = false;
  physics.on('beforestep', (step) => {
    fall = controller.grounded ? 0 : fall - 9.81 * step;
    controller.move([speed * step, Math.min(fall, -0.1) * step, 0]);
  });
  for (let i = 0; i < 240; i++) {
    physics.update(dt);
    const [x, y] = character.position;
    if (x > 2.5 && x < 3.5) {
      onStep = true;
      near(y, 0.2 + halfHeight + radius, 0.05, `height on the step at x=${x.toFixed(2)}`);
    }
  }
  assert.ok(onStep, 'character reached the step');
  const [x] = character.position;
  near(x, 5.9 - radius, 0.05, 'stops at the wall');
  assert.ok(controller.grounded);
  // Walk back off the step: snap to ground keeps it grounded on the way down.
  for (let i = 0; i < 240; i++) {
    physics.step();
    controller.move([-speed * dt, -0.1 * dt, 0]);
  }
  near(character.position[1], halfHeight + radius, 0.05, 'back on the floor');
  // Slopes steeper than maxSlopeClimbAngle are not climbed.
  const ramp = create();
  ground(ramp);
  ramp.addBody(null, {
    type: 'fixed',
    position: [3, 0, 0],
    rotation: eulerToQuat(0, 0, Math.PI / 3),
    colliders: { shape: 'box', halfExtents: [2, 0.05, 2] },
  });
  const climber = ramp.addBody(null, {
    type: 'kinematicPosition',
    position: [0, halfHeight + radius + 0.02, 0],
    colliders: { shape: 'capsule', halfHeight, radius },
  });
  const steep = ramp.createCharacterController(climber, { maxSlopeClimbAngle: Math.PI / 4, autostep: false });
  for (let i = 0; i < 240; i++) {
    ramp.step();
    steep.move([speed * dt, -0.1 * dt, 0]);
  }
  assert.ok(climber.position[1] < 1, `a 60 degree slope is not climbed (y = ${climber.position[1]})`);
  physics.dispose();
  ramp.dispose();
});

rtest('child meshes need core meshes (the transform store); disposed meshes drop their bodies', () => {
  const physics = create();
  const child = fakeMesh();
  parents[child.id] = 0;
  assert.throws(() => physics.addBody(child), /child meshes need core meshes/);
  parents[child.id] = -1;
  const body = physics.addBody(child, { colliders: { shape: 'sphere', radius: 1 } });
  assert.throws(() => physics.addBody(child), /already has a physics body/);
  assert.equal(physics.bodyOf(child), body);
  parents[child.id] = 0;
  assert.throws(() => physics.update(1 / 60), /child meshes need core meshes/);
  parents[child.id] = -1;
  child.dispose();
  physics.update(1 / 60);
  assert.equal(body.valid, false);
  assert.equal(physics.bodyCount, 0);
  physics.dispose();
});

rtest('dispose frees every body, collider, joint, controller and the world', () => {
  const physics = create();
  const freed = [];
  const world = physics.world,
    queue = physics['queue'];
  const spy = (object, label) => {
    const free = object.free.bind(object);
    object.free = () => {
      freed.push(label);
      free();
    };
  };
  spy(world, 'world');
  spy(queue, 'queue');
  const removedControllers = [];
  const removeController = world.removeCharacterController.bind(world);
  world.removeCharacterController = (controller) => {
    removedControllers.push(controller);
    removeController(controller);
  };
  ground(physics);
  const a = physics.addBody(fakeMesh({ geometry: box() }));
  const b = physics.addBody(null, {
    position: [0, 3, 0],
    colliders: [
      { shape: 'sphere', radius: 0.5 },
      { shape: 'box', halfExtents: [0.2, 0.2, 0.2], offset: [0, 1, 0] },
    ],
  });
  const joint = physics.addJoint(a, b, { type: 'spherical' });
  const character = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [5, 1, 0],
    colliders: { shape: 'capsule', halfHeight: 0.5, radius: 0.3 },
  });
  const controller = physics.createCharacterController(character);
  physics.update(1 / 60);
  assert.equal(world.bodies.len(), 4);
  assert.equal(world.colliders.len(), 5);
  assert.equal(world.impulseJoints.len?.() ?? 1, 1);
  // Removing a collider and a body frees them in Rapier immediately.
  b.removeCollider(b.colliders[1]);
  assert.equal(world.colliders.len(), 4);
  physics.dispose();
  assert.deepEqual(freed, ['queue', 'world']);
  assert.deepEqual(removedControllers, [controller.raw]);
  assert.ok(!a.valid && !b.valid && !character.valid && !joint.valid, 'handles are invalidated');
  assert.equal(physics.bodyCount, 0);
  assert.throws(() => physics.world, /disposed/);
  assert.throws(() => a.position, /removed/);
  assert.equal(physics.update(1), 0);
  physics.dispose(); // idempotent
});

rtest('engine plugin lifecycle: use, onPreUpdate, removePlugin disposes', () => {
  // A stand-in with the same plugin contract as core's Engine.use and removePlugin.
  const plugins = new Map();
  const engine = {
    disposed: false,
    use(plugin) {
      plugin.setup(this);
      plugins.set(plugin.name, plugin);
      return this;
    },
    hasPlugin: (name) => plugins.has(name),
    removePlugin(name) {
      const plugin = plugins.get(name);
      plugins.delete(name);
      plugin?.dispose?.();
    },
    render(delta) {
      for (const plugin of plugins.values()) plugin.onPreUpdate?.(delta);
    },
  };
  const physics = new Physics(engine, { rapier: RAPIER });
  assert.ok(engine.hasPlugin('physics'));
  const mesh = fakeMesh({ position: [0, 2, 0] });
  physics.addBody(mesh, { colliders: { shape: 'sphere', radius: 0.5 } });
  engine.render(0.1);
  assert.ok(mesh.position.y < 2, 'engine frames step the world');
  physics.dispose();
  assert.ok(!engine.hasPlugin('physics') && physics.isDisposed, 'dispose detaches from the engine');
  const second = new Physics(engine, { rapier: RAPIER });
  engine.removePlugin('physics');
  assert.ok(second.isDisposed, 'removePlugin disposes');
});

rtest('debugRender returns line segments that margoengine-lines can draw', () => {
  const physics = create();
  ground(physics);
  physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  physics.step();
  const { vertices, colors } = physics.debugRender();
  assert.ok(vertices.length > 0 && vertices.length % 6 === 0, 'xyz pairs');
  assert.equal(colors.length, (vertices.length / 3) * 4, 'rgba per vertex');
  physics.dispose();
});

rtest('sensors also fire for kinematic bodies such as characters', () => {
  const physics = create();
  physics.addBody(null, {
    type: 'fixed',
    position: [3, 1, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 1, 1], sensor: true },
  });
  const character = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, 1, 0],
    colliders: { shape: 'capsule', halfHeight: 0.4, radius: 0.3 },
  });
  const events = [];
  physics.on('intersectionstart', () => events.push('enter'));
  physics.on('intersectionend', () => events.push('exit'));
  for (let i = 0; i < 120; i++) {
    character.setNextPosition([character.position[0] + 0.1, 1, 0]);
    physics.step();
  }
  assert.deepEqual(events, ['enter', 'exit']);
  physics.dispose();
});

rtest(
  'core transform synchronization writes the transform storage directly, bypassing the validating setters',
  async () => {
    const store = await TransformStore.create(8),
      engine = new Engine(
        { width: 1, height: 1 },
        store,
        { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
        undefined,
        null,
      );
    const physics = new Physics(engine, { rapier: RAPIER }),
      mesh = engine.createMesh().setGeometry(box()).setPosition([0, 5, 0]);
    const body = physics.addBody(mesh);
    body.raw.setAngvel({ x: 0.2, y: 0.4, z: 0.1 }, true);
    mesh.setPosition = () => {
      throw new Error('Validating core position setter used');
    };
    mesh.setQuaternion = () => {
      throw new Error('Allocating core quaternion method used');
    };
    for (let i = 0; i < 120; i++) physics.update(1 / 60);
    assert.ok(mesh.position.y < 5);
    const p = body.pose;
    near(mesh.position.y, p[1] + (p[8] - p[1]) * physics.alpha, 1e-4, 'synchronized interpolated height');
    const id = mesh.id,
      q = body.pose.subarray(10, 14);
    for (let i = 0; i < 4; i++)
      near(store.transforms[['qx', 'qy', 'qz', 'qw'][i]][id], q[i], 0.01, 'synchronized quaternion');
    physics.dispose();
    engine.dispose();
  },
);

/** A headless core engine (real transform store and kernel, no GPU). */
async function coreEngine(capacity = 64) {
  const store = await TransformStore.create(capacity);
  return new Engine(
    { width: 1, height: 1 },
    store,
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}
/** gltf-pro's 20-float CPU vertices (position first) and indices from a core geometry. */
function primitiveOf(node, geometry, extra = {}) {
  const count = geometry.vertices.length / 6,
    vertices = new Float32Array(count * 20);
  for (let i = 0; i < count; i++) vertices.set(geometry.vertices.subarray(i * 6, i * 6 + 3), i * 20);
  return { node, vertices, indices: geometry.indices, ...extra };
}
const worldOf = (engine, mesh) => {
  engine.store.tick(false);
  return mesh.matrix;
};

rtest('bodies on child meshes start at the world pose and write parent-relative poses with no lag', async () => {
  const engine = await coreEngine(),
    physics = new Physics(engine, { rapier: RAPIER });
  try {
    ground(physics);
    // Parent: 90 degrees about Y, uniform scale 2, at (0, 3, 0). Child at local (1, 0, 0) is at world (0, 3, -2).
    const parent = engine
      .createMesh()
      .setPosition([0, 3, 0])
      .setRotation([0, Math.PI / 2, 0])
      .setScale([2, 2, 2]);
    const child = engine
      .createMesh(parent)
      .setGeometry(box(1, 1, 1))
      .setPosition([1, 0, 0]);
    const body = physics.addBody(child);
    [0, 3, -2].forEach((v, i) => near(body.position[i], v, 1e-5, 'world start'));
    near(body.colliders[0].halfExtents().y, 1, 1e-6, 'fitted to the world scale');
    near(Math.abs(angleAbout(body.rotation, [0, 1, 0])), Math.PI / 2, 1e-5, 'world rotation');
    run(physics, 3);
    near(body.position[1], 1, 0.01, 'rests on the ground with the world-scaled box');
    const m = worldOf(engine, child);
    [0, 1, 2].forEach((i) => near(m[12 + i], body.position[i], 1e-4, 'rendered world position'));
    // Moving the parent keeps the child where physics has it, from the very next sync.
    parent.setPosition([5, 3, 1]).setRotation([0.4, 0.2, 0]);
    physics.sync();
    const moved = worldOf(engine, child);
    [0, 1, 2].forEach((i) => near(moved[12 + i], body.position[i], 1e-4, 'world position after the parent moved'));
    const q = body.rotation,
      x = [1 - 2 * (q[1] ** 2 + q[2] ** 2), 2 * (q[0] * q[1] + q[3] * q[2]), 2 * (q[0] * q[2] - q[3] * q[1])];
    [0, 1, 2].forEach((i) => near(moved[i] / 2, x[i], 1e-4, 'world rotation after the parent moved'));
  } finally {
    physics.dispose();
    engine.dispose();
  }
});

rtest(
  'addModel: one call builds trimesh colliders for a node hierarchy with instances, scale and filters',
  async () => {
    const engine = await coreEngine(),
      physics = new Physics(engine, { rapier: RAPIER });
    try {
      // Root raised by 1 and turned 90 degrees; a floor node (10 x 0.2 x 10 after its scale) and a wall node; an instanced post.
      const root = engine
        .createMesh()
        .setPosition([0, 1, 0])
        .setRotation([0, Math.PI / 2, 0]);
      const floor = engine.createMesh(root).setScale([10, 1, 10]),
        wall = engine.createMesh(root).setPosition([0, 1, 4]),
        posts = engine.createMesh(root);
      const instances = { count: 2, data: new Float32Array(48) };
      for (let k = 0; k < 2; k++)
        instances.data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * 3 - 6, 0.6, 0, 1], k * 24);
      const model = {
        root,
        primitives: [
          primitiveOf(floor, box(1, 0.2, 1)),
          primitiveOf(wall, box(4, 2, 0.2), { nodeIndex: 7 }),
          primitiveOf(posts, box(0.2, 1, 0.2), { instances }),
        ],
      };
      const [level] = physics.addModel(model, { type: 'fixed', collider: { friction: 0.5 } });
      assert.equal(physics.bodyCount, 1);
      assert.equal(level.mesh, root);
      assert.equal(level.colliders.length, 4, 'one per primitive and per instance');
      assert.equal(level.colliders[0].friction(), 0.5);
      assert.equal(level.colliders[0].shapeType(), RAPIER.ShapeType.TriMesh);
      // The floor top is at y = 1.1 in world space; a ball lands on it.
      const ball = physics.addBody(null, { position: [3, 4, -3], colliders: { shape: 'sphere', radius: 0.5 } });
      run(physics, 3);
      near(ball.position[1], 1.6, 0.02, 'ball rests on the floor');
      // The wall (local z = 4 under the turned root) stands at world x = 4.
      assert.equal(physics.raycast([0, 2, 0], [1, 0, 0], { exclude: ball }).body, level);
      near(physics.raycast([0, 2, 0], [1, 0, 0], { exclude: ball }).distance, 3.9, 1e-4, 'wall face in world space');
      // Instanced posts at local x = -6 and -3 under the turned root: world z = 6 and 3.
      near(physics.raycast([0, 1.6, 0], [0, 0, 1], { exclude: ball }).distance, 2.9, 1e-4, 'nearest post instance');
      // Per node, with a filter: bodies on the nodes themselves, hits report the node.
      level.remove();
      const bodies = physics.addModel(model, { type: 'fixed', perNode: true, filter: (p) => p.nodeIndex !== 7 });
      assert.deepEqual(
        bodies.map((b) => b.mesh),
        [floor, posts],
      );
      physics.step(); // queries see the world as of the last step
      assert.equal(physics.raycast([3, 3, -3], [0, -1, 0], { exclude: ball }).mesh, floor);
      assert.equal(physics.raycast([0, 2, 0], [1, 0, 0], { exclude: ball }), null, 'filtered wall left out');
      // A failure part-way keeps nothing.
      const count = physics.bodyCount;
      assert.throws(() => physics.addModel(model, { type: 'fixed', perNode: true }), /already has a physics body/);
      assert.equal(physics.bodyCount, count);
      assert.throws(() => physics.addModel(model, { shape: 'box' }), /trimesh' or 'convexHull/);
    } finally {
      physics.dispose();
      engine.dispose();
    }
  },
);

rtest('addModel: dynamic models get convex hulls and the root moves as one body', async () => {
  const engine = await coreEngine(),
    physics = new Physics(engine, { rapier: RAPIER });
  try {
    ground(physics);
    const root = engine.createMesh().setPosition([0, 3, 0]),
      part = engine.createMesh(root).setPosition([0.5, 0, 0]).setScale([2, 2, 2]);
    const [body] = physics.addModel({
      root,
      primitives: [primitiveOf(root, box(1, 1, 1)), primitiveOf(part, box(0.5, 0.5, 0.5))],
    });
    assert.equal(body.colliders[1].shapeType(), RAPIER.ShapeType.ConvexPolyhedron);
    assert.ok(body.mass > 1.9, 'convex hulls give the body mass');
    run(physics, 3);
    near(root.position.y, 0.5, 0.02, 'model rests on its lowest hull');
    const m = worldOf(engine, part);
    near(m[13], root.position.y, 1e-4, 'child follows its parent');
  } finally {
    physics.dispose();
    engine.dispose();
  }
});

rtest('the frame path allocates nothing: sync and the wrapper step (heap count in a child process)', () => {
  // Rapier's own World.step and pose getters allocate in its JS glue (see the README); the child stubs them out of the step case.
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--min-semi-space-size=64',
      '--max-semi-space-size=64',
      fileURLToPath(new URL('./allocations.js', import.meta.url)),
      rapierEntry,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const { rapier, ...measured } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(rapier.step.calls > 0 && rapier.getter.calls > 0, 'Rapier reference cases ran');
  for (const [name, { bytes, calls, gcs }] of Object.entries(measured)) {
    assert.equal(gcs, 0, `${name}: a collection ran during the window, so the count is not valid`);
    // Under one byte per call: a single 16-byte object per frame would show as 16.
    assert.ok(bytes < calls, `${name}: ${bytes} bytes over ${calls} calls`);
  }
});

// PhysicsCollider, the voxels and halfSpace shapes and the mass calls: what a dependent reaches instead of the solver's
// own objects, against the real solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics, PhysicsCollider, Vehicle, collisionGroups } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const world = (options) => new Physics(null, options);
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};
const floor = (physics) =>
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [20, 0.5, 20], offset: [0, -0.5, 0] } });
const cells = (...list) => Int32Array.from(list.flat());
// A square of cells at height y, from 0 to size in x and z.
const slab = (size, y = 0) => {
  const out = [];
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) out.push(x, y, z);
  return Int32Array.from(out);
};

test('one wrapper per collider, the same one from the body, events and queries', () => {
  const physics = world(),
    ground = floor(physics),
    ball = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    [groundCollider] = ground.colliders,
    [ballCollider] = ball.colliders;
  assert.ok(ballCollider instanceof PhysicsCollider);
  assert.equal(ballCollider.shape, 'sphere');
  assert.equal(ballCollider.body, ball);
  assert.equal(physics.bodyOfCollider(ballCollider), ball);
  assert.equal(physics.bodyOfCollider(ballCollider.handle), ball);
  let event;
  physics.on('contactstart', (e) => (event ??= e));
  run(physics, 120);
  assert.ok(event, 'the ball reached the floor');
  assert.deepEqual(new Set([event.colliderA, event.colliderB]), new Set([groundCollider, ballCollider]));
  const hit = physics.raycast([0, 5, 0], [0, -1, 0]);
  assert.equal(hit.collider, ballCollider);
  assert.equal(hit.body, ball);
  const seen = [];
  physics.raycast([0, 5, 0], [0, -1, 0], {
    predicate: (body, collider) => {
      seen.push([body, collider]);
      return body === ground;
    },
  });
  assert.ok(seen.some(([body, collider]) => body === ball && collider === ballCollider));
  physics.dispose();
});

test('setters reach the solver and read back', () => {
  const physics = world(),
    body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 2, 3], offset: [0, 4, 0] } }),
    [collider] = body.colliders;
  assert.equal(collider.setFriction(0.25).friction(), 0.25);
  assert.equal(collider.setRestitution(0.5).restitution(), 0.5);
  assert.equal(collider.setSensor(true).isSensor(), true);
  assert.equal(collider.setEnabled(false).isEnabled(), false);
  collider.setEnabled(true).setSensor(false);
  const groups = collisionGroups(1, 2);
  assert.equal(collider.setCollisionGroups(groups).collisionGroups(), groups);
  assert.equal(collider.setSolverGroups(groups).solverGroups(), groups);
  assert.deepEqual({ ...collider.halfExtents() }, { x: 1, y: 2, z: 3 });
  assert.deepEqual({ ...collider.translationWrtParent() }, { x: 0, y: 4, z: 0 });
  assert.equal(collider.containsPoint({ x: 0.5, y: 5, z: 0 }), true);
  assert.equal(collider.containsPoint({ x: 0.5, y: 0, z: 0 }), false);
  assert.equal(collider.boundingRadius, Math.hypot(1, 2, 3));
  physics.dispose();
});

test('boundingRadius holds each simple shape and is null where it would have to walk geometry', () => {
  const physics = world(),
    add = (colliders) => physics.addBody(null, { type: 'fixed', colliders }).colliders[0];
  assert.equal(add({ shape: 'sphere', radius: 2 }).boundingRadius, 2);
  assert.equal(add({ shape: 'capsule', radius: 1, halfHeight: 2 }).boundingRadius, 3);
  assert.equal(add({ shape: 'cylinder', radius: 3, halfHeight: 4 }).boundingRadius, 5);
  assert.equal(add({ shape: 'cone', radius: 3, halfHeight: 4 }).boundingRadius, 5);
  assert.equal(add({ shape: 'voxels', cells: cells([0, 0, 0]) }).boundingRadius, null);
  physics.dispose();
});

test('a removed collider says so, whether alone or with its body', () => {
  const physics = world(),
    body = physics.addBody(null, { colliders: [{ shape: 'sphere', radius: 1 }, { shape: 'sphere', radius: 2 }] }),
    [first, second] = body.colliders;
  body.removeCollider(first);
  assert.equal(first.valid, false);
  assert.throws(() => first.friction(), { code: 'state' });
  assert.equal(body.colliders.length, 1);
  assert.equal(physics.bodyOfCollider(first.handle), undefined);
  body.remove();
  assert.equal(second.valid, false);
  assert.throws(() => second.setFriction(1), { code: 'state' });
  physics.dispose();
});

test('a box rests on a voxels shape at the height of the top of the cells', () => {
  const physics = world();
  assert.equal(physics.supportsShape('voxels'), true);
  const ground = physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'voxels', cells: slab(8), size: [1, 1, 1], massless: true },
    }),
    crate = physics.addBody(null, { position: [4, 3, 4], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  assert.equal(ground.colliders[0].shape, 'voxels');
  run(physics, 240);
  // Top of the cells at y = 1 plus the half height; the solver allows up to its own small contact skin of overlap.
  assert.ok(Math.abs(crate.position[1] - 1.5) < 0.02, `rests at ${crate.position[1]}`);
  physics.dispose();
});

test('the size of a voxels shape scales its cells', () => {
  const physics = world();
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cells: slab(8), size: [0.5, 2, 0.5], massless: true } });
  const crate = physics.addBody(null, { position: [2, 4, 2], colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25] } });
  run(physics, 240);
  assert.ok(Math.abs(crate.position[1] - 2.25) < 0.02, `rests at ${crate.position[1]}`);
  physics.dispose();
});

test('setVoxel opens the grid under a body in place: same collider, and the body falls', () => {
  const physics = world(),
    ground = physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'voxels', cells: cells([0, 0, 0], [1, 0, 0], [2, 0, 0]), massless: true },
    }),
    crate = physics.addBody(null, {
      position: [1.5, 2, 0.5],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25] },
    }),
    [grid] = ground.colliders;
  run(physics, 180);
  assert.ok(Math.abs(crate.position[1] - 1.25) < 0.02, `rests at ${crate.position[1]}`);
  assert.equal(grid.setVoxel(1, 0, 0, false), grid);
  run(physics, 60);
  assert.ok(crate.position[1] < 0.5, `fell through the hole to ${crate.position[1]}`);
  assert.equal(ground.colliders[0], grid);
  physics.dispose();
});

test('two grids coupled along a border and told of changes take the calls a VoxelPhysics makes', () => {
  const physics = world(),
    fixed = (x) =>
      physics.addBody(null, {
        type: 'fixed',
        position: [x, 0, 0],
        colliders: { shape: 'voxels', cells: slab(4), massless: true },
      }).colliders[0],
    a = fixed(0),
    b = fixed(4);
  assert.equal(a.combineVoxelStates(b, 4, 0, 0), a);
  a.setVoxel(3, 0, 0, false);
  assert.equal(a.propagateVoxelChange(b, 3, 0, 0, 4, 0, 0), a);
  // A sliding box crosses the border at the height it left: the coupled seam has no inner edge to catch it.
  const crate = physics.addBody(null, {
    position: [2, 1.3, 2],
    linearVelocity: [3, 0, 0],
    canSleep: false,
    colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], friction: 0 },
  });
  a.setFriction(0);
  b.setFriction(0);
  run(physics, 60);
  assert.ok(crate.position[0] > 4.5, `crossed the seam to x = ${crate.position[0]}`);
  assert.ok(Math.abs(crate.position[1] - 1.3) < 0.02, `stayed on top at ${crate.position[1]}`);
  physics.dispose();
});

test('voxels options are checked before the solver sees them', () => {
  const physics = world(),
    add = (colliders) => physics.addBody(null, { type: 'fixed', colliders });
  assert.throws(() => add({ shape: 'voxels', cells: [0, 0, 0] }), TypeError);
  assert.throws(() => add({ shape: 'voxels', cells: Int32Array.of(0, 0) }), TypeError);
  assert.throws(() => add({ shape: 'voxels', cells: slab(1), size: [1, 0, 1] }), RangeError);
  assert.throws(() => add({ shape: 'voxels', cells: slab(1), size: [1, 1] }), RangeError);
  physics.dispose();
});

test('a solver without voxels refuses them with a coded error', () => {
  const physics = world(),
    { voxels } = physics.rapier.ColliderDesc;
  physics.rapier.ColliderDesc.voxels = undefined;
  try {
    assert.equal(physics.supportsShape('voxels'), false);
    assert.equal(physics.supportsShape('box'), true);
    assert.throws(() => physics.addBody(null, { colliders: { shape: 'voxels', cells: slab(1) } }), { code: 'unsupported' });
  } finally {
    physics.rapier.ColliderDesc.voxels = voxels;
  }
  physics.dispose();
});

test('massless adds nothing to a body, whatever mass or density it names', () => {
  const physics = world(),
    add = (extra) =>
      physics.addBody(null, { colliders: [{ shape: 'box', halfExtents: [1, 1, 1], density: 1 }, { shape: 'sphere', radius: 1, ...extra }] });
  const plain = add({ density: 1000 }),
    light = add({ massless: true }),
    both = add({ massless: true, mass: 5 });
  physics.step();
  assert.ok(plain.mass > 1000);
  assert.ok(Math.abs(light.mass - 8) < 1e-5, `only the box counts: ${light.mass}`);
  assert.ok(Math.abs(both.mass - 8) < 1e-5, `massless wins over mass: ${both.mass}`);
  physics.dispose();
});

test('halfSpace holds a body on the solid side of any normal', () => {
  const physics = world({ gravity: [0, -9.81, 0] });
  const tilted = physics.addBody(null, { type: 'fixed', position: [0, -1, 0], colliders: { shape: 'halfSpace' } }),
    ball = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  assert.equal(tilted.colliders[0].shape, 'halfSpace');
  run(physics, 240);
  assert.ok(Math.abs(ball.position[1] + 0.5) < 0.02, `rests at ${ball.position[1]}`);
  physics.dispose();
  const wall = world({ gravity: [-9.81, 0, 0] });
  // A normal that is not of length 1 is made so.
  wall.addBody(null, { type: 'fixed', position: [-1, 0, 0], colliders: { shape: 'halfSpace', normal: [3, 0, 0] } });
  const pushed = wall.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 } });
  run(wall, 240);
  assert.ok(Math.abs(pushed.position[0] + 0.5) < 0.02, `rests at ${pushed.position[0]}`);
  assert.throws(() => wall.addBody(null, { type: 'fixed', colliders: { shape: 'halfSpace', normal: [0, 0, 0] } }), RangeError);
  wall.dispose();
});

test('fixInternalEdges takes a ball over the shared edges of flat triangles', () => {
  const quads = [],
    indices = [];
  // A strip of flat quads along x.
  for (let i = 0; i < 8; i++) {
    quads.push(i, 0, -1, i + 1, 0, -1, i + 1, 0, 1, i, 0, 1);
    indices.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2);
  }
  const vertices = Float32Array.from(quads);
  const slide = (fixInternalEdges) => {
    const physics = world(),
      ground = physics.addBody(null, {
        type: 'fixed',
        colliders: { shape: 'trimesh', vertices, indices, fixInternalEdges, friction: 0, massless: true },
      });
    assert.equal(ground.colliders[0].shape, 'trimesh');
    const ball = physics.addBody(null, {
      position: [0.5, 0.26, 0],
      linearVelocity: [4, 0, 0],
      colliders: { shape: 'sphere', radius: 0.25, friction: 0 },
    });
    let slowest = Infinity;
    for (let i = 0; i < 90; i++) {
      physics.step();
      if (ball.position[0] < 7) slowest = Math.min(slowest, ball.linearVelocity[0]);
    }
    physics.dispose();
    return slowest;
  };
  // No friction anywhere and a flat floor: nothing may take speed along x, and a seam does when the edges are left as they are.
  assert.ok(Math.abs(slide(true) - 4) < 1e-3, `kept its speed: ${slide(true)}`);
  assert.ok(slide(false) < 3.9, `the seams of the plain mesh catch it: ${slide(false)}`);
});

test('custom keeps working and is named after what it holds', () => {
  const physics = world(),
    { ColliderDesc } = physics.rapier,
    named = physics.addBody(null, { colliders: { shape: 'custom', desc: ColliderDesc.ball(1) } });
  assert.equal(named.colliders[0].shape, 'sphere');
  assert.equal(named.colliders[0].radius(), 1);
  physics.dispose();
});

test('a character predicate gets the wrapper, and can refuse a collider by it', () => {
  const physics = world(),
    wall = physics.addBody(null, {
      type: 'fixed',
      position: [1, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.2, 2, 2] },
    }),
    body = physics.addBody(null, {
      type: 'kinematicPosition',
      colliders: { shape: 'capsule', radius: 0.3, halfHeight: 0.5 },
    }),
    character = physics.createCharacterController(body),
    seen = new Set();
  physics.step();
  const blocked = character.move([2, 0, 0]);
  assert.ok(blocked.movement[0] < 0.6, `the wall stopped it at ${blocked.movement[0]}`);
  const free = character.move([2, 0, 0], {
    predicate: (collider) => {
      seen.add(collider);
      return collider !== wall.colliders[0];
    },
  });
  assert.ok(free.movement[0] > 1.9, `a refused wall lets it through: ${free.movement[0]}`);
  assert.ok(seen.has(wall.colliders[0]));
  physics.dispose();
});

test('a vehicle predicate gets the wrapper, and a refused floor holds no wheel up', () => {
  const seen = new Set(),
    drive = (refuse) => {
      const physics = world(),
        ground = floor(physics),
        chassis = physics.addBody(null, {
          position: [0, 0.6, 0],
          canSleep: false,
          colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 },
        }),
        vehicle = new Vehicle(physics, chassis, {
          wheels: [{ position: [0, -0.1, 0], radius: 0.35, suspensionRestLength: 0.3 }],
          predicate: (collider) => {
            seen.add(collider);
            return !refuse || collider !== ground.colliders[0];
          },
        });
      run(physics, 2);
      const touching = vehicle.wheel(0).inContact;
      assert.ok(seen.has(ground.colliders[0]) && [...seen].every((one) => one instanceof PhysicsCollider));
      physics.dispose();
      return touching;
    };
  assert.equal(drive(false), true);
  assert.equal(drive(true), false);
});

test('mass, centre and inertia read back and setMassProperties replaces them', () => {
  const physics = world(),
    make = () => physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 8 } }),
    near = (got, want) => assert.ok(Math.abs(got - want) < 1e-4, `${got} against ${want}`);
  // Solid cube of 8 kg, side 1: m s^2 / 6 about each axis.
  const body = make();
  physics.step();
  assert.equal(body.mass, 8);
  near(body.principalInertia[0], 8 / 6);
  assert.deepEqual(body.centerOfMass, [0, 0, 0]);
  // Mass alone scales the inertia with it.
  body.setMassProperties({ mass: 16 });
  assert.equal(body.mass, 16);
  near(body.principalInertia[0], 16 / 6);
  // Each figure stands by itself.
  const tuned = make();
  physics.step();
  tuned.setMassProperties({ mass: 2, centerOfMass: [1, 0, 0], inertia: [1, 2, 3] });
  assert.equal(tuned.mass, 2);
  near(tuned.centerOfMass[0], 1);
  assert.deepEqual(
    tuned.principalInertia.map((value) => Math.round(value * 1e4) / 1e4).sort(),
    [1, 2, 3],
  );
  assert.equal(tuned.inertiaFrame.length, 4);
  // The colliders no longer count.
  assert.equal(tuned.colliders[0].density(), 0);
  assert.throws(() => tuned.setMassProperties({ mass: -1 }), RangeError);
  assert.throws(() => tuned.setMassProperties({ mass: Infinity }), RangeError);
  assert.throws(() => tuned.setMassProperties({ inertia: [1, -1, 1] }), RangeError);
  physics.dispose();
});

test('a joint tells where it holds each body', () => {
  const physics = world(),
    a = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } }),
    b = physics.addBody(null, { position: [3, 0, 0], colliders: { shape: 'sphere', radius: 1 } }),
    joint = physics.addJoint(a, b, { type: 'spherical', anchorA: [1, 0, 0], anchorB: [-2, 0, 0] });
  assert.deepEqual(joint.anchorA, [1, 0, 0]);
  assert.deepEqual(joint.anchorB, [-2, 0, 0]);
  physics.dispose();
});

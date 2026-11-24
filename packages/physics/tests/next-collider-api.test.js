// The rest of Rapier's collider and narrow-phase API on the own solver: readers and setters, the lists of what a collider
// touches, contact and cast against a shape or collider, and the detail of a contact (impulses, totals).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const near = (a, b, tol = 1e-4, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b}`);
const PI = Math.PI;

test('volume and mass follow the shape and the density', () => {
  const physics = new Physics(null);
  const shapes = [
    [{ shape: 'sphere', radius: 0.5 }, (4 / 3) * PI * 0.125],
    [{ shape: 'box', halfExtents: [0.5, 1, 1.5] }, 6],
    [{ shape: 'capsule', halfHeight: 1, radius: 0.5 }, PI * 0.25 * 2 + (4 / 3) * PI * 0.125],
    [
      {
        shape: 'convexHull',
        points: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
      },
      8,
    ],
    [
      {
        shape: 'compound',
        parts: [
          { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
          { shape: 'box', halfExtents: [0.5, 0.5, 0.5], offset: [2, 0, 0] },
        ],
      },
      2,
    ],
  ];
  for (const [shape, volume] of shapes) {
    const [collider] = physics.addBody(null, { colliders: { ...shape, density: 3 } }).colliders;
    near(collider.volume(), volume, 1e-3, shape.shape);
    near(collider.mass(), 3 * volume, 3e-3, shape.shape);
  }
  const mesh = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] },
  }).colliders[0];
  assert.equal(mesh.volume(), 0);
  assert.equal(mesh.mass(), 0);
  assert.throws(() => mesh.setMass(1), /no volume/);
  const [box] = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }).colliders;
  box.setMass(12);
  near(box.mass(), 12, 1e-3);
  near(box.density(), 12, 1e-3);
  near(box.body.mass, 12, 1e-3);
  assert.throws(() => box.setMass(-1), /mass/);
  physics.dispose();
});

test('combine rules, border radius and the world pose of a collider read and set', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    position: [1, 2, 3],
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], offset: [2, 0, 0], friction: 0.5 },
  });
  const [collider] = body.colliders;
  assert.equal(collider.frictionCombineRule(), 'average');
  collider.setFrictionCombineRule('max').setRestitutionCombineRule('min');
  assert.equal(collider.frictionCombineRule(), 'max');
  assert.equal(collider.restitutionCombineRule(), 'min');
  assert.throws(() => collider.setFrictionCombineRule('nonsense'), /combine rule/);
  // A quarter turn about y takes the body's x to its -z: the offset (2, 0, 0) lands at (1, 2, 3 - 2).
  const p = collider.translation();
  near(p.x, 1);
  near(p.y, 2);
  near(p.z, 1);
  near(collider.rotation().y, Math.SQRT1_2);
  assert.equal(collider.borderRadius(), 0);
  collider.setBorderRadius(0.2);
  near(collider.borderRadius(), 0.2, 1e-6);
  const [ball] = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } }).colliders;
  assert.throws(() => ball.setBorderRadius(0.1), /no border radius/);
  assert.throws(() => collider.setBorderRadius(-1), /border radius/);
  const [can] = physics.addBody(null, { colliders: { shape: 'cylinder', halfHeight: 1, radius: 0.5 } }).colliders;
  can.setBorderRadius(0.1);
  near(can.borderRadius(), 0.1, 1e-6);
  physics.dispose();
});

test('the vertices, triangles and heights of a collider read back', () => {
  const physics = new Physics(null);
  const cube = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const [hull] = physics.addBody(null, { colliders: { shape: 'convexHull', points: cube } }).colliders;
  const corners = new Set();
  for (let i = 0; i < hull.vertices().length; i += 3) corners.add([...hull.vertices().slice(i, i + 3)].join());
  assert.equal(corners.size, 8);
  const vertices = [0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 2];
  const indices = [0, 1, 2, 2, 1, 3];
  const [mesh] = physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices, indices } }).colliders;
  assert.deepEqual([...mesh.vertices()], vertices);
  assert.deepEqual([...mesh.indices()], indices);
  const heights = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const [field] = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'heightfield', rows: 2, columns: 2, heights, scale: [10, 2, 6] },
  }).colliders;
  assert.equal(field.heightfieldNRows(), 2);
  assert.equal(field.heightfieldNCols(), 2);
  assert.deepEqual(
    [...field.heightfieldHeights()],
    heights.map((h) => h * 2),
  );
  const scale = field.heightfieldScale();
  near(scale[0], 10, 1e-4);
  near(scale[2], 6, 1e-4);
  assert.throws(() => mesh.heightfieldNRows(), /no height field/);
  assert.equal(hull.indices(), undefined);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } }).colliders[0].vertices(),
    /no vertices/,
  );
  assert.equal(physics.getColliders().length, 4);
  physics.dispose();
});

test('contact pairs and intersection pairs list what a collider touches, and contact detail gives impulses', () => {
  const physics = new Physics(null);
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10], friction: 0.8 },
  }).colliders[0];
  const crate = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 100, friction: 0.4 },
  });
  const trigger = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], sensor: true },
  }).colliders[0];
  for (let i = 0; i < 120; i++) physics.step();
  const [piece] = crate.colliders;
  assert.deepEqual(physics.contactPairsWith(piece), [floor]);
  assert.deepEqual(physics.contactPairsWith(floor), [piece]);
  assert.deepEqual(physics.intersectionPairsWith(piece), [trigger]);
  assert.deepEqual(physics.intersectionPairsWith(trigger), [piece]);
  assert.deepEqual(physics.contactPairsWith(trigger), []);
  const [manifold] = physics.contactPair(floor, piece);
  assert.equal(manifold.points.length, 4);
  near(manifold.friction, 0.6, 1e-4, 'average of 0.8 and 0.4');
  // The four points hold the box's weight between them: 100 kg of a cubic metre at 9.81 m/s^2 over a substep of 1/480 s.
  let held = 0;
  for (const p of manifold.points) held += p.normalImpulse;
  near(held, (100 * 9.81 * (1 / 60)) / 8, (0.05 * 100 * 9.81) / 480, 'weight over a substep');
  assert.deepEqual(physics.contactPair(piece, floor)[0].points.length, 4);
  assert.throws(() => physics.contactPairsWith({ handle: 99, valid: false }), /removed/);
  physics.dispose();
});

test('a contact force event carries the total and the strongest contact force', () => {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  physics.addBody(null, { position: [0, 0.5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 10 } });
  let last = null;
  physics.on('contactforce', (event) => {
    last = event;
  });
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(last, 'an event after the settling');
  // At rest a 10 kg box presses with its weight, 98.1 N, straight along the normal, shared by four corners.
  near(Math.abs(last.totalForce[1]), 98.1, 2, 'total force');
  near(Math.hypot(...last.totalForce), 98.1, 2, 'total magnitude');
  assert.ok(last.maxForceMagnitude > 98.1 / 4 - 3 && last.maxForceMagnitude < 98.1, `${last.maxForceMagnitude}`);
  near(Math.abs(last.maxForceDirection[1]), 1, 0.05);
  physics.dispose();
});

test('a collider as a shape: contacts with a shape, and a cast of one collider onto another', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, {
    type: 'fixed',
    position: [5, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 2, 2] },
  }).colliders[0];
  const ball = physics.addBody(null, { position: [0, 0, 0], colliders: { shape: 'sphere', radius: 0.5 } }).colliders[0];
  const compound = physics.addBody(null, {
    type: 'fixed',
    position: [0, 10, 0],
    colliders: {
      shape: 'compound',
      parts: [
        { shape: 'sphere', radius: 0.5, offset: [-2, 0, 0] },
        { shape: 'sphere', radius: 0.5, offset: [2, 0, 0] },
      ],
    },
  }).colliders[0];
  physics.step();
  assert.deepEqual(physics.contactShape(wall, { shape: 'sphere', radius: 0.5 }, [3.5, 0, 0]), []);
  // A ball at 3.9 spans to 4.4, 0.1 short of the face at 4.5: inside a prediction of 0.2, not of 0.05.
  const [close] = physics.contactShape(wall, { shape: 'sphere', radius: 0.5 }, [3.9, 0, 0], [0, 0, 0, 1], 0.2);
  near(close.normal[0], -1, 1e-4, 'from the wall to the ball');
  near(close.points[0].separation, 0.1, 1e-4);
  assert.deepEqual(physics.contactShape(wall, { shape: 'sphere', radius: 0.5 }, [3.9, 0, 0], [0, 0, 0, 1], 0.05), []);
  const [deep] = physics.contactShape(wall, { shape: 'sphere', radius: 0.5 }, [4.2, 0, 0]);
  near(deep.points[0].separation, -0.2, 2e-3);
  assert.equal(
    physics.contactShape(compound, { shape: 'box', halfExtents: [0.4, 0.4, 0.4] }, [2.3, 10, 0]).length,
    1,
    'one child meets it',
  );
  assert.throws(
    () => physics.contactShape(wall, { shape: 'sphere', radius: 0.5 }, [0, 0, 0], [0, 0, 0, 1], -1),
    /prediction|pair query/,
  );
  // The ball, as it is, cast toward the wall: its surface stops at 4.0 from the face at 4.5.
  const hit = physics.castColliderOnto(ball, wall, [1, 0, 0]);
  near(hit.distance, 4, 1e-3);
  assert.equal(hit.collider, wall);
  assert.equal(physics.castColliderOnto(ball, wall, [-1, 0, 0]), null);
  const nearest = physics.castCollider(ball, [1, 0, 0]);
  near(nearest.distance, 4, 1e-3);
  assert.equal(physics.castCollider(ball, [0, 0, -1]), null);
  physics.dispose();
});

test('ray hits and projections name the feature they land on', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  physics.addBody(null, {
    type: 'fixed',
    position: [10, 0, 0],
    colliders: {
      shape: 'convexHull',
      points: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    },
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [20, 0, 0],
    colliders: { shape: 'trimesh', vertices: [0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 2], indices: [0, 1, 2, 2, 1, 3] },
  });
  physics.addBody(null, { type: 'fixed', position: [0, 10, 0], colliders: { shape: 'sphere', radius: 1 } });
  physics.step();
  // A box: the +x face is 0, the -x face 1, +y 2 and so on; a point on an edge or corner says so.
  const faces = [
    [[5, 0.2, 0.3], [-1, 0, 0], 'face', 0],
    [[-5, 0.2, 0.3], [1, 0, 0], 'face', 1],
    [[0.2, 5, 0.3], [0, -1, 0], 'face', 2],
    [[0.2, 0.3, -5], [0, 0, 1], 'face', 5],
  ];
  for (const [origin, direction, type, id] of faces) {
    const hit = physics.raycast(origin, direction, { maxDistance: 20 });
    assert.deepEqual([hit.featureType, hit.featureId], [type, id], `${origin}`);
  }
  const edge = physics.raycast([5, 5, 0.3], [-1, -1, 0], { maxDistance: 20 });
  assert.equal(edge.featureType, 'edge');
  assert.equal(edge.featureId, 4 * 2 + 1 + 2 * 1, 'the edge along z at +x, +y');
  const corner = physics.raycast([5, 5, 5], [-1, -1, -1], { maxDistance: 20 });
  assert.deepEqual([corner.featureType, corner.featureId], ['vertex', 7]);
  // A hull and a mesh give a row and a triangle.
  const hull = physics.raycast([15, 0.2, 0.3], [-1, 0, 0], {
    maxDistance: 20,
    predicate: (body) => body.position[0] === 10,
  });
  assert.equal(hull.featureType, 'face');
  assert.ok(Number.isInteger(hull.featureId));
  const mesh = physics.raycast([20.5, 5, 0.3], [0, -1, 0]);
  assert.deepEqual([mesh.featureType, mesh.featureId], ['face', 0]);
  const mesh2 = physics.raycast([21.5, 5, 1.7], [0, -1, 0]);
  assert.deepEqual([mesh2.featureType, mesh2.featureId], ['face', 1]);
  // A ball names no feature; a projection reads the same way.
  assert.deepEqual(
    [physics.raycast([0, 15, 0], [0, -1, 0]).featureType, physics.raycast([0, 15, 0], [0, -1, 0]).featureId],
    ['unknown', undefined],
  );
  const projection = physics.projectPoint([3, 0.2, 0.3], { solid: false });
  assert.deepEqual([projection.featureType, projection.featureId], ['face', 0]);
  physics.dispose();
});

test('hooks are asked per collider and per kind of pair, and the filter for sensors is its own', () => {
  const asked = [];
  const physics = new Physics(null, {
    contactFilter: (a, b) => {
      asked.push(['contact', a.userData ?? '', b.userData ?? '']);
      return true;
    },
    intersectionFilter: (a, b) => {
      asked.push(['sensor', a.userData ?? '', b.userData ?? '']);
      return a.userData !== 'ghost' && b.userData !== 'ghost';
    },
    gravity: [0, 0, 0],
  });
  const quiet = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'box', halfExtents: [1, 1, 1], activeHooks: { filterContactPairs: false } },
  });
  const watched = physics.addBody(null, {
    position: [0, 0, 0.5],
    colliders: { shape: 'sphere', radius: 0.5, activeHooks: { filterContactPairs: false } },
  });
  const trigger = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [3, 3, 3], sensor: true },
  });
  const other = physics.addBody(null, { position: [0, 0, -0.2], colliders: { shape: 'sphere', radius: 0.2 } });
  quiet.userData = 'quiet';
  watched.userData = 'watched';
  trigger.userData = 'trigger';
  other.userData = 'ghost';
  let entered = 0;
  physics.on('intersectionstart', () => entered++);
  physics.step();
  assert.ok(
    asked.some(([kind]) => kind === 'sensor'),
    'the sensor filter was asked',
  );
  // Both sides of this pair turned the solid filter off, so it is not asked; the ghost, which has it on, is asked about.
  assert.ok(
    !asked.some(([kind, a, b]) => kind === 'contact' && [a, b].includes('quiet') && [a, b].includes('watched')),
    'not asked',
  );
  assert.ok(
    asked.some(([kind, a, b]) => kind === 'contact' && [a, b].includes('ghost')),
    'asked about a collider that left it on',
  );
  assert.equal(entered, 1, 'the ghost is kept out of the sensor by the intersection filter');
  assert.deepEqual(quiet.colliders[0].activeHooks(), {
    filterContactPairs: false,
    filterIntersectionPairs: true,
    modifyContacts: false,
  });
  quiet.colliders[0].setActiveHooks({ modifyContacts: true });
  assert.equal(quiet.colliders[0].activeHooks().modifyContacts, true);
  physics.dispose();
});

test('a collider with mass properties of its own gives the body that mass, centre and inertia', async () => {
  const { RapierPhysics } = await import('./oracle.js');
  await RapierPhysics.load();
  const worlds = [new Physics(null, { gravity: [0, 0, 0] }), new RapierPhysics(null, { gravity: [0, 0, 0] })];
  const bodies = worlds.map((physics) =>
    physics.addBody(null, {
      colliders: {
        shape: 'box',
        halfExtents: [0.5, 0.5, 0.5],
        massProperties: { mass: 5, centerOfMass: [0.3, 0, 0], principalInertia: [1, 2, 3] },
      },
    }),
  );
  for (const body of bodies) near(body.mass, 5, 1e-4, 'mass');
  // A torque about z for a step spins it by torque dt / 3; the centre of mass is where it turns about.
  for (const [i, physics] of worlds.entries()) {
    bodies[i].addTorque([0, 0, 6]);
    physics.step();
  }
  const spins = bodies.map((body) => body.angularVelocity[2]);
  near(spins[0], 6 / 60 / 3, 2e-3, 'spin');
  near(spins[0], spins[1], 2e-3, 'against Rapier');
  const [own] = bodies[0].colliders;
  own.clearMassProperties();
  near(bodies[0].mass, 1, 1e-4, 'back to density 1 of a unit box');
  own.setMassProperties(2, [0, 0, 0], [0.5, 0.5, 0.5]);
  near(bodies[0].mass, 2, 1e-4);
  assert.throws(() => own.setMassProperties(-1, [0, 0, 0], [1, 1, 1]), /mass properties/);
  assert.throws(() => own.setMassProperties(1, [0, 0, 0], [-1, 1, 1]), /mass properties/);
  for (const physics of worlds) physics.dispose();
});

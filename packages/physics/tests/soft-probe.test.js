// Particle probes for soft bodies (`KernelWorld.probeParticles`): a particle of radius r moving over a step meets every kind of
// collider where the shape is: resting a little inside the radius it gets the nearest surface point, the outward normal and the
// depth; a fast one is swept, so it stops at the first surface instead of passing it; groups and filters are honoured.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, collisionGroups } from '../dist/index.js';

await Physics.load();
const R = 0.1;
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

const world = (colliders, extra = {}) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = physics.addBody(null, { type: 'fixed', colliders, ...extra });
  physics.step();
  return { physics, body, kernel: physics.kernel };
};
const probe = (kernel, from, to, radius = R, options) => kernel.probeParticles(from, to, radius, options)[0];

// One particle for each shape, resting 0.1 R inside its radius above (or beside) the top surface it meets: the surface point,
// the normal out of the shape and a depth of 0.1 R.
const shapes = [
  ['ball', { shape: 'sphere', radius: 1 }, [0, 1 + 0.9 * R, 0], [0, 1, 0]],
  ['box', { shape: 'box', halfExtents: [1, 1, 1] }, [0.3, 1 + 0.9 * R, 0.2], [0, 1, 0]],
  ['capsule', { shape: 'capsule', halfHeight: 1, radius: 0.5 }, [0, 1.5 + 0.9 * R, 0], [0, 1, 0]],
  ['cylinder', { shape: 'cylinder', halfHeight: 1, radius: 1 }, [0.2, 1 + 0.9 * R, 0.1], [0, 1, 0]],
  ['cone', { shape: 'cone', halfHeight: 1, radius: 1 }, [0.3, -1 - 0.9 * R, 0.1], [0, -1, 0]],
  [
    'convex hull',
    {
      shape: 'convexHull',
      points: [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1],
    },
    [0.2, 1 + 0.9 * R, -0.3],
    [0, 1, 0],
  ],
  [
    'triangle mesh',
    { shape: 'trimesh', vertices: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 2, 1, 0, 3, 2] },
    [0.4, 0.9 * R, 0.4],
    [0, 1, 0],
    0,
  ],
  [
    'compound',
    {
      shape: 'compound',
      parts: [
        { shape: 'box', halfExtents: [1, 1, 1], offset: [0, 0, 0] },
        { shape: 'sphere', radius: 0.5, offset: [3, 0, 0] },
      ],
    },
    [3, 0.5 + 0.9 * R, 0],
    [0, 1, 0],
    0.5,
  ],
  ['half space', { shape: 'halfSpace', normal: [0, 1, 0] }, [1, 0.9 * R, 2], [0, 1, 0], 0],
  [
    'height field',
    { shape: 'heightfield', rows: 2, columns: 2, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0], scale: [10, 1, 10] },
    [1, 0.9 * R, 1],
    [0, 1, 0],
    0,
  ],
  [
    'voxels',
    { shape: 'voxels', cells: Int32Array.from([0, 0, 0, 1, 0, 0]), size: [1, 1, 1] },
    [0.5, 1 + 0.9 * R, 0.5],
    [0, 1, 0],
    1,
  ],
];
for (const [name, collider, at, up] of shapes)
  test(`a particle resting inside its radius of a ${name} gets the surface point, the outward normal and the depth`, () => {
    const { physics, kernel } = world(collider);
    // It rests: it ends where it began, so there is nothing to sweep and the depth is read from the nearest point.
    const contact = probe(kernel, at, at);
    assert.ok(contact, `${name}: a contact`);
    near(contact.depth, 0.1 * R, 0.01 * R + 2e-3, `${name}: depth`);
    near(contact.normal[0] * up[0] + contact.normal[1] * up[1] + contact.normal[2] * up[2], 1, 0.02, `${name}: normal`);
    // The point is on the surface: the particle's centre is a radius less its depth from it, along the normal.
    const gap = [0, 1, 2].reduce((sum, k) => sum + (at[k] - contact.point[k]) * contact.normal[k], 0);
    near(gap, R - contact.depth, 2e-3, `${name}: the point on the surface`);
    // A particle a radius and a half away touches nothing.
    const away = at.map((v, k) => v + up[k] * 0.15);
    assert.equal(probe(kernel, away, away), null, `${name}: clear`);
    physics.dispose();
  });

test('a particle moving fast through a thin box is stopped at its first face, not carried through it', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [5, 0.01, 5] });
  // 20 m in one step, from far above to far below the 2 cm slab.
  const contact = probe(kernel, [1, 10, 1], [1, -10, 1]);
  assert.ok(contact, 'a contact');
  near(contact.t, (10 - (0.01 + R)) / 20, 1e-3, 'the touch is where the ball meets the top face');
  assert.deepEqual(
    contact.normal.map((v) => Math.round(v) + 0),
    [0, 1, 0],
  );
  assert.ok(contact.depth > 9, `the end of the move is deep inside: ${contact.depth}`);
  assert.equal(contact.started, false);
  physics.dispose();
});

test('a particle moving fast through a one-triangle-thick mesh, a compound and a height field is stopped by each', () => {
  for (const collider of [
    { shape: 'trimesh', vertices: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 2, 1, 0, 3, 2] },
    { shape: 'compound', parts: [{ shape: 'box', halfExtents: [5, 0.005, 5], offset: [0, 0, 0] }] },
    { shape: 'heightfield', rows: 2, columns: 2, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0], scale: [10, 1, 10] },
  ]) {
    const { physics, kernel } = world(collider);
    const contact = probe(kernel, [0.5, 50, 0.5], [0.5, -50, 0.5]);
    assert.ok(contact, `${collider.shape}: stopped`);
    near(contact.t, (50 - R) / 100, 2e-3, `${collider.shape}: at the surface`);
    near(contact.normal[1], 1, 0.01, `${collider.shape}: normal`);
    physics.dispose();
  }
});

test('a particle that starts in contact says so, and one inside a solid is pushed out through the nearest face', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [1, 1, 1] });
  const started = probe(kernel, [0.2, 1 + 0.5 * R, 0], [0.2, 1 + 0.9 * R, 0]);
  assert.ok(started?.started, 'it started touching');
  const inside = probe(kernel, [0.1, 0.7, 0.2], [0.1, 0.5, 0.2]);
  assert.ok(inside, 'inside a solid');
  assert.deepEqual(
    inside.normal.map((v) => Math.round(v) + 0),
    [0, 1, 0],
    'out through the top face',
  );
  near(inside.depth, R + 0.5, 1e-3, 'depth: the way out plus the radius');
  physics.dispose();
});

test('groups and filters are honoured: a query with groups sees only what meets them, flags leave kinds out, a body is skipped', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const a = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], collisionGroups: collisionGroups([1], [1]) },
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [10, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], collisionGroups: collisionGroups([2], [2]) },
  });
  physics.step();
  const kernel = physics.kernel,
    near1 = [0, 1.05, 0],
    near2 = [10, 1.05, 0];
  assert.ok(probe(kernel, near1, near1) && probe(kernel, near2, near2), 'no groups, no test: both seen');
  const g1 = { groups: collisionGroups([1], [1]) };
  assert.ok(probe(kernel, near1, near1, R, g1), 'a particle of group 1 meets the group 1 box');
  assert.equal(probe(kernel, near2, near2, R, g1), null, 'and not the group 2 one');
  assert.equal(probe(kernel, near1, near1, R, { excludeBody: a.row }), null, 'a body can be left out');
  assert.equal(probe(kernel, near1, near1, R, { flags: 1 }), null, 'excludeFixed leaves fixed colliders out');
  physics.dispose();
});

test('a batch is answered one for one, in chunks past the capacity, and bad input is refused', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [100, 1, 100] });
  const count = kernel.probeCapacity + 10,
    from = new Float32Array(3 * count),
    to = new Float32Array(3 * count);
  for (let i = 0; i < count; i++) {
    from.set([i % 50, i % 2 ? 1.05 : 3, i % 7], 3 * i);
    to.set([i % 50, i % 2 ? 1.05 : 3, i % 7], 3 * i);
  }
  const answers = kernel.probeParticles(from, to, R);
  assert.equal(answers.length, count);
  answers.forEach((a, i) => assert.equal(a !== null, i % 2 === 1, `particle ${i}`));
  assert.throws(() => kernel.probeParticles([0, 0, 0], [0, 0], R), /same number/);
  assert.throws(() => kernel.probeParticles([0, 0, 0], [0, 0, 0], [1, 2]), /radii/);
  assert.throws(() => kernel.probeParticles([0, Number.NaN, 0], [0, 0, 0], R), /finite/);
  physics.dispose();
});

test('softContacts lists up to k colliders a particle, deepest first, with the plane, the depth, the surface velocity and the time', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  const wall = physics.addBody(null, {
    type: 'fixed',
    position: [1.55, 1, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 1, 5] },
  });
  physics.step();
  // In the corner: 0.03 into the floor's reach and 0.06 into the wall's, a radius of 0.1.
  const at = [1.0 - 0.0, 0.07, 0];
  const c = physics.softContacts({ from: at, to: at, radius: 0.1 }, 4);
  assert.equal(c.k, 4);
  assert.notEqual(c.collider[0], 0xffffffff);
  assert.notEqual(c.collider[1], 0xffffffff);
  assert.equal(c.collider[2], 0xffffffff, 'only two colliders are near');
  assert.ok(c.depth[0] >= c.depth[1], 'deepest first');
  const depths = [c.depth[0], c.depth[1]].sort();
  near(depths[0], 0.03, 2e-3, 'the floor');
  near(depths[1], 0.1 - (1.05 - 1.0), 2e-3, 'the wall: its near face is at x = 1.05');
  const floor = [0, 1].find((s) => Math.abs(c.normal[3 * s + 1] - 1) < 1e-3);
  assert.ok(floor !== undefined, 'one normal points up');
  assert.equal(
    physics.colliderOf(c.collider[0]).body.row === wall.row || physics.colliderOf(c.collider[1]).body.row === wall.row,
    true,
  );
  physics.dispose();
});

test('a collider within the margin is listed with a negative depth, and none beyond it', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [1, 1, 1] });
  const at = [0, 1.3, 0];
  assert.equal(kernel.softContacts({ from: at, to: at, radius: 0.1 }, 1).collider[0], 0xffffffff);
  const near1 = kernel.softContacts({ from: at, to: at, radius: 0.1, margin: 0.25 }, 1);
  assert.notEqual(near1.collider[0], 0xffffffff);
  near(near1.depth[0], 0.1 - 0.3, 1e-4, 'a gap of 0.2 still open');
  assert.equal(kernel.softContacts({ from: at, to: at, radius: 0.1, margin: 0.15 }, 1).collider[0], 0xffffffff);
  physics.dispose();
});

test('the surface velocity at the contact is the body’s velocity and spin about its centre', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const spinner = physics.addBody(null, {
    type: 'kinematicVelocity',
    position: [0, 0, 0],
    linearVelocity: [1, 0, 0],
    angularVelocity: [0, 0, 2],
    colliders: { shape: 'box', halfExtents: [1, 1, 1] },
  });
  physics.step();
  const at = [1.05, 0, 0.3];
  const c = physics.softContacts({ from: at, to: at, radius: 0.1 }, 1);
  assert.notEqual(c.collider[0], 0xffffffff);
  // The point on the face is (1, 0, 0.3): v = lin + w x r = (1, 0, 0) + (0, 0, 2) x (1, 0, 0.3) = (1, 2, 0).
  const p = [c.point[0], c.point[1], c.point[2]];
  // About the body's centre, which has moved with it: w x r = (-2 ry, 2 rx, 0).
  const r = [p[0] - spinner.position[0], p[1] - spinner.position[1]];
  near(c.velocity[0], 1 - 2 * r[1], 2e-3, 'vx');
  near(c.velocity[1], 2 * r[0], 2e-3, 'vy');
  near(c.velocity[2], 0, 1e-4, 'vz');
  physics.dispose();
});

test('sensors are never met, a disabled collider neither, and per-particle groups choose what each meets', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], sensor: true },
  });
  const red = physics.addBody(null, {
    type: 'fixed',
    position: [10, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], collisionGroups: collisionGroups([1], [1]) },
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [20, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], collisionGroups: collisionGroups([2], [2]) },
  });
  physics.step();
  const kernel = physics.kernel,
    from = [0, 1.05, 0, 10, 1.05, 0, 20, 1.05, 0, 10, 1.05, 0],
    groups = Uint32Array.of(
      0xffffffff,
      collisionGroups([1], [1]),
      collisionGroups([1], [1]),
      collisionGroups([2], [2]),
    );
  const c = kernel.softContacts({ from, to: from, radius: 0.1, groups }, 1);
  assert.equal(c.collider[0], 0xffffffff, 'a sensor is passed through');
  assert.notEqual(c.collider[1], 0xffffffff, 'a group 1 particle meets the group 1 box');
  assert.equal(c.collider[2], 0xffffffff, 'and not the group 2 box');
  assert.equal(c.collider[3], 0xffffffff, 'a group 2 particle does not meet the group 1 box');
  void red;
  assert.throws(() => kernel.softContacts({ from, to: from, radius: 0.1 }, 9), /1 to 4/);
  physics.dispose();
});

test('a deformable mesh gives the velocity of its surface, by the triangle the contact is on', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const sheet = physics.addBody(null, {
    type: 'fixed',
    colliders: {
      shape: 'trimesh',
      vertices: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5],
      indices: [0, 2, 1, 0, 3, 2],
      deformable: true,
    },
  });
  physics.step();
  // The sheet rises 0.06 m over a step of 1/60 s: 3.6 m/s.
  sheet.colliders[0].setVertices([-5, 0.06, -5, 5, 0.06, -5, 5, 0.06, 5, -5, 0.06, 5]);
  const at = [1, 0.05, 1];
  const c = physics.softContacts({ from: at, to: at, radius: 0.1 }, 1);
  assert.notEqual(c.collider[0], 0xffffffff);
  assert.notEqual(c.triangle[0], 0xffffffff);
  near(c.velocity[1], 3.6, 1e-2, 'the sheet rises at 3.6 m/s');
  physics.dispose();
});

// KB-PHYS-PROBE-THIN1: a start that touches, or lies inside the radius, has a defined answer, and a thin solid is met on the side
// the move came from, whatever the speed and wherever it starts.
test('a particle that starts exactly touching a thin wall, or inside its radius, meets the near face, whatever its speed', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [0.01, 2, 2] }, { position: [3, 0, 0] });
  // The soft body session's two cases.
  const touching = probe(kernel, [2.97, 1, 0], [3.065, 1, 0], 0.02, { flags: 8 });
  assert.ok(touching, 'exactly touching, moving in: a contact');
  assert.deepEqual(
    touching.normal.map((v) => Math.round(v) + 0),
    [-1, 0, 0],
  );
  near(touching.point[0], 2.99, 1e-5, 'the near face');
  assert.equal(touching.t, 0);
  const inside = probe(kernel, [2.9701, 1, 0], [3, 1, 0], 0.02);
  assert.ok(inside?.started);
  near(inside.point[0], 2.99, 1e-5, 'the near face, not the far one');
  assert.deepEqual(
    inside.normal.map((v) => Math.round(v) + 0),
    [-1, 0, 0],
  );
  near(inside.depth, 0.02 + 0.01, 1e-4, 'pushed back by the way in plus the radius');
  // A sweep over speeds and start offsets, from both sides: the face is always the one the move came from, and every fast
  // particle that would end past the wall is stopped.
  for (const side of [-1, 1]) {
    for (const speed of [0.01, 0.5, 5, 60, 600]) {
      for (const gap of [0.02 - 1e-6, 0.02, 0.02 + 1e-6, 0.021, 0.05, 0.3]) {
        const from = [3 - side * (0.01 + gap), 1, 0];
        const to = [from[0] + (side * speed) / 60, 1, 0];
        const contact = probe(kernel, from, to, 0.02);
        const reaches = Math.abs(to[0] - 3) < 0.01 + 0.02 || (to[0] - 3) * side > 0;
        const label = `side ${side}, speed ${speed}, gap ${gap}`;
        if (!reaches) {
          assert.equal(contact, null, label);
          continue;
        }
        assert.ok(contact, label);
        // The wall's face on the side the particle is on: its x is 3 - side * 0.01, and the normal points back at the particle.
        near(contact.point[0], 3 - side * 0.01, 1e-4, `${label}: the near face`);
        assert.equal(Math.round(contact.normal[0]) + 0, -side, `${label}: the normal`);
      }
    }
  }
  physics.dispose();
});

test('softContacts with several slots gives a thin wall the same side, from both sides', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [0.01, 2, 2] }, { position: [3, 0, 0] });
  const c = kernel.softContacts({ from: [2.9701, 1, 0, 3.0299, 1, 0], to: [3, 1, 0, 3, 1, 0], radius: 0.02 }, 3);
  assert.equal(c.normal[0], -1);
  assert.equal(c.normal[3 * 3], 1, 'the second particle came from the far side');
  near(c.point[3 * 3], 3.01, 1e-5, 'and meets the far face');
  physics.dispose();
});

// A collider that moves is met along its own motion over the step (the relative sweep, conservative advancement in the
// collider's frame: Mirtich 1996), so a fast bat or a spinning paddle cannot pass particles.
test('a fast thin box sweeping up through a column of resting particles hits every one', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const bat = physics.addBody(null, {
    type: 'kinematicVelocity',
    position: [0, -0.5, 0],
    linearVelocity: [0, 150, 0],
    colliders: { shape: 'box', halfExtents: [2, 0.01, 2] },
  });
  physics.step();
  // The step moved it; put it back to its start pose so the probe is asked at the start of a step.
  bat.setPosition([0, -0.5, 0]);
  bat.setLinearVelocity([0, 150, 0]);
  const count = 20,
    radius = 0.01,
    dt = 1 / 60,
    from = [];
  for (let i = 0; i < count; i++) from.push(0, 0.04 * (i + 1), 0);
  const swept = physics.softContacts({ from, to: from, radius }, 1, { dt });
  const still = physics.softContacts({ from, to: from, radius }, 1);
  const top = -0.49,
    travel = 150 * dt;
  for (let i = 0; i < count; i++) {
    const y = 0.04 * (i + 1);
    assert.notEqual(swept.collider[i], 0xffffffff, `particle ${i} is hit`);
    assert.equal(still.collider[i], 0xffffffff, `and a static query misses it, as before`);
    near(swept.t[i], (y - radius - top) / travel, 5e-3, `particle ${i}: the time the top face reaches it`);
    near(swept.normal[3 * i + 1], 1, 1e-3, `particle ${i}: pushed up`);
    near(swept.velocity[3 * i + 1], 150, 1e-2, `particle ${i}: the plane goes on up at 150 m/s`);
    // The plane at the end of the step has passed the particle: pushed out along the normal by the way it went, to ride on top.
    near(swept.depth[i], radius - (y - travel - top), 1e-3, `particle ${i}: depth`);
  }
  physics.dispose();
});

test('a spinning paddle catches the particles in its sweep and not those outside it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const paddle = physics.addBody(null, {
    type: 'kinematicVelocity',
    position: [0, 0, 0],
    angularVelocity: [0, 30, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.1, 0.01] },
  });
  physics.step();
  paddle.setRotation([0, 0, 0, 1]);
  paddle.setAngularVelocity([0, 30, 0]);
  const dt = 1 / 60,
    sweep = 30 * dt,
    radius = 0.01,
    from = [],
    angles = [0.05, 0.1, 0.2, 0.3, 0.4, 0.45, 0.6, 0.8];
  // A positive spin about y turns +x towards -z, so the paddle sweeps the particles placed at -z.
  for (const a of angles) from.push(0.6 * Math.cos(a), 0, -0.6 * Math.sin(a));
  const swept = physics.softContacts({ from, to: from, radius }, 1, { dt });
  const still = physics.softContacts({ from, to: from, radius }, 1);
  let last = -1;
  angles.forEach((a, i) => {
    if (a < sweep - 0.02) {
      assert.notEqual(swept.collider[i], 0xffffffff, `angle ${a}: caught`);
      // The face reaches a particle when the paddle has turned by a minus (radius + half thickness) / 0.6.
      near(swept.t[i], (a - 0.02 / 0.6) / sweep, 0.03, `angle ${a}: time`);
      assert.ok(swept.t[i] > last, 'later for a particle further round');
      last = swept.t[i];
      // The face the particle is on: its normal is the paddle's -z face, and the surface moves along -z about x = 0.6 at 18 m/s.
      near(swept.normal[3 * i + 2], -1, 0.05, `angle ${a}: normal`);
      near(swept.velocity[3 * i + 2], -30 * 0.6, 0.5, `angle ${a}: the surface speed there`);
    } else if (a > sweep + 0.05) {
      assert.equal(swept.collider[i], 0xffffffff, `angle ${a}: outside the sweep`);
    }
    assert.equal(still.collider[i], 0xffffffff, `angle ${a}: a static query meets nothing`);
  });
  physics.dispose();
});

test('a collider that does not move is met where it is whatever dt says, and dt must be a length of time', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [1, 1, 1] });
  const at = [0, 1.05, 0];
  assert.equal(kernel.softContacts({ from: at, to: at, radius: 0.1 }, 1, { dt: 1 / 60 }).collider[0], 0);
  assert.throws(() => kernel.softContacts({ from: at, to: at, radius: 0.1 }, 1, { dt: -1 }), /step length/);
  physics.dispose();
});

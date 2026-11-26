import assert from 'node:assert/strict';
import test from 'node:test';
import { GirderJointSolver } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { ATMOSPHERE, HULL_BREACHES_FIELD, HULL_BREACH_WORDS, HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const zero = [0, 0, 0];
const step = 1 / 60;
const masses = [4, 6];
const half = 0.25;
const inertia = masses.map((mass) => (mass * 2 * half ** 2) / 3);
const area = 0.01;
const depth = 0.1;
const modulus = 2000;
const stiffness = 2 * area * depth ** 2 * modulus;
const gaugeLength = 0.6;
const anchorStiffness = 900;
const failureStrain = 0.045;
const curve = [
  { strain: -0.2, stress: -0.2 * modulus },
  { strain: 0, stress: 0 },
  { strain: 0.2, stress: 0.2 * modulus },
];
const fibers = [-depth, depth].map((offset) => ({ offset, area, curve }));
const near = (value, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(value - expected) <= tolerance, `${value} differs from ${expected} by more than ${tolerance}`);

async function assemble({ separated = false, ...overrides } = {}) {
  await Physics.load({ threads: false });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: zero, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: step });
  const parts = masses.map((mass, index) =>
    physics.addBody(null, {
      position: [separated ? (2 * index - 1) * half : 0, 0, 0],
      colliders: { shape: 'box', halfExtents: [half, half, half], mass, sensor: true },
    }),
  );
  const [a, b] = parts;
  const capacity = physics.kernel.capacity;
  const seam = new GirderJointSolver();
  world.add(new RigidSolver(), { physics, capacity });
  world.add(seam, {
    bodyCapacity: capacity,
    joints: [
      {
        first: { body: a.row, anchor: separated ? [half, 0, 0] : zero },
        second: { body: b.row, anchor: separated ? [-half, 0, 0] : zero },
        axis: [0, 0, 1],
        gaugeLength,
        anchorStiffness,
        failureStrain,
        fibers,
        ...overrides,
      },
    ],
  });
  world.couple(['rigid', seam.id], 'staggered');
  return { physics, world, seam, a, b };
}

test('the live section follows the closed elastic moment and transfers a co-rotating reciprocal couple', async () => {
  const angle = 0.14;
  const sin = Math.sin(angle / 2);
  const cos = Math.cos(angle / 2);
  // Closed moment and tangent from the energy of two purely elastic strips.
  const curvature = (2 * sin) / gaugeLength;
  const tangent = (stiffness * Math.cos(angle)) / gaugeLength;
  const moment = (stiffness * curvature * cos) / (1 + step ** 2 * tangent * (1 / inertia[0] + 1 / inertia[1]));
  const rootHalf = Math.SQRT1_2;
  for (const rotated of [false, true]) {
    const { physics, world, seam, a, b } = await assemble();
    try {
      if (rotated) a.setRotation([rootHalf, 0, 0, rootHalf]);
      b.setRotation(rotated ? [rootHalf * cos, -rootHalf * sin, rootHalf * sin, rootHalf * cos] : [0, 0, sin, cos]);
      world.advance(1);
      const state = seam.read(0);
      near(state.curvature, curvature);
      near(state.peakTension, depth * curvature);
      near(state.bendingMoment, moment);
      assert.equal(state.broken, false);
      world.advance(2);
      const component = rotated ? 1 : 2;
      const direction = rotated ? -1 : 1;
      near(a.angularVelocity[component], (direction * step * moment) / inertia[0]);
      near(b.angularVelocity[component], (-direction * step * moment) / inertia[1]);
      near(inertia[0] * a.angularVelocity[component] + inertia[1] * b.angularVelocity[component], 0);
      assert.deepEqual(a.linearVelocity, zero);
      assert.deepEqual(b.linearVelocity, zero);
    } finally {
      physics.dispose();
    }
  }
});

test('an eccentric section transfers three-dimensional pull through an equal and opposite world impulse', async () => {
  const { physics, world, seam, a, b } = await assemble({ separated: true });
  try {
    const lateral = 0.005;
    b.setPosition([half, lateral, 0]);
    world.advance(1);
    near(seam.read(0).separation, lateral);
    const inverseMass = 1 / masses[0] + 1 / masses[1];
    const inverseInertia = 1 / inertia[0] + 1 / inertia[1];
    const yy = 1 + step ** 2 * anchorStiffness * (inverseMass + half ** 2 * inverseInertia);
    // Both moment arms are inclined, which couples longitudinal and lateral impulses.
    const offset = lateral / 2;
    const xx = 1 + step ** 2 * anchorStiffness * (inverseMass + offset ** 2 * inverseInertia);
    const xy = -(step ** 2) * anchorStiffness * half * offset * inverseInertia;
    const expectedY = (step * anchorStiffness * lateral * xx) / (xx * yy - xy ** 2);
    const expectedX = (-xy * expectedY) / xx;
    world.advance(2);
    near(masses[0] * a.linearVelocity[1], expectedY);
    near(masses[0] * a.linearVelocity[0], expectedX);
    near(masses[1] * b.linearVelocity[1], -expectedY);
    near(masses[1] * b.linearVelocity[0], -expectedX);
    near(inertia[0] * a.angularVelocity[2], half * expectedY - offset * expectedX);
    near(inertia[1] * b.angularVelocity[2], half * expectedY - offset * expectedX);
  } finally {
    physics.dispose();
  }
});

test('a tensile strain crossing irreversibly releases the seam, even after the parts align again', async () => {
  const { physics, world, seam, a, b } = await assemble();
  try {
    world.advance(1);
    assert.equal(seam.read(0).broken, false);
    const start = world.takeSnapshot();
    const release = () => {
      const angle = 2 * Math.asin((1.05 * gaugeLength * failureStrain) / (2 * depth));
      b.setRotation([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
      world.advance(2);
      const failed = seam.read(0);
      assert.equal(failed.broken, true);
      near(failed.peakTension, 1.05 * failureStrain);
      assert.equal(failed.bendingMoment, 0);
      b.setRotation([0, 0, 0, 1]);
      b.setLinearVelocity([0.1, 0, 0]);
      world.advance(17);
      near(b.linearVelocity[0], 0.1);
      assert.deepEqual(a.linearVelocity, zero);
      assert.deepEqual(a.angularVelocity, zero);
      assert.deepEqual(b.angularVelocity, zero);
      const after = seam.read(0);
      near(after.separation, 0.025);
      assert.equal(after.curvature, failed.curvature);
      assert.equal(after.peakTension, failed.peakTension);
      assert.equal(after.broken, true);
      return after;
    };
    const first = release();
    const hash = world.hash();
    world.restoreSnapshot(start.bytes);
    assert.equal(seam.read(0).broken, false);
    assert.deepEqual(release(), first);
    assert.equal(world.hash(), hash);
  } finally {
    physics.dispose();
  }
});

test('a differential load bends and releases two freely integrated hull parts', async () => {
  const { physics, world, seam, a, b } = await assemble({ separated: true });
  try {
    const applied = 0.8;
    a.addTorque([0, 0, -applied]);
    b.addTorque([0, 0, applied]);
    let frame = 0;
    let maximumMoment = 0;
    let peakBeforeRelease = 0;
    for (; frame < 60 && !seam.read(0).broken; frame++) {
      const state = seam.read(0);
      maximumMoment = Math.max(maximumMoment, state.bendingMoment);
      peakBeforeRelease = Math.max(peakBeforeRelease, state.peakTension);
      world.advance(frame + 1);
    }
    const failed = seam.read(0);
    assert.ok(failed.broken && frame < 60, 'the applied torques must release the section within one second');
    assert.ok(maximumMoment > 0.08, 'the section must resist the load before release');
    assert.ok(peakBeforeRelease > 0.9 * failureStrain && peakBeforeRelease < failureStrain);
    assert.ok(failed.peakTension >= failureStrain);
    assert.equal(failed.bendingMoment, 0);
    const bothSpin = () => a.angularVelocity[2] - b.angularVelocity[2];
    const before = bothSpin();
    world.advance(frame + 5);
    assert.ok(bothSpin() < before, 'after release the external torques rotate independent rigid bodies');
    assert.equal(seam.read(0).bendingMoment, 0);
  } finally {
    physics.dispose();
  }
});

async function floatingPair(girderJoint = 0, connected = true) {
  await Physics.load({ threads: false });
  const gravity = [0, -9.81, 0];
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: step });
  const size = 0.2;
  const mesh = {
    vertices: Float64Array.from(
      [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
      (value) => value * size,
    ),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    ]),
  };
  const capacity = physics.kernel.capacity;
  const makeBody = (x) =>
    physics.addBody(null, {
      position: [x, 0.1, 0],
      colliders: { shape: 'box', halfExtents: [size, size, size], mass: 16, sensor: true },
    });
  const a = makeBody(-size);
  const b = makeBody(size);
  const seam = new GirderJointSolver();
  const hull = new HullSolver('hull', undefined, undefined, connected ? seam.seamField : undefined);
  const width = 0.02;
  const discharge = 0.6;
  world.add(new RigidSolver(), { physics, capacity });
  world.add(seam, {
    bodyCapacity: capacity,
    joints: [
      {
        first: { body: a.row, anchor: [size, 0, 0] },
        second: { body: b.row, anchor: [-size, 0, 0] },
        axis: [0, 0, 1],
        gaugeLength,
        anchorStiffness,
        failureStrain,
        fibers,
      },
    ],
  });
  world.add(hull, {
    hulls: [
      {
        row: a.row,
        mesh,
        compartments: [{ mesh, permeability: 1 }],
        openings: [
          {
            from: 0,
            to: 'outside',
            centre: [0, -size, 0],
            normal: [0, -1, 0],
            width,
            height: width,
            discharge,
            girderJoint: connected ? girderJoint : undefined,
            opens: connected ? undefined : Infinity,
          },
        ],
      },
      { row: b.row, mesh },
    ],
    sea: { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) },
    gravity,
    addedMass: false,
    radiation: false,
    drag: false,
    rollDamping: false,
  });
  world.couple(['rigid', seam.id, hull.id], 'staggered');
  const opening = () => {
    const port = world.fields.port(HULL_BREACHES_FIELD.name);
    const values = regionWords(world.memory, port.region);
    assert.equal(values[0], 1);
    return Array.from(values.slice(1, 1 + HULL_BREACH_WORDS));
  };
  return { physics, world, seam, a, b, opening, discharge, size, width };
}

test('an actual girder break latches a native flooding aperture and carries water into the hull', async () => {
  const { physics, world, seam, a, b, opening, discharge, size, width } = await floatingPair();
  const angle = (radians) => [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
  try {
    world.advance(1);
    const saved = world.takeSnapshot();
    const partial = () => {
      b.setRotation(angle(0.12));
      world.advance(2);
      assert.ok(seam.read(0).peakTension > 0);
      assert.equal(seam.read(0).broken, false);
      assert.equal(opening()[8], 0);
      assert.equal(opening()[9], 0);
    };
    const broken = () => {
      partial();
      b.setRotation(angle(0.36));
      world.advance(3);
      assert.equal(seam.read(0).broken, true);
      const record = opening();
      near(record[8], width ** 2);
      const head = record[14];
      const initial = discharge * width ** 2 * Math.sqrt(2 * 9.81 * head);
      const volume = initial * step;
      const backHead = volume / (2 * size) ** 2 + (ATMOSPHERE * volume) / (9810 * ((2 * size) ** 3 - volume));
      const minimum = initial * Math.sqrt((head - backHead) / head);
      const inflow = -record[9];
      assert.ok(inflow >= minimum && inflow <= initial, `expected ${minimum} to ${initial}, got ${inflow}`);
      world.advance(65);
      assert.ok(opening()[9] < 0);
      return a.position[1];
    };
    const wet = broken();
    const hash = world.hash();
    world.restoreSnapshot(saved.bytes);
    assert.equal(broken(), wet);
    assert.equal(world.hash(), hash);
    const control = await floatingPair(0, false);
    try {
      control.world.advance(1);
      control.b.setRotation(angle(0.12));
      control.world.advance(2);
      control.b.setRotation(angle(0.36));
      control.world.advance(65);
      assert.equal(control.seam.read(0).broken, true);
      assert.ok(wet < control.a.position[1], 'the retained water increases the draft after the same break');
      assert.equal(control.opening()[9], 0);
    } finally {
      control.physics.dispose();
    }
  } finally {
    physics.dispose();
  }
});

test('a hull opening must name a seam row in its connected field', async () => {
  const { physics, world } = await floatingPair(2);
  try {
    assert.throws(() => world.advance(2), { code: 'state', message: /girderJoint within the connected seam port/ });
  } finally {
    physics.dispose();
  }
});

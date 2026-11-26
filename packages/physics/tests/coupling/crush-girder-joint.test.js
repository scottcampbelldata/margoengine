import assert from 'node:assert/strict';
import test from 'node:test';
import { GirderJointSolver } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

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

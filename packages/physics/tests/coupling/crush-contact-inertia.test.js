import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushSolver, crushInertiaChannel } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const zero = [0, 0, 0];
const mass = 500;
const half = 0.5;
const water = 0.25;
const density = 1000;
const speed = 2;
const stiffness = 80e3;
const mesh = {
  vertices: Float64Array.from(
    [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    (value) => value * half,
  ),
  indices: Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  ]),
};

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}, tolerance ${tolerance}`);
}

async function setup(axis, order = ['hull', 'crush', 'rigid'], volume = water, exterior, friction = 0) {
  await Physics.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false), gravity: zero });
  // One native substep evaluates the exterior load at the exact half-submerged pose.
  const physics = new Physics(null, { arena: world.arena, gravity: zero, substeps: exterior ? 1 : 4 });
  const normal = [0, 0, 0];
  normal[axis] = 1;
  const anchor = exterior ? zero : normal.map((component) => component * half);
  const velocity = normal.map((component) => component * speed);
  if (friction > 0) velocity[0] = 1;
  const vessel = physics.addBody(null, {
    linearVelocity: velocity,
    colliders: { shape: 'box', halfExtents: [half, half, half], mass, sensor: true },
  });
  const channel = crushInertiaChannel();
  const hull = HullSolver.withContactInertia(channel);
  const crush = CrushSolver.withContactInertia(channel);
  const capacity = physics.kernel.capacity;
  world.add(new RigidSolver(), { physics, capacity });
  world.add(hull, {
    hulls: [
      {
        row: vessel.row,
        mesh: exterior ?? mesh,
        compartments: exterior ? undefined : [{ mesh, permeability: 1, water: volume }],
      },
    ],
    sea: { density, elevation: () => 0, pressure: () => 0 },
    gravity: zero,
    addedMass: !!exterior,
    radiation: false,
    rollDamping: false,
    drag: false,
    slamming: false,
  });
  world.add(crush, {
    bodyCapacity: capacity,
    patches: [
      {
        body: vessel.row,
        anchor,
        normal,
        radius: 0.4,
        support: { point: anchor },
        material: { stiffness, yieldForce: 1e9, stroke: 1 },
        friction,
      },
    ],
  });
  world.couple(order, 'staggered');
  const receipt = () => {
    const port = world.fields.port(channel.receipt.name);
    return Array.from(regionWords(world.memory, port.region).slice(vessel.row * 6, vessel.row * 6 + 6));
  };
  return { world, physics, vessel, crush, receipt };
}

test('the wet normal impulse uses actual carried water and is accounted for exactly once', async () => {
  const scene = await setup(1);
  using _physics = scene.physics;
  const { world, vessel, crush, receipt } = scene;
  const wetMass = mass + density * water;
  world.advance(1);
  const hit = crush.read(0);
  near(hit.impulse, 2 * wetMass * speed, 0.0002);
  near(hit.peakStroke, speed * Math.sqrt(wetMass / stiffness), 1e-7);
  near(receipt()[1], -2 * mass * speed, 0.0002);
  near(vessel.linearVelocity[1], -speed, 1e-6);
  const saved = world.takeSnapshot();
  const drift = () => {
    world.advance(6);
    near(vessel.linearVelocity[1], -speed, 1e-6);
    assert.equal(crush.read(0).impacts, 1);
    assert.deepEqual(receipt(), [0, 0, 0, 0, 0, 0]);
    return { velocity: vessel.linearVelocity, position: vessel.position, hash: world.hash() };
  };
  const first = drift();
  world.restoreSnapshot(saved.bytes);
  assert.deepEqual(drift(), first);
});

test('wet transverse contact rotates from the carried-water offset with correctly mapped impulse', async () => {
  const scene = await setup(0);
  using _physics = scene.physics;
  const { world, vessel, crush, receipt } = scene;
  const dryI = mass / 6;
  const carried = density * water;
  const y = -half + water / 2;
  const inertia = dryI + carried * y * y;
  const coupling = -carried * y;
  // The point-mass energy is 1/2 m |v + omega x r|². Eliminate omega from the two coupled equations.
  const effective = mass + carried - coupling ** 2 / inertia;
  const rotation = (2 * speed * coupling) / inertia;
  world.advance(1);
  near(crush.read(0).impulse, 2 * effective * speed, 0.0002);
  near(vessel.linearVelocity[0], -speed, 1e-6);
  near(vessel.angularVelocity[2], rotation, 4e-6);
  near(receipt()[0], -2 * mass * speed, 0.0002);
  near(receipt()[5], dryI * rotation, 0.0002);
});

test('dry hulls keep bare response and an invalid schedule names the coupling order', async () => {
  const dry = await setup(1, undefined, 0);
  using _dry = dry.physics;
  dry.world.advance(1);
  near(dry.crush.read(0).impulse, 2 * mass * speed, 0.0002);
  assert.deepEqual(dry.receipt(), [0, 0, 0, 0, 0, 0]);
  const reversed = await setup(0, ['crush', 'hull', 'rigid']);
  using _reversed = reversed.physics;
  assert.throws(() => reversed.world.advance(1), { code: 'state', message: /Place the hull before crush/ });
  const late = await setup(0, ['hull', 'rigid', 'crush']);
  using _late = late.physics;
  assert.throws(() => late.world.advance(1), { code: 'state', message: /and rigid last/ });
});

test('wet Coulomb sticking uses the coupled material-point mobility', async () => {
  const scene = await setup(1, undefined, water, undefined, 0.5);
  using _physics = scene.physics;
  const { world, crush, vessel, receipt } = scene;
  const dryI = mass / 6;
  const carried = density * water;
  const lever = -half + water / 2;
  const totalMass = mass + carried;
  const inertia = dryI + carried * lever ** 2;
  const c = -carried * lever;
  const det = totalMass * inertia - c * c;
  const mobility = (inertia + 2 * half * c + half ** 2 * totalMass) / det;
  const impulse = -1 / mobility;
  assert.ok(Math.abs(impulse) < 0.5 * 2 * totalMass * speed);
  const linear = (impulse * (inertia + half * c)) / det;
  const angular = (impulse * (-c - half * totalMass)) / det;
  world.advance(1);
  near(crush.read(0).impulse, 2 * totalMass * speed, 0.0002);
  near(vessel.linearVelocity[0], 1 + linear, 2e-6);
  near(vessel.angularVelocity[2], angular, 5e-6);
  near(vessel.linearVelocity[0] - half * vessel.angularVelocity[2], 0, 2e-6);
  near(receipt()[0], mass * linear, 0.0002);
  near(receipt()[5], dryI * angular, 0.0002);
});

function halfCylinder(radius, length, divisions = 64) {
  const vertices = [];
  const indices = [];
  const ring = divisions + 1;
  for (const x of [-length / 2, length / 2]) {
    for (let i = 0; i <= divisions; i++) {
      const theta = (Math.PI * i) / divisions;
      const y = i === 0 || i === divisions ? 0 : -radius * Math.sin(theta);
      vertices.push(x, y, radius * Math.cos(theta));
    }
  }
  for (let i = 0; i <= divisions; i++) {
    const next = (i + 1) % ring;
    indices.push(i, next + ring, i + ring, i, next, next + ring);
  }
  for (let i = 1; i < divisions; i++) indices.push(0, i + 1, i, ring, ring + i, ring + i + 1);
  return { vertices, indices };
}

test('instantaneous exterior heave inertia follows the half-cylinder image solution', async (t) => {
  const radius = 0.5;
  const length = 1.5;
  const scene = await setup(1, undefined, 0, halfCylinder(radius, length));
  using _physics = scene.physics;
  const { world, crush, vessel, receipt } = scene;
  // Reflect the dipping semicircle across the free surface with the opposite
  // potential. The full circle's translation dipole adds rho*pi*R² per metre.
  const added = (density * Math.PI * radius ** 2 * length) / 2;
  world.advance(1);
  const got = crush.read(0).impulse;
  near(got, 2 * speed * (mass + added), 0.001 * 2 * speed * added);
  near(receipt()[1], -2 * mass * speed, 0.0002);
  near(vessel.linearVelocity[1], -speed, 1e-6);
  t.diagnostic(
    `Exterior inertia implied by impact ${(got / (2 * speed) - mass).toFixed(3)} kg; analytical ${added.toFixed(3)} kg.`,
  );
});

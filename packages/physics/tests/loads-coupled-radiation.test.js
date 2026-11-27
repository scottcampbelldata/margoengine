import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { LoadSolver } from '../dist/loads.js';
import { FORCE_WORDS, PhysicsWorld, RigidSolver, regionWords, worldMemory } from '../dist/world.js';

await Physics.load();

const dt = 1 / 60;
const mass = 10;
const inertia = 2;
const density = 1000;
const radius = 0.25;
const centre = [0.04, -0.08, 0.12];
const direction = [0.71, 0.9, -0.53, 0.38, -0.19, 0.62];
const frequency = 8;
const decayRate = 1.5;
const strength = 70;
const resonance = { direction, frequency, decayRate, strength };
const linearVelocity = [0.18, 0.78, -0.42];
const angularVelocity = [0.54, 0.31, -0.34];

function profile(infiniteMass = Array(36).fill(0), overrides) {
  return {
    centre,
    density,
    waterline: 0,
    draft: radius,
    immersion: 0.5,
    infiniteMass,
    resonances: [resonance],
    ...overrides,
  };
}

function setup(
  coupledRadiation,
  {
    elevation = () => 0,
    locked = false,
    extra,
    rotation = [0, 0, 0, 1],
    motionLocks = false,
    loads = new LoadSolver(),
    publishMobility = true,
    shared = false,
    mixed = false,
  } = {},
) {
  const gravity = [0, 0, 0];
  const simulation = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(shared) });
  const physics = new Physics(null, { arena: simulation.arena, fixedTimestep: dt, gravity });
  const body = physics.addBody(null, {
    position: [1, -4, 2],
    rotation,
    linearVelocity: motionLocks ? [linearVelocity[0], 0, linearVelocity[2]] : linearVelocity,
    angularVelocity: locked ? [0, 0, 0] : motionLocks ? [0, angularVelocity[1], angularVelocity[2]] : angularVelocity,
    enabledTranslations: [true, !motionLocks, true],
    enabledRotations: [!motionLocks, true, true],
    colliders: {
      shape: 'sphere',
      radius,
      massProperties: {
        mass,
        principalInertia: motionLocks ? [2, 3, 5] : Array(3).fill(locked ? 0 : inertia),
        centerOfMass: centre,
      },
    },
    canSleep: false,
  });
  // Initialize the rigid world COM after collider mass properties are installed.
  body.setPosition(body.position);
  const regular = mixed
    ? physics.addBody(null, {
        position: [1.5, -4, -2],
        linearVelocity: [0.3, -0.1, 0.5],
        angularVelocity: [0.1, 0.2, -0.4],
        colliders: { shape: 'box', halfExtents: [0.12, 0.25, 0.18], mass: 7 },
      })
    : undefined;
  const sea = {
    density,
    elevation,
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample(_x, _y, _z, _t, out) {
        out.velocity.fill(0);
        out.density = density;
        return out;
      },
    },
  };
  simulation
    .add(new RigidSolver('rigid', { publishMobility }), { physics })
    .add(loads, {
      sea,
      bodies: [
        { row: body.row, shape: { sphere: radius }, drag: 0, spinDrag: 0, coupledRadiation, ...extra },
        ...(regular ? [{ row: regular.row, shape: { box: [0.12, 0.25, 0.18] }, addedInertia: 'ellipsoid' }] : []),
      ],
    })
    .couple(['loads', 'rigid'], 'staggered');
  const wrench = (row = body.row) => {
    const { region } = loads.exportPorts(0)[0];
    const all = regionWords(simulation.arena.memory, region);
    return [...all.subarray(row * FORCE_WORDS, (row + 1) * FORCE_WORDS)];
  };
  return { body, regular, simulation, wrench, loads, physics };
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const twist = (body) => [...body.linearVelocity, ...body.angularVelocity];
const firstOrderError = 12 * 2 ** -23;

function compareWrenches(actual, expected) {
  for (let i = 0; i < 6; i++) {
    const error = Math.abs(actual[i] - expected[i]);
    assert.ok(error <= firstOrderError * Math.max(1, Math.abs(expected[i])), 'component ' + i + ': ' + error);
  }
}

test('SEA-12 a body-frame radiation profile holds the live joint force and torque about an offset COM', () => {
  const infinite = 3.2;
  const matrix = direction.flatMap((a) => direction.map((b) => infinite * a * b));
  const rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const world = [direction[2], direction[1], -direction[0], direction[5], direction[4], -direction[3]];
  const ratio = 2; // Full immersion relative to the profile's half-submerged reference.
  const response = 1 / (1 + decayRate * dt + frequency ** 2 * dt ** 2);
  for (const locked of [false, true]) {
    const scene = setup(profile(matrix), { locked, rotation });
    const initial = twist(scene.body);
    const mobility = [1 / mass, 1 / mass, 1 / mass, ...Array(3).fill(locked ? 0 : 1 / inertia)];
    const compliance = dot(
      world,
      world.map((d, i) => d * mobility[i]),
    );
    // Solve a rank-one wet inertia update analytically. This forces all 36 entries to contribute.
    const denominator = 1 + ratio * (infinite + strength * response * dt ** 2) * compliance;
    const magnitude = (-ratio * strength * response * dt * dot(world, initial)) / denominator;
    const expectedWrench = world.map((d) => d * magnitude);
    assert.ok(expectedWrench.every((component) => Math.abs(component) > 0.01));
    scene.simulation.advance(1);
    compareWrenches(scene.wrench(), expectedWrench);
    compareWrenches(
      twist(scene.body),
      initial.map((speed, i) => speed + dt * mobility[i] * expectedWrench[i]),
    );
  }
});

function rotatedVector(quaternion, vector) {
  const [qx, qy, qz, scalar] = quaternion;
  const imaginary = [qx, qy, qz];
  const cross = [qy * vector[2] - qz * vector[1], qz * vector[0] - qx * vector[2], qx * vector[1] - qy * vector[0]];
  const radial = 2 * dot(imaginary, vector);
  const scale = scalar ** 2 - dot(imaginary, imaginary);
  return vector.map((value, i) => scale * value + radial * imaginary[i] + 2 * scalar * cross[i]);
}

test('SEA-12 ordinary added mass keeps locked-axis reaction and uses only free translational acceleration', async () => {
  const gravity = [0, 0, 0];
  const rotation = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
  const waterAcceleration = [2, 0.5, 0];
  const coefficient = 0.3;
  const displacedMass = density * ((4 * Math.PI * radius ** 3) / 3);
  const sea = {
    density,
    elevation: () => 0,
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample(_x, _y, _z, t, out) {
        for (let i = 0; i < 3; i++) out.velocity[i] = waterAcceleration[i] * t;
        out.density = density;
        return out;
      },
    },
  };
  const run = (loads, publishMobility) => {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
    using physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: dt });
    const rigidMass = 8;
    const body = physics.addBody(null, {
      position: [0, -4, 0],
      rotation,
      enabledTranslations: [true, false, true],
      colliders: { shape: 'sphere', radius, mass: rigidMass },
    });
    const axis = rotatedVector(body.rotation, [1, 0, 0]);
    const added = coefficient * displacedMass;
    const incident = dot(axis, waterAcceleration);
    const rhs = waterAcceleration.map((a, i) => displacedMass * a + added * axis[i] * incident);
    const netX = rhs[0] / (1 + (added * axis[0] ** 2) / rigidMass);
    const expected = [netX, rhs[1] - (added * axis[1] * axis[0] * netX) / rigidMass, 0, 0, 0, 0];
    world.add(new RigidSolver('rigid', { publishMobility }), { physics }).add(loads, {
      sea,
      bodies: [{ row: body.row, shape: { sphere: radius }, drag: 0, spinDrag: 0, addedMass: [coefficient, 0, 0] }],
    });
    world.advance(1);
    const { region } = loads.exportPorts(0)[0];
    const wrench = [
      ...regionWords(world.memory, region).subarray(body.row * FORCE_WORDS, (body.row + 1) * FORCE_WORDS),
    ];
    if (publishMobility) {
      compareWrenches(wrench, expected);
      assert.ok(Math.abs(wrench[1]) > 1, 'the lock still receives the transverse fluid reaction');
      compareWrenches(twist(body), [(dt * netX) / rigidMass, 0, 0, 0, 0, 0]);
    }
    assert.equal(body.linearVelocity[1], 0);
    return wrench;
  };
  const ts = run(new LoadSolver(), true);
  assert.deepEqual(run(await LoadSolver.load(), true), ts);
  const legacy = run(new LoadSolver(), false);
  assert.deepEqual(run(await LoadSolver.load({ readMobility: false }), false), legacy);
  assert.ok(Math.abs(legacy[0] - ts[0]) > 1, 'the all-free legacy receipt resolves a physically different force');
});

test('SEA-12 coupled radiation retains locked reactions and matches their constrained response through restore', async () => {
  const infinite = 3.2;
  const matrix = direction.flatMap((a) => direction.map((b) => infinite * a * b));
  const rotation = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
  const options = { rotation, motionLocks: true };
  const coupled = profile(matrix);
  const reference = setup(coupled, options);
  using _referencePhysics = reference.physics;
  const plain = setup(coupled, { ...options, loads: await LoadSolver.load() });
  using _plainPhysics = plain.physics;
  await Physics.load({ threads: true });
  const shared = setup(coupled, { ...options, loads: await LoadSolver.load(), shared: true });
  using _sharedPhysics = shared.physics;
  const body = reference.body;
  const quaternion = body.rotation;
  const mode = [...rotatedVector(quaternion, direction.slice(0, 3)), ...rotatedVector(quaternion, direction.slice(3))];
  const angular = body.effectiveWorldInverseInertia.map(Math.fround);
  assert.ok(Math.abs(angular[5]) > 0.05, 'the two free angular axes are coupled by the rotated dry inertia');
  const mobility = (wrench) => [
    wrench[0] / mass,
    0,
    wrench[2] / mass,
    dot(angular.slice(0, 3), wrench.slice(3)),
    dot(angular.slice(3, 6), wrench.slice(3)),
    dot(angular.slice(6, 9), wrench.slice(3)),
  ];
  const initial = twist(body);
  const exposureSquared = 2;
  const response = 1 / (1 + decayRate * dt + frequency ** 2 * dt ** 2);
  const denominator = 1 + exposureSquared * (infinite + strength * response * dt ** 2) * dot(mode, mobility(mode));
  const magnitude = (-exposureSquared * strength * response * dt * dot(mode, initial)) / denominator;
  const expected = mode.map((d) => d * magnitude);
  const expectedDelta = mobility(expected).map((a) => dt * a);
  assert.ok(Math.abs(expected[1]) > 0.01 && Math.abs(expected[3]) > 0.01);
  for (const scene of [reference, plain, shared]) {
    const zero = scene.simulation.takeSnapshot();
    scene.simulation.advance(1);
    assert.deepEqual(scene.wrench(), reference.wrench());
    compareWrenches(scene.wrench(), expected);
    const actual = twist(scene.body);
    compareWrenches(
      actual,
      initial.map((speed, i) => speed + expectedDelta[i]),
    );
    assert.equal(actual[1], 0);
    assert.equal(actual[3], 0);
    scene.simulation.advance(16);
    const hash = scene.simulation.hash();
    scene.simulation.restoreSnapshot(zero.bytes);
    scene.simulation.advance(16);
    assert.equal(scene.simulation.hash(), hash);
    scene.simulation.restoreSnapshot(zero.bytes);
    scene.simulation.advance(1);
  }
});

test('SEA-12 changing exposure and body orientation preserves discrete modal work and restores every bit', () => {
  // The short completely dry interval must decouple the mode while allowing its existing state to decay.
  const wet = (time) => time < 0.45 || time >= 0.63;
  const scene = setup(profile(), { elevation: (_x, _z, time) => (wet(time) ? 0 : -20) });
  let position = 0;
  let momentum = 0;
  let absorbed = 0;
  let positive = false;
  let saved;
  for (let frame = 1; frame <= 90; frame++) {
    const q = scene.body.rotation;
    const exposed = wet((frame - 0.5) * dt) ? Math.SQRT2 : 0;
    const world = [...rotatedVector(q, direction.slice(0, 3)), ...rotatedVector(q, direction.slice(3))];
    const oldStorage = (strength * (momentum ** 2 + frequency ** 2 * position ** 2)) / 2;
    scene.simulation.advance(frame);
    const output = scene.wrench();
    const after = twist(scene.body);
    momentum =
      (momentum + dt * (exposed * dot(world, after) - frequency ** 2 * position)) /
      (1 + decayRate * dt + frequency ** 2 * dt ** 2);
    position += dt * momentum;
    const expected = world.map((d) => -d * strength * exposed * momentum);
    compareWrenches(output, expected);
    if (exposed === 0) assert.ok(output.every((value) => value === 0));
    const storage = (strength * (momentum ** 2 + frequency ** 2 * position ** 2)) / 2;
    const work = -dt * dot(output, after);
    absorbed += work;
    positive ||= work > 0.001;
    assert.ok(work - (storage - oldStorage) >= -firstOrderError, 'discrete modal power balance');
    assert.ok(absorbed >= storage - firstOrderError, 'cumulative work funds mode storage');
    if (frame === 31) saved = scene.simulation.takeSnapshot();
  }
  assert.ok(positive && absorbed > 0.01);
  const final = scene.simulation.hash();
  scene.simulation.restoreSnapshot(saved.bytes);
  assert.equal(scene.simulation.hash(), saved.hash);
  scene.simulation.advance(90);
  assert.equal(scene.simulation.hash(), final);
});

test('SEA-12 radiation profile requires the sea density and local rigid COM and rejects duplicate water inertia', () => {
  assert.throws(() => setup(profile(undefined, { density: 1025 })), /generate the profile using sea\.density/);
  assert.throws(() => setup(profile(), { extra: { addedMass: [0, 0, 0] } }), /supply only coupledRadiation/);
  const wrongCentre = setup(profile(undefined, { centre: [0, 0, 0] }));
  assert.throws(() => wrongCentre.simulation.advance(1), /use the rigid body’s local COM/);
});

test('SEA-12 mixed 32-word and 41-word holds match TypeScript exactly in plain and shared worlds', async () => {
  const matrix = direction.flatMap((a) => direction.map((b) => 3.2 * a * b));
  const options = {
    mixed: true,
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    elevation: (x, _z, time) => (x < 1.25 && time >= 0.32 && time < 0.5 ? -20 : 0),
  };
  const coupled = profile(matrix);
  const reference = setup(coupled, options);
  using _referencePhysics = reference.physics;
  const plain = setup(coupled, { ...options, loads: await LoadSolver.load() });
  using _plainPhysics = plain.physics;
  await Physics.load({ threads: true });
  const shared = setup(coupled, { ...options, loads: await LoadSolver.load(), shared: true });
  using _sharedPhysics = shared.physics;

  for (let frame = 1; frame <= 48; frame++) {
    for (const scene of [reference, plain, shared]) scene.simulation.advance(frame);
    for (const scene of [plain, shared]) {
      assert.deepEqual(scene.wrench(), reference.wrench());
      assert.deepEqual(scene.wrench(scene.regular.row), reference.wrench(reference.regular.row));
      assert.deepEqual(twist(scene.body), twist(reference.body));
      assert.deepEqual(twist(scene.regular), twist(reference.regular));
    }
    if (frame === 1) {
      const words = regionWords(plain.simulation.memory, plain.loads.exportPorts(0)[0].region).length;
      const capacity = words / FORCE_WORDS;
      for (const scene of [plain, shared])
        assert.deepEqual(scene.loads.workCounts(), { heldBodies: 2, batchCalls: 2, scratchBytes: capacity * 41 * 8 });
    }
    if (frame === 25) {
      assert.equal(plain.loads.workCounts().batchCalls, 1, 'the dry coupled row takes the original hold');
      assert.equal(shared.loads.workCounts().batchCalls, 1);
    }
  }
  for (const scene of [plain, shared]) {
    const saved = scene.simulation.takeSnapshot();
    scene.simulation.advance(64);
    const hash = scene.simulation.hash();
    scene.simulation.restoreSnapshot(saved.bytes);
    scene.simulation.advance(64);
    assert.equal(scene.simulation.hash(), hash);
  }
});

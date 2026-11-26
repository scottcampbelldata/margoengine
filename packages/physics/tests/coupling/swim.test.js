import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SWIM_CONTACT_FIELD,
  SWIM_CONTACT_LAYOUT,
  SWIM_WAKE_FIELD,
  SWIM_WAKE_LAYOUT,
  SwimSolver,
  swimPropulsion,
} from '@margoengine/physics/life';
import { SchoolSolver } from '@margoengine/physics/schooling';
import { SpectralSea } from '@margoengine/physics/sea';
import { TracerSolver } from '@margoengine/physics/tracers';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const zero = [0, 0, 0];
const rate = { num: 60, den: 1 };
const density = 1025;
const gravity = -9.80665;
const volume = (Math.PI * 0.2 * 0.2) / 6;
const mass = density * volume;
const tail = { amplitude: 0.08, span: 0.16, wavelength: 0.85 };
const coast = { position: [0, -1, 0], mass, length: 1, width: 0.2, height: 0.2, tail, wettedArea: 0 };
const noTail = { ...tail, amplitude: 0 };
const sec = 1 / 60;

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    actual + ' vs ' + expected + ', difference ' + Math.abs(actual - expected),
  );
}

function put(solver, bodies, options = {}, extra = {}) {
  return new PhysicsWorld({ rate, ...options }).add(solver, { bodies, ...extra });
}

function stillSea(wave = 0) {
  const frequencies = new Float64Array([0.2, 0.4, 0.6]);
  const directions = new Float64Array([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  const energy = new Float64Array(12);
  // Grid spacing is 0.2 Hz times pi/2 radians. Put one progressive wave at 0.4 Hz.
  energy[5] = (wave * wave) / (0.2 * Math.PI);
  return new SpectralSea({ waves: { frequencies, directions, energy, depth: Infinity, density } });
}

test('Lighthill mean thrust and efficiency equal the trailing-edge cycle integral', () => {
  const omega = 4 * Math.PI;
  const waveNumber = (2 * Math.PI) / tail.wavelength;
  const speed = 0.75 * 2 * tail.wavelength;
  const addedPerLength = (Math.PI * density * tail.span * tail.span) / 4;
  let thrust = 0,
    power = 0;
  const samples = 128;
  for (let i = 0; i < samples; i++) {
    const phase = (i * 2 * Math.PI) / samples;
    const hT = tail.amplitude * omega * Math.cos(phase);
    const hZ = -tail.amplitude * waveNumber * Math.cos(phase);
    thrust += (addedPerLength * (hT * hT - speed * speed * hZ * hZ)) / (2 * samples);
    power += (addedPerLength * speed * (hT + speed * hZ) * hT) / samples;
  }
  const got = swimPropulsion(tail, 2, speed, density);
  close(got.thrust, thrust);
  close(got.power, power);
  close(got.efficiency, (thrust * speed) / power);
  assert.ok(got.strouhal >= 0.2 && got.strouhal <= 0.4, 'this chosen cruise represents the measured strouhal regime');
  assert.equal(swimPropulsion(tail, 2, 2 * tail.wavelength).thrust, 0);
  assert.ok(swimPropulsion(tail, 2, 3 * tail.wavelength).thrust < 0);
  assert.equal(swimPropulsion(tail, 0, speed).thrust, 0);
});

test('BB-4 axial speed evolves from the tail oscillator and resistance with first-order convergence to the exact solution', async () => {
  const frequency = 2;
  const t0 = swimPropulsion(tail, frequency, 0).thrust;
  const c = tail.wavelength * frequency;
  const k = 0.5 * density * 0.02 + t0 / (c * c);
  const equilibrium = Math.sqrt(t0 / k);
  const exact = equilibrium * Math.tanh(Math.sqrt(t0 * k) / mass);
  const errors = [];
  for (const level of [1, 2, 3]) {
    const swimmer = await SwimSolver.load({ level });
    const world = put(swimmer, [{ ...coast, frequency, formDragArea: 0.02 }]);
    world.advance(60);
    const speed = swimmer.read(0).velocity[2];
    assert.ok(speed > 0 && speed < c);
    errors.push(Math.abs(speed - exact));
  }
  assert.ok(errors[1] < 0.6 * errors[0], errors);
  assert.ok(errors[2] < 0.6 * errors[1], errors);
});

test('BB-9 the stroke accelerates, and the coast obeys the exact quadratic drag law', async () => {
  const swimmer = await SwimSolver.load();
  const area = 0.01;
  const world = put(swimmer, [{ ...coast, frequency: 1.5, burstSeconds: 1, coastSeconds: 1, formDragArea: area }]);
  world.advance(60);
  const u = swimmer.read(0).velocity[2];
  assert.ok(u > 0 && swimmer.read(0).thrust > 0);
  const start = swimmer.read(0).position[2];
  world.advance(120);
  const reading = swimmer.read(0);
  close(reading.velocity[2], u / (1 + ((0.5 * density * area) / mass) * u));
  assert.equal(reading.thrust, 0);
  assert.ok(reading.position[2] > start);
  world.advance(121);
  assert.ok(swimmer.read(0).velocity[2] > reading.velocity[2]);
});

test('BB-4, BB-5 bank and yaw come from fin load; the swimming wave travels along the body', async () => {
  const swimmer = await SwimSolver.load();
  const fins = { area: 0.02, liftCoefficient: 0.6 };
  const world = put(swimmer, [
    { ...coast, velocity: [0, 0, 1], frequency: 2, fins, steering: [1, 0.2, 0] },
    { ...coast, position: [1, -1, 0], velocity: [0, 0, 1], frequency: 2, fins },
  ]);
  world.advance(6);
  const turning = swimmer.read(0);
  assert.ok(turning.angularVelocity[1] > 0 && turning.angularVelocity[0] < 0 && turning.angularVelocity[2] > 0);
  assert.ok(turning.velocity[0] > 0 && turning.velocity[1] > 0);
  close(Math.hypot(...turning.orientation), 1);
  close(swimmer.read(1).angularVelocity[1], 0);
  const before = [0.25, 0.55, 1].map((fraction) => swimmer.sampleSpine(0, fraction));
  world.advance(12);
  const after = [0.25, 0.55, 1].map((fraction) => swimmer.sampleSpine(0, fraction));
  for (let i = 0; i < 3; i++) {
    assert.notEqual(before[i].position[0], after[i].position[0]);
    close(Math.hypot(...after[i].tangent), 1);
  }
  const head = swimmer.sampleSpine(0, 0).position;
  assert.equal(head[2], 0.5);
  assert.notEqual(head[0], 0, 'the head recoils against the mass-weighted body wave');
  let centroid = 0;
  for (let i = 0; i < 2048; i++) {
    const s = (i + 0.5) / 2048;
    centroid += (6 * s * (1 - s) * swimmer.sampleSpine(0, s).position[0]) / 2048;
  }
  // Midpoint quadrature error for this smooth function is bounded by max |f''|/(24 n²)
  // with max |f''| < 300 m.
  close(centroid, 0, 300 / (24 * 2048 * 2048));
});

test('BB-3 the half-cycle Blake drag stroke generates the analytical mean at zero through-flow', async () => {
  const swimmer = await SwimSolver.load();
  const frequency = 1,
    area = 0.025,
    amplitude = 0.1;
  const fins = { area, strokeFrequency: frequency, strokeAmplitude: amplitude, liftCoefficient: 0, momentArm: 0 };
  const world = put(swimmer, [
    { ...coast, tail: noTail, formDragArea: 0, fins, steering: [0, 0, 1] },
    { ...coast, tail: noTail, formDragArea: 0, fins },
  ]);
  world.advance(60);
  const strokeSpeed = 2 * Math.PI * frequency * amplitude;
  const expected = (density * area * strokeSpeed * strokeSpeed) / (8 * mass);
  close(swimmer.read(0).velocity[2], expected);
  assert.deepEqual(swimmer.read(1).velocity, zero);
});

test('BS-1 the diver receives actual SEA-02 orbital acceleration, and ballast changes the hydrostatic balance', async () => {
  const sea = stillSea(0.14);
  const swimmer = await SwimSolver.load();
  const world = put(swimmer, [{ ...coast, tail: noTail, crossflowDrag: [0, 0], formDragArea: 0 }], {}, { sea });
  world.advance(1);
  const u = sea.water.sample(0, -1, 0, 0).velocity;
  const later = sea.water.sample(u[0] * sec, -1 + u[1] * sec, u[2] * sec, sec).velocity;
  const first = swimmer.read(0);
  // Neutral ellipsoid: its own mass equals displaced water mass, so the pressure/added-mass
  // force divided by total directional inertia exactly recovers the sampled material acceleration.
  for (let axis = 0; axis < 3; axis++) close(first.velocity[axis], later[axis] - u[axis]);
  const flat = await SwimSolver.load();
  const flatWorld = put(flat, [{ ...coast, tail: noTail, crossflowDrag: [0, 0] }], {}, { sea: stillSea() });
  flatWorld.advance(6);
  assert.deepEqual(flat.read(0).velocity, zero);
  flat.setControl(0, { buoyancy: 0.8 });
  const snapshot = flatWorld.takeSnapshot();
  flatWorld.advance(7);
  const addedY = (Math.PI * density * 0.1 * 0.1 * 2) / 3;
  close(flat.read(0).velocity[1], (0.2 * gravity * mass * sec) / (mass + addedY));
  flat.setControl(0, { buoyancy: 2 });
  flatWorld.restoreSnapshot(snapshot.bytes);
  flatWorld.advance(7);
  close(flat.read(0).velocity[1], (0.2 * gravity * mass * sec) / (mass + addedY));
});

test('BB-8 vertical flukes transfer the opposing wake impulse and can breach into ballistic motion', async () => {
  const swimmer = await SwimSolver.load();
  const dolphin = { ...coast, tail: { ...tail, plane: 'vertical' }, frequency: 1, formDragArea: 0 };
  const world = put(swimmer, [dolphin], { gravity: zero });
  world.advance(1);
  const port = swimmer.exportPorts(1).find(({ field }) => field === SWIM_WAKE_FIELD.name);
  assert.equal(port.region.layout, SWIM_WAKE_LAYOUT);
  const wake = new Float64Array(world.memory.buffer, port.region.byteOffset, 16);
  close(wake[5], -mass * swimmer.read(0).velocity[2]);
  close(wake[6], tail.span / 2);
  close(wake[2], -coast.length / 2);
  assert.equal(swimmer.sampleSpine(0, 1).position[0], 0);
  assert.notEqual(swimmer.sampleSpine(0, 1).position[1], 0);

  const flying = await SwimSolver.load();
  const launch = 0.2,
    v = 3;
  const surfaceWorld = put(
    flying,
    [{ ...dolphin, position: [0, launch, 0], velocity: [0, v, 0] }],
    { gravity: [0, gravity, 0] },
    { sea: stillSea() },
  );
  surfaceWorld.advance(30);
  const raised = flying.read(0);
  assert.equal(raised.wetFraction, 0);
  assert.equal(raised.thrust, 0);
  close(raised.position[1], launch + 0.5 * v + gravity * 0.125);
  close(raised.velocity[1], v + gravity * 0.5);
  surfaceWorld.advance(40);
  assert.ok(flying.read(0).wetFraction > 0 && flying.read(0).wetFraction < 1);
});

test('LIFE-04 and LIFE-03 exchange real kinematics and physical tail effort in a staggered group', async () => {
  const [swim, school] = await Promise.all([
    SwimSolver.load({ readSchoolIntent: true }),
    SchoolSolver.load({ mode: 'intent' }),
  ]);
  const fish = [
    { ...coast, position: [0, -1, 0], velocity: [0, 0, 0.2] },
    { ...coast, position: [0, -1, 1], velocity: [0, 0, 0.25] },
  ];
  const world = put(swim, fish, { cellSize: 256 }, { cellSize: 256 }).add(
    school,
    { members: fish, cruiseSpeed: 0.8, cellSize: 256 },
    [1, 0, 0],
  );
  world.couple(['school', 'swim'], 'staggered');
  world.advance(12);
  assert.ok(school.read(0).position[0] < -255, 'the positions are converted between solver cells');
  assert.ok(school.read(0).intent[2] > 0);
  assert.ok(swim.read(0).frequency > 0);
  assert.ok(swim.read(0).velocity[2] > fish[0].velocity[2]);
});

test('SwimSolver replays bit-identically across frame schedules, snapshots, and world memory kinds', async () => {
  const pool = await Promise.all(Array.from({ length: 7 }, () => SwimSolver.load()));
  const bodies = [
    { ...coast, frequency: 2, burstSeconds: 0.65, coastSeconds: 0.3 },
    { ...coast, position: [0.5, -2, 1], frequency: 1.5, tail: { ...tail, plane: 'vertical' } },
  ];
  const sea = stillSea(0.1);
  const make = (fps, memory) => put(pool.shift(), bodies, { rate: fps, memory }, { sea });
  frameRateIndependent((fps) => make(fps), { seconds: 2 });
  seekEqualsContinuous(() => make({ num: 24, den: 1 }));
  const plain = make(rate, worldMemory(false));
  const normal = make(rate);
  plain.advance(120);
  normal.advance(120);
  assert.equal(plain.hash(), normal.hash());
});

test('BB-7 a pectoral beat lifts sand above a near bed and the plume drifts and settles', async () => {
  const swimmer = await SwimSolver.load();
  const tracer = new TracerSolver('tracers', { bedJets: true });
  const frequency = 1,
    amplitude = 0.2,
    area = 0.05,
    depth = 0.5;
  const ray = {
    ...coast,
    position: [0, -0.2, 0],
    tail: noTail,
    fins: { area, strokeAmplitude: amplitude, strokeFrequency: frequency },
    steering: [0, 1, 0],
  };
  const water = { medium: 'water', cell: zero, sample: () => ({ velocity: [0.5, 0, 0], density, temperature: 280 }) };
  const world = put(swimmer, [ray]).add(tracer, {
    bed: depth,
    bedJets: { availableMass: 0.023 },
    water,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
  });
  world.advance(1);
  const speed = 2 * Math.PI * frequency * amplitude * Math.cos(Math.PI * frequency * sec);
  const footprint = Math.PI * (Math.sqrt(area / Math.PI) + 0.1 * (depth + ray.position[1])) ** 2;
  const shear = (0.05 * 0.5 * density * speed * speed * area) / footprint;
  const threshold = 0.05 * (2650 - density) * -gravity * 2.5e-4;
  close(tracer.jetErosion, 0.02 * (shear / threshold - 1) * footprint * sec);
  assert.ok(swimmer.read(0).velocity[1] > 0);
  const first = [...tracer.particlesOf()];
  assert.equal(first.length, 4);
  assert.ok(first.every(({ position, state }) => position[1] > -depth && position[1] < 0 && state === 'water'));
  const save = world.takeSnapshot();
  world.advance(11);
  const after = [...tracer.particlesOf()];
  close(after[0].position[0] - first[0].position[0], 0.5 * 10 * sec);
  assert.ok(after[0].position[1] < first[0].position[1]);
  world.advance(180);
  close(tracer.jetErosion, 0.023);
  close(tracer.budget.water + tracer.budget.bed, tracer.jetErosion);
  close(tracer.budget.bed, tracer.jetErosion);
  const hash = world.hash();
  world.restoreSnapshot(save.bytes);
  world.advance(180);
  assert.equal(world.hash(), hash);
});

test('BB-7 still fins and a bed below the jet footprint do not release sand', async () => {
  for (const [depth, strokeAmplitude] of [
    [0.5, 0],
    [100, 0.2],
  ]) {
    const swimmer = await SwimSolver.load();
    const tracer = new TracerSolver('tracers', { bedJets: true });
    const ray = {
      ...coast,
      position: [0, -0.2, 0],
      tail: noTail,
      fins: { area: 0.05, strokeAmplitude, strokeFrequency: 1 },
      steering: [0, 1, 0],
    };
    const world = put(swimmer, [ray]).add(tracer, { bed: depth });
    world.advance(1);
    assert.equal(tracer.jetErosion, 0);
    assert.deepEqual([...tracer.particlesOf()], []);
  }
});

test('BB-3 pectoral sculling can maintain station against a uniform current', async () => {
  const swimmer = await SwimSolver.load();
  const flow = { medium: 'water', cell: zero, sample: () => ({ velocity: [0, 0, 0.2], density, temperature: 280 }) };
  const body = {
    ...coast,
    tail: noTail,
    formDragArea: 0.04,
    fins: { area: 0.05, liftCoefficient: 0, strokeAmplitude: 0.2, strokeFrequency: 1 },
    responseSeconds: 0.5,
  };
  const world = put(swimmer, [{ ...body, target: { position: body.position } }, body], {}, { flow });
  world.advance(240);
  const unpowered = swimmer.read(1).position[2];
  const controlled = swimmer.read(0).position[2];
  assert.ok(unpowered > 0 && Math.abs(controlled) < unpowered / 2, controlled + ' vs ' + unpowered);
});

test('swimmer linear momentum in air does not depend on body orientation or changing body axes', async () => {
  const swimmer = await SwimSolver.load();
  const velocity = [0.3, -0.5, 0.7];
  const world = put(
    swimmer,
    [
      {
        ...coast,
        velocity,
        orientation: [0, 1, 0, 1],
        angularVelocity: [1, 2, 1],
      },
    ],
    { gravity: zero },
    { density: 0 },
  );
  world.advance(120);
  const result = swimmer.read(0);
  for (let axis = 0; axis < 3; axis++) {
    close(result.velocity[axis], velocity[axis]);
    close(result.position[axis], coast.position[axis] + 2 * velocity[axis]);
  }
  close(Math.hypot(...result.orientation), 1);
});

test('BB-3 a contact wrench changes the swimmer motion through a versioned world port', async () => {
  const swim = await SwimSolver.load({ readContacts: true });
  let contact, host;
  const reaction = {
    describe: () => ({
      id: 'anemone-contact',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: SWIM_CONTACT_FIELD, access: 'write' }],
    }),
    init(owner) {
      host = owner;
      contact = host.allocate('anemone-wrench', 48, 'f64', SWIM_CONTACT_LAYOUT);
      new Float64Array(host.memory.buffer, contact.byteOffset, 6).set([-2, 0, 0, 0, 0.3, 0]);
    },
    step() {},
    exportPorts: (tick) => [{ field: SWIM_CONTACT_FIELD.name, cell: zero, region: contact, tick }],
    importPorts() {},
    stateRegions: () => [contact],
    extraState: () => [],
  };
  const body = { ...coast, crossflowDrag: [0, 0], tail: noTail };
  const world = put(swim, [body]).add(reaction, {});
  world.advance(1);
  const added = (Math.PI * density * 0.1 * 0.1 * 2) / 3;
  close(swim.read(0).velocity[0], (-2 * sec) / (mass + added));
  const yawInertia = (mass * (0.1 * 0.1 + 0.5 * 0.5)) / 5 + (Math.PI * density * 0.1 * 0.1) / 30;
  close(swim.read(0).angularVelocity[1], (sec * 0.3) / yawInertia);
});

test('a swimmer steers out of an exactly reversed heading with finite hydrodynamic torque', async () => {
  const swimmer = await SwimSolver.load();
  const world = put(swimmer, [
    {
      ...coast,
      velocity: [0, 0, 1],
      target: { velocity: [0, 0, -0.8] },
      fins: { area: 0.02 },
    },
  ]);
  world.advance(1);
  const reading = swimmer.read(0);
  assert.ok(reading.angularVelocity[1] > 0);
  close(Math.hypot(...reading.orientation), 1);
});

test('fin lift gives the geometric curvature bound from force over effective lateral mass', async () => {
  const swimmer = await SwimSolver.load();
  const area = 0.015,
    liftCoefficient = 0.75,
    speed = 1.2;
  const world = put(swimmer, [
    {
      ...coast,
      tail: noTail,
      velocity: [0, 0, speed],
      formDragArea: 0,
      crossflowDrag: [0, 0],
      steering: [1, 0, 0],
      fins: { area, liftCoefficient, momentArm: 0, halfSpacing: 0 },
    },
  ]);
  world.advance(1);
  const effectiveMass = mass + (Math.PI * density * 0.1 * 0.1 * 2) / 3;
  const curvature = swimmer.read(0).velocity[0] / (sec * speed * speed);
  close(curvature, (0.5 * density * liftCoefficient * area) / effectiveMass);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import {
  SEISMIC_LAYOUT,
  SeismicGround,
  SeismicInertialLoad,
  momentFraction,
  seismicCyclicStress,
} from '../../dist/seismic.js';
import {
  BODIES_FIELD,
  BODY_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const fps = { num: 60, den: 1 };
const dt = 1 / 60;
const rock = { density: 2200, compressionalSpeed: 35, shearSpeed: 20 };
const basic = { width: 65, depth: 32, spacing: [1, 1], material: rock, absorbingCells: 0 };
const pulse = { position: [32, 8], timescale: 0.045, moment: [23000, -23000, 17000] };

function close(actual, expected, tolerance = 128 * Number.EPSILON * Math.max(1, Math.abs(expected))) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected} ± ${tolerance}`);
}
function make(solver, params = {}, options = {}) {
  return new PhysicsWorld({ rate: fps, ...options }).add(solver, { ...basic, ...params });
}

test('the native P and SV branches match the staggered-grid dispersion relation', async () => {
  for (const [axis, speed] of [
    [0, rock.compressionalSpeed],
    [1, rock.shearSpeed],
  ]) {
    const ground = await SeismicGround.load();
    const k = (2 * Math.PI) / 16;
    const wave = (x, _depth) => (axis === 0 ? [Math.sin(k * x), 0] : [0, Math.sin(k * x)]);
    const world = make(ground, { initialVelocity: wave });
    const n = 7,
      column = 19,
      depth = 15;
    world.advance(n);
    const phase = 2 * Math.asin(speed * dt * Math.sin(k / 2));
    const x = column + (axis === 0 ? 1 : 0.5);
    const exact = (Math.sin(k * x) * Math.cos((n - 0.5) * phase)) / Math.cos(phase * 0.5);
    close(ground.velocity(column, depth)[axis], exact);
    close(ground.velocity(column, depth)[1 - axis], 0);
  }
});

test('the traction-free surface doubles the incoming normal velocity', async () => {
  const ground = await SeismicGround.load();
  const world = make(ground, {
    absorbingCells: 0,
    initialVelocity: (_x, z) => [0, Math.exp(-((z - 23) * (z - 23)) / 32)],
  });
  // Start with equal up/down components. A free surface reflects vertical velocity with the same sign,
  // so its first positive peak approaches the initial unit amplitude.
  let peak = 0;
  for (let tick = 1; tick <= 56; tick++) {
    world.advance(tick);
    peak = Math.max(peak, ground.motion(32).velocity[1]);
  }
  // The analytic packet's spatial width is four cells, placing its dominant k*dx near 1/4.
  // The leading second-order staggered dispersion error is O((k*dx)^2 / 24).
  assert.ok(Math.abs(peak - 1) < 1 / 48, `free-surface peak ${peak}`);
});

test('an elastic low-impedance layer amplifies early surface motion', async () => {
  const homogeneous = await SeismicGround.load();
  const layered = await SeismicGround.load();
  const initialVelocity = (_x, z) => [0, Math.exp(-((z - 25) * (z - 25)) / 16)];
  const plain = make(homogeneous, { initialVelocity, depth: 42 });
  const withLayer = make(layered, {
    initialVelocity,
    depth: 42,
    material: (_x, depth) => (depth < 10 ? { density: 1800, compressionalSpeed: 20, shearSpeed: 11 } : rock),
  });
  let reference = 0,
    amplified = 0;
  for (let tick = 1; tick <= 80; tick++) {
    plain.advance(tick);
    withLayer.advance(tick);
    reference = Math.max(reference, homogeneous.motion(32).velocity[1]);
    amplified = Math.max(amplified, layered.motion(32).velocity[1]);
  }
  const transmission =
    (2 * rock.density * rock.compressionalSpeed) / (rock.density * rock.compressionalSpeed + 1800 * 20);
  assert.ok(
    amplified > reference && amplified < transmission * reference,
    `${reference}, ${amplified}, ${transmission}`,
  );
});

test('a resolved ground tick drives the Newmark building update and peak cyclic stress screening', async () => {
  const ground = await SeismicGround.load();
  const soil = { overburdenRatio: 1.7, depthReduction: 0.92, cyclicResistance: 0.18 };
  const world = make(ground, {
    sources: [pulse],
    sites: [{ x: 32.5, frequency: 2, dampingRatio: 0.08, saturatedSoil: soil }],
  });
  world.advance(31);
  const prev = ground.reading();
  world.advance(32);
  const output = ground.reading(),
    motion = ground.motion(32);
  const accel = motion.acceleration[0],
    omega = 4 * Math.PI;
  assert.notEqual(accel, 0);
  close(
    output.displacement,
    prev.displacement + dt * prev.velocity + 0.25 * dt * dt * (prev.relativeAcceleration + output.relativeAcceleration),
  );
  close(output.velocity, prev.velocity + 0.5 * dt * (prev.relativeAcceleration + output.relativeAcceleration));
  close(output.absoluteAcceleration, output.relativeAcceleration + accel);
  close(output.relativeAcceleration + 2 * 0.08 * omega * output.velocity + omega * omega * output.displacement, -accel);
  close(output.cyclicStress, (0.65 * 1.7 * 0.92 * motion.peakHorizontalAcceleration) / 9.80665);
  assert.equal(output.liquefactionPotential, output.cyclicStress >= soil.cyclicResistance);
  assert.equal(seismicCyclicStress(0.4 * 9.80665, 9.80665, 2, 0.8), 0.65 * 0.4 * 2 * 0.8);
});

test('the two public fields hold exact ground and building rows for world readers', async () => {
  const ground = await SeismicGround.load();
  const world = make(ground, { sources: [pulse], sites: [{ x: 30, frequency: 2 }] });
  world.advance(60);
  const [motion, sites] = ground.exportPorts(60);
  const payload = (port) => new Float64Array(world.memory.buffer, port.region.byteOffset, port.region.byteLength / 8);
  assert.equal(motion.field, ground.groundField.name);
  assert.equal(sites.field, ground.siteField.name);
  assert.equal(motion.region.layout, SEISMIC_LAYOUT);
  assert.equal(sites.region.layout, SEISMIC_LAYOUT);
  assert.equal(payload(motion)[32 * 8 + 5], ground.motion(32).acceleration[0]);
  assert.equal(payload(sites)[3], ground.reading().absoluteAcceleration);
});

test('seismic initialization tolerates plain-memory growth and a rejected native pulse preserves accepted state', async () => {
  using ground = await SeismicGround.load();
  const memory = worldMemory(false);
  const cell = [-8, 6, -4];
  const step = 1 / 120;
  let sampled = 0;
  const world = new PhysicsWorld({ rate: fps, memory }).add(
    ground,
    {
      ...basic,
      spacing: [0.5, 0.5],
      material: () => {
        if (++sampled === 10) memory.grow(1);
        return rock;
      },
      initialVelocity: () => [0.1, 0],
      sites: [{ x: 3, frequency: 2 }],
      sources: [{ position: [3.25, 4.25], timescale: 0.001, start: step, moment: [Number.MAX_VALUE, 0, 0] }],
    },
    cell,
  );
  assert.equal(sampled, (basic.width + 2) * (basic.depth + 2));
  assert.equal(ground.velocity(12, 12)[0], 0.1);
  const context = { tick: 0, level: 1, seed: 7, cell, inputs: new Map() };
  const initial = world.takeSnapshot();
  ground.step(context, step);
  const accepted = world.takeSnapshot();
  const receipt = ground.readNativeWork();
  assert.ok(receipt.velocityCells > 0);
  assert.throws(
    () => ground.step({ ...context, tick: 1 }, step),
    (error) => error.code === 'state' && /Nonfinite seismic wave trial.*errors#seismic/.test(error.message),
  );
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  assert.deepEqual(ground.readNativeWork(), receipt);

  world.shiftOrigin([2, -3, 1]);
  assert.deepEqual(
    ground.exportPorts(1).map((port) => port.cell),
    Array(2).fill([-10, 9, -5]),
  );
  world.restoreSnapshot(initial.bytes);
  ground.step(context, step);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
});

test('seismic rigid forces use both owning memories and reject a later invalid load atomically', async () => {
  const field = {
    name: 'seismic-test:ground',
    kind: 'particleSet',
    quantity: 'ground motion',
    unit: 'm, m/s, m/s^2',
    centring: 'particle',
  };
  const driver = new SeismicInertialLoad(field);
  const cell = [-3, 2, -7];
  const world = new PhysicsWorld({ rate: fps }).add(
    driver,
    {
      bodyCapacity: 2,
      supports: [
        { body: 0, column: 0 },
        { body: 1, column: 1 },
      ],
    },
    cell,
  );
  const motionMemory = new WebAssembly.Memory({ initial: 1 });
  const bodiesMemory = new WebAssembly.Memory({ initial: 1 });
  const motionRegion = {
    name: 'foreign ground',
    memory: motionMemory,
    type: 'f64',
    layout: 1,
    byteOffset: 128,
    byteLength: 128,
  };
  const bodiesRegion = {
    name: 'foreign bodies',
    memory: bodiesMemory,
    type: 'f32',
    layout: 2,
    byteOffset: 256,
    byteLength: 2 * BODY_WORDS * 4,
  };
  const motion = new Float64Array(motionMemory.buffer, 128, 16);
  const bodies = new Float32Array(bodiesMemory.buffer, 256, 2 * BODY_WORDS);
  motion.set([5, -4], 5);
  motion.set([20, 5], 13);
  bodies[16] = 0.5;
  bodies[BODY_WORDS + 16] = 0.25;
  const step = (region = bodiesRegion) =>
    driver.step({
      tick: 0,
      level: 0,
      seed: 4,
      cell,
      inputs: new Map([
        [field.name, { field: field.name, region: motionRegion, tick: 0, cell }],
        [BODIES_FIELD.name, { field: BODIES_FIELD.name, region, tick: 0, cell }],
      ]),
    });
  step();
  const accepted = world.takeSnapshot();
  const port = driver.exportPorts(0)[0];
  const words = regionWords(world.memory, port.region);
  assert.deepEqual([words[0], words[1], words[FORCE_WORDS], words[FORCE_WORDS + 1]], [-10, 8, -80, -20]);
  motion[5] = -10;
  motion[13] = NaN;
  assert.throws(
    () => step(),
    (error) => error.code === 'state' && /finite acceleration.*errors#seismic/.test(error.message),
  );
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  assert.throws(() => step({ ...bodiesRegion, byteOffset: 257 }), /unaligned.*errors#seismic/);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
});

test('ground acceleration moves an actual rigid body in its shaking support frame', async () => {
  await Physics.load({ threads: false });
  const ground = await SeismicGround.load();
  const gravity = [0, 0, 0];
  const world = make(
    ground,
    {
      initialVelocity: (x) => [Math.sin((x * 2 * Math.PI) / 16), 0],
    },
    { gravity, memory: worldMemory(false) },
  );
  const physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: dt });
  try {
    const body = physics.addBody(null, {
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 3, sensor: true },
    });
    const capacity = physics.kernel.capacity;
    const driver = new SeismicInertialLoad(ground.groundField);
    world.add(new RigidSolver(), { physics, capacity });
    world.add(driver, { bodyCapacity: capacity, supports: [{ body: body.row, column: 19 }] });
    world.couple(['rigid', driver.id], 'staggered');
    for (let tick = 1; tick <= 8; tick++) {
      const before = body.linearVelocity[0];
      const previousGroundAcceleration = ground.motion(19).acceleration[0];
      world.advance(tick);
      const previousForce = -previousGroundAcceleration * 3;
      const actual = body.linearVelocity[0] - before;
      close(actual, (previousForce * dt) / 3, 8 * 2 ** -24);
    }
    assert.ok(body.linearVelocity[0] > 0);
  } finally {
    physics.dispose();
  }
});

test('a causal Brune pulse integrates to its prescribed total moment', () => {
  const tau = 0.04;
  assert.equal(momentFraction(-0.1, tau), 0);
  close(momentFraction(tau, tau), 1 - 2 / Math.E);
  close(momentFraction(50 * tau, tau), 1);
  close(momentFraction(tau / 1e5, tau), 0.5e-10 - 1e-15 / 3, 1.26e-21);
});

test('seismic waveforms and site responses replay across schedules, seek and native memory modes', async () => {
  const pool = await Promise.all(Array.from({ length: 7 }, () => SeismicGround.load()));
  const params = { width: 17, depth: 15, sources: [{ ...pulse, position: [8, 6] }], sites: [{ x: 8, frequency: 2 }] };
  const worldAt = (rate, memory) => make(pool.shift(), params, { rate, memory });
  frameRateIndependent((rate) => worldAt(rate), { seconds: 1 });
  seekEqualsContinuous(() => worldAt(fps));
  const plain = worldAt(fps, worldMemory(false)),
    shared = worldAt(fps, worldMemory(true));
  plain.advance(60);
  shared.advance(60);
  assert.equal(plain.hash(), shared.hash());
});

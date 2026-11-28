import assert from 'node:assert/strict';
import test from 'node:test';
import { RealFft2 } from '@margoengine/math/fft';
import { Physics } from '../../dist/index.js';
import { FiniteQuayWake, SurgeWakeCoupling } from '../../dist/loads.js';
import { SpectralSea, SUBMERGED_WAKE_WORDS, WakeSolver, WAKE_HEIGHT_FIELD } from '../../dist/sea.js';
import { HullSolver } from '../../dist/seakeeping.js';
import {
  BODIES_FIELD,
  BODY_MOBILITY_FIELD,
  BODY_MOBILITY_WORDS,
  BODY_WORDS,
  IMPULSE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '../../dist/world.js';

import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load({ threads: true });
const gravity = 9.81,
  density = 1024,
  mass = 1024,
  dt = 1 / 60;
const depth = 3,
  depths = [0, 0.25, 0.5],
  cells = [40, 32],
  cellSize = 0.4;
const [nx, nz] = cells;
const fft = new RealFft2(nx, nz);
const mesh = {
  vertices: Float64Array.of(
    -1,
    -0.5,
    -0.5,
    1,
    -0.5,
    -0.5,
    1,
    0.5,
    -0.5,
    -1,
    0.5,
    -0.5,
    -1,
    -0.5,
    0.5,
    1,
    -0.5,
    0.5,
    1,
    0.5,
    0.5,
    -1,
    0.5,
    0.5,
  ),
  indices: Uint32Array.of(
    0,
    2,
    1,
    0,
    3,
    2,
    4,
    5,
    6,
    4,
    6,
    7,
    0,
    1,
    5,
    0,
    5,
    4,
    3,
    7,
    6,
    3,
    6,
    2,
    0,
    4,
    7,
    0,
    7,
    3,
    1,
    2,
    6,
    1,
    6,
    5,
  ),
};

function waveEnergy(world, wake) {
  const potential = wake.heights().reduce((sum, h) => sum + gravity * h * h, 0);
  const phi = fft.forward(regionWords(world.memory, wake.stateRegions()[1]));
  const half = nx / 2 + 1;
  let kinetic = 0;
  for (let z = 0; z < nz; z++) {
    const kz = (2 * Math.PI * (z < nz / 2 ? z : z - nz)) / (nz * cellSize);
    for (let x = 0; x < half; x++) {
      const kx = (2 * Math.PI * x) / (nx * cellSize);
      const k = Math.hypot(kx, kz);
      const at = 2 * (z * half + x);
      const weight = x === 0 || x === nx / 2 ? 1 : 2;
      kinetic += weight * k * Math.tanh(k * depth) * (phi[at] ** 2 + phi[at + 1] ** 2);
    }
  }
  // Parseval converts the unnormalized Fourier field to mean kinetic density per cell.
  return 0.5 * density * cellSize ** 2 * (potential + kinetic / (nx * nz));
}

function setup({ reaction = true, axis = 'x', initial, speed = 1.25, shared = false, rate = { num: 60, den: 1 } } = {}) {
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0], memory: worldMemory(shared) });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: dt, substeps: 1, gravity: [0, -gravity, 0] });
  const along = axis === 'x' ? 0 : 2;
  const turn = Math.SQRT1_2;
  const body = physics.addBody(null, {
    position: [-2, 0, 0.3],
    rotation: along === 0 ? [0, 0, 0, 1] : [0, turn, 0, turn], // local +X points along −Z.
    linearVelocity: along === 0 ? [speed, 0, 0] : [0, 0, speed],
    enabledTranslations: [along === 0, false, along === 2],
    enabledRotations: [false, false, false],
    colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass },
  });
  const surge = new SurgeWakeCoupling({
    row: body.row,
    mesh,
    axis,
    waterline: 0,
    depth,
    depths,
    cells,
    cellSize,
    density,
    minimumRadius: 0.35,
  });
  const hull = new HullSolver('hull', reaction ? undefined : { submergedAdvance: depths, minimumRadius: 0.35 });
  const wake = reaction
    ? new WakeSolver('wake', undefined, surge.submergedSource)
    : new WakeSolver('wake', hull.wakeSourceField, hull.submergedWakeSource);
  const sea = new SpectralSea({
    waves: {
      frequencies: Float64Array.of(0.5),
      directions: Float64Array.of(0),
      energy: Float64Array.of(0),
      depth,
      density,
    },
  });
  world.add(new RigidSolver(), { physics }).add(hull, {
    hulls: [{ row: body.row, mesh }],
    sea,
    addedMass: false,
    radiation: false,
    drag: false,
    rollDamping: false,
    diffraction: false,
    drift: false,
    slamming: false,
    greenWater: false,
  });
  if (reaction) world.add(surge, undefined);
  world
    .add(wake, surge.wakeParams({ initial }))
    .couple(reaction ? ['hull', 'surgeWake', 'wake', 'rigid'] : ['hull', 'wake', 'rigid'], 'staggered');
  return {
    world,
    physics,
    body,
    surge,
    wake,
    along,
    bodyEnergy: () => 0.5 * mass * body.linearVelocity[along] ** 2,
    waveEnergy: () => waveEnergy(world, wake),
  };
}

test('the actual hull and dispersive wake exchange matched energy with free rigid surge', (t) => {
  function run(reaction, shared) {
    const sim = setup({ reaction, shared });
    using _physics = sim.physics;
    const { world, body } = sim;
    const empty = world.takeSnapshot();
    const initialEnergy = sim.bodyEnergy() + sim.waveEnergy();
    let checkpoint;
    let maxResidual = 0,
      totalScale = 0;
    for (let tick = 1; tick <= 90; tick++) {
      world.advance(tick);
      const total = sim.bodyEnergy() + sim.waveEnergy();
      assert.equal(body.position[1], 0, 'the guide holds the exact reference waterline');
      maxResidual = Math.max(maxResidual, Math.abs(total - initialEnergy));
      totalScale += total;
      if (tick === 30) checkpoint = world.takeSnapshot();
    }
    // Four f32 half-ulp factors cover the per-step impulse and velocity writes to the native rigid state.
    const roundoff = 4 * 2 ** -24 * totalScale;
    const wave = sim.waveEnergy(),
      deltaBody = sim.bodyEnergy() - initialEnergy;
    const final = world.hash();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(90);
    assert.equal(world.hash(), final);
    world.restoreSnapshot(empty.bytes);
    world.advance(90);
    assert.equal(world.hash(), final);
    return { maxResidual, roundoff, wave, deltaBody, final, speed: body.linearVelocity[0] };
  }
  const coupled = run(true, false);
  assert.deepEqual(run(true, true), coupled);
  const disabled = run(false, false);
  assert.ok(coupled.wave > 20 && coupled.deltaBody < -20, JSON.stringify(coupled));
  assert.ok(coupled.maxResidual < coupled.roundoff, JSON.stringify(coupled));
  assert.equal(disabled.speed, 1.25);
  assert.equal(disabled.deltaBody, 0);
  assert.ok(disabled.maxResidual > 20, JSON.stringify(disabled));
  t.diagnostic(JSON.stringify({ coupled, disabled }));
});

test('guided surge closes work against a finite quay with an opening and an active absorber', (t) => {
  function run(reaction, shared) {
    const cells = [37, 19],
      dx = 0.25,
      bed = 1.5,
      centre = [0, 0];
    const origin = [(-cells[0] * dx) / 2, (-cells[1] * dx) / 2];
    const world = new PhysicsWorld({
      rate: { num: 60, den: 1 },
      gravity: [0, -gravity, 0],
      memory: worldMemory(shared),
    });
    using physics = new Physics(null, {
      arena: world.arena,
      fixedTimestep: dt,
      substeps: 1,
      gravity: [0, -gravity, 0],
    });
    const body = physics.addBody(null, {
      position: [-1.5, 0, 0.5],
      linearVelocity: [1.25, 0, 0],
      enabledTranslations: [true, false, false],
      lockRotations: true,
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass },
    });
    let wake;
    const surge = reaction
      ? new SurgeWakeCoupling({
          row: body.row,
          mesh,
          waterline: 0,
          depth: bed,
          depths,
          cells,
          cellSize: dx,
          centre,
          density,
          finiteReceiver: () => wake,
        })
      : undefined;
    const hull = new HullSolver('hull', reaction ? undefined : { minimumRadius: dx, submergedAdvance: depths });
    wake = new FiniteQuayWake('wake', { submerged: surge?.submergedSource ?? hull.submergedWakeSource });
    const plane = cells[0] * cells[1];
    const openZ = new Float64Array(4 * plane).fill(1);
    for (let x = 9; x < 27; x++) openZ[x + 6 * cells[0]] = openZ[x + 6 * cells[0] + plane] = 0;
    world
      .add(new RigidSolver(), { physics })
      .add(hull, {
        hulls: [{ row: body.row, mesh }],
        sea: { density, elevation: () => 0 },
        addedMass: false,
        radiation: false,
        drag: false,
        diffraction: false,
        drift: false,
        slamming: false,
        greenWater: false,
        rollDamping: false,
      })
      .add(wake, {
        cells,
        cellSize: dx,
        origin,
        depths: [0, 0.2, 0.5, 0.9, bed],
        openZ,
        density,
        sponge: { cells: 3, rate: 2 },
      });
    if (surge) world.add(surge, undefined);
    world.couple(surge ? ['hull', 'surgeWake', 'wake', 'rigid'] : ['hull', 'wake', 'rigid'], 'staggered');
    const zero = world.takeSnapshot();
    const initial = 0.5 * mass * body.linearVelocity[0] ** 2;
    let maximum = 0,
      scale = 0;
    for (let tick = 1; tick <= 48; tick++) {
      world.advance(tick);
      const { absorbedJoules, joules } = wake.work();
      const wave = wake.energy();
      assert.ok(Math.abs(wave + absorbedJoules - joules) < 1e-8);
      const total = wave + absorbedJoules + 0.5 * mass * body.linearVelocity[0] ** 2;
      maximum = Math.max(maximum, Math.abs(total - initial));
      scale += total;
    }
    const hash = world.hash(),
      accounted = wake.energy() + wake.work().absorbedJoules;
    world.restoreSnapshot(zero.bytes);
    world.advance(48);
    assert.equal(world.hash(), hash);
    return {
      hash,
      maximum,
      roundoff: 4 * 2 ** -24 * scale,
      wave: accounted,
      absorbed: wake.work().absorbedJoules,
      speed: body.linearVelocity[0],
    };
  }
  const coupled = run(true, false),
    uncoupled = run(false, false);
  assert.deepEqual(run(true, true), coupled);
  assert.ok(coupled.wave > 20 && coupled.absorbed > 0 && coupled.speed < 1.25);
  assert.ok(coupled.maximum < coupled.roundoff, JSON.stringify(coupled));
  assert.ok(uncoupled.maximum > 20 && uncoupled.speed === 1.25, JSON.stringify(uncoupled));
  t.diagnostic(JSON.stringify({ coupled, uncoupled }));
});

test('a pre-existing wave starts a stationary hull on its negative-facing Z guide', (t) => {
  const sim = setup({
    axis: 'z',
    speed: 0,
    initial: (_x, z) => [0.025 * Math.sin((2 * Math.PI * z) / (nz * cellSize)), 0],
  });
  using _physics = sim.physics;
  const { world, body, surge } = sim;
  const before = sim.waveEnergy();
  assert.equal(body.linearVelocity[2], 0);
  world.advance(1);
  const [source, reaction] = surge.stateRegions();
  const values = regionWords(world.memory, source);
  const impulses = regionWords(world.memory, reaction);
  const at = body.row * IMPULSE_WORDS;
  assert.ok(Math.abs(impulses[at + 2]) > 0.1);
  assert.equal(impulses[at], 0);
  assert.equal(body.linearVelocity[0], 0);
  assert.ok(Math.abs(body.linearVelocity[2]) > 1e-4);
  let volume = 0;
  for (let i = 4; i < values.length; i += SUBMERGED_WAKE_WORDS) volume += values[i];
  assert.ok(Math.abs(volume) < 1e-13);
  const deltaWave = sim.waveEnergy() - before,
    deltaBody = sim.bodyEnergy();
  assert.ok(deltaWave < 0 && deltaBody > 0);
  assert.ok(Math.abs(deltaBody + deltaWave) < 4 * 2 ** -24 * deltaBody + 64 * Number.EPSILON * before);
  t.diagnostic(JSON.stringify({ deltaWave, deltaBody, impulse: impulses[at + 2] }));
});

test('guided surge replays across presentation clocks and snapshots', () => {
  const sims = [];
  const model = (rate = { num: 24, den: 1 }) => {
    const sim = setup({ rate });
    sims.push(sim);
    return sim.world;
  };
  try {
    frameRateIndependent(model);
    seekEqualsContinuous(() => model(), { at: 2, frames: 12 });
  } finally {
    for (const { physics } of sims) physics.dispose();
  }
});

test('bad prior-tick ports and an off-guide pose leave both current outputs intact', () => {
  const { world, physics, body, surge } = setup();
  using _physics = physics;
  world.advance(1);
  const position = world.fields.port(BODIES_FIELD.name);
  const mobility = world.fields.port(BODY_MOBILITY_FIELD.name);
  const wake = world.fields.port(WAKE_HEIGHT_FIELD.name);
  const readOutput = () => surge.stateRegions().map((region) => regionWords(world.memory, region).slice());
  const before = readOutput();
  const wrongBody = new WebAssembly.Memory({ initial: Math.ceil(position.region.byteLength / 65536) });
  const words = new Float32Array(wrongBody.buffer, 0, position.region.byteLength / 4);
  words.set(regionWords(world.memory, position.region));
  const offGuide = { ...position, region: { ...position.region, memory: wrongBody, byteOffset: 0 } };
  const context = (p = position, m = mobility, h = wake) => ({
    tick: wake.tick + 1,
    level: 0,
    cell: wake.cell,
    seed: 0,
    inputs: new Map([
      [position.field, p],
      [mobility.field, m],
      [wake.field, h],
    ]),
  });
  for (const ctx of [
    context(position, mobility, { ...wake, cell: [1, 0, 0] }),
    context(position, { ...mobility, tick: mobility.tick - 1 }),
    context({ ...position, region: { ...position.region, layout: 1 } }),
  ]) {
    assert.throws(() => surge.step(ctx, dt), /prior-tick.+#hydrodynamic-loads/);
    assert.deepEqual(readOutput(), before);
  }
  words[body.row * BODY_WORDS + 1] = 0.05;
  assert.throws(() => surge.step(context(offGuide), dt), /reference waterline.+#hydrodynamic-loads/);
  assert.deepEqual(readOutput(), before);
  words[body.row * BODY_WORDS + 1] = 0;
  words[body.row * BODY_WORDS] = 9;
  assert.throws(() => surge.step(context(offGuide), dt), /inside the wake grid.+#hydrodynamic-loads/);
  assert.deepEqual(readOutput(), before);
  const unlockedMemory = new WebAssembly.Memory({ initial: Math.ceil(mobility.region.byteLength / 65536) });
  const unlocked = new Float32Array(unlockedMemory.buffer, 0, mobility.region.byteLength / 4);
  unlocked.set(regionWords(world.memory, mobility.region));
  unlocked[body.row * BODY_MOBILITY_WORDS + 1] = 1 / mass;
  const wrongLocks = { ...mobility, region: { ...mobility.region, memory: unlockedMemory, byteOffset: 0 } };
  assert.throws(() => surge.step(context(position, wrongLocks), dt), /only its guide translation.+#hydrodynamic-loads/);
  assert.deepEqual(readOutput(), before);
});

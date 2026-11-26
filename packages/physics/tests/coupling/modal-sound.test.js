import assert from 'node:assert/strict';
import test from 'node:test';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { Physics } from '../../dist/index.js';
import { MODAL_CONTACT_WORDS, ModalContactRigidSolver, ModalSoundSolver } from '@margoengine/physics/modal-sound';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const FPS = { num: 60, den: 1 };
const centre = [0, 0, 0];
const mode = { frequency: 400, decay: 25, gain: 0.2 };
const oneMode = [{ material: { modes: [mode] } }];

class LoadSource {
  constructor(sound, load, fracture, level = 0) {
    this.contact = sound.contactField;
    this.fracture = sound.fractureField;
    this.load = load;
    this.break = fracture;
    this.level = level;
  }
  describe() {
    return {
      id: 'sound-source',
      rate: this.level,
      stableRate: () => this.level,
      fields: [this.contact, this.fracture].map((field) => ({ field, access: 'write' })),
    };
  }
  init(host) {
    this.memory = host.memory;
    this.contactRegion = host.allocate('contact', MODAL_CONTACT_WORDS * 8, 'f64', 1);
    this.fractureRegion = host.allocate('fracture', 8, 'f64', 1);
  }
  step({ tick }) {
    regionWords(this.memory, this.contactRegion).set(this.load(tick));
    regionWords(this.memory, this.fractureRegion)[0] = this.break(tick);
  }
  exportPorts(tick) {
    return [
      { field: this.contact.name, region: this.contactRegion, tick, cell: centre },
      { field: this.fracture.name, region: this.fractureRegion, tick, cell: centre },
    ];
  }
  importPorts() {}
  stateRegions() {
    return [this.contactRegion, this.fractureRegion];
  }
  extraState() {
    return [];
  }
}

const quiet = () => [0, 0, 0, 0, 0];
const peak = (values) => values.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
const energy = (values) => values.reduce((a, v) => a + v * v, 0);

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `got ${actual}, expected ${expected} ± ${tolerance}`);
}

test('ModalSoundSolver produces FoleyAutomatic Eq. 1 on the audio clock', async () => {
  const sound = await ModalSoundSolver.load();
  const source = new LoadSource(
    sound,
    (tick) => [tick === 0 ? 0.7 : 0, 0, 0, 0, 0],
    () => 0,
  );
  const world = new PhysicsWorld({ rate: FPS }).add(sound, { tracks: oneMode }).add(source, {});
  assert.equal(sound.copyBlock(), null);
  world.advance(1);
  const first = sound.copyBlock();
  assert.equal(first.firstSample, 0);
  assert.equal(first.sampleRate, 48000);
  assert.equal(first.samples.length, 800);
  world.advance(2);
  const second = sound.copyBlock();
  assert.equal(second.firstSample, 800);
  for (const block of [first, second]) {
    for (const [i, y] of block.samples.entries()) {
      const t = (block.firstSample + i) / block.sampleRate;
      // Accumulated f64 roundoff is far below the f32 output quantization of at most half an ulp.
      near(y, 0.7 * mode.gain * Math.exp(-mode.decay * t) * Math.sin(2 * Math.PI * mode.frequency * t), 8e-9);
    }
  }
});

test('ModalSoundSolver clocks 44.1 kHz exactly against a 120 Hz world and does not repeat a slower impulse', async () => {
  const sound = await ModalSoundSolver.load({ rate: 1, inputs: 'fractures' });
  const source = new LoadSource(sound, quiet, (tick) => (tick === 0 ? 0.5 : 0), 0);
  const world = new PhysicsWorld({ rate: { num: 120, den: 1 } })
    .add(source, {})
    .add(sound, { tracks: oneMode, sampleRate: 44100 });
  let total = 0;
  let onset;
  for (let frame = 1; frame <= 120; frame++) {
    world.advance(frame);
    const { firstSample, samples } = sound.copyBlock();
    assert.equal(firstSample, total);
    assert.ok(samples.length === 367 || samples.length === 368);
    if (peak(samples) > 0) onset ??= firstSample;
    for (let i = 0; i < samples.length; i++) {
      const t = (firstSample + i - onset) / 44100;
      if (onset !== undefined)
        near(
          samples[i],
          0.5 * mode.gain * Math.exp(-mode.decay * t) * Math.sin(2 * Math.PI * mode.frequency * t),
          5e-9,
        );
    }
    total += samples.length;
  }
  assert.equal(onset, 367);
  assert.equal(total, 44100);
});

test('ModalSoundSolver resolves the analytic convolution of a sampled roughness profile', async () => {
  const sound = await ModalSoundSolver.load();
  const sampleRate = 8000;
  const seed = 23;
  const source = new LoadSource(
    sound,
    () => [0, 4, 4, 0, 0],
    () => 0,
  );
  const world = new PhysicsWorld({ rate: FPS, seed }).add(sound, { tracks: oneMode, sampleRate }).add(source, {});
  world.advance(1);
  const { samples } = sound.copyBlock();
  const tau = 2 * Math.PI;
  const random = new RandomStream(seed, solverNumber(sound.id));
  const phase = Array.from({ length: 4 }, (_, i) => tau * random.unitF64(0, 0, i)[0]);
  const distances = [0.71, 1.13, 1.87, 2.79];
  const weights = [0.52, 0.24, 0.15, 0.09];
  const force = (j) => {
    const t = j / sampleRate;
    const profile = weights.reduce((sum, a, k) => sum + a * Math.cos(phase[k] - (tau * distances[k] * t) / 0.006), 0);
    return 0.8 * (1 - Math.exp(-(j + 1) / (sampleRate * 0.003))) * profile;
  };
  const w = tau * mode.frequency;
  const slope = (t) =>
    (Math.exp(-mode.decay * t) * (mode.decay * Math.sin(w * t) + w * Math.cos(w * t))) / (mode.decay ** 2 + w ** 2);
  const steps = Array.from(samples, (_, i) => slope(i / sampleRate));
  for (let i = 1; i < samples.length; i++) {
    const exact = steps.slice(0, i).reduce((sum, a, j) => sum + force(i - j - 1) * (a - steps[j + 1]), 0);
    near(samples[i], mode.gain * exact, 5e-11);
  }
});

test('ModalSoundSolver retains complete audio at 24 fps and wraps its history without gaps', async () => {
  async function create(rate) {
    const sound = await ModalSoundSolver.load();
    const source = new LoadSource(
      sound,
      (tick) => [tick % 5 === 0 ? 0.23 : 0, 2, 2, 0, 0],
      () => 0,
    );
    return {
      sound,
      world: new PhysicsWorld({ rate }).add(sound, { tracks: oneMode, historySeconds: 0.125 }).add(source, {}),
    };
  }
  const film = await create({ num: 24, den: 1 });
  const fixed = await create(FPS);
  const recorded = new Float32Array(48000);
  let cursor = 0;
  for (let f = 1; f <= 24; f++) {
    film.world.advance(f);
    const block = film.sound.copySince(cursor);
    assert.equal(block.firstSample, cursor);
    recorded.set(block.samples, cursor);
    cursor += block.samples.length;
  }
  assert.equal(cursor, 48000);
  for (let f = 1; f <= 60; f++) {
    fixed.world.advance(f);
    const block = fixed.sound.copyBlock();
    assert.deepEqual(recorded.subarray(block.firstSample, block.firstSample + block.samples.length), block.samples);
  }
  assert.equal(film.sound.copySince(cursor), null);
  assert.throws(() => film.sound.copySince(0), /42000 through 48000/);
  assert.deepEqual(film.sound.copySince(42001).samples, recorded.slice(42001));
});

test('ModalSoundSolver restores input history, seeded phase, force envelope and PCM on plain/shared memory', async () => {
  function create(builds, rate, shared, seed = 47) {
    // Each factory is called with a fresh compiled instance so its arena belongs to one world.
    const sound = builds.shift();
    const loads = new LoadSource(
      sound,
      (tick) => [tick === 20 ? 0.5 : 0, 5, 5, 2, 4],
      () => 0,
    );
    return new PhysicsWorld({ rate, memory: worldMemory(shared), seed }).add(sound, { tracks: oneMode }).add(loads, {});
  }
  const builds = await Promise.all(Array.from({ length: 9 }, () => ModalSoundSolver.load()));
  frameRateIndependent((rate) => create(builds, rate, true));
  seekEqualsContinuous(() => create(builds, { num: 24, den: 1 }, false));
  const plain = create(builds, FPS, false);
  const shared = create(builds, FPS, true);
  const otherSeed = create(builds, FPS, true, 48);
  plain.advance(40);
  shared.advance(40);
  otherSeed.advance(40);
  assert.equal(plain.hash(), shared.hash());
  assert.notEqual(shared.hash(), otherSeed.hash());
});

function rigidScenario(
  sound,
  { material = 'wood', y = 1, speed = 0, spin = 0, friction = 0, gravity = [0, -9.81, 0] } = {},
) {
  const physics = new Physics(null, { gravity, fixedTimestep: 1 / 60 });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.1, 0],
    colliders: { shape: 'box', halfExtents: [25, 0.1, 4], friction },
  });
  const ball = physics.addBody(null, {
    position: [0, y, 0],
    linearVelocity: [speed, 0, 0],
    angularVelocity: [0, 0, spin],
    colliders: { shape: 'sphere', radius: 0.25, mass: 1, friction },
  });
  const world = new PhysicsWorld({ rate: FPS, gravity })
    .add(sound, { tracks: [{ material }] })
    .add(new ModalContactRigidSolver(sound), { physics, emitters: [ball] });
  return { world, physics, ball };
}

test('ModalContactRigidSolver turns a real dropped body into material-dependent ringing and quiet support', async () => {
  await Physics.load();
  const materials = ['wood', 'metal', 'glass', 'bell'];
  const solvers = await Promise.all(materials.map(() => ModalSoundSolver.load()));
  const scenarios = solvers.map((sound, index) => rigidScenario(sound, { material: materials[index] }));
  const onset = scenarios.map(() => 0);
  const frames = scenarios.map(() => []);
  for (let frame = 1; frame <= 160; frame++) {
    for (const [idx, { world }] of scenarios.entries()) {
      world.advance(frame);
      const block = solvers[idx].copyBlock();
      const p = peak(block.samples);
      if (p > 0.01) onset[idx] ||= frame;
      if (onset[idx] && frame <= onset[idx] + 4) frames[idx].push(...block.samples);
    }
  }
  assert.equal(onset[0], onset[1]);
  assert.ok(onset[0] >= 22 && onset[0] <= 26, `ball falls 0.75 m, onset ${onset[0]} frames`);
  assert.ok(energy(frames[1]) > 3 * energy(frames[0]));
  for (const [index, sound] of solvers.entries()) {
    assert.ok(peak(frames[index]) > 0.01, `${materials[index]} rings`);
    assert.ok(peak(sound.copyBlock().samples) < 0.00015, `${materials[index]} silent after tail`);
  }
  assert.notDeepEqual(frames[2], frames[3]);
  const still = await ModalSoundSolver.load();
  const { world } = rigidScenario(still, { y: 0.25 });
  for (let frame = 1; frame <= 60; frame++) {
    world.advance(frame);
    assert.equal(peak(still.copyBlock().samples), 0);
  }
  for (const { physics } of scenarios) physics.dispose();
});

test('ModalContactRigidSolver separates relative slip from a rolling point with near-zero tangential slip', async () => {
  await Physics.load();
  const materials = [
    { modes: [{ ...mode, scrape: 1, roll: 0 }], scrapeSpacing: 0.004 },
    { modes: [{ ...mode, scrape: 0, roll: 1 }], rollSpacing: 0.004 },
  ];
  const profiles = [
    { y: 0.25, speed: 2, spin: 0, friction: 0.1 },
    { y: 0.25, speed: 2, spin: -8, friction: 0.1 },
  ];
  const solvers = await Promise.all(Array.from({ length: 4 }, () => ModalSoundSolver.load()));
  const power = solvers.map((sound, i) => {
    const { world, physics } = rigidScenario(sound, { ...profiles[i >> 1], material: materials[i % 2] });
    let output = 0;
    for (let f = 1; f <= 6; f++) {
      world.advance(f);
      output += energy(sound.copyBlock().samples);
    }
    physics.dispose();
    return output;
  });
  assert.ok(power[0] > 1e-6, `slide is heard: ${power}`);
  assert.ok(power[3] > 1e-6, `roll is heard: ${power}`);
  assert.ok(power[0] > 40 * power[2], `scrape rejects rolling: ${power}`);
  assert.ok(power[3] > 40 * power[1], `roll rejects sliding: ${power}`);
});

test('ModalContactRigidSolver sounds a real joint rupture once and replays before and after the break', async () => {
  await Physics.load();
  const sound = await ModalSoundSolver.load({ inputs: 'both' });
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  const anchor = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, {
    position: [0, -2, 0],
    colliders: { shape: 'sphere', radius: 0.25, mass: 10 },
  });
  const joint = physics.addJoint(anchor, weight, { type: 'spherical', anchorB: [0, 2, 0], breakForce: 50 });
  const rigid = new ModalContactRigidSolver(sound, {
    jointBreaks: [{ joint, track: 0, energy: 0.25, effectiveMass: 0.5 }],
  });
  const world = new PhysicsWorld({ rate: FPS })
    .add(rigid, { physics, emitters: [weight] })
    .add(sound, { tracks: oneMode });
  const start = world.takeSnapshot();
  let onset;
  let atBreak;
  for (let f = 1; f <= 16; f++) {
    world.advance(f);
    const block = sound.copyBlock();
    if (!joint.broken) assert.equal(peak(block.samples), 0);
    if (peak(block.samples) > 0) {
      if (!onset) {
        onset = f;
        atBreak = world.takeSnapshot();
      }
      for (let i = 0; i < block.samples.length; i++) {
        const t = ((f - onset) * 800 + i) / 48000;
        near(
          block.samples[i],
          0.5 * mode.gain * Math.exp(-mode.decay * t) * Math.sin(2 * Math.PI * mode.frequency * t),
          5e-9,
        );
      }
    }
  }
  assert.ok(onset && onset <= 10);
  const final = world.hash();
  world.restoreSnapshot(atBreak.bytes);
  world.advance(16);
  assert.equal(world.hash(), final);
  world.restoreSnapshot(start.bytes);
  world.advance(16);
  assert.equal(world.hash(), final);
  physics.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { SpectralSea } from '../../dist/sea.js';
import { HullSolver, stillWaterline } from '../../dist/seakeeping.js';
import { FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';
import { kvlcc2Hull } from './kvlcc2-hull.js';

const LENGTH = 3.2;
const BEAM = 0.58;
const DRAFT = 0.208;
const VERTICAL_CENTRE_OF_MASS = 0.1856;
const DRAFT_UNCERTAINTY = 0.001;
const DEPTH = 3.5;
const DENSITY = 997.8;
const GRAVITY = 9.799;
const WAVE_AMPLITUDE = 0.016;
const SPEED = 0.142 * Math.sqrt(GRAVITY * LENGTH);
const MASS = DENSITY * 0.312622;
const PITCH_RADIUS = 0.25 * LENGTH;
const STEP_RATE = 60;
const MEMORY = 20;
const CYCLES = 6;

function headSea(wavelengthRatio) {
  const waveNumber = (2 * Math.PI) / (wavelengthRatio * LENGTH);
  const omega = Math.sqrt(GRAVITY * waveNumber * Math.tanh(waveNumber * DEPTH));
  const hz = omega / (2 * Math.PI);
  const frequencies = Float64Array.of(0.8 * hz, hz, 1.2 * hz);
  const directions = Float64Array.of(0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2);
  const energy = new Float64Array(frequencies.length * directions.length);
  energy[6] = (WAVE_AMPLITUDE * WAVE_AMPLITUDE) / (2 * (frequencies[2] - hz) * (Math.PI / 2));
  const sea = new SpectralSea({
    waves: { frequencies, directions, energy, depth: DEPTH, density: DENSITY },
    gravity: GRAVITY,
    seed: 17,
  });
  const row = new Float32Array(4);
  assert.equal(sea.waveComponents(0, row), 1);
  assert.ok(Math.abs(row[0] + waveNumber) <= 2 ** -23 * waveNumber);
  assert.ok(Math.abs(row[2] - WAVE_AMPLITUDE) <= 2 ** -23 * WAVE_AMPLITUDE);
  return { sea, waveNumber, encounter: omega + waveNumber * SPEED };
}

/** Integrate over complete encounters, using linear partial steps at both endpoints. */
function periodMean(samples, end, span) {
  const start = end - span;
  let integral = 0;
  for (let i = Math.floor(start); i < Math.ceil(end); i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const left = Math.max(0, start - i);
    const right = Math.min(1, end - i);
    integral += (right - left) * (a + 0.5 * (left + right) * (b - a));
  }
  return integral / span;
}

function measuredWaves(wavelengthRatio, stride, shortWaveResistance = true) {
  const mesh = kvlcc2Hull({
    length: LENGTH,
    freeboard: 0.29 - DRAFT,
    centre: [0.0348 * LENGTH, VERTICAL_CENTRE_OF_MASS - DRAFT],
    stride,
  });
  const referenceWaterline = stillWaterline(mesh, MASS, DENSITY);
  if (stride === 1) {
    const nominalWaterline = DRAFT - VERTICAL_CENTRE_OF_MASS;
    assert.ok(
      Math.abs(referenceWaterline - nominalWaterline) <= DRAFT_UNCERTAINTY,
      `Reference waterline ${referenceWaterline} differs from ${nominalWaterline} beyond the measured draft uncertainty`,
    );
  }
  const { sea, waveNumber, encounter } = headSea(wavelengthRatio);
  const gravity = [0, -GRAVITY, 0];
  using physics = new Physics(null, { fixedTimestep: 1 / STEP_RATE, gravity, substeps: 1 });
  const body = physics.addBody(null, {
    position: [0, -referenceWaterline, 0],
    linearVelocity: [SPEED, 0, 0],
    enabledTranslations: [true, true, false],
    enabledRotations: [false, false, true],
    colliders: {
      shape: 'box',
      halfExtents: [LENGTH / 2, 0.14, BEAM / 2],
      massProperties: {
        mass: MASS,
        centerOfMass: [0, 0, 0],
        principalInertia: [1, MASS * PITCH_RADIUS * PITCH_RADIUS, MASS * PITCH_RADIUS * PITCH_RADIUS],
      },
    },
  });
  const hull = new HullSolver();
  const world = new PhysicsWorld({ rate: { num: STEP_RATE, den: 1 }, gravity })
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh, course: { speed: SPEED }, shortWaveResistance }],
      sea,
      gravity,
      memory: MEMORY,
      drift: false,
      drag: false,
      greenWater: false,
      rollDamping: false,
      slamming: false,
    })
    .couple(['hull', 'rigid'], 'staggered');
  const period = (2 * Math.PI * STEP_RATE) / encounter;
  const windowEnd = Math.ceil(MEMORY * STEP_RATE + 2 * CYCLES * period);
  const force = new Float64Array(windowEnd + 1);
  const heaveCos = new Float64Array(windowEnd + 1);
  const heaveSin = new Float64Array(windowEnd + 1);
  const pitchCos = new Float64Array(windowEnd + 1);
  const pitchSin = new Float64Array(windowEnd + 1);
  for (let frame = 1; frame <= windowEnd; frame++) {
    // The tank keeps the carriage speed fixed. Heave and pitch are solved freely.
    body.setLinearVelocity([SPEED, body.linearVelocity[1], 0]);
    world.advance(frame);
    const values = regionWords(world.arena.memory, hull.exportPorts(frame)[0].region);
    force[frame] = -values[body.row * FORCE_WORDS];
    const angle = (frame * encounter) / STEP_RATE;
    const heave = body.position[1] + referenceWaterline;
    const pitch = 2 * Math.asin(body.rotation[2]);
    heaveCos[frame] = heave * Math.cos(angle);
    heaveSin[frame] = heave * Math.sin(angle);
    pitchCos[frame] = pitch * Math.cos(angle);
    pitchSin[frame] = pitch * Math.sin(angle);
  }
  const span = CYCLES * period;
  const scale = (DENSITY * GRAVITY * WAVE_AMPLITUDE * WAVE_AMPLITUDE * BEAM * BEAM) / LENGTH;
  const amplitude = (a, b) => 2 * Math.hypot(periodMean(a, windowEnd, span), periodMean(b, windowEnd, span));
  return {
    resistance: periodMean(force, windowEnd, span) / scale,
    priorResistance: periodMean(force, windowEnd - span, span) / scale,
    heave: amplitude(heaveCos, heaveSin) / WAVE_AMPLITUDE,
    pitch: amplitude(pitchCos, pitchSin) / (waveNumber * WAVE_AMPLITUDE),
    waterline: referenceWaterline,
  };
}

await Physics.load();

test('HullSolver: freely moving KVLCC2 holds out measured long head-wave resistance and motion', (context) => {
  // Park, Lee and Kim (2014), Tables 10–12, expanded 95% intervals from repeated towing runs.
  const [observed, expanded] = [0.8099, 0.4922];
  for (const stride of [2, 1]) {
    const receipt = measuredWaves(2, stride);
    context.diagnostic(JSON.stringify({ wavelengthRatio: 2, stride, observed, expanded, ...receipt }));
    assert.ok(Math.abs(receipt.resistance - observed) <= expanded);
    assert.ok(Math.abs(receipt.priorResistance - observed) <= expanded);
    assert.ok(Math.abs(receipt.heave - 0.8799) <= 0.04024);
    assert.ok(Math.abs(receipt.pitch - 0.9735) <= 0.07355);
  }
});

test('HullSolver: KVLCC2 meets held-out near-resonant resistance, heave and pitch with reflection', (context) => {
  const withReflection = measuredWaves(1.1, 1);
  const withoutReflection = measuredWaves(1.1, 1, false);
  const measured = {
    resistance: { mean: 7.195, expanded: 0.7072 },
    heave: { mean: 0.73, expanded: 0.0371 },
    pitch: { mean: 0.5521, expanded: 0.04158 },
  };
  context.diagnostic(JSON.stringify({ wavelengthRatio: 1.1, measured, withoutReflection, withReflection }));
  assert.ok(Math.abs(withReflection.resistance - measured.resistance.mean) <= measured.resistance.expanded);
  assert.ok(Math.abs(withReflection.priorResistance - measured.resistance.mean) <= measured.resistance.expanded);
  assert.ok(Math.abs(withReflection.heave - measured.heave.mean) <= measured.heave.expanded);
  assert.ok(Math.abs(withReflection.pitch - measured.pitch.mean) <= measured.pitch.expanded);
});

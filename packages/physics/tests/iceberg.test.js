import assert from 'node:assert/strict';
import test from 'node:test';

import { icebergCriticalAspect, IcebergSolver } from '../dist/iceberg.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const gravity = 9.80665;
const iceDensity = 917;
const waterDensity = 1025;
const ratio = iceDensity / waterDensity;

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} differs from ${expected} by more than ${bound}`);
}

async function iceberg(spec, params = {}) {
  const berg = await IcebergSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0] }).add(berg, {
    bodies: [spec],
    ...params,
  });
  return { berg, world };
}

test('stable blocks float at the Archimedean draft with exact volume and no spurious heave or roll', async () => {
  const [width, height, length] = [8, 4, 12];
  const seaLevel = 10;
  const volume = width * height * length;
  const { berg, world } = await iceberg({ size: [width, height, length] }, { seaLevel });
  const equilibrium = seaLevel + height * (0.5 - ratio);
  world.advance(300);
  const sample = berg.sample(0);
  near(sample.position[1], equilibrium, 300 * 16 * Number.EPSILON * seaLevel);
  near(sample.displaced, ratio * volume, 300 * 24 * Number.EPSILON * volume);
  near(sample.spin[2], 0, 300 * 32 * Number.EPSILON);
  near(sample.waveVolume, 0, 300 * 32 * Number.EPSILON * volume);
  assert.equal(berg.budget.ice, volume);
});

test('frictionless heave agrees with the analytically bounded harmonic oscillator', async () => {
  const size = [8, 4, 12];
  const centre = size[1] * (0.5 - ratio);
  const height = 0.125;
  const { berg, world } = await iceberg({ size, position: [0, centre + height, 0] }, { waterDrag: 0, airDrag: 0 });
  const ticks = 60;
  const omega = Math.sqrt(gravity / (ratio * size[1]));
  const phase = omega / 60;
  const verletPhase = Math.acos(1 - 0.5 * phase * phase);
  world.advance(ticks);
  const actual = berg.sample(0).position[1];
  near(actual, centre + height * Math.cos(ticks * verletPhase), 256 * Number.EPSILON * Math.abs(centre));
  near(actual, centre + height * Math.cos(omega), height * ticks * (verletPhase - phase) + 256 * Number.EPSILON);
});

test('a narrow block capsizes from hydrostatic torque while a wider block with the same heel is stable', async () => {
  const s = 0.001;
  const orientation = [0, 0, s, Math.sqrt(1 - s * s)];
  const tall = await iceberg({ size: [1, 4, 8], orientation });
  const wide = await iceberg({ size: [5, 4, 8], orientation });
  assert.ok(1 / 4 < icebergCriticalAspect(iceDensity, waterDensity));
  assert.ok(5 / 4 > icebergCriticalAspect(iceDensity, waterDensity));
  tall.world.advance(1);
  wide.world.advance(1);
  assert.ok(tall.berg.sample(0).spin[2] > 0);
  assert.ok(wide.berg.sample(0).spin[2] < 0);
  tall.world.advance(1200);
  wide.world.advance(1200);
  const moving = tall.berg.sample(0);
  assert.ok(Math.abs(moving.orientation[2]) > 0.5, 'the narrow block rolls more than 60 degrees');
  assert.ok(Math.abs(wide.berg.sample(0).orientation[2]) < 2 * s, 'the wide block stays near upright');
  near(
    moving.orientation.reduce((sum, word) => sum + word * word, 0),
    1,
    8 * Number.EPSILON,
  );
  assert.equal(tall.berg.budget.ice, 32);
});

test('default mechanical perturbation excites an unstable roll and only moves a stable block by roundoff', async () => {
  const { berg, world } = await iceberg({ size: [1, 4, 8] });
  const first = berg.sample(0).orientation;
  assert.ok(first[2] > 0);
  world.advance(120);
  assert.ok(berg.sample(0).orientation[2] > first[2]);
  const stable = await iceberg({ size: [5, 4, 8] });
  assert.deepEqual(stable.berg.sample(0).orientation, [0, 0, 0, 1]);
});

test('uniform water current and air flow accelerate a block in their respective directions', async () => {
  const size = [8, 4, 12];
  const water = await iceberg({ size }, { current: [1, 0, 0], airDrag: 0 });
  const air = await iceberg({ size }, { wind: [0, 0, -1], waterDrag: 0 });
  water.world.advance(60);
  air.world.advance(60);
  assert.ok(water.berg.sample(0).velocity[0] > 0);
  assert.ok(air.berg.sample(0).velocity[2] < 0);
  near(water.berg.sample(0).velocity[2], 0, 60 * 64 * Number.EPSILON);
  near(air.berg.sample(0).velocity[0], 0, 60 * 64 * Number.EPSILON);
});

test('basal ablation uses wetted area and conserves the solid and released freshwater volumes', async () => {
  const size = [8, 4, 12];
  const initial = size[0] * size[1] * size[2];
  const rate = 0.125;
  const { berg, world } = await iceberg({ size }, { basalMelt: rate, waterDrag: 0, airDrag: 0 });
  world.advance(60);
  const expected = rate * size[0] * size[2];
  near(berg.sample(0).size[1], size[1] - rate, 60 * 8 * Number.EPSILON * size[1]);
  near(berg.budget.melted, expected, 60 * 8 * Number.EPSILON * initial);
  near(berg.budget.ice + berg.budget.melted, initial, 60 * 4 * Number.EPSILON * initial);
});

test('the loader validates source units and preserves abort reasons', async () => {
  await assert.rejects(IcebergSolver.load({ calving: { unit: 'm^3/s' } }), /field in cubic metres/);
  await assert.rejects(iceberg({ size: [8, 0, 12] }), /dimension y/);
  await assert.rejects(iceberg({ size: [8, 4, 12] }, { waterDensity: iceDensity }), /less dense/);
  const reason = new Error('cancel iceberg load');
  await assert.rejects(IcebergSolver.load({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
});

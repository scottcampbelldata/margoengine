// The waves' coupling checks (SEA-01): `WaveSolver` held to the harness, the same sea at 24, 30 and 60 frames a second and
// a seek equal to a continuous run, with a wind sea growing and a swell coming in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WaveSolver } from '../../dist/waves.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const wind = {
  medium: 'air',
  cell: [0, 0, 0],
  sample(_x, _y, _z, t, out = { velocity: [0, 0, 0], density: 1.225, temperature: 288 }) {
    out.velocity[0] = 9 + 2 * Math.sin(t / 600);
    out.velocity[1] = 0;
    out.velocity[2] = 3;
    return out;
  },
};

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new WaveSolver(), {
    cells: [4, 3],
    cellSize: 600,
    wind,
    swell: { height: 1, period: 9, direction: 0.4 },
    frequencies: { min: 0.05, max: 0.8, count: 12 },
    directions: 12,
    timeScale: 600,
    interval: 30,
  });

test('WaveSolver: the same sea at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('WaveSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

test('WaveSolver rejects a late wind sample without publishing any interval and then replays exactly', () => {
  const interval = 10,
    timeScale = 1200,
    waves = new WaveSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  let fail = false,
    sampledCell;
  const input = {
    medium: 'air',
    cell: [-3, 1, 4],
    sample(x, y, z, t) {
      sampledCell = [x, y, z];
      const failing = fail && t === 30 / timeScale && x > 500;
      return { velocity: [failing ? Number.NaN : 18, 0, 2], density: 1.225, temperature: 288 };
    },
  };
  world.add(waves, {
    cells: [2, 1],
    cellSize: 100,
    originCellSize: 512,
    depth: 12,
    wind: input,
    interval,
    timeScale,
    directions: 8,
    frequencies: { min: 0.08, max: 0.8, count: 10 },
    start: { height: 0.8, period: 6, direction: 0.2 },
  });
  world.setCell('waves', [-2, 1, 3]);
  world.advance(1);
  assert.equal(waves.time, 20);
  assert.deepEqual(sampledCell, [562, 10, -512]);
  assert.deepEqual(waves.field.cell, [-2, 1, 3]);
  const baseline = world.takeSnapshot();
  const readOwned = () =>
    [...waves.stateRegions(), ...waves.extraState()].map(({ byteOffset, byteLength }) =>
      new Uint8Array(world.memory.buffer, byteOffset, byteLength).slice(),
    );
  const before = readOwned();
  fail = true;
  assert.throws(
    () => world.advance(2),
    (e) => e.code === 'unsupported' && /return|supply/.test(e.message) && e.message.includes('errors#wave-spectrum'),
  );
  assert.deepEqual(readOwned(), before);
  assert.equal(waves.time, 20);

  fail = false;
  world.advance(2);
  const reached = world.takeSnapshot();
  assert.equal(waves.time, 40);
  assert.notDeepEqual(readOwned(), before);
  world.restoreSnapshot(baseline.bytes);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot(), reached);

  world.shiftOrigin([-2, 3, 0]);
  assert.deepEqual(waves.field.cell, [0, -2, 3]);
  world.restoreSnapshot(baseline.bytes);
  assert.deepEqual(waves.field.cell, [-2, 1, 3]);
});

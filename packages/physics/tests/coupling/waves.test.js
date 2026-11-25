// The waves' coupling checks (SEA-01): `WaveSolver` held to the harness, the same sea at 24, 30 and 60 frames a second and
// a seek equal to a continuous run, with a wind sea growing and a swell coming in.
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

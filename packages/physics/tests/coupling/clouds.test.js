// The clouds' coupling checks (ATMO-03): `CloudSolver` held to the harness, the same clouds at 24, 30 and 60 frames a
// second and a seek equal to a continuous run, with a warm moist bubble rising, condensing and drifting in a wind.
import test from 'node:test';
import { CloudSolver } from '../../dist/clouds.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const wind = {
  medium: 'air',
  cell: [0, 0, 0],
  sample(_x, _y, _z, t, out = { velocity: [0, 0, 0], density: 1.2, temperature: 290 }) {
    out.velocity[0] = 4 + Math.sin(t);
    out.velocity[1] = 0;
    out.velocity[2] = 1;
    return out;
  },
};

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new CloudSolver(), {
    cells: [8, 6, 8],
    cellSize: 120,
    wind,
    timeScale: 30,
    interval: 1,
    bubbles: [{ centre: [0, 250, 0], radius: 300, warming: 2, humidity: 1.05 }],
  });

test('CloudSolver: the same clouds at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('CloudSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

// The shallow water's coupling checks (HYDRO-01): `ShallowWaterSolver` held to the harness, the same flood at 24, 30 and 60
// frames a second and a seek equal to a continuous run, with a dam breaking down a slope, a river pouring in and rain.
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const columns = 12,
  rows = 6,
  shape = { columns, rows, width: 60, depth: 30, centre: [30, 15] },
  elevations = new Float64Array((columns + 1) * (rows + 1));
for (let c = 0; c <= columns; c++)
  for (let r = 0; r <= rows; r++) elevations[r + (rows + 1) * c] = 2 - 0.03 * 5 * c + 0.1 * Math.sin(r);
const bed = bedSurface(shape, elevations),
  rain = { cell: [0, 0, 0], sample: (_x, _y, _z, t) => ({ rain: { rate: 20 + 10 * Math.sin(t) } }) };

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new ShallowWaterSolver(), {
    bed,
    level: (x) => (x < 15 ? 3 : -10),
    inflows: [{ position: [2, 15], discharge: (t) => 2 + Math.sin(t) }],
    rain,
    sides: { maxX: 'open' },
  });

test('ShallowWaterSolver: the same flood at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('ShallowWaterSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

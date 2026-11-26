// The surf's coupling checks (SEA-05): `SurfSolver` driving a `ShallowWaterSolver`, held to the harness: the same surf beat,
// set-up and run-up at 24, 30 and 60 frames a second, and a seek equal to a continuous run.
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { SurfSolver } from '../../dist/surf.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const nx = 30,
  nz = 2,
  shape = { columns: nx, rows: nz, width: 60, depth: 8, centre: [30, 4] },
  elevations = new Float64Array((nx + 1) * (nz + 1));
for (let c = 0; c <= nx; c++) for (let r = 0; r <= nz; r++) elevations[r + (nz + 1) * c] = -1.2 + 0.03 * 2 * c;
const bed = bedSurface(shape, elevations);

const make = (rate = { num: 24, den: 1 }) => {
  const water = new ShallowWaterSolver();
  return new PhysicsWorld({ rate })
    .add(water, { bed, level: 0, sides: { minX: { sea: 0 }, minZ: 'periodic', maxZ: 'periodic' } })
    .add(new SurfSolver(), {
      water,
      incident: { height: 0.4, period: 6, direction: 0.3 },
      alongshore: 'periodic',
      directions: 12,
    })
    .couple(['surf', 'water'], 'staggered');
};

test('SurfSolver: the same surf at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('SurfSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

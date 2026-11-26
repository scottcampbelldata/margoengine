// The surge's coupling checks (SEA-07): `SurgeSolver` forcing a `ShallowWaterSolver` with a moving low and the world's tide,
// held to the harness: the same surge at 24, 30 and 60 frames a second, and a seek equal to a continuous run.
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { CelestialSolver } from '../../dist/celestial.js';
import { SurgeSolver } from '../../dist/surge.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const nx = 12,
  nz = 4,
  shape = { columns: nx, rows: nz, width: 12000, depth: 4000, centre: [6000, 2000] },
  elevations = new Float64Array((nx + 1) * (nz + 1)).fill(-30);
const bed = bedSurface(shape, elevations);

const make = (rate = { num: 24, den: 1 }) => {
  const water = new ShallowWaterSolver();
  return new PhysicsWorld({ rate })
    .add(new CelestialSolver(), { timeScale: 3600 })
    .add(water, { bed, level: 0, coriolis: { latitude: 0.8 } })
    .add(new SurgeSolver('surge', { tide: true }), {
      water,
      site: { latitude: 0.8, longitude: -1.5 },
      pressure: (x, z, t) => 101325 - 2000 * Math.exp(-((x - 200 * t) ** 2 + (z - 2000) ** 2) / 1e7),
    })
    .couple(['surge', 'water'], 'staggered');
};

test('SurgeSolver: the same surge at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('SurgeSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

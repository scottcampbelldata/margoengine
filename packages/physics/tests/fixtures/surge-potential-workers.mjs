import { CelestialSolver, TIDAL_POTENTIAL_FIELD } from '@margoengine/physics/celestial';
import { bedSurface } from '@margoengine/physics/earth';
import { ShallowWaterSolver, SURFACE_WATER_POTENTIAL_FIELD } from '@margoengine/physics/hydro';
import { SurgeSolver } from '@margoengine/physics/surge';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const delta = [4_100_000, -21_500_000, 17_300_000];
export const surgeCell = signedCell.map((value, i) => value - delta[i]);

export async function followSurgePotential(scenario, threads) {
  const [nx, nz] = scenario === 'combined' ? [17, 9] : scenario === 'pressure' ? [11, 5] : [9, 5];
  const dx = 8000;
  const dz = 6200;
  const width = nx * dx;
  const length = nz * dz;
  const shape = { columns: nx, rows: nz, width, depth: length, centre: [width / 2, length / 2] };
  const elevations = new Float64Array((nx + 1) * (nz + 1));
  for (let x = 0; x <= nx; x++)
    for (let z = 0; z <= nz; z++)
      elevations[z + (nz + 1) * x] = scenario === 'dry' ? 25 : x > nx - 4 ? 5 : -16 - x * 0.25 - 0.1 * z;
  const timeScale = 180;
  const pressure = (x, z, time) => 101325 - (420 + time * 3.5) * (1 - x / (2 * width)) + (180 * z) / length;
  const tide = scenario !== 'pressure';
  const bed = bedSurface(shape, elevations);
  const water = new ShallowWaterSolver();
  using surge = threads ? await SurgeSolver.load('surge', { tide }, { threads }) : new SurgeSolver('surge', { tide });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 4096, memory: worldMemory(threads > 1) });
  if (tide) world.add(new CelestialSolver(), { timeScale });
  world
    .add(water, { bed, level: 0, timeScale })
    .add(surge, { water, pressure, site: { latitude: 0.68, longitude: -0.9, north: 0.17 } })
    .setCell('water', signedCell)
    .setCell('surge', signedCell)
    .couple(['surge', 'water'], 'staggered');
  world.advance(2);
  const from = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    const work = [];
    for (let tick = 3; tick <= 6; tick++) {
      world.advance(tick);
      work.push(surge.readNativeWork());
    }
    const forcing = surge.exportPorts(world.tick).find(({ field }) => field === SURFACE_WATER_POTENTIAL_FIELD.name);
    const celestial = world.fields.port(TIDAL_POTENTIAL_FIELD.name);
    return {
      accepted: world.takeSnapshot(),
      potential: regionWords(world.memory, forcing.region).slice(),
      parts: surge.extraState().map((region) => regionWords(world.memory, region).slice()),
      bodyVectors: celestial ? regionWords(world.memory, celestial.region).slice() : undefined,
      water: water.sample(dx / 2, dz / 2),
      volume: water.volume(),
      cell: Array.from(forcing.cell),
      work,
    };
  }
  const result = run();
  world.restoreSnapshot(from.bytes);
  return { ...result, replay: run(), cells: nx * nz, tide, scenario };
}

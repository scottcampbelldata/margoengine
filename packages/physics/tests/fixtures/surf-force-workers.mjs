import { bedSurface } from '@margoengine/physics/earth';
import { ShallowWaterSolver, SURFACE_WATER_FORCING_FIELD } from '@margoengine/physics/hydro';
import { SURF_FIELD, SurfSolver } from '@margoengine/physics/surf';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const delta = [4_100_000, -21_500_000, 17_300_000];
export const rebasedCell = signedCell.map((value, i) => value - delta[i]);

export async function followSurfForce(oneDimensional, threads) {
  const [nx, nz, dx, dz] = oneDimensional ? [137, 1, 0.2, 1] : [25, 9, 0.5, 1.1];
  const directions = oneDimensional ? 17 : 23;
  const width = nx * dx;
  const length = nz * dz;
  const shape = { columns: nx, rows: nz, width, depth: length, centre: [width / 2, length / 2] };
  const elevations = new Float64Array((nx + 1) * (nz + 1));
  for (let x = 0; x <= nx; x++) {
    for (let z = 0; z <= nz; z++) {
      const ripple = oneDimensional ? 0 : 0.037 * Math.cos((2 * Math.PI * z) / nz);
      elevations[z + (nz + 1) * x] = -0.85 + (0.97 * x) / nx + ripple;
    }
  }
  const bed = bedSurface(shape, elevations);
  const water = new ShallowWaterSolver();
  using surf = threads ? await SurfSolver.load('surf', { threads }) : new SurfSolver();
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    cellSize: 4096,
    memory: worldMemory(threads > 1),
    seed: 0x235ef4a1,
  })
    .add(water, { bed, level: 0, sides: { minX: { sea: 0 }, minZ: 'periodic', maxZ: 'periodic' } })
    .add(surf, {
      water,
      incident: { height: 0.68, period: 6, direction: 0.24 },
      groups: false,
      alongshore: 'periodic',
      directions,
      breaking: { gamma: 0.47 },
      roller: { beta: 0.17 },
    })
    .setCell('water', signedCell)
    .setCell('surf', signedCell)
    .couple(['surf', 'water'], 'staggered');
  world.advance(8);
  const from = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    const work = [];
    for (const target of [12, 16, 20]) {
      world.advance(target);
      work.push(surf.readNativeWork());
    }
    const forcing = surf.exportPorts(world.tick).find(({ field }) => field === SURFACE_WATER_FORCING_FIELD.name);
    const shortWaves = world.fields.port(SURF_FIELD.name);
    return {
      accepted: world.takeSnapshot(),
      forcing: regionWords(world.memory, forcing.region).slice(),
      waves: regionWords(world.memory, shortWaves.region).slice(),
      water: water.sample(0.45, 0.5),
      cell: Array.from(forcing.cell),
      waveCell: Array.from(shortWaves.cell),
      work,
    };
  }
  const result = run();
  world.restoreSnapshot(from.bytes);
  return { ...result, replay: run(), cells: nx * nz, directions };
}

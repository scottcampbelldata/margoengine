import { FoamSolver } from '../../dist/foam.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const foamCell = [-954_302_365, 883_237_692, -841_726_227];
const waterCell = [foamCell[0] - 1, foamCell[1] + 1, foamCell[2] + 2];
const originStep = [0, 1, 0];
const frequencies = new Float64Array([0.08, 0.1, 0.13, 0.17]);
const directions = new Float64Array([0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]);
const spectrum = { frequencies, directions, energy: new Float64Array(16), depth: 100, density: 1025 };
const waves = {
  cell: foamCell,
  sample(_x, _z, out) {
    if (!out) return spectrum;
    out.energy.fill(0);
    out.depth = spectrum.depth;
    out.density = spectrum.density;
    return out;
  },
};

export async function foamTransportWorld(cells, threads) {
  const solver = threads === 0 ? new FoamSolver() : await FoamSolver.load({ threads });
  try {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 512, memory: worldMemory(false) });
    let invalid = false;
    const current = {
      medium: 'water',
      cell: waterCell,
      sample(x, _y, z, _time, out) {
        const localX = x - 512;
        const localZ = z + 1024;
        out.velocity[0] = invalid && localX > 2 && localZ > 0 ? Number.NaN : localX < 0 ? 10.5 : -10.5;
        out.velocity[1] = 0;
        out.velocity[2] = (localZ < 0 ? 7.75 : -7.75) + localX / 4;
        out.density = 1025;
        out.temperature = 288.15;
        return out;
      },
    };
    world.add(
      solver,
      { waves, current, cells, cellSize: 0.125, originCellSize: 512, windrows: false, windDrift: 0 },
      foamCell,
    );
    solver.addFoam([-1.25, -0.85], [-0.2, 0.4], 0.65, 2);
    solver.addFoam([-0.7, -0.65], [0.5, 0.6], 1, 7);
    solver.addFoam([0.45, -0.1], [1.35, 0.77], 0.78, 4);
    return {
      world,
      solver,
      fail: () => {
        invalid = true;
      },
      recover: () => {
        invalid = false;
      },
    };
  } catch (cause) {
    solver.dispose();
    throw cause;
  }
}

export async function foamTransportRun(cells, threads) {
  const { world, solver } = await foamTransportWorld(cells, threads);
  try {
    const port = () => {
      const { cell, region } = world.fields.port('seaFoam');
      return { cell: [...cell], values: regionWords(region.memory ?? world.memory, region).slice() };
    };
    const start = world.takeSnapshot();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const before = solver.meanCoverage();
    function finish() {
      world.shiftOrigin(originStep);
      world.advance(8);
      return {
        snapshot: world.takeSnapshot(),
        field: port(),
        mean: solver.meanCoverage(),
        centre: solver.coverage(0, 0),
        work: solver.workCounts(),
      };
    }
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredCell = port().cell;
    const replay = finish();
    return { start, accepted, replay, before, restoredCell, initialCell: foamCell };
  } finally {
    solver.dispose();
  }
}

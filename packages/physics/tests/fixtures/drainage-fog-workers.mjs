import { DrainageFog } from '../../dist/drainage-fog.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const far = [-955_121_884, 736_221_938, -804_221_539];
const delta = [1, -1, 2];

export async function fogWorkerRun(width, depth, threads, shared) {
  const size = width * depth;
  const perCell = (value) => Float64Array.from({ length: size }, (_, i) => value(i % width, Math.floor(i / width), i));
  let firstWind;
  const wind = {
    medium: 'air',
    cell: far.map((cell, axis) => cell - delta[axis]),
    sample(x, y, z) {
      firstWind ??= [x, y, z];
      return { velocity: [0.3 + x / 500, 0, -0.1 + z / 300], density: 1.225, temperature: 281 };
    },
  };
  const fog = await DrainageFog.load({ threads });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
  try {
    world.add(
      fog,
      {
        width,
        depth,
        origin: [-2, 1],
        spacing: [1.5, 1.25],
        terrain: perCell((x, z) => 4 - x * 0.018 + z * 0.023),
        initialDepth: perCell((_, __, i) => (i % 31 === 6 ? 0 : 0.5 + (i % 11) * 0.03)),
        initialTemperature: perCell((x) => 275.15 + 0.01 * x),
        initialHumidity: 1,
        initialLiquid: perCell((_, __, i) => 0.0001 + (i % 17) * 0.0002),
        initialVelocity: [perCell((x) => 0.55 + x / 80), perCell((_, z) => -0.27 + z / 95)],
        airTemperature: 281,
        airHumidity: 0.7,
        heat: perCell((x) => ((x % 3) - 1) * 2),
        moisture: perCell((_, __, i) => ((i % 13) - 6) * 1e-6),
        longwave: 'liquid-water-path',
        skyTemperature: 264,
        open: { maxX: true, minZ: true },
        secondsPerSecond: 120,
        wind,
        worldCellSize: 8,
      },
      far,
    );
    const start = world.takeSnapshot();
    const coldWork = fog.workCounts();
    const initialBudget = fog.budget;
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    function finish() {
      world.shiftOrigin(far);
      wind.cell = delta.map((v) => -v);
      world.advance(5);
      const fields = fog.exportPorts(5).map((port) => ({
        cell: [...port.cell],
        words: regionWords(port.region.memory ?? world.memory, port.region).slice(),
      }));
      return { snapshot: world.takeSnapshot(), fields, budget: fog.budget, work: fog.workCounts() };
    }
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    wind.cell = far.map((cell, axis) => cell - delta[axis]);
    const restoredCells = fog.exportPorts(2).map((port) => [...port.cell]);
    const replay = finish();
    return { start, accepted, replay, initialBudget, firstWind, restoredCells, far, coldWork };
  } finally {
    fog[Symbol.dispose]();
  }
}

export function expectedFogWork(cells, substeps, threads) {
  const workers = Array.from({ length: threads }, (_, id) => {
    const width = Math.floor(((id + 1) * cells) / threads) - Math.floor((id * cells) / threads);
    return {
      resolvedRows: width * substeps,
      sourceRows: width * substeps,
      settledRows: width * substeps,
      publishedRows: width,
      simdPairs: Math.floor(width / 2) * substeps,
    };
  });
  return {
    threads,
    workers,
    resolvedRows: cells * substeps,
    sourceRows: cells * substeps,
    settledRows: cells * substeps,
    publishedRows: cells,
    simdPairs: workers.reduce((sum, work) => sum + work.simdPairs, 0),
  };
}

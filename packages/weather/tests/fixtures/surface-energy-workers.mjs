import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';

export const surfaceCell = [-901_123_036, 933_702_143, -879_827_164];

function options(columns, rows) {
  return {
    grid: {
      columns,
      rows,
      spacing: [3, 7],
      origin: [-31, 2, -21],
      patches: Array.from({ length: columns * rows }, (_, i) => {
        if (i % 13 === 0) return { initialTemperature: 273.15, initialSnow: 2, shortwave: 730, longwave: 350 };
        if (i % 17 === 0) return { initialTemperature: 273.15, initialSnow: 1e-7, shortwave: 730, longwave: 350 };
        if (i % 19 === 0) return { initialTemperature: 266, airTemperature: 296, humidity: 0.99, shortwave: 0 };
        return {
          initialTemperature: 282 + (i % 31) / 4,
          shortwave: 257 + (i % 75),
          humidity: 0.24 + (i % 66) / 100,
          pressure: 85_000 + (i % 701),
          initialWater: (i % 21) / 4,
          airTemperature: 291 + (i % 13) / 4,
          groundConductance: 1 + (i % 18),
          emissivity: 0.4 + (i % 10) / 20,
        };
      }),
    },
  };
}

export async function surfaceEnergyRun(columns, rows, threads) {
  const solver = threads === 0 ? new SurfaceEnergySolver() : await SurfaceEnergySolver.load({}, { threads });
  try {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(threads > 1) }).add(
      solver,
      options(columns, rows),
      surfaceCell,
    );
    const fields = () =>
      solver.exportPorts(0).map(({ field }) => {
        const { cell, region } = world.fields.port(field);
        return { cell: [...cell], words: regionWords(region.memory ?? world.memory, region).slice() };
      });
    const start = world.takeSnapshot();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const finish = () => {
      world.shiftOrigin(surfaceCell);
      world.advance(7);
      return {
        snapshot: world.takeSnapshot(),
        fields: fields(),
        work: solver.workCounts(),
        partial: solver.readPatch(0),
        complete: solver.readPatch(17),
        condensing: solver.readPatch(19),
        end: solver.readPatch(columns * rows - 1),
      };
    };
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredCells = fields().map(({ cell }) => cell);
    const replay = finish();
    return { start, accepted, replay, restoredCells };
  } finally {
    solver[Symbol.dispose]();
  }
}

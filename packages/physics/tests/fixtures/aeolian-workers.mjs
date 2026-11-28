import { AeolianTransport } from '../../dist/aeolian.js';
import { TerrainBed } from '../../dist/earth.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const far = [-955_121_884, 736_221_938, -804_221_539];
const shift = [1, -1, 2];

export async function aeolianWorkerRun(nx, nz, material, threads, shared) {
  const count = nx * nz;
  const perVertex = (fn) => Float64Array.from({ length: count }, (_, i) => fn(i, i % nx, Math.floor(i / nx)));
  const transport = await AeolianTransport.load({ threads });
  const terrain = new TerrainBed();
  const rates = { num: 60, den: 1 };
  const world = new PhysicsWorld({ rate: rates, gravity: [0, -9.81, 0], memory: worldMemory(shared) });
  const grid = { columns: nx - 1, rows: nz - 1, width: (nx - 1) / 32, depth: (nz - 1) / 16, centre: [0, 0] };
  const originalWindCell = () => far.map((cell, axis) => cell - shift[axis]);
  let firstWind;
  const wind = {
    medium: 'air',
    cell: originalWindCell(),
    sample(x, y, z, time) {
      firstWind ??= [x, y, z];
      return {
        velocity: [14 + (x - 8) / 4 + time * 0.2, 0, -5 + (z - 16) / 2],
        density: 1.225 + (z - 16) * 0.01,
        temperature: 278,
      };
    },
  };
  try {
    world.add(terrain, { ...grid, elevations: (x, z) => (x > 0 ? 0.0625 : 0.125) + (z >= 0 ? 0.03125 : 0) }, far);
    world.add(
      transport,
      {
        grid,
        material,
        wind,
        referenceHeight: 8,
        cellSize: 8,
        initialSaltation: perVertex((i) => 0.01 + (i % 7) * 0.002),
        erodibility: perVertex((i) => 0.55 + (i % 8) * 0.05),
        mobileDepth: 0.25,
        repose: 0.6,
        hillFetch: 0.25,
        open: { maxX: true, minZ: true },
        ripples: material === 'sand' ? { meanHop: 0.065, ejectionsPerSecond: 8 } : undefined,
      },
      far,
    );
    const start = world.takeSnapshot();
    const coldWork = transport.workCounts();
    const initialBudget = transport.budget;
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    function finish() {
      world.shiftOrigin(far);
      wind.cell = shift.map((v) => -v);
      world.advance(5);
      const fields = transport.exportPorts(5).map((port) => ({
        cell: [...port.cell],
        words: regionWords(port.region.memory ?? world.memory, port.region).slice(),
      }));
      return {
        snapshot: world.takeSnapshot(),
        fields,
        budget: transport.budget,
        work: transport.workCounts(),
        bed: terrain.elevations().slice(),
      };
    }
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    wind.cell = originalWindCell();
    const restoredCells = transport.exportPorts(2).map(({ cell }) => [...cell]);
    const replay = finish();
    return { start, accepted, replay, firstWind, initialBudget, restoredCells, far, coldWork };
  } finally {
    transport[Symbol.dispose]();
  }
}

export function aeolianWork(count, substeps, threads) {
  return {
    substeps,
    workers: Array.from({ length: threads }, (_, part) => {
      const rows = Math.floor(((part + 1) * count) / threads) - Math.floor((part * count) / threads);
      const pairs = Math.floor(rows / 2);
      return {
        slopeRows: rows,
        forcingRows: rows,
        exchangeRows: rows * substeps,
        publishedRows: rows,
        forcingPairs: pairs,
        exchangePairs: pairs * substeps,
      };
    }),
  };
}

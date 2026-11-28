import { TerrainBed } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { SynopticWeather } from '@margoengine/physics/synoptic';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const start = [1_125_000_000, -530_000_000, 409_000_000];
const shift = [-215_000, 13_470_000, 960_000];
const cellSize = 4096;
const rate = { num: 60, den: 1 };
const dx = 20_000;
const dz = 18_000;
export const synopticCell = start.map((coordinate, axis) => coordinate - shift[axis]);
export const synopticCases = { fast: [16, 8], high: [8, 16], layers: [32, 8] };

export function expectedSynopticWork(count, layered, threads) {
  const pairs = Math.floor(count / 2);
  const workers = Array.from({ length: threads }, (_, part) => {
    const lo = 2 * Math.floor((part * pairs) / threads);
    const hi = part + 1 === threads ? count : 2 * Math.floor(((part + 1) * pairs) / threads);
    const rows = hi - lo;
    return { rows, pairedRows: rows - (rows % 2), layerRows: layered ? rows : 0 };
  });
  return { threads, rows: count, pairedRows: 2 * pairs, layerRows: layered ? count : 0, workers };
}

export async function followSynoptic(tier, threads = 1, shared = threads > 1) {
  const layered = tier === 'layers';
  const cells = synopticCases[tier];
  const [nx, nz] = cells;
  const wave = (x, z) => Math.cos((2 * Math.PI * x) / (dx * nx)) * Math.cos((2 * Math.PI * z) / (dz * nz));
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize });
  const terrain = new TerrainBed();
  const water = new ShallowWaterSolver();
  const weather = await SynopticWeather.load({ water: true, threads });
  try {
    world.add(
      terrain,
      { columns: 2, rows: 2, width: 2 * dx, depth: 2 * dz, centre: [3 * dx, dz], elevations: Array(9).fill(-2) },
      start,
    );
    world.add(water, { bed: terrain.bed, level: 0, roughness: 0, timeScale: 720 }, start);
    world.add(
      weather,
      {
        cells,
        spacing: [dx, dz],
        fidelity: tier === 'fast' ? 'fast' : 'high',
        cell: start,
        cellSize,
        meanWind: [9, -3],
        beta: 1.5e-11,
        coriolis: 1e-4,
        timeScale: 720,
        streamfunction: (x, z) => 180_000 * wave(x, z),
        temperature: (x, z) => 288 + 2.3 * wave(x, z),
        vapour: (x, z) => 17 + 2.5 * wave(x, z),
        cloud: (x, z) => 1.4 - 0.31 * wave(x, z),
        hydrometeors: (x, z) => 0.39 + 0.16 * wave(x, z),
        evaporation: 0.00013,
        cloudTime: 90,
        falloutTime: 135,
        water: { columns: 2, rows: 2, spacing: [dx, dz], origin: [2.5 * dx, 0.5 * dz], cellSize },
        ...(layered
          ? { layers: { upperMeanWind: [16, -4], upperStreamfunction: (x, z) => -165_000 * wave(x, z) } }
          : {}),
      },
      start,
    );
    world.couple([water.describe().id, weather.id], 'staggered');
    world.advance(2);
    const baseline = world.takeSnapshot();

    function run() {
      world.shiftOrigin(shift);
      const work = [];
      for (let frame = 3; frame <= 8; frame++) {
        world.advance(frame);
        work.push(weather.readNativeWork?.());
      }
      const ports = Object.fromEntries(
        weather
          .exportPorts(8)
          .map(({ field, cell, region }) => [
            field,
            { words: regionWords(world.memory, region).slice(), cell: Array.from(cell) },
          ]),
      );
      return {
        state: {
          snapshot: world.takeSnapshot(),
          ports,
          budget: weather.budget,
          water: water.sample(0, 0),
          sample: weather.sample(3 * dx, dz),
          layers: weather.sampleLayers(3 * dx, dz),
        },
        work,
      };
    }
    const accepted = run();
    world.restoreSnapshot(baseline.bytes);
    return { accepted, replay: run() };
  } finally {
    weather[Symbol.dispose]?.();
  }
}

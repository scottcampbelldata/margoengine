import { ForestEcosystemSolver } from '@margoengine/biomes/forest';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const initialCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const forestCell = initialCell.map((value, axis) => value - shift[axis]);
const ONE = 65536;

export function referenceShade(population, capacity, count, cellSize, threads) {
  const x = population.subarray(0, capacity);
  const z = population.subarray(capacity, 2 * capacity);
  const radius = population.subarray(2 * capacity, 3 * capacity);
  const death = population.subarray(4 * capacity, 5 * capacity);
  const id = population.subarray(6 * capacity);
  const buckets = new Map();
  const key = (x, z) => x + ',' + z;
  for (let i = 0; i < count; i++) {
    if (death[i] >= 0) continue;
    const cell = key(Math.floor(x[i] / cellSize), Math.floor(z[i] / cellSize));
    if (!buckets.has(cell)) buckets.set(cell, []);
    buckets.get(cell).push(i);
  }
  const shade = new Int32Array(count);
  const workers = Array.from({ length: threads }, (_, part) => {
    const first = Math.floor((part * count) / threads);
    const end = Math.floor(((part + 1) * count) / threads);
    const work = { trees: end - first, liveQueries: 0, candidateVisits: 0, overlaps: 0, pairedOverlaps: 0 };
    for (let i = first; i < end; i++) {
      if (death[i] >= 0 || radius[i] <= 0) continue;
      work.liveQueries++;
      const cx = Math.floor(x[i] / cellSize);
      const cz = Math.floor(z[i] / cellSize);
      let sum = 0;
      let terms = 0;
      neighbourhood: for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const values = buckets.get(key(cx + dx, cz + dz)) ?? [];
          for (let at = values.length - 1; at >= 0; at--) {
            work.candidateVisits++;
            const j = values[at];
            if (j === i || radius[j] < radius[i] || (radius[j] === radius[i] && id[j] > id[i])) continue;
            const reach = radius[i] + radius[j];
            const squared = ((x[j] - x[i]) ** 2 + (z[j] - z[i]) ** 2) * 100;
            if (squared >= reach ** 2) continue;
            terms++;
            const overlap = reach - Math.floor(Math.sqrt(squared));
            sum += Math.min(ONE, Math.floor((overlap * ONE) / (2 * radius[i])));
            if (terms % 2 === 0 && sum >= ONE) break neighbourhood;
          }
        }
      }
      shade[i] = Math.min(sum, ONE);
      work.overlaps += terms;
      work.pairedOverlaps += terms - (terms % 2);
    }
    return work;
  });
  const totals = Object.fromEntries(
    Object.keys(workers[0]).map((field) => [field, workers.reduce((sum, worker) => sum + worker[field], 0)]),
  );
  return { shade, receipt: { threads, ...totals, workers } };
}

const species = [
  {
    id: 'fir',
    radius: 7.5,
    growth: 0.37,
    age: 160,
    shade: 0.9,
    seeds: 2.4,
    maturity: 0.17,
    dispersal: 2,
    rootCohesion: 1250,
    canopyFuel: 1.6,
  },
  {
    id: 'birch',
    radius: 8.3,
    growth: 0.53,
    age: 120,
    shade: 0.23,
    seeds: 1.6,
    maturity: 0.22,
    dispersal: 3.5,
    rootCohesion: 560,
    canopyFuel: 0.95,
  },
];
const capacity = 160;
const cellSize = 2 * 830 + 1;

export async function followForest(count, threads, shared = threads > 1) {
  using forest = await ForestEcosystemSolver.load({ threads });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared), cellSize: 4096 });
  const plants = Array.from({ length: count }, (_, i) => ({
    species: species[i % 2].id,
    x: -10 + (i % 8) * 2.45 + (i % 3) * 0.11,
    z: -9 + Math.floor(i / 8) * 2.42 + (i % 4) * 0.19,
    radius: 0.22 + (i % 7) * 0.67,
    age: 9 + (i % 11),
  }));
  world.add(
    forest,
    {
      bounds: [-18, -16, 18, 15],
      cells: [9, 7],
      species,
      plants,
      limit: capacity,
      ticksPerYear: 3,
      snags: 3,
      seed: 1793936,
    },
    initialCell,
  );
  world.advance(6);
  const checkpoint = world.takeSnapshot();
  function run() {
    world.shiftOrigin(shift);
    const work = [];
    const first = forest.trees();
    for (const frame of [9, 12, 15]) {
      const population = regionWords(world.memory, forest.stateRegions()[0]).slice();
      const count = forest.trees().length;
      const expected = referenceShade(population, capacity, count, cellSize, threads).receipt;
      world.advance(frame);
      work.push({ receipt: forest.readNativeWork(), expected });
    }
    const ports = Object.fromEntries(
      forest.exportPorts(15).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: { first, trees: forest.trees(), year: forest.year, snapshot: world.takeSnapshot(), ports },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}

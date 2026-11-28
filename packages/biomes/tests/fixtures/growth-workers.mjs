import { PlantGrowth } from '@margoengine/biomes/growth';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const growthCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);

export function referenceShadows([nx, ny, nz], depth, transmission, sources, threads = 1) {
  const totalRows = ny * nz;
  const values = new Float64Array(nx * totalRows);
  const ranges = Array.from({ length: threads }, (_, i) => [
    Math.floor((i * totalRows) / threads),
    Math.floor(((i + 1) * totalRows) / threads),
  ]);
  const workers = ranges.map(() => ({ sources: 0, rows: 0, additions: 0, pairedAdditions: 0 }));
  for (const { x, y, z, amount } of sources) {
    let strength = amount;
    const touched = new Set();
    for (let layer = 0; layer <= Math.min(depth, y); layer++) {
      const left = Math.max(0, x - layer);
      const right = Math.min(nx - 1, x + layer);
      const front = Math.max(0, z - layer);
      const back = Math.min(nz - 1, z + layer);
      const width = right - left + 1;
      for (let zi = front; zi <= back; zi++) {
        const row = zi * ny + y - layer;
        const owner = ranges.findIndex(([start, end]) => row >= start && row < end);
        const work = workers[owner];
        work.rows++;
        work.additions += width;
        work.pairedAdditions += width - (width % 2);
        touched.add(work);
        for (let xi = left; xi <= right; xi++) values[row * nx + xi] += strength;
      }
      strength *= transmission;
    }
    for (const work of touched) work.sources++;
  }
  const total = (name) => workers.reduce((sum, work) => sum + work[name], 0);
  return {
    values,
    receipt: {
      threads,
      sources: sources.length,
      rows: total('rows'),
      additions: total('additions'),
      pairedAdditions: total('pairedAdditions'),
      workers,
    },
  };
}

export function orderedObstacles([nx, ny, nz]) {
  const result = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = 17 * x + 23 * y + 37 * z;
        if (y >= 2 && i % 41 === 0) result.push({ x, y, z, amount: 0.018 + (i % 15) / 120 });
      }
    }
  }
  return result;
}

function species(index) {
  return {
    productiveSeasons: 5,
    seasonalExtension: 0.78,
    minimumExtension: 0.044,
    internodeLength: 0.275,
    tipRadius: 0.016 + index / 500,
    apicalWeight: 0.61,
    branchingAngle: Math.PI / 3.8,
    divergence: 1.19,
    phototropism: 0.14,
    gravitropism: 0.12,
    leafShadow: 0.035 + index / 260,
  };
}

export async function followGrowth(dimensions, threads, shared = threads > 1) {
  using growth = await PlantGrowth.load({ threads });
  const [nx, ny, nz] = dimensions;
  const size = 0.4;
  const depth = 4;
  const transmission = 0.61;
  const origin = [-0.7, -0.3, -1.8];
  const obstacleSources = orderedObstacles(dimensions);
  const obstacles = new Float64Array(nx * ny * nz);
  for (const { x, y, z, amount } of obstacleSources) obstacles[(z * ny + y) * nx + x] = amount;
  const plants = Array.from({ length: 7 }, (_, i) => ({
    position: [
      origin[0] + (2.3 + i * 1.28) * size,
      origin[1] + 0.2 * size,
      origin[2] + (0.6 + (i * (nz - 1)) / 7) * size,
    ],
    species: species(i),
  }));
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared), cellSize: 4096 });
  world.add(
    growth,
    {
      plants,
      voxels: { dimensions, origin, size, obstacles, shadowDepth: depth, shadowTransmission: transmission },
      ticksPerSeason: 3,
    },
    startCell,
  );
  world.advance(6);
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    const seasonAtStart = growth.season;
    for (const frame of [9, 12, 15]) {
      const sources = obstacleSources.slice();
      for (const { end, plant } of growth.internodes()) {
        const indices = end.map((v, i) => Math.floor((v - origin[i]) / size));
        if (indices.every((index, i) => index >= 0 && index < dimensions[i])) {
          const [x, y, z] = indices;
          sources.push({ x, y, z, amount: plants[plant].species.leafShadow });
        }
      }
      world.advance(frame);
      work.push({
        receipt: growth.readNativeWork(),
        expected: referenceShadows(dimensions, depth, transmission, sources, threads).receipt,
      });
    }
    const port = world.fields.port(growth.branchesField.name);
    return {
      state: {
        snapshot: world.takeSnapshot(),
        cell: Array.from(port.cell),
        words: regionWords(world.memory, port.region).slice(),
        branches: growth.toBranches(),
        season: growth.season,
        seasonAtStart,
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}

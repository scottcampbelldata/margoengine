import { SeismicGround } from '@margoengine/physics/seismic';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);

function stencilWork(width, rows) {
  const cells = width * rows;
  const paired = (width - (width % 2)) * rows;
  return {
    velocityCells: cells,
    stressCells: cells,
    pairedVelocityCells: paired,
    pairedStressCells: paired,
  };
}

export function expectedWork(width, depth, threads) {
  return {
    threads,
    surfacePoints: width,
    ...stencilWork(width, depth),
    workers: Array.from({ length: threads }, (_, part) => {
      const first = Math.floor((part * depth) / threads);
      const end = Math.floor(((part + 1) * depth) / threads);
      return stencilWork(width, end - first);
    }),
  };
}

export async function followSeismic(width, depth, threads, shared = threads > 1) {
  using ground = await SeismicGround.load({ threads });
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  });
  const dx = 14;
  const dz = 11;
  const receiverX = (Math.floor(width / 2) + 0.5) * dx;
  world.add(
    ground,
    {
      width,
      depth,
      spacing: [dx, dz],
      origin: [9, 12, -16],
      material: (x, z) =>
        z < 3 * dz + x / 31
          ? { density: 1910, compressionalSpeed: 1290, shearSpeed: 690, damping: 0.02 }
          : { density: 2410, compressionalSpeed: 1820, shearSpeed: 980 },
      absorbingCells: Math.min(2, Math.floor(Math.min(width, depth) / 3)),
      initialVelocity: (x, z) => [(0.0001 * x) / (1 + z), (0.0002 * (x - receiverX)) / (1 + z)],
      sources: [
        {
          position: [receiverX, Math.min(2.35, depth / 2) * dz],
          timescale: 0.035,
          moment: [2.3e6, -2.3e6, 1.7e6],
        },
      ],
      sites: [
        { x: receiverX, frequency: 2.1, dampingRatio: 0.08 },
        {
          x: 0.5 * dx,
          saturatedSoil: { overburdenRatio: 1.7, depthReduction: 0.92, cyclicResistance: 0.18 },
        },
      ],
    },
    startCell,
  );
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 9; frame++) {
      world.advance(frame);
      work.push(ground.readNativeWork());
    }
    const ports = Object.fromEntries(
      ground.exportPorts(9).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: {
        snapshot: world.takeSnapshot(),
        ports,
        motion: ground.motion(Math.floor(width / 2)),
        building: ground.reading(0),
        soil: ground.reading(1),
        inside: ground.velocity(Math.floor(width / 2), Math.min(4, depth - 1)),
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}

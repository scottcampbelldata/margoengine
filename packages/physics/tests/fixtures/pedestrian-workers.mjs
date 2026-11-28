import { PedestrianCrowd } from '@margoengine/physics/pedestrians';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const start = [972_300_000, -602_200_000, 784_400_000];
const shift = [9_100_000, 7_340_000, -130_000];
const rate = { num: 60, den: 1 };
export const pedestrianCell = start.map((value, axis) => value - shift[axis]);
export const height = (x, z) => 0.35 + 0.016 * x - 0.009 * z;
export const corridorWalls = [
  [
    [-1.5, -13],
    [-1.5, 13],
  ],
  [
    [1.5, -13],
    [1.5, 13],
  ],
];

export function corridorWalkers(count) {
  return Array.from({ length: count }, (_, row) => {
    const lane = row % 4;
    const band = Math.floor(row / 4);
    const x = [-1.29, -0.42, 0.36, 1.29][lane];
    const z = 0.57 * (band - Math.floor(count / 8)) + (lane % 2) * 0.09;
    const sign = band % 2 === 0 ? 1 : -1;
    const side = lane === 0 ? -0.18 : lane === 3 ? 0.18 : 0.018 * ((row % 7) - 3);
    const speed = sign * (0.82 + (row % 13) * 0.022);
    return {
      position: [x, height(x, z), z],
      heading: [0, sign],
      velocity: [side * 0.3, speed],
      preferredVelocity: [side, speed],
      width: 0.5 + (row % 7) * 0.004,
      depth: 0.28 + (row % 9) * 0.005,
      mass: 54 + (row % 21) * 2.1,
    };
  });
}

export async function followPedestrians(count, threads, shared = threads > 1) {
  using pedestrians = await PedestrianCrowd.load({ threads });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize: 1024 });
  world.add(
    pedestrians,
    {
      bodies: corridorWalkers(count),
      walls: corridorWalls,
      stiffness: 3200,
      damping: 0,
      sliding: 800,
      observationSeconds: 1.4,
      ground: { locate: () => 0, heightAt: (_, x, z) => height(x, z) },
    },
    start,
  );
  world.advance(2);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 3; frame <= 12; frame++) {
      world.advance(frame);
      work.push(pedestrians.readNativeWork());
    }
    const ports = Object.fromEntries(
      pedestrians.exportPorts(12).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: {
        snapshot: world.takeSnapshot(),
        ports,
        walkers: Array.from({ length: count }, (_, row) => pedestrians.read(row)),
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}

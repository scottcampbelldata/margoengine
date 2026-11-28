import { TerrainBed } from '@margoengine/physics/earth';
import { GroundLocomotion } from '@margoengine/physics/locomotion';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);
const kinds = ['snake', 'lizard', 'insect', 'spider', 'crab'];
const linkCount = (row) => 23 + 2 * (row % 4);

export function expectedRows(first, end) {
  const counts = { bodies: end - first, snakeLinks: 0, feet: 0, torsoRows: 0 };
  for (let i = first; i < end; i++) {
    const kind = i % 5;
    if (kind === 0) counts.snakeLinks += linkCount(i);
    else {
      counts.feet += [0, 4, 6, 8, 8][kind];
      counts.torsoRows++;
    }
  }
  return { ...counts, contactRows: counts.snakeLinks + counts.feet + counts.torsoRows };
}

export async function followLocomotion(count, threads, shared = threads > 1) {
  const bed = { width: 14, depth: 14, columns: 20, rows: 20, centre: [0, 0] };
  using movement = await GroundLocomotion.load({ threads, bedShape: bed, cellSize: 4096 });
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  });
  const bodies = Array.from({ length: count }, (_, i) => {
    const kind = kinds[i % kinds.length];
    const x = 0.32 * (i % 19) - 2.88;
    const z = 0.35 * Math.floor(i / 19) - 2.5;
    const offset = 0.021 * x + 0.014 * z + 0.004 * x * z + 0.001 * x * x;
    const height = [0.018, 0.045, 0.016, 0.032, 0.04][i % 5];
    return {
      kind,
      position: [x, offset + height, z],
      heading: 0.13 * (i % 21),
      phase: (i % 14) / 14,
      velocity: [0.02 - (i % 3) * 0.02, -0.002, 0.04],
      ...(kind === 'snake' ? { links: linkCount(i), frequency: 0.9 + 0.02 * (i % 7) } : {}),
    };
  });
  world
    .add(
      new TerrainBed(),
      { ...bed, elevations: (x, z) => 0.021 * x + 0.014 * z + 0.004 * x * z + 0.001 * x * x },
      startCell,
    )
    .add(movement, { bodies, originCell: startCell }, startCell);
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(movement.readNativeWork());
    }
    const ports = Object.fromEntries(
      movement.exportPorts(7).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    const state = {
      snapshot: world.takeSnapshot(),
      ports,
      snake: movement.read(0),
      snakeContact: movement.readContact(0, 0),
      lizard: movement.read(1),
    };
    return { state, work };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}

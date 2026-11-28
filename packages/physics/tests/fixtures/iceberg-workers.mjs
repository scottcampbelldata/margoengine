import { GlacierSolver } from '@margoengine/physics/glacier';
import { IcebergSolver } from '@margoengine/physics/iceberg';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((index, axis) => index - shift[axis]);

export async function followIcebergs(active, slots, threads, shared = threads > 1) {
  const glacier = await GlacierSolver.load();
  using berg = await IcebergSolver.load({ calving: glacier.calvingField, threads });
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  });
  const bodies = Array.from({ length: active }, (_, i) => {
    const scale = i % 8 === 0 ? 0.035 : 0.3 + (i % 7) * 0.18;
    return {
      size: [0.8 * scale, 1.4 * scale, 1.8 * scale],
      position: [0.4 * (i % 19), scale * (i % 2 ? -0.51 : -0.35), 0.3 * Math.floor(i / 19)],
      orientation: [0.015 * (i % 4), 0.03, 0.05 - 0.008 * (i % 5), 1],
      velocity: [0.04 * (i % 11), -0.07, 0.11],
      spin: [0.15, (i % 4) * 0.06, -0.24],
    };
  });
  world
    .add(berg, {
      bodies,
      releaseSites: [
        { sourceCell: 2, position: [3, 7] },
        { sourceCell: 3, position: [4, 8], slots: slots - 1 },
      ],
      current: [0.8, 0.015, 0.3],
      wind: [-2.1, 0.1, 0.6],
      airDrag: 0.85,
      sideMelt: 0.004,
      basalMelt: 0.007,
    })
    .add(glacier, {
      nx: 4,
      nz: 1,
      dx: 1,
      bed: [-0.53, -0.63, -0.83, -2],
      thickness: [1, 1, 1, 0],
      boundary: [0, 0, 0, 1],
      timeScale: 60,
    })
    .setCell('iceberg', startCell)
    .setCell('glacier', startCell);
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(berg.readNativeWork());
    }
    const ports = Object.fromEntries(
      berg.exportPorts(7).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    const state = {
      snapshot: world.takeSnapshot(),
      ports,
      budget: berg.budget,
      first: berg.sample(0),
      firstCalved: berg.sample(active),
      empty: berg.sample(active + slots - 1),
    };
    return { state, work };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}

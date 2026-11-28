import { GlacierSolver } from '@margoengine/physics/glacier';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((index, axis) => index - shift[axis]);

export async function followGlacier(nx, nz, threads, shared = threads > 1) {
  using ice = await GlacierSolver.load({ threads });
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  });
  const row = (sample) => Array.from({ length: nx * nz }, (_, i) => sample(i % nx, Math.floor(i / nx)));
  const water = (x) => x === nx - 1;
  world
    .add(ice, {
      nx,
      nz,
      dx: 40,
      dz: 35,
      bed: row((x, z) => (water(x) ? -250 : -12 - 3.9 * x - 0.4 * z - 0.09 * x * x)),
      thickness: row((x, z) => (water(x) ? 0 : 133 + 0.2 * x - 0.07 * z + 0.09 * (x % 5))),
      boundary: row((x) => (water(x) ? 1 : 0)),
      accumulation: row((x, z) => (water(x) ? 0 : (2 + ((x + z) % 4)) * 1e-7)),
      melt: row((x) => (water(x) ? 0 : (1 + (x % 3)) * 2e-6)),
      crevasseWater: row((x, z) => ((x + 3 * z) % 7) * 0.1),
      timeScale: 216_000,
    })
    .setCell('glacier', startCell);
  const initialVolume = ice.budget.ice;
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(ice.readNativeWork());
    }
    const ports = Object.fromEntries(
      ice.exportPorts(7).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    const state = {
      snapshot: world.takeSnapshot(),
      ports,
      budget: ice.budget,
      initialVolume,
      midSlope: ice.sample(9, 8),
    };
    return { state, work };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}

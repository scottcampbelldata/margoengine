import { Physics } from '@margoengine/physics';
import { PackIceSolver } from '@margoengine/physics/pack-ice';
import { BODIES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const packIceCell = signedCell.map((index, axis) => index - shift[axis]);

export async function followPackIce(count, threads, shared = threads > 1) {
  await Physics.load({ threads: shared });
  using pack = await PackIceSolver.load({ rigid: true, threads });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared), cellSize: 4096 });
  using physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
  const ship = physics.addBody(null, {
    position: [0.14, 0, 0],
    linearVelocity: [0.15, 0, 12],
    colliders: { shape: 'box', halfExtents: [0.5, 0.28, 1], mass: 6000 },
  });
  const floes = Array.from({ length: count }, (_, i) => ({
    position: [0.38 * (i % 17) - 3.04, 1.04 + 0.39 * Math.floor(i / 17)],
    velocity: [(i % 2 ? -1 : 1) * 0.15, -0.65 - 0.16 * (i % 3)],
    radius: 0.18 + 0.012 * (i % 4),
    thickness: 0.1 + 0.065 * (i % 4),
    spin: 0.16 * ((i % 5) - 2),
  }));
  let added = false;
  const cell = () => (added ? world.cellOf('pack-ice') : [0, 0, 0]);
  const wind = {
    medium: 'air',
    get cell() {
      return cell();
    },
    sample(x, _y, z, time) {
      return { velocity: [11.5 + 0.2 * z, 0, -3.1 + 0.11 * x + time], density: 1.23, temperature: 276 };
    },
  };
  const current = {
    medium: 'water',
    get cell() {
      return cell();
    },
    sample(x, _y, z) {
      return { velocity: [0.25 + 0.015 * x, 0, 0.36 - 0.02 * z], density: 1025, temperature: 275 };
    },
  };
  world
    .add(pack, { floes, wind, current, vessels: [{ bodyRow: ship.row, length: 2, beam: 1 }] })
    .add(new RigidSolver(), { physics })
    .setCell('pack-ice', signedCell)
    .setCell('rigid', signedCell)
    .couple(['pack-ice', 'rigid'], 'staggered');
  added = true;
  world.advance(1);
  const baseline = world.takeSnapshot();
  function run() {
    world.shiftOrigin(shift);
    const work = [];
    const impulses = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push({ native: pack.readNativeWork(), contacts: pack.work });
      impulses.push(pack.vesselImpulse(ship.row));
    }
    const port = world.fields.port(pack.floeField.name);
    const bodies = world.fields.port(BODIES_FIELD.name);
    return {
      snapshot: world.takeSnapshot(),
      floes: regionWords(world.memory, port.region).slice(),
      bodies: regionWords(world.memory, bodies.region).slice(),
      work,
      impulses,
      cell: Array.from(port.cell),
      rigidCell: Array.from(bodies.cell),
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run(), count };
}

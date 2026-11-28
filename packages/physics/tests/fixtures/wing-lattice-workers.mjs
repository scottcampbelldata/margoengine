import { AirSolver, WingForce } from '../../dist/flight.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

const farCell = [-795_631_407, 907_323_906, -856_129_099];
const windCell = [farCell[0] - 1, farCell[1] + 1, farCell[2] - 2];
const originStep = [0, 1, 0];
const rate = { num: 60, den: 1 };

export async function wingWorkerWorld(panels, threads) {
  await Physics.load();
  const world = new PhysicsWorld({ rate, cellSize: 512, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity: [0, 0, 0] });
  const body = physics.addBody(null, {
    position: [0, 4, 0],
    linearVelocity: [0, 0, 1.6],
    angularVelocity: [0.01, 0, 0.02],
    colliders: { shape: 'box', halfExtents: [0.4, 0.15, 0.4], mass: 500 },
  });
  world.add(new RigidSolver(), { physics }, farCell).add(new AirSolver(), { physics }, farCell);
  world.couple(['air', 'rigid'], 'staggered');
  let invalid = false;
  const options = {
    sections: [
      { leadingEdge: [0.2, 0, 0.3], chord: 0.9, twist: 0.04 },
      { leadingEdge: [3.9, 0.16, -0.4], chord: 0.56, twist: 0.07 },
    ],
    panels,
    mirror: false,
    profileDrag: 0.008,
    frame: {
      cellSize: world.cellSize,
      get cell() {
        return world.cellOf('rigid');
      },
    },
    wind: {
      medium: 'air',
      cell: windCell,
      sample(x, _y, _z, time, out) {
        const across = x - 512;
        const stall = across > 1.25 && across < 2.65;
        out.velocity = [0.15, invalid && across > 3.6 ? Number.NaN : (stall ? 10 : 1.8) + 0.06 * time, -18];
        out.density = 1.18 + 0.025 * across;
        out.temperature = 288.15;
        return out;
      },
    },
  };
  try {
    const wing =
      threads === 0 ? new WingForce(physics, body, options) : await WingForce.load(physics, body, options, { threads });
    return {
      world,
      physics,
      body,
      wing,
      fail: () => {
        invalid = true;
      },
      recover: () => {
        invalid = false;
      },
    };
  } catch (cause) {
    physics.dispose();
    throw cause;
  }
}

export async function wingLatticeRun(panels, threads) {
  const { world, physics, body, wing } = await wingWorkerWorld(panels, threads);
  try {
    const start = world.takeSnapshot();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    function finish() {
      world.shiftOrigin(originStep);
      world.advance(7);
      return {
        snapshot: world.takeSnapshot(),
        force: [...wing.force],
        torque: [...wing.torque],
        circulation: wing.circulation.slice(),
        position: [...body.position],
        cell: [...world.cellOf('rigid')],
        work: wing.workCounts(),
      };
    }
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredCell = [...world.cellOf('rigid')];
    const replay = finish();
    return { start, accepted, replay, restoredCell, initialCell: farCell };
  } finally {
    physics.dispose();
  }
}

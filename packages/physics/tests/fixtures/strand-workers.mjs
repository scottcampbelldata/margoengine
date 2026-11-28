import { Physics } from '@margoengine/physics';
import { StrandSolver } from '@margoengine/physics/strands';
import { BODY_IMPULSES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

const start = [135_000_000, -88_000_000, 580_000_000];
const shift = [17_000, 39_000, -5_400_000];
const zero = [0, 0, 0];
export const strandCell = start.map((value, axis) => value - shift[axis]);

export function expectedStrandWork(guides, pointsPerGuide, threads) {
  const count = guides * pointsPerGuide;
  const pairs = Math.floor(count / 2);
  const workers = Array.from({ length: threads }, (_, part) => {
    const from = 2 * Math.floor((part * pairs) / threads);
    const to = part + 1 === threads ? count : 2 * Math.floor(((part + 1) * pairs) / threads);
    const result = { points: to - from, movingPoints: 0, spinningPoints: 0, pairedMovingPoints: 0 };
    for (let i = from; i < to; i++) {
      const j = i % pointsPerGuide;
      if (j !== 0) {
        result.movingPoints++;
        if (j < pointsPerGuide - 1) result.spinningPoints++;
        const mate = i % 2 === 0 ? i + 1 : i - 1;
        if (mate < to && mate % pointsPerGuide !== 0) result.pairedMovingPoints++;
      }
    }
    return result;
  });
  const sum = (key) => workers.reduce((total, worker) => total + worker[key], 0);
  return {
    threads,
    workers,
    points: sum('points'),
    movingPoints: sum('movingPoints'),
    spinningPoints: sum('spinningPoints'),
    pairedMovingPoints: sum('pairedMovingPoints'),
  };
}

function guidesOverGrid(count, pointsPerGuide) {
  return Array.from({ length: count }, (_, index) => {
    const x = index === 0 ? 0 : 1 + (index % 32) * 0.12;
    const z = index === 0 ? 0 : 1 + Math.floor(index / 32) * 0.12;
    return {
      points: Array.from({ length: pointsPerGuide }, (_, j) => [
        x + (index === 0 || j === 0 ? 0 : (j % 2) * (0.003 + (index % 3) * 0.0007)),
        0.3 * (1 - j / (pointsPerGuide - 1)),
        z,
      ]),
      radius: 0.009 + (index % 5) * 0.0003,
      density: 850 + (index % 17) * 9,
      young: index === 0 ? 0.25 : 130 + (index % 7) * 15,
      drag: index === 0 ? 0 : 0.5 + (index % 11) * 0.07,
    };
  });
}

export function equalStrandWords(a, b) {
  return a.length === b.length && a.every((word, i) => Object.is(word, b[i]));
}

export function equalStrandState(a, b) {
  return (
    a.snapshot.hash === b.snapshot.hash &&
    equalStrandWords(a.snapshot.bytes, b.snapshot.bytes) &&
    equalStrandWords(a.pending, b.pending) &&
    a.tip === b.tip &&
    a.spin === b.spin &&
    equalStrandWords(a.cells[0], b.cells[0]) &&
    equalStrandWords(a.cells[1], b.cells[1])
  );
}

export async function followStrands(count, pointsPerGuide, threads, shared = threads > 1) {
  await Physics.load({ threads: shared });
  const rate = { num: 60, den: 1 };
  const cellSize = 16;
  const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(shared), cellSize });
  using rigid = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / 60 });
  const body = rigid.addBody(null, {
    position: [0.14, 0, 0],
    linearVelocity: [-3.6, 0, 0],
    colliders: { shape: 'sphere', radius: 0.1, mass: 2, sensor: true },
  });
  world.add(new RigidSolver(), { physics: rigid }, start);
  using solver = await StrandSolver.load({
    threads,
    rigidCapsules: [{ body: body.row, start: [0, 0.04, 0], end: [0, 0.04, 0], radius: 0.1 }],
  });
  let windCell = start;
  const wind = {
    medium: 'air',
    get cell() {
      return windCell;
    },
    sample(x, _y, z, time) {
      return { velocity: [0.5 + x / 11 + time / 3, z / 8, -0.3 + z / 10], density: 1.225, temperature: 289 };
    },
  };
  world.add(
    solver,
    {
      strands: guidesOverGrid(count, pointsPerGuide),
      wind,
      rate: 0,
      damping: 0.4,
      friction: 0,
      iterations: 1,
      rodSolve: 'local',
      selfCollision: false,
      cellSize,
    },
    start,
  );
  world.couple(['rigid', solver.id], 'staggered');
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    windCell = strandCell;
    world.advance(1);
    const first = solver.exportPorts(1).find(({ field }) => field === BODY_IMPULSES_FIELD.name);
    const pending = regionWords(world.memory, first.region).slice(6 * body.row, 6 * (body.row + 1));
    const work = [solver.readNativeWork()];
    for (let frame = 2; frame <= 5; frame++) {
      world.advance(frame);
      work.push(solver.readNativeWork());
    }
    return {
      state: {
        snapshot: world.takeSnapshot(),
        cells: solver.exportPorts(5).map(({ cell }) => Array.from(cell)),
        pending,
        tip: solver.sample(0, pointsPerGuide - 1).velocity[0],
        spin: body.angularVelocity[2],
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}

import { Physics } from '@margoengine/physics';
import { bakeHullPanels, HullSolver, SEA_WATER, volumeBelow } from '@margoengine/physics/seakeeping';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

export function hemisphere(rings, around) {
  const vertices = [0, -1, 0];
  const indices = [];
  for (let j = 1; j <= rings; j++) {
    const theta = (j * Math.PI) / (2 * rings);
    for (let i = 0; i < around; i++) {
      const azimuth = (2 * Math.PI * i) / around;
      vertices.push(
        Math.sin(theta) * Math.cos(azimuth),
        j === rings ? 0 : -Math.cos(theta),
        Math.sin(theta) * Math.sin(azimuth),
      );
    }
  }
  const top = vertices.length / 3;
  vertices.push(0, 0, 0);
  for (let i = 0; i < around; i++) {
    const next = (i + 1) % around;
    indices.push(0, 1 + i, 1 + next);
    for (let row = 0; row < rings - 1; row++) {
      const lower = 1 + row * around;
      const upper = lower + around;
      indices.push(lower + i, upper + i, upper + next, lower + i, upper + next, lower + next);
    }
    indices.push(top, top - around + next, top - around + i);
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

export function options(count, depth = Infinity) {
  return { depth, frequencies: Array.from({ length: count }, (_, i) => 0.65 + i * 0.2), headings: 5 };
}

function equal(left, right) {
  return left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
}

export function equalPanels(left, right) {
  return (
    equal(left.frequencies, right.frequencies) &&
    equal(left.infiniteMass, right.infiniteMass) &&
    left.samples.every((row, i) => Object.keys(row).every((key) => equal(row[key], right.samples[i][key])))
  );
}

export async function hullPanelRun(mesh, threads) {
  return await bakeHullPanels(mesh, { ...options(8), threads });
}

export async function followHull(mesh, panels) {
  await Physics.load();
  const signed = [1_170_000_000, -1_070_000_000, 2_000_000_000];
  const delta = [4_100_000, -21_500_000, 17_300_000];
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false), cellSize: 1 });
  using physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
  const body = physics.addBody(null, {
    enabledTranslations: [true, false, false],
    lockRotations: true,
    linearVelocity: [0.23, 0, 0],
    colliders: { shape: 'sphere', radius: 1, mass: SEA_WATER * volumeBelow(mesh, [0, 1, 0], 0) },
  });
  const hull = new HullSolver();
  const sea = { elevation: () => 0, density: SEA_WATER, cell: signed };
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh, panels }],
      sea,
      originCellSize: 1,
      stations: 8,
      memory: 0.5,
      slamming: false,
      drag: false,
      greenWater: false,
      diffraction: false,
      rollDamping: false,
    })
    .couple(['hull', 'rigid'], 'staggered');
  world.setCell('hull', signed).setCell('rigid', signed);
  world.advance(5);
  const start = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    sea.cell = signed.map((cell, axis) => cell - delta[axis]);
    world.advance(18);
    const load = regionWords(world.memory, hull.exportPorts(17)[0].region)[6 * body.row];
    return { accepted: world.takeSnapshot(), load, cell: Array.from(world.cellOf('hull')) };
  }
  const result = run();
  world.restoreSnapshot(start.bytes);
  const replay = run();
  return { ...result, replay, exact: equal(result.accepted.bytes, replay.accepted.bytes) };
}

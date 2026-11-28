import { Physics } from '@margoengine/physics';
import { HullSolver, SEA_WATER } from '@margoengine/physics/seakeeping';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';
import { vHull } from '../coupling/sections.js';

export function slammingMesh(sheer = false) {
  const mesh = vHull(Math.PI / 6, 1, 4);
  if (sheer) {
    mesh.vertices[4] /= 2;
    mesh.vertices[7] /= 2;
  }
  return mesh;
}

function equal(left, right) {
  return left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
}

export function equalProfiles(left, right) {
  return (
    left.length === right.length &&
    left.every((a, i) => {
      const b = right[i];
      return (
        a.x === b.x &&
        a.width === b.width &&
        a.keel === b.keel &&
        equal(a.heights, b.heights) &&
        equal(a.wetted, b.wetted) &&
        equal(a.slope, b.slope)
      );
    })
  );
}

export async function followSlamming(mesh, slammingTable, slamming = true) {
  await Physics.load();
  const signed = [1_170_000_000, -1_070_000_000, 2_000_000_000];
  const delta = [4_100_000, -21_500_000, 17_300_000];
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(false),
    cellSize: 1,
    gravity: [0, 0, 0],
  });
  using physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena, gravity: [0, 0, 0] });
  const body = physics.addBody(null, {
    position: [0, 0.09, 0],
    linearVelocity: [0, -2, 0],
    enabledTranslations: [false, true, false],
    lockRotations: true,
    colliders: { shape: 'box', halfExtents: [2, 0.3, 1], mass: 1e7 },
  });
  const hull = new HullSolver();
  const sea = { elevation: () => 0, density: SEA_WATER, cell: signed };
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh, slammingTable }],
      sea,
      originCellSize: 1,
      stations: 25,
      gravity: [0, 0, 0],
      slamming,
      addedMass: false,
      radiation: false,
      drag: false,
      greenWater: false,
      diffraction: false,
      rollDamping: false,
    })
    .couple(['hull', 'rigid'], 'staggered');
  world.setCell('hull', signed).setCell('rigid', signed);
  world.advance(2);
  const start = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    sea.cell = signed.map((cell, axis) => cell - delta[axis]);
    world.advance(8);
    const load = regionWords(world.memory, hull.exportPorts(7)[0].region)[6 * body.row + 1];
    return { accepted: world.takeSnapshot(), load, cell: Array.from(world.cellOf('hull')) };
  }
  const result = run();
  world.restoreSnapshot(start.bytes);
  const replay = run();
  return {
    ...result,
    exact: equal(result.accepted.bytes, replay.accepted.bytes) && Object.is(result.load, replay.load),
  };
}

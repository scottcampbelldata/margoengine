import { EntrySolver } from '../../dist/entry.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const entryCell = [-865_411_043, 789_047_271, -862_514_733];
const shift = [1, 0, 0];

export function entryMesh(radius, sides, rings) {
  const vertices = [0, radius, 0];
  const indices = [];
  for (let ring = 0; ring < rings; ring++) {
    const theta = (Math.PI * (ring + 1)) / (rings + 1);
    for (let side = 0; side < sides; side++) {
      const phi = (2 * Math.PI * side) / sides;
      vertices.push(
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.cos(theta),
        0.9 * radius * Math.sin(theta) * Math.sin(phi),
      );
    }
  }
  const bottom = vertices.length / 3;
  vertices.push(0, -radius, 0);
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    indices.push(0, 1 + next, 1 + side);
    for (let ring = 0; ring + 1 < rings; ring++) {
      const a = 1 + sides * ring;
      const b = a + sides;
      indices.push(a + side, a + next, b + next, a + side, b + next, b + side);
    }
    const a = 1 + sides * (rings - 1);
    indices.push(a + side, a + next, bottom);
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

export async function entryProfileRun(sides, rings, threads) {
  await Physics.load();
  const world = new PhysicsWorld({ rate: { num: 240, den: 1 }, cellSize: 512, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 240 });
  const radius = 0.08;
  const mesh = entryMesh(radius, sides, rings);
  const probe = physics.addBody(null, {
    position: [0.1, 0.13, -0.2],
    linearVelocity: [0.2, -4.3, 0.1],
    angularVelocity: [0.25, 0.19, -0.04],
    colliders: { shape: 'sphere', radius, mass: 8 },
  });
  let entry;
  try {
    entry =
      threads === 0
        ? new EntrySolver('entry', { cavityPressure: true })
        : await EntrySolver.load({ threads, cavityPressure: true });
    world.add(new RigidSolver(), { physics }, entryCell);
    world.add(
      entry,
      {
        bodies: [{ row: probe.row, mesh, contactAngle: 140 }],
        sea: { elevation: (x, z, time) => 0.036 * x - 0.05 * z + 0.004 * time, density: 1024 },
        level: 2,
        originCellSize: 512,
      },
      entryCell,
    );
    world.couple(['entry', 'rigid'], 'staggered');
    const fields = () =>
      entry.exportPorts(world.tick).map((port) => {
        const { cell, region } = world.fields.port(port.field) ?? port;
        return { cell: [...cell], values: regionWords(region.memory ?? world.memory, region).slice() };
      });
    const start = world.takeSnapshot();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    function finish() {
      world.shiftOrigin(shift);
      world.advance(8);
      return {
        snapshot: world.takeSnapshot(),
        fields: fields(),
        splashes: entry.splashes(),
        sources: entry.seaSources(),
        position: [...probe.position],
        velocity: [...probe.linearVelocity],
        cell: [...world.cellOf('entry')],
        work: entry.workCounts(),
      };
    }
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredCell = [...world.cellOf('entry')];
    const replay = finish();
    return { start, accepted, replay, restoredCell, initialCell: entryCell };
  } finally {
    entry?.dispose();
    physics.dispose();
  }
}

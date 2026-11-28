import { Physics } from '@margoengine/physics';
import { TerrainBed } from '@margoengine/physics/earth';
import { ResistiveSoil } from '@margoengine/physics/terramechanics';
import { BODIES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);

export const sampleBatches = [
  [[105, 107, 109, 111, 113]],
  [
    [105, 103, 101],
    [125, 119],
    [97, 89, 7],
  ],
];

export async function followResistiveSoil(batch, threads, shared = threads > 1) {
  await Physics.load({ threads: true });
  const plan = sampleBatches[batch];
  using soil = await ResistiveSoil.load({ threads });
  const memory = worldMemory(shared);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0], memory, cellSize: 4096 });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
  const terrain = { columns: 12, rows: 10, width: 4, depth: 3, centre: [0, 0] };
  const bodies = plan.map((steps, row) => {
    const body = physics.addBody(null, {
      type: 'dynamic',
      colliders: { shape: 'sphere', radius: 0.14, mass: 30 + row * 3 },
      position: [1.1 * row - 0.9, 0.035, 0.1 * row - 0.3],
      linearVelocity: [0.25 - 0.03 * row, -0.41 + 0.02 * row, 0.09],
      angularVelocity: [0.04, 0.1 + row * 0.02, -0.17],
    });
    const strips = steps.map((samples, strip) => ({
      start: [-0.035 + 0.01 * strip, -0.12 - 0.006 * strip, 0.025 * strip - 0.05],
      end: [0.09 + 0.01 * strip, -0.1 - 0.008 * strip, 0.025 * strip - 0.05],
      width: 0.023,
      samples,
    }));
    return { body, strips };
  });
  world
    .add(new TerrainBed(), { ...terrain, elevations: (x, z) => 0.013 * x + 0.009 * z + 0.002 * x * z }, startCell)
    .add(new RigidSolver(), { physics }, startCell)
    .add(
      soil,
      {
        terrain,
        coefficients: [51_000, 47_000, 53_000, 83_000, 20_000, -26_000, 57_000, 0, 25_000],
        bodies: bodies.map(({ body, strips }) => ({ row: body.row, strips })),
      },
      startCell,
    )
    .couple(['bed', 'rigid', soil.id], 'staggered');
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(soil.readNativeWork());
    }
    const force = soil.exportPorts(7)[0];
    const rigid = world.fields.port(BODIES_FIELD.name);
    return {
      state: {
        snapshot: world.takeSnapshot(),
        forceCell: Array.from(force.cell),
        rigidCell: Array.from(rigid.cell),
        forceRows: regionWords(memory, force.region).slice(),
        rigidRows: regionWords(memory, rigid.region).slice(),
        bodies: bodies.map(({ body }) => ({
          ...soil.read(body.row),
          velocity: Array.from(body.linearVelocity),
          spin: Array.from(body.angularVelocity),
        })),
      },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}

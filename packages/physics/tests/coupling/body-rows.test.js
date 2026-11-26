// The world's body rows (docs/physics-framework.md, section 5): every body-set field (`bodies`, `bodyImpulses`,
// `bodyForces`, `deckClaims`) holds one record a body row, and the world fixes how many once, by its `bodies` option or the
// rigid solver's kernel capacity; every solver that pushes on bodies sizes its contribution by them. Solvers that each sized
// their own (the soft and air solvers by the kernel, the hull, ship, entry and deck-water solvers one past their highest
// row) could not share a world: its sum refused their lengths.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { DeckWaterSolver } from '../../dist/flip.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { KVLCC2_L7, ShipSolver } from '../../dist/ship.js';
import { SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';

await Physics.load();

/** A box from corner a to corner b, twelve triangles wound outward. */
function cuboid([x0, y0, z0], [x1, y1, z1]) {
  return {
    vertices: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

test('a hull, its ship model, a curtain and the water on its deck share a world, each covering its body rows', async () => {
  // A 4 by 1.5 by 2 m box at its 0.5 m draft, a sensor so the cloth inside it meets nothing: the hull solver floats it,
  // the ship solver drives it, a curtain hangs from its deckhead, a deck volume rides its deck, the rigid solver moves it.
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    body = physics.addBody(null, {
      position: [0, 0.25, 0],
      colliders: { shape: 'box', halfExtents: [2, 0.75, 1], mass: 1025 * 4 * 2 * 0.5, sensor: true },
    }),
    soft = await SoftBodies.attach(physics),
    curtain = soft.create(SoftBodyDesc.cloth([-0.3, 0.9, 0], [0.15, 0, 0], [0, -0.1, 0], 5, 8).setParticleMass(0.005));
  for (let i = 0; i < 5; i++) curtain.attachParticle(i * 8, body);
  const hull = new HullSolver(),
    ships = new ShipSolver(),
    deck = new DeckWaterSolver('deckWater'),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(new SoftSolver(), { soft })
      .add(ships, { ships: [{ row: body.row, model: { ...KVLCC2_L7, centre: 0 }, midship: [0, -0.25, 0] }] })
      .add(hull, {
        hulls: [{ row: body.row, mesh: cuboid([-2, -0.75, -1], [2, 0.75, 1]) }],
        sea: { elevation: () => 0 },
      })
      .add(deck, { row: body.row, offset: [-2, 0.75, -1], cells: [8, 4, 4], cellSize: 0.5, initial: () => false })
      .couple(['ship', 'hull', 'deckWater', 'soft', 'rigid'], 'staggered');
  assert.equal(world.bodyRows, physics.kernel.capacity, "the rigid solver fixed the world's body rows");
  world.advance(30);
  for (const solver of [hull, ships, deck]) {
    const port = solver.exportPorts(world.tick).find((p) => p.field === BODY_FORCES_FIELD.name);
    assert.equal(port.region.byteLength, world.bodyRows * FORCE_WORDS * 8, `${solver.id} covers the world's body rows`);
  }
  assert.ok(Number.isFinite(body.position[1]) && Number.isFinite(curtain.particlePosition(39)[1]));
});

test('a solver that pushes on bodies before the world knows its body rows, or past them, is refused with the fix', () => {
  const mesh = cuboid([-1, -0.5, -1], [1, 0.5, 1]),
    sea = { elevation: () => 0 };
  assert.throws(
    () => new PhysicsWorld().add(new HullSolver(), { hulls: [{ row: 0, mesh }], sea }),
    /add the RigidSolver first .* or make the world with \{bodyRows: physics\.kernel\.capacity\}/,
  );
  // Given by the world, the rows serve the hull before any rigid solver, and the rigid solver must fit in them.
  const world = new PhysicsWorld({ bodyRows: 4 }).add(new HullSolver(), { hulls: [{ row: 3, mesh }], sea });
  assert.equal(world.bodyRows, 4);
  assert.throws(
    () => new PhysicsWorld({ bodyRows: 4 }).add(new HullSolver(), { hulls: [{ row: 4, mesh }], sea }),
    /body row 4 and the world has 4 body rows; make the world with \{bodyRows: 5\} or more/,
  );
  assert.throws(
    () => new PhysicsWorld({ bodyRows: 4 }).add(new HullSolver(), { hulls: [{ row: 0, mesh }], sea, capacity: 2 }),
    /capacity of 2 body rows is not the world's 4/,
  );
  const physics = new Physics(null);
  assert.throws(
    () => new PhysicsWorld({ bodyRows: 1 }).add(new RigidSolver(), { physics }),
    new RegExp(`The world has 1 body rows and solver "rigid" needs ${physics.kernel.capacity}`),
  );
  assert.throws(() => new PhysicsWorld({ bodyRows: 0 }), /whole number above 0/);
  // A solver that fixed the rows and then failed to add leaves them unfixed.
  const empty = new PhysicsWorld(),
    failing = {
      describe: () => ({ id: 'failing', rate: 0, stableRate: () => 0, fields: [] }),
      init(host) {
        host.bodyRows(5);
        throw new RangeError('it fails after');
      },
    };
  assert.throws(() => empty.add(failing, {}), /it fails after/);
  assert.equal(empty.bodyRows, undefined);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { ICE_FIELD_LAYOUT, ICE_HEAT_ABSORPTION_FIELD, ICE_MELTWATER_FIELD, ICE_STEAM_FIELD } from '../../dist/ice.js';
import { LavaSolver } from '../../dist/lava.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const thermalOff = { conductivity: 0, emissivity: 0, convection: 0, waterHeatTransfer: 0 };
const cell = { cells: [1, 1], spacing: 1, bed: 0, ...thermalOff };

const error = (message) => ({ name: 'MargoError', code: 'state', message });

function stateBytes(world, lava) {
  return lava
    .stateRegions()
    .map(({ byteOffset, byteLength }) => Buffer.from(new Uint8Array(world.memory.buffer, byteOffset, byteLength)));
}

test('LavaSolver refuses malformed grids, unrepresentable extents and source scales with coded corrections', async () => {
  const lava = await LavaSolver.load();
  const invalid = [
    [{ cells: null }, /positive whole X and Z cell counts/],
    [{ cells: [50_000, 50_000] }, /arena capacity/],
    [{ origin: [2 ** 53, 0] }, /cell centres exceed coordinate resolution/],
    [{ originCell: [4, 0, 0] }, /same cell as world.add/],
    [{ origin: [0, Infinity] }, /Z origin/],
    [{ bed: null }, /bed layout/],
    [{ spacing: Number.MIN_VALUE }, /cell area/],
    [{ spacing: 1e100, density: 1e120 }, /density times cell area/],
    [{ liquidus: 100, solidus: 200 }, /liquidus above solidus/],
    [{ depth: 0.5, dischargeX: Number.MAX_VALUE }, /initial mobile velocity/],
    [{ vents: [null] }, /vent cell/],
    [{ vents: [{ cell: [0, 0], flow: Number.MAX_VALUE }], spacing: 0.5 }, /vent discharge per cell area/],
  ];
  for (const [options, expected] of invalid) {
    assert.throws(() => new PhysicsWorld({ rate }).add(lava, { ...cell, ...options }), error(expected));
  }
  new PhysicsWorld({ rate }).add(lava, cell);
  assert.throws(() => lava.sample(-1, 0), error(/X index/));
});

test('LavaSolver refuses unrepresentable initial heat or ICE publication without attaching', async () => {
  const lava = await LavaSolver.load();
  const world = new PhysicsWorld({ rate });
  assert.throws(
    () => world.add(lava, { ...cell, spacing: 1e75, density: 1e150, depth: 1e10, temperature: 500 }),
    error(/publication exceeds finite surface, source or budget range/),
  );
  assert.throws(() => lava.sample(0, 0), error(/unattached/));
  new PhysicsWorld({ rate }).add(lava, cell);
  assert.equal(lava.budget.initialEnthalpy, 0);

  const contact = await LavaSolver.load({ exchangeIce: true });
  assert.throws(
    () => new PhysicsWorld({ rate }).add(contact, { ...cell, ice: [{ cell: [0, 0], area: Number.MIN_VALUE }] }),
    error(/ice heat request exceeds numeric range/),
  );
  assert.throws(() => contact.sample(0, 0), error(/unattached/));
});

test('LavaSolver rejects a late aggregate publication overflow without altering accepted state', async () => {
  for (const shared of [false, true]) {
    const lava = await LavaSolver.load();
    const world = new PhysicsWorld({ rate, memory: worldMemory(shared) }).add(lava, {
      ...cell,
      depth: 0.5,
      spacing: 1e100,
      density: 1e100,
      heatCapacity: 1e6,
      latentHeat: 0,
      solidus: 50,
      liquidus: 100,
      temperature: 200,
      seaLevel: 1,
      vents: [{ cell: [0, 0], temperature: 200, flow: 3e201 }],
    });
    const before = stateBytes(world, lava);
    const saved = world.takeSnapshot();
    assert.ok(lava.budget.initialEnthalpy > 9.9e307);
    for (let replay = 0; replay < 2; replay++) {
      assert.throws(() => world.advance(1), error(/publication exceeds finite surface, source or budget range/));
      assert.equal(world.tick, 0);
      assert.deepEqual(stateBytes(world, lava), before);
      world.restoreSnapshot(saved.bytes);
    }
  }
});

test('LavaSolver refuses an unresolved explicit tick without advancing the accepted state', async () => {
  const lava = await LavaSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, -1e11, 0] }).add(lava, { ...cell, depth: 1 });
  const before = stateBytes(world, lava);
  assert.throws(() => world.advance(1), error(/exceeds 4096 explicit microsteps/));
  assert.equal(world.tick, 0);
  assert.deepEqual(stateBytes(world, lava), before);
});

const feedback = [ICE_HEAT_ABSORPTION_FIELD, ICE_MELTWATER_FIELD, ICE_STEAM_FIELD];
class InvalidIceFeedback {
  describe() {
    return {
      id: 'invalid-lava-ice-feedback',
      rate: 0,
      stableRate: () => 0,
      fields: feedback.map((field) => ({ field, access: 'write' })),
    };
  }
  init(host) {
    this.memory = host.memory;
    this.regions = feedback.map(({ name }) => host.allocate(name, 8, 'f64', ICE_FIELD_LAYOUT));
    regionWords(this.memory, this.regions[0])[0] = Number.MAX_VALUE;
  }
  step() {}
  importPorts() {}
  stateRegions() {
    return this.regions;
  }
  extraState() {
    return [];
  }
  exportPorts(tick) {
    return feedback.map(({ name }, i) => ({ field: name, region: this.regions[i], tick, cell: [0, 0, 0] }));
  }
}

test('LavaSolver rejects over-accepted ICE heat before replacing any accepted field', async () => {
  const lava = await LavaSolver.load({ exchangeIce: true });
  const world = new PhysicsWorld({ rate })
    .add(lava, { ...cell, depth: 0.4, ice: [{ cell: [0, 0], area: 1 }] })
    .add(new InvalidIceFeedback(), {});
  const before = stateBytes(world, lava);
  assert.throws(() => world.advance(1), error(/Ice accepted more heat than lava offered/));
  assert.equal(world.tick, 0);
  assert.deepEqual(stateBytes(world, lava), before);
});

test('LavaSolver follows TerrainBed in its live world cell after an origin shift', async () => {
  const shape = { columns: 2, rows: 2, width: 2, depth: 2, centre: [1, 1] };
  const originCell = [3, 0, -4];
  const make = async () => {
    const lava = await LavaSolver.load({ terrain: shape });
    const world = new PhysicsWorld({ rate })
      .add(new TerrainBed(), { ...shape, elevations: (x, z) => x + 2 * z }, originCell)
      .add(lava, { ...cell, cells: [2, 2], originCell }, originCell);
    return { lava, world };
  };
  const control = await make();
  const shifted = await make();
  control.world.advance(1);
  shifted.world.advance(1);
  assert.equal(shifted.lava.sample(0, 0).surfaceElevation, 1.5);
  shifted.world.shiftOrigin(originCell);
  control.world.advance(2);
  shifted.world.advance(2);
  assert.deepEqual(stateBytes(shifted.world, shifted.lava), stateBytes(control.world, control.lava));
  assert.deepEqual(shifted.lava.exportPorts(2)[0].cell, [0, 0, 0]);
  assert.deepEqual(control.lava.exportPorts(2)[0].cell, originCell);
});

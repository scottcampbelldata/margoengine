import assert from 'node:assert/strict';
import test from 'node:test';
import { LightningSolver } from '../../dist/lightning.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const size = [3, 8, 3];
const spacing = 1;
const c = 299_792_458;

function basin(solver, options = {}, shared = false) {
  return new PhysicsWorld({ rate, memory: worldMemory(shared) }).add(solver, { size, spacing, ...options });
}

function fault(code, message) {
  return { name: 'MargoError', code, message };
}

function bed(sample, cell = [0, 0, 0]) {
  return { cell, sample: (x, z) => ({ elevation: sample(x, z), normal: [0, 1, 0] }) };
}

test('LightningSolver rejects invalid cell, bed, grid, charge, query and timing values', async () => {
  const lightning = await LightningSolver.load();
  const cases = [
    [{ size: [3, 8] }, /node counts/],
    [{ size: [50_000, 50_000, 50_000] }, /wasm32 memory/],
    [{ origin: [2 ** 30, 0, 0] }, /nodes cannot be distinguished/],
    [{ spacing: Number.MAX_VALUE }, /nodes cannot be distinguished/],
    [{ cell: [0, 0.5, 0] }, /safe integer origin cells/],
    [{ bed: bed(() => 0, [0, Infinity, 0]) }, /safe integer origin cells/],
    [
      { cell: [Number.MAX_SAFE_INTEGER, 0, 0], bed: bed(() => 0, [-Number.MAX_SAFE_INTEGER, 0, 0]) },
      /bed offset exceeds safe cells/,
    ],
    [{ bed: bed(() => NaN) }, /bed elevation must be finite/],
    [{ bed: bed(() => 7) }, /Raise the cloud plane/],
    [{ charge: () => NaN }, /space charge must be finite/],
    [{ charge: () => Number.MAX_VALUE }, /space charge exceeds numeric resolution/],
    [{ sweeps: 2 ** 32 }, /relaxation sweeps/],
    [{ start: Number.MAX_VALUE }, /timing exceeds numeric resolution/],
    [{ startColumn: [3, 1] }, /seed is off the cloud plane/],
  ];
  for (const [parameters, expected] of cases)
    assert.throws(() => basin(lightning, parameters), fault('state', expected));
  basin(lightning);
  assert.throws(() => lightning.potentialAt(0, Infinity, 1), fault('state', /Use valid x, y and z indices/));
  assert.throws(() => lightning.brightness(NaN), fault('state', /flash time must be finite/));
});

test('LightningSolver limits leader and return propagation independently by the SI speed of light', async () => {
  const lightning = await LightningSolver.load();
  assert.throws(() => basin(lightning, { leaderSpeed: c + 1 }), fault('state', /leader speed exceeds light speed/));
  assert.throws(() => basin(lightning, { returnSpeed: c + 1 }), fault('state', /return speed exceeds light speed/));
  const world = basin(lightning, { leaderSpeed: c, returnSpeed: c });
  world.advance(1);
  assert.ok(lightning.flash);
  assert.ok(lightning.thunder().every((source) => source.emissionTime > lightning.flash.time));

  const sloped = await LightningSolver.load();
  const terrain = bed((x, z) => (x === 1 && z === 1 ? 0 : 1.75));
  const steep = basin(sloped, { size: [3, 3, 3], leaderSpeed: c, bed: terrain });
  assert.throws(() => steep.advance(1), fault('state', /attachment would cross faster than light/));
  assert.equal(steep.tick, 0);
  assert.equal(sloped.channel().count, 0);
});

test('LightningSolver refuses unrepresentable native solves and keeps finite bounded iterations and rails', async () => {
  for (const shared of [false, true]) {
    const lightning = await LightningSolver.load();
    assert.throws(
      () => basin(lightning, { cloudPotential: 1, charge: () => 1e297 }, shared),
      fault('failed', /potential solve exceeded numeric range/),
    );
    assert.throws(
      () => basin(lightning, { cloudPotential: Number.MAX_VALUE, charge: () => 2e297 }, shared),
      fault('failed', /potential or boundary rail/),
    );
    basin(lightning, { cloudPotential: 200, charge: () => 1e-10, tolerance: 1e-12, sweeps: 1 }, shared);
    assert.equal(lightning.potentialAt(1, 0, 1), 0);
    assert.equal(lightning.potentialAt(1, 7, 1), 200);
    assert.ok(Number.isFinite(lightning.residual) && lightning.residual > 1e-12);
  }
});

test('Unthresholded LightningSolver reports an electrically blocked leader with a coded correction', async () => {
  const lightning = await LightningSolver.load();
  const world = basin(lightning, { cloudPotential: 1, charge: () => 1e-8 });
  assert.ok(lightning.potentialAt(1, 6, 1) > 1);
  assert.throws(() => world.advance(1), fault('failed', /no downhill electric bond/));
  assert.equal(world.tick, 0);
  assert.equal(lightning.channel().count, 0);
});

test('LightningSolver leaves every accepted region unchanged when a late return-stroke delay fails', async () => {
  for (const shared of [false, true]) {
    const lightning = await LightningSolver.load();
    const world = basin(lightning, { returnSpeed: 3e-308 }, shared);
    const initial = world.takeSnapshot();
    const dump = () =>
      lightning.stateRegions().map((region) => {
        const bytes = new Uint8Array(world.memory.buffer, region.byteOffset, region.byteLength);
        return Buffer.from(bytes);
      });
    const before = dump();
    for (let replay = 0; replay < 2; replay++) {
      assert.throws(() => world.advance(1), fault('state', /return-stroke delay exceeds numeric resolution/));
      assert.equal(world.tick, 0);
      assert.deepEqual(dump(), before);
      assert.equal(lightning.channel().count, 0);
      assert.equal(lightning.flash, undefined);
      assert.deepEqual(lightning.thunder(), []);
      world.restoreSnapshot(initial.bytes);
    }
  }
});

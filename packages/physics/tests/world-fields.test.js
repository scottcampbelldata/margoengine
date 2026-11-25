// The field registry of the physics framework: one writer per field, SI units, readers see the value at the coupling tick
// with the previous kept, contributions summed by contributor id then element whatever order they came in, and every byte
// of it in regions of the world's memory, so the state hash and a snapshot take it along.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Arena,
  FieldRegistry,
  TransferRegistry,
  regionWords,
  restoreSnapshot,
  stateHash,
  takeSnapshot,
} from '../dist/world.js';

const velocity = { name: 'wind', kind: 'uniformGrid', quantity: 'velocity', unit: 'm/s', centring: 'cell' };
const impulse = { name: 'hullImpulse', kind: 'bodySet', quantity: 'impulse', unit: 'N s', centring: 'particle' };

/** A port over a fresh region of `arena` holding `values` as `type` words. */
function port(arena, field, tick, values, type = 'f64', name = field) {
  const bytes = { f64: 8, f32: 4 }[type],
    region = arena.allocate(name, values.length * bytes, type, 1);
  regionWords(arena.memory, region).set(values);
  return { field, region, tick, cell: [0, 0, 0] };
}

const words = (arena, p) => Array.from(regionWords(arena.memory, p.region));

test('one writer per field, refused all or nothing', () => {
  const fields = new FieldRegistry(new Arena());
  fields.declare('atmosphere', [{ field: velocity, access: 'write' }]);
  fields.declare('sails', [
    { field: velocity, access: 'read' },
    { field: impulse, access: 'write' },
  ]);
  assert.throws(
    () =>
      fields.declare('gusts', [
        { field: { ...impulse, name: 'other' }, access: 'write' },
        { field: velocity, access: 'write' },
      ]),
    /two writers, "atmosphere" and "gusts"/,
  );
  assert.equal(fields.field('other'), undefined, 'a refused declaration adds no field');
  assert.deepEqual(
    fields.list().map((f) => [f.descriptor.name, f.owner, f.readers]),
    [
      ['hullImpulse', 'sails', []],
      ['wind', 'atmosphere', ['sails']],
    ],
  );
  fields.remove('sails');
  assert.deepEqual(fields.field('wind').readers, []);
  assert.equal(fields.field('hullImpulse'), undefined, 'a field nobody touches is dropped');
});

test('a field is described alike everywhere, in SI', () => {
  const fields = new FieldRegistry(new Arena());
  fields.declare('atmosphere', [{ field: velocity, access: 'write' }]);
  assert.throws(
    () => fields.declare('tree', [{ field: { ...velocity, centring: 'face' }, access: 'read' }]),
    /declared two ways/,
  );
  assert.throws(
    () => fields.declare('tree', [{ field: { ...velocity, name: 'gust', unit: 'km/h' }, access: 'read' }]),
    /velocity in "km\/h"; velocity is in "m\/s"/,
  );
  assert.throws(
    () => fields.declare('tree', [{ field: { ...velocity, name: 'g', kind: 'grid' }, access: 'read' }]),
    /kind "grid"/,
  );
  assert.throws(
    () => fields.declare('tree', [{ field: { ...velocity, name: 'g', unit: '' }, access: 'read' }]),
    /no unit/,
  );
  // A quantity the framework does not list keeps the unit its descriptor names.
  fields.declare('tree', [{ field: { ...velocity, name: 'stress', quantity: 'stress', unit: 'Pa' }, access: 'write' }]);
});

test('readers see the value at the coupling tick, and the previous one, after the owner steps on', () => {
  const arena = new Arena(),
    fields = new FieldRegistry(arena);
  fields.declare('atmosphere', [{ field: velocity, access: 'write' }]);
  const own = port(arena, 'wind', 0, [1, 2, 3]);
  fields.publish('atmosphere', { ...own, cell: [0, 0, 0] }, 0);
  regionWords(arena.memory, own.region).set([7, 7, 7]); // the owner steps on in its own region
  assert.deepEqual(words(arena, fields.port('wind')), [1, 2, 3]);
  fields.publish('atmosphere', { ...own, tick: 1, cell: [1, 0, -2] }, 0);
  const wind = fields.field('wind');
  assert.deepEqual(words(arena, wind.current.port), [7, 7, 7]);
  assert.deepEqual(words(arena, wind.previous.port), [1, 2, 3]);
  assert.deepEqual(
    [wind.current.port.tick, wind.current.port.cell, wind.previous.port.cell],
    [1, [1, 0, -2], [0, 0, 0]],
  );
  // Tick 3 at 240 Hz ends at the same time as tick 0 at 60 Hz: earlier than the current value, refused.
  assert.throws(() => fields.publish('atmosphere', { ...own, tick: 3, cell: [0, 0, 0] }, 2), /publish in time order/);
  fields.publish('atmosphere', { ...own, tick: 7, cell: [0, 0, 0] }, 2); // ends with tick 1 at 60 Hz: allowed
  assert.throws(
    () => fields.publish('atmosphere', port(arena, 'wind', 9, [1, 2]), 0),
    /keeps its type, length and layout/,
  );
  assert.throws(
    () => fields.publish('sails', { ...own, tick: 9, cell: [0, 0, 0] }, 0),
    /neither writes nor accumulates/,
  );
});

test('contributions sum by contributor id then element, the same bits in any order', () => {
  // Values whose float sum depends on the order they are added in.
  const parts = { aSail: [1e16, 0.5], bHull: [1, 0.25], cRudder: [-1e16, 1e-17] };
  const run = (order) => {
    const arena = new Arena(),
      fields = new FieldRegistry(arena);
    fields.declare('rigid', [{ field: impulse, access: 'write' }]);
    for (const id of Object.keys(parts)) fields.declare(id, [{ field: impulse, access: 'accumulate' }]);
    for (const id of order) fields.publish(id, port(arena, 'hullImpulse', 0, parts[id], 'f64', id), 0);
    // A substep of the hull adds to its own contribution first, in time order.
    fields.publish('bHull', { ...port(arena, 'hullImpulse', 1, [2, 2], 'f64', 'again'), cell: [0, 0, 0] }, 0);
    const sum = fields.sum('hullImpulse', 1);
    return { sum: words(arena, sum), next: words(arena, fields.sum('hullImpulse', 2)) };
  };
  const first = run(['aSail', 'bHull', 'cRudder']);
  assert.deepEqual(first.sum, [1e16 + 3 + -1e16, 0.5 + 2.25 + 1e-17]);
  assert.deepEqual(run(['cRudder', 'aSail', 'bHull']), first);
  assert.deepEqual(run(['bHull', 'cRudder', 'aSail']), first);
  assert.deepEqual(first.next, [0, 0], 'a sum clears the contributions');
});

test('an f32 contribution is summed in f64, and nobody contributing gives no port', () => {
  const arena = new Arena(),
    fields = new FieldRegistry(arena);
  fields.declare('rigid', [{ field: impulse, access: 'write' }]);
  fields.declare('cloth', [{ field: impulse, access: 'accumulate' }]);
  assert.equal(fields.sum('hullImpulse', 0), undefined);
  fields.publish('cloth', { ...port(arena, 'hullImpulse', 0, [0.1, 3], 'f32'), cell: [0, 0, 0] }, 3);
  fields.publish('cloth', { ...port(arena, 'hullImpulse', 0, [0.1, 3], 'f32', 'more'), cell: [0, 0, 0] }, 3);
  const sum = fields.sum('hullImpulse', 0);
  assert.equal(sum.region.type, 'f64');
  assert.deepEqual(words(arena, sum), [2 * Math.fround(0.1), 6]);
  assert.throws(
    () => fields.publish('cloth', { ...port(arena, 'hullImpulse', 1, [1, 2, 3], 'f32', 'long'), cell: [0, 0, 0] }, 3),
    /keep a contribution's length/,
  );
});

test("the registry's state is in the world's memory: hashed, snapshotted and restored", () => {
  const arena = new Arena(),
    fields = new FieldRegistry(arena),
    world = {
      describe: () => ({ id: '', fields: [], rate: 0, stableRate: () => 0 }),
      stateRegions: () => fields.stateRegions(),
      extraState: () => [],
    };
  fields.declare('atmosphere', [{ field: velocity, access: 'write' }]);
  fields.declare('rigid', [{ field: impulse, access: 'write' }]);
  fields.declare('sail', [{ field: impulse, access: 'accumulate' }]);
  const own = port(arena, 'wind', 0, [1, 2, 3]),
    push = port(arena, 'hullImpulse', 0, [4, 5], 'f64', 'push');
  fields.publish('atmosphere', { ...own, cell: [0, 0, 0] }, 0);
  fields.publish('sail', { ...push, cell: [0, 0, 0] }, 0);
  fields.sum('hullImpulse', 0);
  const before = stateHash(arena.memory, [world]),
    snapshot = takeSnapshot(arena.memory, [world]);
  fields.publish('atmosphere', { ...own, tick: 1, cell: [2, 0, 0] }, 0);
  fields.publish('sail', { ...push, cell: [0, 0, 0] }, 0);
  assert.notEqual(stateHash(arena.memory, [world]), before, 'a publish and a pending contribution change the hash');
  restoreSnapshot(arena.memory, [world], snapshot.bytes);
  assert.equal(stateHash(arena.memory, [world]), before);
  const wind = fields.field('wind');
  assert.deepEqual([wind.current.port.tick, wind.current.port.cell, wind.previous], [0, [0, 0, 0], undefined]);
  assert.deepEqual(words(arena, fields.sum('hullImpulse', 1)), [0, 0], 'the restored contribution was the cleared one');
});

test('transfers are registered once by name', () => {
  const transfers = new TransferRegistry(),
    apic = { name: 'apic', from: 'particles', to: 'grid', apply() {} };
  transfers.register(apic);
  assert.equal(transfers.get('apic'), apic);
  assert.throws(() => transfers.register(apic), /already registered/);
  assert.throws(
    () => transfers.get('remap'),
    (e) => e.name === 'MargoError' && e.code === 'state',
  );
  assert.deepEqual(transfers.names(), ['apic']);
});

test("a port for the tick the current value ends at replaces it; regionsOf lists a field's regions", () => {
  const arena = new Arena(),
    fields = new FieldRegistry(arena);
  fields.declare('atmosphere', [{ field: velocity, access: 'write' }]);
  fields.declare('tree', [{ field: velocity, access: 'read' }]);
  const own = port(arena, 'wind', 0, [1, 2, 3]);
  fields.publish('atmosphere', own, 0, [0, 0, 0]);
  regionWords(arena.memory, own.region).set([4, 5, 6]);
  fields.publish('atmosphere', { ...own, tick: 1 }, 0, [0, 0, 0]);
  // A coupling group re-runs tick 1 (and tick 3 of level 1 ends with it): the current value is replaced, the previous kept.
  regionWords(arena.memory, own.region).set([7, 8, 9]);
  fields.publish('atmosphere', { ...own, tick: 3 }, 1, [0, 0, 0]);
  const wind = fields.field('wind');
  assert.deepEqual(words(arena, wind.current.port), [7, 8, 9]);
  assert.deepEqual(words(arena, wind.previous.port), [1, 2, 3]);
  assert.deepEqual(
    fields.regionsOf('wind').map((r) => r.name),
    ['wind/meta', 'wind/a', 'wind/b'],
  );
  assert.deepEqual(fields.regionsOf('nothing'), []);
  assert.deepEqual(fields.stateRegions(), fields.regionsOf('wind'));
});

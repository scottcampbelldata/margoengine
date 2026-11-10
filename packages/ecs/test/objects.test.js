import assert from 'node:assert/strict';
import test from 'node:test';
import { World, Query, ChangeTracker } from '../dist/index.js';
import { GrowableWorld } from '../dist/growable.js';
import { ObjectComponent, objectField } from '../dist/objects.js';

test('mixed fields keep JS identity, numeric validation, query rows and lifecycle notifications', () => {
  const world = new World(4);
  const c = new ObjectComponent(world, { name: objectField(() => ''), data: objectField(() => []), x: Uint8Array });
  const a = world.create(),
    b = world.create();
  const cycle = {};
  cycle.self = cycle;
  const tracker = new ChangeTracker(c);
  const seen = [];
  c.observers.push({ onAdd: (e) => seen.push(c.fields.name[c.index(e)]), onChange() {}, onRemove() {} });
  c.add(a, { name: '你好', data: cycle, x: 255 });
  c.add(b);
  assert.deepEqual(seen, ['你好', '']);
  assert.equal(c.fields.data[c.index(a)], cycle);
  assert.deepEqual(c.fields.data[c.index(b)], []);
  assert.throws(() => c.add(a, { name: 'bad', x: 256 }), /Invalid/);
  assert.throws(() => c.add(a, { missing: 0 }), /Unknown/);
  assert.equal(c.fields.name[c.index(a)], '你好');
  const out = new Uint32Array(4);
  assert.equal(new Query(world, { with: [c] }).run(out), 2);
  assert.equal(world.query([c], out), 2);
  assert.equal(tracker.added(out), 2);
  world.destroy(a);
  assert.equal(c.index(b), 0);
  assert.equal(c.fields.data.length, 1);
  c.add(b, { data: () => 'function' });
  assert.equal(c.fields.data[0](), 'function');
  world.destroy(b);
  assert.equal(c.fields.data.length, 0);
  assert.equal(c.fields.name.length, 0);
  assert.throws(() => c.add(a), /stale/);
  tracker.stop();
});

test('growable arrays and independent defaults survive packed moves and slot reuse', () => {
  const world = new GrowableWorld({ capacity: 1, limit: 8 });
  const c = new ObjectComponent(world, { item: objectField(() => []), x: Float64Array });
  const a = world.create();
  c.add(a, { x: 12 });
  const b = world.create();
  c.add(b, { x: 13 });
  assert.notEqual(c.fields.item[0], c.fields.item[1]);
  const fields = c.fields.x;
  world.destroy(a);
  assert.equal(fields[c.index(b)], 13);
  const next = world.create();
  c.add(next);
  assert.equal(fields[c.index(next)], 0);
  assert.equal(c.fields.item[c.index(next)].length, 0);
});

test('factory failures do not allocate partial membership and special field names are safe', () => {
  const world = new World(2);
  let fail = true;
  const c = new ObjectComponent(world, {
    value: objectField(() => {
      if (fail) throw new TypeError('factory');
      return 7;
    }),
  });
  const a = world.create();
  assert.throws(() => c.add(a), /factory/);
  assert.equal(c.size, 0);
  assert.equal(c.index(a), -1);
  fail = false;
  c.add(a);
  assert.equal(c.fields.value[0], 7);
  const names = new ObjectComponent(world, { ['__proto__']: objectField(), constructor: objectField() });
  names.add(a, { ['__proto__']: 'own', constructor: null });
  assert.equal(names.fields.__proto__[0], 'own');
  assert.equal(names.fields.constructor[0], null);
  assert.throws(() => new ObjectComponent(world, {}), /Empty/);
  assert.throws(() => objectField(5), /factory/);
});

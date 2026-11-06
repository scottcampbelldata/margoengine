import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/index.js';
import { ChangeTracker } from '../dist/changes.js';
import { GrowableWorld } from '../dist/growable.js';
import { Query } from '../dist/query.js';
import { Relation } from '../dist/relations.js';

test('a GrowableWorld is a World and doubles when create runs out', () => {
  const world = new GrowableWorld({ capacity: 2 });
  assert.ok(world instanceof World);
  assert.equal(world.limit, 1_000_000);
  for (let i = 0; i < 5; i++) world.create();
  assert.equal(world.capacity, 8);
});

test('growing keeps ids, rows and every array reference, including ones taken before it', () => {
  const world = new GrowableWorld({ capacity: 2 }),
    position = world.component({ x: Float32Array, id: Uint32Array }),
    wide = world.component({ value: Float64Array }),
    { x } = position.fields,
    output = world.allocate(Uint32Array);
  const entities = [];
  for (let i = 0; i < 100; i++) {
    const entity = world.create();
    entities.push(entity);
    position.add(entity, { x: i, id: i });
    wide.add(entity, { value: i / 3 });
  }
  assert.equal(world.capacity, 128);
  assert.equal(x, position.fields.x);
  assert.equal(x.length, 128);
  assert.equal(output.length, 128);
  entities.forEach((entity, i) => {
    assert.equal(world.alive(entity), true);
    assert.equal(x[position.index(entity)], i);
    assert.equal(wide.fields.value[wide.index(entity)], i / 3);
  });
  assert.equal(world.query([position, wide], output), 100);
});

test('slots added by growing start empty for components made before and after', () => {
  const world = new GrowableWorld({ capacity: 1 }),
    before = world.component({ x: Float32Array }),
    tag = world.tag();
  const first = world.create(),
    second = world.create();
  const after = world.component({ y: Int32Array });
  assert.equal(world.capacity, 2);
  for (const store of [before, tag, after]) assert.equal(store.index(second), -1);
  before.add(second, { x: 1 });
  tag.add(second);
  after.add(second, { y: 2 });
  assert.equal(before.index(first), -1);
  const third = world.create();
  assert.equal(after.fields.y.length, 4);
  assert.equal(after.index(third), -1);
  assert.equal(after.fields.y[after.index(second)], 2);
});

test('the limit stops growth with an error that says what to change, and freed slots are used first', () => {
  const world = new GrowableWorld({ capacity: 1, limit: 3 });
  const entities = [world.create(), world.create(), world.create()];
  assert.equal(world.capacity, 3);
  assert.throws(() => world.create(), (error) => error instanceof RangeError && /higher limit/.test(error.message));
  world.destroy(entities[1]);
  const reused = world.create();
  assert.notEqual(reused, entities[1]);
  assert.equal(world.alive(entities[1]), false);
  assert.equal(world.capacity, 3);
});

test('a slot retired by the id space is replaced by growing', () => {
  const world = new GrowableWorld({ capacity: 1 });
  for (let i = 0; i < 5000; i++) world.destroy(world.create());
  assert.equal(world.capacity, 2);
  assert.equal(world.alive(world.create()), true);
});

test('trackers, queries and relations carry on across growth', () => {
  const world = new GrowableWorld({ capacity: 2 }),
    position = world.component({ x: Float32Array }),
    frozen = world.tag(),
    tracker = new ChangeTracker(position),
    childOf = new Relation(world, { cascade: true }),
    moving = new Query(world, { with: [position], without: [frozen] });
  const root = world.create(),
    children = Array.from({ length: 40 }, () => {
      const entity = world.create();
      position.add(entity, { x: 1 });
      childOf.add(entity, root);
      return entity;
    });
  frozen.add(children[0]);
  const output = world.allocate(Uint32Array);
  assert.equal(tracker.added(output), 40);
  assert.equal(moving.run(output), 39);
  assert.equal(moving.forEach(() => {}), 39);
  tracker.clear();
  world.destroy(root);
  assert.equal(tracker.removed(output), 40);
  assert.equal(position.size, 0);
});

test('fixed worlds keep their ids, their bound and their error', () => {
  const world = new World(3);
  assert.equal(world.stride, 3);
  const a = world.create();
  world.destroy(a);
  world.create();
  assert.equal(world.create(), 1);
  world.create();
  assert.throws(() => world.create(), /larger capacity/);
});

test('bad settings say what to pass', () => {
  for (const options of [{ capacity: 0 }, { capacity: 1.5 }, { limit: 0 }, { limit: 2_000_000 }, { capacity: 8, limit: 4 }])
    assert.throws(() => new GrowableWorld(options), (error) => error instanceof RangeError && /;/.test(error.message));
});

test('seeded work matches a plain model across growth', () => {
  let seed = 4242;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  const world = new GrowableWorld({ capacity: 1, limit: 1000 }),
    store = world.component({ value: Int32Array }),
    model = new Map(),
    stale = [];
  for (let step = 0; step < 20000; step++) {
    const list = [...model.keys()],
      entity = list[random(list.length)];
    const action = random(5);
    if (action < 2 && model.size < 500) {
      const fresh = world.create();
      assert.equal(model.has(fresh), false);
      store.add(fresh, { value: step });
      model.set(fresh, step);
    } else if (action === 2 && entity !== undefined) {
      world.destroy(entity);
      model.delete(entity);
      stale.push(entity);
    } else if (entity !== undefined) store.add(entity, { value: -step }), model.set(entity, -step);
    if (step % 500 === 0) {
      for (const [id, value] of model) assert.equal(store.fields.value[store.index(id)], value);
      for (const id of stale) assert.equal(world.alive(id), false);
      assert.equal(store.size, model.size);
    }
  }
  assert.ok(world.capacity >= model.size && world.capacity <= 1000);
});

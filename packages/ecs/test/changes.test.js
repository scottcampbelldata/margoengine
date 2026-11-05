import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/index.js';
import { ChangeTracker } from '../dist/changes.js';
import { ChangeTracker as RootTracker } from '../dist/index.js';

const read = (tracker, capacity) => {
  const output = new Uint32Array(capacity),
    list = (kind) => [...output.subarray(0, tracker[kind](output))].sort((a, b) => a - b);
  return { added: list('added'), changed: list('changed'), removed: list('removed') };
};
const setup = (capacity = 8) => {
  const world = new World(capacity),
    position = world.component({ x: Float32Array });
  return { world, position, tracker: new ChangeTracker(position) };
};

test('the root entry exports the same ChangeTracker', () => {
  assert.equal(RootTracker, ChangeTracker);
});

test('add, overwrite, touch and remove land in the right list and clear starts a new window', () => {
  const { world, position, tracker } = setup();
  const a = world.create(),
    b = world.create();
  position.add(a, { x: 1 });
  position.add(b);
  assert.deepEqual(read(tracker, 8), { added: [a, b], changed: [], removed: [] });
  tracker.clear();
  assert.deepEqual(read(tracker, 8), { added: [], changed: [], removed: [] });
  position.add(a, { x: 2 });
  position.fields.x[position.index(b)] = 3;
  assert.equal(position.touch(b), true);
  assert.deepEqual(read(tracker, 8), { added: [], changed: [a, b], removed: [] });
  tracker.clear();
  position.remove(a);
  assert.deepEqual(read(tracker, 8), { added: [], changed: [], removed: [a] });
});

test('add with no values on an existing row changes nothing and touch needs a row', () => {
  const { world, position, tracker } = setup();
  const a = world.create();
  assert.equal(position.touch(a), false);
  position.add(a);
  tracker.clear();
  position.add(a);
  assert.deepEqual(read(tracker, 8), { added: [], changed: [], removed: [] });
});

test('results are net over the window', () => {
  const { world, position, tracker } = setup();
  const a = world.create(),
    b = world.create();
  position.add(b);
  tracker.clear();
  position.add(a, { x: 1 });
  position.add(a, { x: 2 });
  assert.deepEqual(read(tracker, 8).added, [a]);
  assert.deepEqual(read(tracker, 8).changed, []);
  position.remove(a);
  position.remove(b);
  position.add(b);
  assert.deepEqual(read(tracker, 8), { added: [], changed: [b], removed: [] });
  position.add(b, { x: 4 });
  position.remove(b);
  assert.deepEqual(read(tracker, 8), { added: [], changed: [], removed: [b] });
});

test('destroying an entity reports its stale id, and a new entity in the same slot is reported beside it', () => {
  const { world, position, tracker } = setup(1);
  const old = world.create();
  position.add(old);
  tracker.clear();
  world.destroy(old);
  const fresh = world.create();
  position.add(fresh);
  assert.notEqual(fresh, old);
  assert.deepEqual(read(tracker, 1), { added: [fresh], changed: [], removed: [old] });
  world.destroy(fresh);
  assert.deepEqual(read(tracker, 1), { added: [], changed: [], removed: [old] });
});

test('two trackers keep separate windows and a stopped tracker sees nothing new', () => {
  const { world, position, tracker } = setup();
  const second = new ChangeTracker(position);
  const a = world.create();
  position.add(a);
  tracker.clear();
  assert.deepEqual(read(second, 8).added, [a]);
  position.touch(a);
  assert.deepEqual(read(tracker, 8).changed, [a]);
  assert.deepEqual(read(second, 8).changed, []);
  tracker.stop();
  tracker.stop();
  assert.equal(position.observers.length, 1);
  const b = world.create();
  position.add(b);
  assert.deepEqual(read(tracker, 8).added, []);
  {
    using scoped = new ChangeTracker(position);
    assert.equal(position.observers.length, 2);
    assert.ok(scoped);
  }
  assert.equal(position.observers.length, 1);
});

test('a small output throws and says what to pass', () => {
  const { world, position, tracker } = setup();
  position.add(world.create());
  assert.throws(() => tracker.added(new Uint32Array(0)), (error) => error instanceof RangeError && /;/.test(error.message));
});

test('seeded random work matches a snapshot diff of the window', () => {
  let seed = 12345;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  const capacity = 16,
    { world, position, tracker } = setup(capacity);
  const alive = new Set();
  let before = new Set(),
    written = new Set();
  for (let round = 0; round < 500; round++) {
    for (let i = 0; i < 12; i++) {
      const list = [...alive],
        entity = list.length ? list[random(list.length)] : undefined;
      switch (random(5)) {
        case 0:
          if (alive.size < capacity) alive.add(world.create());
          break;
        case 1:
          if (entity !== undefined) {
            world.destroy(entity);
            alive.delete(entity);
          }
          break;
        case 2:
          if (entity !== undefined) {
            if (before.has(entity)) written.add(entity);
            position.add(entity, { x: i });
          }
          break;
        case 3:
          if (entity !== undefined && position.remove(entity) && before.has(entity)) written.add(entity);
          break;
        default:
          if (entity !== undefined && position.touch(entity) && before.has(entity)) written.add(entity);
      }
    }
    const after = new Set([...alive].filter((entity) => position.index(entity) >= 0)),
      sorted = (list) => [...list].sort((a, b) => a - b);
    assert.deepEqual(read(tracker, capacity), {
      added: sorted([...after].filter((entity) => !before.has(entity))),
      changed: sorted([...after].filter((entity) => before.has(entity) && written.has(entity))),
      removed: sorted([...before].filter((entity) => !after.has(entity))),
    });
    tracker.clear();
    before = after;
    written = new Set();
  }
});

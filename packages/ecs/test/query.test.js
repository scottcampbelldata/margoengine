import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/index.js';
import { Query } from '../dist/query.js';
import { Query as RootQuery } from '../dist/index.js';

const scene = () => {
  const world = new World(8),
    position = world.component({ x: Float32Array }),
    health = world.component({ value: Uint8Array }),
    frozen = world.tag();
  const [a, b, c] = [world.create(), world.create(), world.create()];
  position.add(a, { x: 1 });
  position.add(b, { x: 2 });
  position.add(c, { x: 3 });
  health.add(b, { value: 50 });
  frozen.add(c);
  return { world, position, health, frozen, a, b, c };
};
const ids = (query, size = 8) => {
  const output = new Uint32Array(size);
  return [...output.subarray(0, query.run(output))].sort((x, y) => x - y);
};

test('the root entry exports the same Query', () => {
  assert.equal(RootQuery, Query);
});

test('tags hold no field data and work as components in queries and destroy', () => {
  const { world, frozen, position, c } = scene();
  assert.deepEqual(Object.keys(frozen.fields), []);
  assert.equal(frozen.has(c), true);
  assert.equal(position.has(c), true);
  const output = new Uint32Array(8);
  assert.equal(world.query([frozen, position], output), 1);
  assert.equal(output[0], c);
  assert.throws(() => frozen.add(c, { x: 1 }), RangeError);
  world.destroy(c);
  assert.equal(frozen.size, 0);
  assert.equal(frozen.has(c), false);
});

test('a plain empty schema is still refused', () => {
  assert.throws(() => new World(2).component({}), TypeError);
});

test('without drops entities, optional never changes the match', () => {
  const { world, position, health, frozen, a, b, c } = scene();
  assert.deepEqual(ids(new Query(world, { with: [position] })), [a, b, c]);
  assert.deepEqual(ids(new Query(world, { with: [position], without: [frozen] })), [a, b]);
  assert.deepEqual(ids(new Query(world, { with: [position], without: [frozen, health] })), [a]);
  assert.deepEqual(ids(new Query(world, { with: [position], optional: [health] })), [a, b, c]);
  assert.deepEqual(ids(new Query(world, { with: [position, health], without: [frozen] })), [b]);
});

test('an output sized for the filtered matches is enough, and a smaller one throws', () => {
  const { world, position, frozen } = scene();
  const query = new Query(world, { with: [position], without: [frozen] });
  assert.equal(query.run(new Uint32Array(2)), 2);
  assert.throws(() => query.run(new Uint32Array(1)), (error) => error instanceof RangeError && /;/.test(error.message));
});

test('forEach gives the row of every term and -1 for a missing optional', () => {
  const { world, position, health, frozen, a, b } = scene();
  const seen = new Map();
  const calls = new Query(world, { with: [position], without: [frozen], optional: [health] }).forEach((entity, rows) =>
    seen.set(entity, [position.fields.x[rows[0]], rows[1] < 0 ? -1 : health.fields.value[rows[1]]]),
  );
  assert.equal(calls, 2);
  assert.deepEqual(seen.get(a), [1, -1]);
  assert.deepEqual(seen.get(b), [2, 50]);
});

test('forEach survives destroying and removing during the loop and passes over what stopped matching', () => {
  const world = new World(16),
    position = world.component({ x: Float32Array }),
    gone = world.tag();
  const entities = Array.from({ length: 10 }, (_, i) => {
    const entity = world.create();
    position.add(entity, { x: i });
    return entity;
  });
  const seen = [];
  new Query(world, { with: [position], without: [gone] }).forEach((entity, rows) => {
    seen.push(position.fields.x[rows[0]]);
    if (seen.length === 1) {
      world.destroy(entity);
      position.remove(entities[9]);
      gone.add(entities[8]);
    }
  });
  assert.deepEqual(seen.sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a query cannot re-enter itself, recovers after a throw, and a second query may nest', () => {
  const { world, position, health } = scene();
  const query = new Query(world, { with: [position] }),
    inner = new Query(world, { with: [health] }),
    state = (error) => error.code === 'state' && /second Query/.test(error.message);
  assert.throws(() => query.forEach(() => query.run(new Uint32Array(8))), state);
  assert.throws(() => query.forEach(() => query.forEach(() => {})), state);
  assert.throws(() => query.forEach(() => { throw new Error('boom'); }), /boom/);
  let nested = 0;
  query.forEach(() => { nested += inner.forEach(() => {}); });
  assert.equal(nested, 3);
});

test('terms must be of this world and with must not be empty', () => {
  const { world, position } = scene();
  const foreign = new World(2).component({ x: Float32Array });
  for (const terms of [
    { with: [] },
    { with: [foreign] },
    { with: [position], without: [foreign] },
    { with: [position], optional: [foreign] },
  ])
    assert.throws(() => new Query(world, terms), (error) => error instanceof TypeError && /;/.test(error.message));
});

test('seeded scenes match a filter over every entity', () => {
  let seed = 99;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  for (let round = 0; round < 200; round++) {
    const world = new World(32),
      stores = [world.component({ x: Float32Array }), world.tag(), world.component({ y: Int32Array }), world.tag()],
      entities = Array.from({ length: 32 }, () => world.create());
    for (const entity of entities) for (const store of stores) if (random(2)) store.add(entity);
    const pick = (from) => from.filter(() => random(2));
    const required = [stores[random(4)]],
      excluded = pick(stores).filter((store) => !required.includes(store)),
      expected = entities
        .filter((entity) => required[0].has(entity) && !excluded.some((store) => store.has(entity)))
        .sort((x, y) => x - y);
    assert.deepEqual(ids(new Query(world, { with: required, without: excluded }), 32), expected);
  }
});

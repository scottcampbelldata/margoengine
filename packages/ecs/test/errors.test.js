import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/index.js';

// Every ECS error keeps its class and names its fix after a '; ' clause.
const fixes = (Class) => (error) => error instanceof Class && /;/.test(error.message);

test('schema and storage errors are TypeErrors that say what to pass', () => {
  const world = new World(8);
  assert.throws(() => world.component({}), fixes(TypeError));
  assert.throws(() => world.component({ x: Array }), fixes(TypeError));
});

test('capacity, data and query-size errors are RangeErrors that say what to change', () => {
  for (const capacity of [0, 1.5, 2_000_000]) assert.throws(() => new World(capacity), fixes(RangeError));
  const world = new World(2);
  const position = world.component({ x: Float32Array, id: Uint8Array });
  const entity = world.create();
  assert.throws(() => position.add(entity, { x: Number.NaN }), fixes(RangeError));
  assert.throws(() => position.add(entity, { id: 300 }), fixes(RangeError));
  position.add(entity, { x: 1 });
  world.create();
  assert.throws(
    () => world.create(),
    (error) => fixes(RangeError)(error) && /larger capacity/.test(error.message),
  );
  const small = new Uint32Array(0);
  assert.throws(
    () => world.query([position], small),
    (error) => fixes(RangeError)(error) && /Uint32Array/.test(error.message),
  );
});

test('a stale entity throws a coded state error', () => {
  const world = new World(2);
  const entity = world.create();
  world.destroy(entity);
  assert.throws(
    () => world.check(entity),
    (error) => error.name === 'MargoError' && error.code === 'state' && /world\.alive/.test(error.message),
  );
});

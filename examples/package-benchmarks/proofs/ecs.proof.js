// Proof for @margoengine/ecs: query tests entity liveness once per row instead of once per component, and
// add/remove walk a cached column list instead of calling Object.values per call.
// Run: node examples/package-benchmarks/proofs/ecs.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/ecs.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('ecs', ref, undefined, pin);
// A mid-sized game scene: 10,000 live entities, every one with a transform, two thirds moving, half with health.
const entityCount = 10000;
function scene({ World }) {
  const world = new World(16384),
    position = world.component({ x: Float32Array, y: Float32Array, z: Float32Array });
  const velocity = world.component({ x: Float32Array, y: Float32Array, z: Float32Array }),
    health = world.component({ value: Uint8Array, team: Int32Array });
  const entities = [];
  for (let i = 0; i < entityCount; i++) {
    const entity = world.create();
    entities.push(entity);
    position.add(entity, { x: i, y: i * 0.5, z: -i });
    if (i % 3) velocity.add(entity, { x: 1, z: i % 7 });
    if (i % 2) health.add(entity, { value: i % 256, team: -(i % 5) });
  }
  return { world, position, velocity, health, entities, output: new Uint32Array(16384) };
}
// Spawn/despawn churn: 1,000 entities die and 1,000 respawn with all three components (a busy frame of projectiles).
function churn(s, round) {
  for (let i = 0; i < 1000; i++) {
    const at = (i * 7 + round * 13) % s.entities.length;
    s.world.destroy(s.entities[at]);
    const entity = s.world.create();
    s.entities[at] = entity;
    s.position.add(entity, { x: i, y: round, z: 1 });
    s.velocity.add(entity, { x: 2 });
    s.health.add(entity, { value: 9 });
  }
  for (let i = 0; i < 500; i++) s.velocity.remove(s.entities[(i * 11 + round) % s.entities.length]);
}
const state = (s) =>
  [s.position, s.velocity, s.health].map((c) => ({
    size: c.size,
    entities: c.entities.slice(0, c.size),
    fields: Object.values(c.fields).map((field) => field.slice(0, c.size)),
  }));
const queries = (s) =>
  [[s.position, s.velocity, s.health], [s.health, s.position], [s.velocity], [s.position, s.position]].map((set) => {
    const count = s.world.query(set, s.output);
    return s.output.slice(0, count);
  });

const a = scene(baseline),
  b = scene(candidate);
assert.deepEqual(queries(b), queries(a));
for (let round = 0; round < 20; round++) {
  churn(a, round);
  churn(b, round);
  assert.deepEqual(b.entities, a.entities);
  assert.deepEqual(state(b), state(a));
  assert.deepEqual(queries(b), queries(a));
}
// Edge cases from the package tests plus the ones the query rewrite could disturb.
for (const { World, Component } of [baseline, candidate]) {
  const world = new World(3),
    position = world.component({ x: Float32Array }),
    health = world.component({ value: Uint8Array }),
    output = new Uint32Array(3);
  const e = [world.create(), world.create(), world.create()];
  for (const entity of e) position.add(entity, { x: entity + 1 });
  health.add(e[1], { value: 100 });
  assert.equal(world.query([position, health], output), 1);
  assert.equal(output[0], e[1]);
  assert.throws(() => world.query([position], new Uint32Array(0)), {
    name: 'RangeError',
    message: 'Query output is too small',
  });
  assert.throws(() => world.query([], output), { name: 'TypeError' });
  assert.throws(() => world.query([new World(2).component({ x: Float32Array })], output), { name: 'TypeError' });
  assert.throws(() => position.add(e[1], { x: NaN }), { name: 'RangeError', message: 'Invalid component data' });
  assert.throws(() => position.add(e[1], { y: 1 }), { name: 'RangeError' });
  world.destroy(e[0]);
  assert.equal(position.size, 2);
  assert.equal(position.fields.x[position.index(e[2])], e[2] + 1);
  assert.throws(() => position.add(e[0]), /stale/);
  assert.equal(position.remove(e[0]), false);
  // A component built directly is not registered with the world, so destroyed entities stay in its rows; queries must still skip them.
  const loose = new Component(world, { x: Float32Array });
  loose.add(e[1]);
  loose.add(e[2]);
  world.destroy(e[1]);
  const reused = world.create();
  loose.add(reused, { x: 5 });
  assert.equal(loose.size, 3);
  assert.equal(world.query([loose], output), 2);
  assert.deepEqual([...output.slice(0, 2)], [e[2], reused]);
  assert.equal(world.query([loose, position], output), 1);
  assert.equal(output[0], e[2]);
}

const cases = [];
const qa = scene(baseline),
  qb = scene(candidate),
  sets = (s) => [s.position, s.velocity, s.health];
// 600 three-component queries is ten systems per frame for one second at 60 FPS.
cases.push({
  case: 'query 3 components over 10,000 entities',
  queries: 600,
  ...time(
    () => {
      const set = sets(qa);
      for (let i = 0; i < 600; i++) qa.world.query(set, qa.output);
    },
    () => {
      const set = sets(qb);
      for (let i = 0; i < 600; i++) qb.world.query(set, qb.output);
    },
  ),
});
let ra = 0,
  rb = 0;
cases.push({
  case: 'spawn and despawn 1,000 entities with 3 components',
  rounds: 20,
  ...time(
    () => {
      for (let i = 0; i < 20; i++) churn(qa, ra++);
    },
    () => {
      for (let i = 0; i < 20; i++) churn(qb, rb++);
    },
  ),
});
assert.deepEqual(state(qb), state(qa));
await record(
  'ecs',
  ref,
  cases,
  'World.query hoists the per-entity liveness test out of the per-component loop; Component.add/remove iterate a column list cached at construction.',
  pin,
);

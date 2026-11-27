import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { LoadSolver } from '../dist/loads.js';
import {
  Arena,
  BODY_IMPULSES_FIELD,
  FieldRegistry,
  IMPULSE_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '../dist/world.js';

test('first accumulator publication reserves one f64 sum shared by later contributors', () => {
  const arena = new Arena();
  const registry = new FieldRegistry(arena);
  const field = { name: 'testImpulse', kind: 'bodySet', quantity: 'impulse', unit: 'N s', centring: 'particle' };
  registry.declare('owner', [{ field, access: 'write' }]);
  registry.declare('first', [{ field, access: 'accumulate' }]);
  registry.declare('next', [{ field, access: 'accumulate' }]);
  const publish = (solver, values, type) => {
    const region = arena.allocate(solver, values.length * (type === 'f32' ? 4 : 8), type, 1);
    regionWords(arena.memory, region).set(values);
    registry.publish(solver, { field: field.name, region, tick: -1, cell: [0, 0, 0] }, 0);
  };
  assert.deepEqual(
    registry.regionsOf(field.name).map(({ name }) => name),
    ['testImpulse/meta'],
  );
  publish('first', [0.5, -2], 'f32');
  const sum = registry.regionsOf(field.name)[1];
  assert.equal(sum.name, 'testImpulse/sum');
  assert.equal(sum.type, 'f64');
  assert.equal(sum.byteLength, 16);
  assert.deepEqual([...regionWords(arena.memory, sum)], [0, 0]);
  const before = registry.stateRegions();
  assert.throws(() => publish('next', [1, 2, 3], 'f64'), /every contribution to a field must cover the same elements/);
  assert.deepEqual(
    registry.stateRegions(),
    before,
    'a mismatched contributor leaves the active sum and topology intact',
  );
  publish('next', [2.5, 3], 'f64');
  assert.equal(registry.regionsOf(field.name)[1], sum);
  assert.deepEqual([...regionWords(arena.memory, registry.sum(field.name, 0).region)], [3, 1]);
  registry.remove('first');
  registry.remove('next');
  assert.equal(registry.sum(field.name, 1), undefined);
  registry.declare('next', [{ field, access: 'accumulate' }]);
  publish('next', [1, -2, 3], 'f64');
  assert.deepEqual([...regionWords(arena.memory, registry.sum(field.name, 2).region)], [1, -2, 3]);
});

test('frame-zero restore replays live buoyancy and preserves a pending 5 N s rigid impulse', async () => {
  await Physics.load();
  const gravity = [0, -9.81, 0];
  const world = new PhysicsWorld({ rate: { num: 120, den: 1 }, gravity, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 120, gravity });
  const radius = 0.25;
  const mass = 10;
  const body = physics.addBody(null, {
    position: [0, -1, 0],
    colliders: { shape: 'sphere', radius, mass },
  });
  const sea = {
    elevation: () => 0,
    density: 1000,
    water: { medium: 'water', cell: [0, 0, 0], sample: (_x, _y, _z, _time, out) => out },
  };
  let impulse;
  let memory;
  const firstImpulse = {
    describe: () => ({
      id: 'firstImpulse',
      fields: [{ field: BODY_IMPULSES_FIELD, access: 'accumulate' }],
      rate: 1,
      stableRate: () => 1,
    }),
    init(host) {
      memory = host.memory;
      impulse = host.allocate('initialImpulse', host.bodyRows() * IMPULSE_WORDS * 8, 'f64', 1);
      regionWords(memory, impulse)[body.row * IMPULSE_WORDS] = 5;
    },
    step() {
      regionWords(memory, impulse).fill(0);
    },
    exportPorts(tick) {
      return [{ field: BODY_IMPULSES_FIELD.name, region: impulse, tick, cell: [0, 0, 0] }];
    },
    importPorts() {},
    stateRegions: () => [impulse],
    extraState: () => [],
  };
  world
    .add(new RigidSolver(), { physics })
    .add(new LoadSolver(), {
      level: 1,
      sea,
      bodies: [{ row: body.row, shape: { sphere: radius }, addedMass: [0, 0, 0], drag: 0, spinDrag: 0 }],
    })
    .add(firstImpulse, {})
    .couple(['firstImpulse', 'loads', 'rigid'], 'staggered');

  const before = world.takeSnapshot();
  const beginning = { position: body.position, velocity: body.linearVelocity };
  assert.equal(world.tick, 0);
  assert.deepEqual(beginning, { position: [0, -1, 0], velocity: [0, 0, 0] });
  world.advance(1);
  const first = { hash: world.hash(), velocity: body.linearVelocity };
  assert.equal(first.velocity[0], 5 / mass, 'the registered initial contribution reaches the real rigid step');
  assert.ok(first.velocity[1] > 0, 'the same tick applies positive hydrostatic lift from the live Loads solver');
  world.advance(2);
  assert.equal(body.linearVelocity[0], 5 / mass, 'the initial impulse is consumed once');
  const second = world.hash();

  world.restoreSnapshot(before.bytes);
  assert.equal(world.tick, 0);
  assert.equal(world.hash(), before.hash);
  assert.deepEqual({ position: body.position, velocity: body.linearVelocity }, beginning);
  world.advance(1);
  assert.deepEqual({ hash: world.hash(), velocity: body.linearVelocity }, first);
  world.advance(2);
  assert.equal(world.hash(), second);
});

// The shared physics debug view (@margoengine/physics/debug-view): the world's lines plus any source's, one buffer a frame.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Physics } from '../dist/index.js';
import { PhysicsDebugView } from '../dist/debug-view.js';

await Physics.load();

async function makeEngine() {
  const store = await TransformStore.create(64);
  return new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
}
const segments = (lines) => lines.vertices.length / 6;
const one = (x) => ({ vertices: new Float32Array([x, 0, 0, x, 1, 0]), colors: new Float32Array(8).fill(1) });

function world(engine = null) {
  const physics = new Physics(engine);
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const box = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  physics.addJoint(floor, box, { type: 'spherical', anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0] });
  physics.step();
  return { physics, box };
}

test('collect gives exactly the world lines, then each source in order, and the centre-of-mass crosses', () => {
  const { physics, box } = world();
  const view = new PhysicsDebugView(physics),
    base = physics.debugRender();
  assert.deepEqual(view.collect(), base, 'default view is physics.debugRender() with its defaults');

  const off = view.add(() => one(5));
  view.add({ debugRender: () => one(7) });
  const lines = view.collect();
  assert.equal(segments(lines), segments(base) + 2);
  assert.deepEqual([...lines.vertices.slice(base.vertices.length)], [5, 0, 0, 5, 1, 0, 7, 0, 0, 7, 1, 0]);
  off();
  assert.equal(segments(view.collect()), segments(base) + 1, 'the returned function removes its source');

  view.world = false;
  view.centerOfMass = true;
  const com = view.collect(),
    c = box.worldCenterOfMass;
  // One dynamic body: a three-segment cross 0.08 m each way about its centre of mass, then the source left.
  assert.equal(segments(com), 3 + 1);
  assert.deepEqual(
    [...com.vertices.slice(0, 6)].map((v) => +v.toFixed(5)),
    [c[0] - 0.08, c[1], c[2], c[0] + 0.08, c[1], c[2]].map((v) => +Math.fround(v).toFixed(5)),
  );

  view.enabled = false;
  assert.equal(segments(view.collect()), 0, 'disabled collects nothing');
  view.dispose();
  assert.throws(() => view.collect(), { name: 'MargoError', code: 'disposed' });
  physics.dispose();
});

test('the same world gives the same lines after a snapshot and restore', () => {
  const { physics } = world();
  const view = new PhysicsDebugView(physics, { world: { boxes: true, axes: true } });
  const snapshot = physics.takeSnapshot();
  for (let i = 0; i < 20; i++) physics.step();
  const after = view.collect();
  physics.restoreSnapshot(snapshot);
  for (let i = 0; i < 20; i++) physics.step();
  assert.deepEqual(view.collect(), after);
  physics.dispose();
});

test('attach runs after Physics each frame and sends the merged lines to its sink', async () => {
  const engine = await makeEngine();
  const { physics } = world(engine);
  const got = [];
  const view = await PhysicsDebugView.attach(engine, physics, { sink: { update: (lines) => got.push(lines) } });
  assert.ok(engine.hasPlugin(view.name));
  view.add(() => one(1));
  for (const plugin of engine.plugins.values()) plugin.onPreUpdate?.(1 / 60);
  assert.equal(got.length, 1);
  assert.equal(segments(got[0]), segments(physics.debugRender()) + 1);
  await assert.rejects(PhysicsDebugView.attach(engine, physics, { sink: { update() {} } }), {
    name: 'MargoError',
    code: 'attached',
  });
  view.dispose();
  assert.equal(engine.hasPlugin(view.name), false, 'dispose leaves the scene');
  physics.dispose();
  engine.dispose();
});

test('bad input is a coded error with its help link', async () => {
  assert.throws(() => new PhysicsDebugView(null), { name: 'MargoError', message: /errors#physics-debug-view/ });
  const { physics } = world();
  assert.throws(() => new PhysicsDebugView(physics, { width: 0 }), { name: 'MargoError', message: /width/ });
  assert.throws(() => new PhysicsDebugView(physics).add({}), { name: 'MargoError', message: /debugRender/ });
  const engine = await makeEngine();
  await assert.rejects(PhysicsDebugView.attach(engine, physics), { name: 'MargoError', code: 'state' });
  physics.dispose();
  assert.throws(() => new PhysicsDebugView(physics), { name: 'MargoError', code: 'state' });
  engine.dispose();
});

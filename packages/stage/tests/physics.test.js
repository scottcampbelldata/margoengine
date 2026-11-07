import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Stage, Geometry, box, sphere } from '@margoengine/stage';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { addBody, addPhysics } from '@margoengine/stage/physics';

// The real solver and a real engine on a stand-in renderer: bodies really fall, and the collider shapes are the solver's own.
async function fixture() {
  const store = await TransformStore.create(32),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, store, renderer, undefined, null);
  return new Stage(engine);
}
const silent = mock.method(console, 'warn', () => {}); // the solver's own init notice
test.after(() => silent.mock.restore());
const collider = (body) => body.colliders[0];
const shapeOf = (body) => collider(body).shape;

test('addBody loads physics on first use, and a body falls and lands on the floor', async () => {
  const stage = await fixture(),
    floor = stage.box({ size: [20, 1, 20], position: [0, -0.5, 0] }),
    crate = stage.box({ position: [0, 3, 0] });
  await addBody(stage, floor, { type: 'fixed' });
  await addBody(stage, crate);
  for (let i = 0; i < 240; i++) stage.engine.render({ delta: 1 / 60 });
  assert.ok(Math.abs(crate.position.y - 0.5) < 0.02, `the crate rests at ${crate.position.y}`);
  stage.dispose();
});

test('a stage has one world: later calls return it, and options then reject, naming the fix', async () => {
  const stage = await fixture(),
    physics = await addPhysics(stage, { gravity: [0, -1, 0] });
  assert.deepEqual(physics.gravity, [0, -1, 0]);
  assert.equal(await addPhysics(stage), physics);
  await assert.rejects(addPhysics(stage, { gravity: [0, 0, 0] }), { code: 'state', message: /set them on the world/ });
  const [one, two] = await Promise.all([addPhysics(await fixture()), addPhysics(await fixture())]);
  assert.notEqual(one, two);
  stage.dispose();
});

test('calls at once share the world that the first one makes', async () => {
  const stage = await fixture(),
    [one, two] = await Promise.all([addPhysics(stage), addPhysics(stage)]);
  assert.equal(one, two);
  stage.dispose();
});

test('a world the caller disposed is replaced on the next call', async () => {
  const stage = await fixture(),
    physics = await addPhysics(stage);
  physics.dispose();
  const next = await addPhysics(stage);
  assert.notEqual(next, physics);
  assert.equal(next.isDisposed, false);
  stage.dispose();
});

test('the collider is the simplest shape that fits the mesh', async () => {
  const stage = await fixture(),
    up = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    ramp = new Geometry([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2], up, [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]),
    flat = new Geometry([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], up, [0, 2, 1, 0, 3, 2]);
  const shape = async (geometry, options, scale) => {
    const mesh = stage.mesh(geometry, scale ? { scale } : {});
    return shapeOf(await addBody(stage, mesh, options));
  };
  assert.equal(await shape(box(1, 2, 3)), 'box');
  assert.equal(await shape(sphere(1, 16)), 'sphere');
  assert.equal(await shape(sphere(1, 16), {}, [1, 2, 1]), 'convexHull', 'a stretched sphere is no ball');
  assert.equal(await shape(ramp), 'convexHull');
  assert.equal(await shape(ramp, { type: 'fixed' }), 'trimesh');
  assert.equal(await shape(ramp, { type: 'kinematicPosition' }), 'trimesh');
  assert.equal(await shape(flat, { type: 'fixed' }), 'trimesh', 'a flat mesh has corners but no volume');
  stage.dispose();
});

test('collider settings reach the collider; given colliders win over the fitted one', async () => {
  const stage = await fixture(),
    bouncy = await addBody(stage, stage.sphere(), { collider: { restitution: 0.6, friction: 0.2 } }),
    named = await addBody(stage, stage.box(), {
      colliders: { shape: 'sphere', radius: 2 },
      collider: { restitution: 0.9 },
    });
  assert.ok(Math.abs(collider(bouncy).restitution() - 0.6) < 1e-6);
  assert.ok(Math.abs(collider(bouncy).friction() - 0.2) < 1e-6);
  assert.equal(shapeOf(named), 'sphere');
  assert.equal(collider(named).restitution(), 0);
  stage.dispose();
});

test('a root without geometry gets a box around what it holds, with collider settings too', async () => {
  const stage = await fixture(),
    root = stage.engine.createMesh();
  stage.box({ size: [2, 2, 2], parent: root });
  const body = await addBody(stage, root, { collider: { restitution: 0.5 } });
  assert.equal(shapeOf(body), 'box');
  assert.ok(Math.abs(collider(body).restitution() - 0.5) < 1e-6);
  stage.dispose();
});

test('a body with no mesh takes named colliders', async () => {
  const stage = await fixture(),
    body = await addBody(stage, null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  assert.equal(shapeOf(body), 'box');
  stage.dispose();
});

test('abort and stage disposal reject with AbortError', async () => {
  const stage = await fixture(),
    caller = new AbortController();
  caller.abort();
  await assert.rejects(addPhysics(stage, { signal: caller.signal }), { name: 'AbortError' });
  const pending = addPhysics(stage);
  stage.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(addBody(stage, null), { name: 'AbortError' });
});

test('one caller aborting leaves the shared world to the others', async () => {
  const stage = await fixture(),
    caller = new AbortController(),
    aborted = addPhysics(stage, { signal: caller.signal }),
    other = addPhysics(stage);
  caller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal((await other).isDisposed, false);
  stage.dispose();
});

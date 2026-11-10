import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '@margoengine/core/extension';
import { SpatialPicking } from '../dist/spatial.js';
import { setRenderLayers } from '@margoengine/cameras/layers';

async function fixture(t, options = {}) {
  const engine = new Engine(
    { width: 100, height: 80, clientWidth: 100, clientHeight: 80 },
    await TransformStore.create(128),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  t.after(() => engine.dispose());
  const calls = [],
    picker = new SpatialPicking(
      engine,
      {
        async pick(...args) {
          calls.push(args);
          return null;
        },
      },
      options,
    );
  t.after(() => picker.dispose());
  return { engine, picker, calls };
}
test('sphere hits actual triangle surfaces and excludes empty bounding-volume space', async (t) => {
  const { engine, picker } = await fixture(t);
  const mesh = engine.createMesh().setGeometry(box());
  const hit = await picker.sphere([0, 0, 0.6], 0.11);
  assert.equal(hit.mesh, mesh);
  assert.ok(Math.abs(hit.distance - 0.1) < 1e-7);
  assert.deepEqual(hit.position, [0, 0, 0.5]);
  assert.equal(await picker.sphere([0, 0, 0], 0.1), null, 'the empty interior is not a surface');
  assert.equal(await picker.sphere([0.6, 0.6, 0.6], 0.11), null, 'sphere near a box corner misses its triangles');
});
test('nearest contact is in world metres under nonuniform scale and a transformed parent', async (t) => {
  const { engine, picker } = await fixture(t);
  const parent = engine.createMesh().setPosition([3, 0, 0]);
  const mesh = engine.createMesh().setGeometry(box()).setScale([4, 0.2, 2]).setParent(parent);
  engine.createMesh().setGeometry(box()).setPosition([3, 0, 3]);
  const hit = await picker.sphere([3, 0, 1.2], 0.3);
  assert.equal(hit.mesh, mesh);
  assert.ok(Math.abs(hit.distance - 0.2) < 1e-7);
  assert.deepEqual(hit.position, [3, 0, 1]);
});
test('scene membership and hidden ancestors constrain proximity selection', async (t) => {
  const { engine } = await fixture(t),
    scene = engine.createScene('other');
  let mesh;
  scene.use({
    name: 'mesh',
    setup() {
      mesh = engine.createMesh().setGeometry(box());
    },
  });
  const defaultPicker = new SpatialPicking(engine, {}),
    secondary = new SpatialPicking(engine, {}, { scene });
  assert.equal(await defaultPicker.sphere([0, 0, 0.6], 0.2), null);
  assert.equal((await secondary.sphere([0, 0, 0.6], 0.2)).mesh, mesh);
  mesh.visible = false;
  assert.equal(await secondary.sphere([0, 0, 0.6], 0.2), null);
});
test('rays preserve each asynchronous camera and use canvas center in the requested scene', async (t) => {
  const { engine, picker, calls } = await fixture(t);
  await Promise.all([picker.ray([0, 0, 1], [0, 1, 0]), picker.ray([2, 3, 4], [0, 0, -2])]);
  assert.deepEqual(
    calls.map((c) => c.slice(0, 2)),
    [
      [50, 40],
      [50, 40],
    ],
  );
  assert.notEqual(calls[0][2].camera, calls[1][2].camera);
  assert.deepEqual(calls[0][2].camera.position, [0, 0, 1]);
  calls[0][2].camera.update(1, true); // vertical rays have a valid up vector
  assert.deepEqual(calls[1][2].camera.target, [2, 3, 3]);
  assert.equal(engine.camera.position[0], 0);
});
test('invalid ranges, abort and terminal disposal refuse queries', async (t) => {
  const { picker } = await fixture(t);
  await assert.rejects(picker.ray([0, 0, 0], [0, 0, 0]), RangeError);
  await assert.rejects(picker.sphere([0, NaN, 0], 1), RangeError);
  await assert.rejects(picker.sphere([0, 0, 0], -1), RangeError);
  await assert.rejects(picker.sphere([0, 0, 0], 1, AbortSignal.abort(new Error('stop'))), /stop/);
  picker.dispose();
  await assert.rejects(picker.sphere([0, 0, 0], 1), { code: 'disposed' });
  await assert.rejects(picker.ray([0, 0, 0], [0, 0, -1]), { code: 'disposed' });
});
const triangle = (z) => {
  const vertices = new Float32Array(60);
  vertices.set([-1, -1, z], 0);
  vertices.set([1, -1, z], 20);
  vertices.set([0, 1, z], 40);
  return vertices;
};
test('model instances retain instance identity and world-space contact distance', async (t) => {
  const { engine, picker } = await fixture(t),
    node = engine.createMesh();
  const data = new Float32Array(48);
  for (const at of [0, 24]) for (const i of [0, 5, 10, 15]) data[at + i] = 1;
  data[36] = 3;
  const primitive = { node, vertices: triangle(0), indices: new Uint32Array([0, 1, 2]), instances: { count: 2, data } };
  const model = { name: 'contact-model', root: node, primitives: [primitive], setup() {} };
  engine.use(model);
  const hit = await picker.sphere([3, 0, 0.1], 0.11);
  assert.equal(hit.model, model);
  assert.equal(hit.primitive, primitive);
  assert.equal(hit.instanceId, 1);
  assert.deepEqual(hit.position, [3, 0, 0]);
});
test('model primitives inherit the root render mask and can override it', async (t) => {
  const { engine } = await fixture(t), root = engine.createMesh(), node = engine.createMesh();
  const primitive = { node, vertices: triangle(0), indices: new Uint32Array([0, 1, 2]) };
  engine.use({ name: 'layered-model', root, primitives: [primitive], setup() {} });
  const picker = new SpatialPicking(engine, {}, { layers: 2 });
  setRenderLayers(root, 1);
  assert.equal(await picker.sphere([0, 0, 0.1], 0.11), null);
  setRenderLayers(root, 2);
  assert.equal((await picker.sphere([0, 0, 0.1], 0.11)).mesh, node);
  setRenderLayers(node, 1);
  assert.equal(await picker.sphere([0, 0, 0.1], 0.11), null);
  picker.dispose();
});
test('deformed model proximity uses the current readback rather than bind-pose vertices', async (t) => {
  const { engine, picker } = await fixture(t),
    node = engine.createMesh();
  const primitive = { node, vertices: triangle(0), indices: new Uint32Array([0, 1, 2]), deformed: {} };
  const model = {
    name: 'deformed-contact',
    root: node,
    primitives: [primitive],
    setup() {},
    async readPickingGeometry() {
      return [{ primitiveIndex: 0, vertices: triangle(2), indices: primitive.indices, matrix: node.matrix.slice() }];
    },
  };
  engine.use(model);
  const hit = await picker.sphere([0, 0, 2.1], 0.11);
  assert.equal(hit.model, model);
  assert.deepEqual(hit.position, [0, 0, 2]);
  assert.equal(await picker.sphere([0, 0, 0.1], 0.11), null);
});
test('static batched primitives remain selectable in a model with deformed siblings', async (t) => {
  const { engine, picker } = await fixture(t), root = engine.createMesh(), other = engine.createMesh().setPosition([3, 0, 0]);
  const moving = { node: root, vertices: triangle(0), indices: new Uint32Array([0, 1, 2]), deformed: {} };
  const fixed = { node: other, vertices: triangle(0), indices: moving.indices };
  engine.use({ name: 'mixed-contact', root, primitives: [moving, fixed], setup() {},
    async readPickingGeometry() { return [{ primitiveIndex: 0, vertices: triangle(2), indices: moving.indices, matrix: root.matrix.slice() }]; } });
  const hit = await picker.sphere([3, 0, 0.1], 0.11);
  assert.equal(hit.mesh, other);
  assert.equal(hit.primitiveIndex, 1);
});
test('an abort settles a pending ray without waiting for GPU readback', async (t) => {
  const { engine } = await fixture(t),
    abort = new AbortController();
  let complete;
  const picker = new SpatialPicking(engine, {
    pick() {
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const pending = picker.ray([0, 0, 1], [0, 0, -1], undefined, undefined, abort.signal);
  abort.abort(new Error('stop readback'));
  await assert.rejects(pending, /stop readback/);
  complete(null);
  picker.dispose();
});
test('ray helper refuses a picker registered in a different scene', async (t) => {
  const { engine } = await fixture(t);
  const picking = { name: 'ray-picker', setup() {}, pick() { assert.fail('a foreign picker must not be called'); } };
  engine.use(picking);
  const scene = engine.createScene('ray-owner');
  const spatial = SpatialPicking.attach(engine, picking, { scene });
  await assert.rejects(spatial.ray([0, 0, 1], [0, 0, -1]), { code: 'attached', message: /errors#arguments$/ });
  spatial.dispose(); engine.removePlugin(picking.name);
});

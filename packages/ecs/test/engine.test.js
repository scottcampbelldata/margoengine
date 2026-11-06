import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { World } from '../dist/index.js';
import { MeshBridge, transformSchema } from '../dist/engine.js';

const renderer = () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
const scene = async (capacity = 8) => {
  const engine = new Engine(
    { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    await TransformStore.create(capacity),
    renderer(),
  );
  const world = new World(64),
    transform = world.component(transformSchema);
  return { engine, world, transform, bridge: new MeshBridge(transform) };
};
const close = (actual, expected) =>
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${actual} vs ${expected}`));

test('link fills a new row from the mesh, so sync moves nothing until a system does', async () => {
  const { engine, world, transform, bridge } = await scene();
  const mesh = engine.createMesh().setPosition([1, 2, 3]).setScale([2, 2, 2]);
  mesh.setRotation([0, 0.5, 0]);
  const entity = world.create();
  bridge.link(entity, mesh);
  const row = transform.index(entity),
    { x, sy, qw } = transform.fields,
    before = mesh.rotation.y;
  assert.equal(x[row], 1);
  assert.equal(sy[row], 2);
  assert.ok(qw[row] > 0);
  assert.equal(bridge.sync(), 1);
  assert.equal(mesh.position.x, 1);
  assert.equal(mesh.rotation.y, before);
  assert.equal(bridge.meshOf(entity), mesh);
});

test('sync copies all three groups, world matrices follow, and mesh.rotation stays true', async () => {
  const { engine, world, transform, bridge } = await scene();
  const mesh = engine.createMesh(),
    entity = world.create();
  bridge.link(entity, mesh);
  const s = Math.SQRT1_2;
  transform.add(entity, { x: 5, y: 6, z: 7, qx: 0, qy: 0, qz: s, qw: s, sx: 2, sy: 3, sz: 4 });
  bridge.sync();
  engine.render({ delta: 0 });
  close([mesh.matrix[12], mesh.matrix[13], mesh.matrix[14]], [5, 6, 7]);
  close([mesh.matrix[0], mesh.matrix[1]], [0, 2]);
  close([mesh.matrix[4], mesh.matrix[5]], [-3, 0]);
  close([mesh.matrix[10]], [4]);
  close([mesh.rotation.z], [Math.PI / 2]);
});

test('a quaternion that is not unit length is normalised as setQuaternion does', async () => {
  const { engine, world, transform, bridge } = await scene();
  const mesh = engine.createMesh(),
    entity = world.create();
  bridge.link(entity, mesh);
  transform.add(entity, { qw: 2, qx: 0, qy: 0, qz: 0 });
  bridge.sync();
  assert.equal(engine.store.transforms.qw[mesh.id], 1);
});

test('rows already equal to the mesh are left alone', async () => {
  const { engine, world, bridge } = await scene();
  const mesh = engine.createMesh(),
    entity = world.create();
  bridge.link(entity, mesh);
  let writes = 0;
  const { set } = mesh.position;
  mesh.position.set = function (...values) {
    writes++;
    return set.apply(this, values);
  };
  bridge.sync();
  assert.equal(writes, 0);
});

test('a component with one group leaves the others to the mesh; a partial group or none is refused', async () => {
  const { engine, world } = await scene();
  const position = world.component({ x: Float32Array, y: Float32Array, z: Float32Array }),
    bridge = new MeshBridge(position),
    mesh = engine.createMesh().setScale([3, 3, 3]),
    entity = world.create();
  bridge.link(entity, mesh);
  position.add(entity, { x: 9 });
  bridge.sync();
  assert.equal(mesh.position.x, 9);
  assert.equal(mesh.scale.x, 3);
  assert.throws(() => new MeshBridge(world.component({ x: Float32Array })), /Partial/);
  assert.throws(() => new MeshBridge(world.component({ hp: Float32Array })), /no transform fields/);
  assert.throws(() => new MeshBridge(world.tag()), /no transform fields/);
});

test('losing the component or the entity ends the link; disposeMeshes also disposes the mesh', async () => {
  const { engine, world, transform, bridge } = await scene();
  const keep = engine.createMesh(),
    a = world.create(),
    b = world.create();
  bridge.link(a, keep);
  bridge.link(b, engine.createMesh());
  transform.remove(a);
  world.destroy(b);
  assert.equal(bridge.sync(), 0);
  assert.equal(bridge.meshOf(a), undefined);
  keep.check();
  const owning = new MeshBridge(transform, { disposeMeshes: true }),
    mesh = engine.createMesh(),
    c = world.create();
  owning.link(c, mesh);
  world.destroy(c);
  assert.throws(() => mesh.check(), /disposed/i);
});

test('a mesh disposed behind the bridge is reported, not written over its reused slot', async () => {
  const { engine, world, transform, bridge } = await scene();
  const mesh = engine.createMesh(),
    entity = world.create();
  bridge.link(entity, mesh);
  transform.add(entity, { x: 4 });
  mesh.dispose();
  const next = engine.createMesh();
  assert.throws(() => bridge.sync(), /disposed/i);
  assert.equal(next.position.x, 0);
  assert.equal(bridge.unlink(entity), true);
  assert.equal(bridge.unlink(entity), false);
  assert.equal(bridge.sync(), 0);
});

test('sync keeps working after the transform store grows', async () => {
  const { engine, world, transform, bridge } = await scene(2);
  const links = Array.from({ length: 6 }, () => {
    const entity = world.create(),
      mesh = engine.createMesh();
    bridge.link(entity, mesh);
    return [entity, mesh];
  });
  assert.ok(engine.store.capacity > 2);
  links.forEach(([entity], i) => transform.add(entity, { x: i + 1 }));
  bridge.sync();
  links.forEach(([, mesh], i) => assert.equal(mesh.position.x, i + 1));
});

test('values the mesh refuses throw the mesh error', async () => {
  const { engine, world, transform, bridge } = await scene();
  const mesh = engine.createMesh(),
    entity = world.create();
  bridge.link(entity, mesh);
  const row = transform.index(entity);
  transform.fields.x[row] = Number.NaN;
  assert.throws(() => bridge.sync(), RangeError);
  transform.fields.x[row] = 0;
  transform.fields.sx[row] = 0;
  assert.throws(() => bridge.sync(), RangeError);
  transform.fields.sx[row] = 1;
  transform.fields.qw[row] = 0;
  assert.throws(() => bridge.sync(), RangeError);
});

test('link refuses stale entities, disposed meshes and a mesh another entity holds; relinking replaces', async () => {
  const { engine, world, bridge } = await scene();
  const mesh = engine.createMesh(),
    other = engine.createMesh(),
    a = world.create(),
    b = world.create(),
    dead = world.create();
  world.destroy(dead);
  assert.throws(() => bridge.link(dead, mesh), (error) => error.code === 'state');
  bridge.link(a, mesh);
  assert.throws(() => bridge.link(b, mesh), (error) => error instanceof TypeError && /;/.test(error.message));
  bridge.link(a, mesh);
  bridge.link(a, other);
  assert.equal(bridge.meshOf(a), other);
  bridge.link(b, mesh);
  assert.equal(bridge.sync(), 2);
  const gone = engine.createMesh();
  gone.dispose();
  assert.throws(() => bridge.link(world.create(), gone), /disposed/i);
});

test('stop ends every link and detaches from the component', async () => {
  const { engine, world, transform, bridge } = await scene();
  bridge.link(world.create(), engine.createMesh());
  bridge.stop();
  bridge.stop();
  assert.equal(bridge.sync(), 0);
  assert.equal(transform.observers.length, 0);
});

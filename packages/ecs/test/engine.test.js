import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { TransformWriter } from '@margoengine/scene/bulk';
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

const counted = (t) => {
  const { write } = TransformWriter.prototype,
    calls = [];
  TransformWriter.prototype.write = function (rows, range) {
    calls.push({ fields: Object.keys(rows), ...range });
    return write.call(this, rows, range);
  };
  t.after(() => {
    TransformWriter.prototype.write = write;
  });
  return calls;
};
const linked = async (count) => {
  const made = await scene(count),
    links = Array.from({ length: count }, () => {
      const entity = made.world.create(),
        mesh = made.engine.createMesh();
      made.bridge.link(entity, mesh);
      return { entity, mesh };
    });
  return { ...made, links };
};

test('a world that moves everything costs one bulk write a group', async (t) => {
  const { transform, bridge, links } = await linked(60),
    calls = counted(t);
  bridge.sync();
  assert.equal(calls.length, 0, 'nothing moved, nothing written');
  for (const { entity } of links) {
    const row = transform.index(entity);
    transform.fields.x[row] = row + 1;
    transform.fields.qz[row] = 1;
    transform.fields.qw[row] = 1;
    transform.fields.sy[row] = 2;
  }
  assert.equal(bridge.sync(), 60);
  assert.deepEqual(calls.map(({ fields, from, count }) => [fields[0], from, count]), [
    ['positions', 0, 60],
    ['quaternions', 0, 60],
    ['scales', 0, 60],
  ]);
});

test('only the runs of rows that moved are written', async (t) => {
  const { transform, bridge, links } = await linked(8),
    calls = counted(t);
  for (const i of [1, 2, 6]) transform.fields.y[transform.index(links[i].entity)] = i;
  bridge.sync();
  assert.deepEqual(calls.map(({ from, count }) => [from, count]), [
    [1, 2],
    [6, 1],
  ]);
  links.forEach(({ mesh }, i) => assert.equal(mesh.position.y, [1, 2, 6].includes(i) ? i : 0));
});

test('the bulk result is what the setters give, bit for bit', async () => {
  const { transform, bridge, links, engine } = await linked(60);
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x40000000 - 1;
  for (const { entity, mesh } of links) {
    const row = transform.index(entity),
      f = transform.fields,
      values = { x: next() * 9, y: next() * 9, z: next() * 9, q: [next(), next(), next(), next() + 2], s: [next() + 2, next() + 2, next() + 2] };
    [f.x[row], f.y[row], f.z[row]] = [values.x, values.y, values.z];
    [f.qx[row], f.qy[row], f.qz[row], f.qw[row]] = values.q;
    [f.sx[row], f.sy[row], f.sz[row]] = values.s;
    const twin = engine.createMesh();
    twin.position.set(f.x[row], f.y[row], f.z[row]);
    twin.setQuaternion([f.qx[row], f.qy[row], f.qz[row], f.qw[row]]);
    twin.scale.set(f.sx[row], f.sy[row], f.sz[row]);
    mesh.twin = twin;
  }
  bridge.sync();
  for (const { mesh } of links) {
    const { twin } = mesh;
    assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [twin.position.x, twin.position.y, twin.position.z]);
    assert.deepEqual([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z], [twin.rotation.x, twin.rotation.y, twin.rotation.z]);
    assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [twin.scale.x, twin.scale.y, twin.scale.z]);
  }
});

test('a rotation the row did not change keeps its Euler angles while a neighbour turns', async () => {
  const { transform, bridge, links } = await linked(3),
    [first, middle, last] = links;
  middle.mesh.rotation.set(0, 4, 0);
  bridge.unlink(middle.entity);
  transform.remove(middle.entity);
  bridge.link(middle.entity, middle.mesh);
  bridge.sync();
  for (const { entity } of [first, last]) {
    const row = transform.index(entity);
    transform.fields.qz[row] = 1;
    transform.fields.qw[row] = 1;
  }
  bridge.sync();
  assert.equal(middle.mesh.rotation.y, 4);
});

test('links made or ended between syncs are picked up', async () => {
  const { engine, world, transform, bridge, links } = await linked(3);
  bridge.sync();
  const entity = world.create(),
    mesh = engine.createMesh();
  bridge.link(entity, mesh);
  transform.fields.x[transform.index(entity)] = 5;
  assert.equal(bridge.sync(), 4);
  assert.equal(mesh.position.x, 5);
  bridge.unlink(links[0].entity);
  transform.fields.x[transform.index(links[0].entity)] = 9;
  transform.fields.x[transform.index(links[1].entity)] = 3;
  assert.equal(bridge.sync(), 3);
  assert.equal(links[0].mesh.position.x, 0);
  assert.equal(links[1].mesh.position.x, 3);
});

test('one bridge can feed the meshes of two engines', async () => {
  const { engine, world, transform, bridge } = await scene(),
    { engine: other } = await scene(),
    near = world.create(),
    far = world.create(),
    here = engine.createMesh(),
    there = other.createMesh();
  bridge.link(near, here).link(far, there);
  transform.fields.x[transform.index(near)] = 1;
  transform.fields.x[transform.index(far)] = 2;
  assert.equal(bridge.sync(), 2);
  assert.equal(here.position.x, 1);
  assert.equal(there.position.x, 2);
});

test('the bridge shares scene/bulk, it does not carry a copy', async () => {
  const { readFile } = await import('node:fs/promises'),
    code = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
  assert.match(code, /from\s*["`]@margoengine\/scene\/bulk["`]/);
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

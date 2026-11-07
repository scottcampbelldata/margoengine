// Bodies on meshes below the root: a real engine and transform store on a stand-in renderer, against the real solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Physics } from '../dist/index.js';
import { setMeshSource, clearMeshSource } from '../../shared/mesh-source.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const makeEngine = async () =>
  new Engine(
    { width: 1, height: 1 },
    await TransformStore.create(64),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
const registerPBR = (mesh, geometry) => {
  const vertices = new Float32Array((geometry.vertices.length / 6) * 20);
  for (let i = 0; i < geometry.vertices.length / 6; i++)
    vertices.set(geometry.vertices.subarray(i * 6, i * 6 + 3), i * 20);
  setMeshSource(mesh, { model: { disposed: false }, node: mesh, primitives: [{ vertices, indices: geometry.indices }], skinned: false, morphed: false });
};
// World position of a mesh, from the chain of its parents' local transforms: nothing the code under test computes.
const worldPosition = (engine, mesh) => {
  const chain = [];
  for (let node = mesh; node; node = parentMesh(engine, node)) chain.unshift(node);
  let p = [0, 0, 0],
    q = [0, 0, 0, 1],
    s = [1, 1, 1];
  for (const node of chain) {
    const local = [node.position.x * s[0], node.position.y * s[1], node.position.z * s[2]];
    p = add(p, rotate(q, local));
    q = multiply(q, node.quaternion ? [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w] : eulerQuat(node));
    s = [s[0] * node.scale.x, s[1] * node.scale.y, s[2] * node.scale.z];
  }
  return p;
};
const parentMesh = (engine, mesh) => {
  const id = engine.store.parents[mesh.id];
  return id === -1 ? null : [...engine.meshes.values()].find((node) => node.id === id);
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const multiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const rotate = (q, v) => {
  const r = multiply(multiply(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]);
  return r.slice(0, 3);
};
// Only yaw is used here.
const eulerQuat = (node) => [0, Math.sin(node.rotation.y / 2), 0, Math.cos(node.rotation.y / 2)];
const nearVec = (got, want, bound, label) =>
  got.forEach((value, i) => assert.ok(Math.abs(value - want[i]) <= bound, `${label}: ${got} against ${want}`));

test('a child body added before its parent body is written after it, with no frame of lag', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine, { gravity: [0, 0, 0] }),
    parent = engine.createMesh().setPosition([0, 0, 0]),
    child = engine.createMesh(parent).setPosition([0, 1, 0]);
  const childBody = physics.addBody(child, { colliders: { shape: 'sphere', radius: 0.1 } }),
    parentBody = physics.addBody(parent, { linearVelocity: [60, 0, 0], colliders: { shape: 'sphere', radius: 0.1 } });
  for (let i = 0; i < 3; i++) {
    physics.step();
    physics.sync(1);
    nearVec(worldPosition(engine, child), childBody.position, 1e-5, `child at step ${i}`);
    nearVec(worldPosition(engine, parent), parentBody.position, 1e-5, `parent at step ${i}`);
  }
  physics.dispose();
  engine.dispose();
});

test('three levels of bodies keep their world poses whatever order they came in', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine, { gravity: [0, 0, 0] }),
    a = engine.createMesh(),
    b = engine.createMesh(a).setPosition([0, 1, 0]).setRotation([0, Math.PI / 2, 0]),
    c = engine.createMesh(b).setPosition([0, 0, 2]),
    shape = { colliders: { shape: 'sphere', radius: 0.1 } };
  const bodyB = physics.addBody(b, { ...shape, linearVelocity: [0, 0, 30] }),
    bodyC = physics.addBody(c, { ...shape, linearVelocity: [0, 30, 0] }),
    bodyA = physics.addBody(a, { ...shape, linearVelocity: [30, 0, 0] });
  for (let i = 0; i < 3; i++) {
    physics.step();
    physics.sync(1);
    nearVec(worldPosition(engine, a), bodyA.position, 1e-5, 'a');
    nearVec(worldPosition(engine, b), bodyB.position, 1e-5, 'b');
    nearVec(worldPosition(engine, c), bodyC.position, 1e-5, 'c');
  }
  physics.dispose();
  engine.dispose();
});

test('a resting body under a moving parent keeps its world pose', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine, { gravity: [0, 0, 0] }),
    parent = engine.createMesh(),
    child = engine.createMesh(parent).setPosition([1, 0, 0]),
    body = physics.addBody(child, { sleeping: true, colliders: { shape: 'sphere', radius: 0.1 } });
  physics.step();
  physics.sync(1);
  parent.setPosition([5, 0, 0]);
  physics.step();
  physics.sync(1);
  nearVec(worldPosition(engine, child), [1, 0, 0], 1e-5, 'held');
  nearVec(body.position, [1, 0, 0], 1e-6, 'body');
  physics.dispose();
  engine.dispose();
});

test('a nested PBR node is fitted at its world scale', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine),
    parent = engine.createMesh().setScale([3, 2, 4]),
    child = engine.createMesh(parent);
  registerPBR(child, box(2, 2, 2));
  const body = physics.addBody(child, { type: 'fixed' }),
    { x, y, z } = body.colliders[0].halfExtents();
  nearVec([x, y, z], [3, 2, 4], 1e-5, 'half extents');
  clearMeshSource(child);
  physics.dispose();
  engine.dispose();
});

test('a geometry-free root below a turned parent keeps its parts where they are', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine),
    parent = engine.createMesh().setPosition([10, 0, 0]).setRotation([0, Math.PI / 2, 0]),
    root = engine.createMesh(parent).setPosition([0, 0, 3]),
    part = engine.createMesh(root).setPosition([1, 0, 0]);
  registerPBR(part, box(2, 2, 2));
  const body = physics.addBody(root, { type: 'fixed' });
  // Turned a quarter about y, the parent takes local +z to world +x and local +x to world -z.
  nearVec(body.position, [13, 0, 0], 1e-4, 'root');
  const { x, y, z } = body.colliders[0].translation();
  nearVec([x, y, z], [13, 0, -1], 1e-4, 'the part in the world');
  clearMeshSource(part);
  physics.dispose();
  engine.dispose();
});

test('follow: a part of a moving model carries its body at any depth, pushes what it meets and is not written back', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine, { gravity: [0, 0, 0] }),
    base = engine.createMesh(),
    arm = engine.createMesh(base).setPosition([0, 0, 0]),
    hand = engine.createMesh(arm).setPosition([0, 1, 0]),
    body = physics.addBody(hand, {
      type: 'kinematicPosition',
      follow: true,
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    }),
    crate = physics.addBody(null, {
      position: [2, 1, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
  const before = [hand.position.x, hand.position.y, hand.position.z];
  for (let i = 1; i <= 60; i++) {
    base.setPosition([i * 0.05, 0, 0]);
    physics.update(1 / 60);
    nearVec(body.position, [i * 0.05, 1, 0], 1e-4, `follows at step ${i}`);
  }
  assert.ok(crate.position[0] > 3, `the hand pushed the crate to ${crate.position[0]}`);
  assert.deepEqual([hand.position.x, hand.position.y, hand.position.z], before);
  physics.dispose();
  engine.dispose();
});

test('follow is refused where it cannot work', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine),
    mesh = engine.createMesh(),
    colliders = { shape: 'sphere', radius: 1 };
  assert.throws(() => physics.addBody(mesh, { follow: true, colliders }), TypeError);
  assert.throws(() => physics.addBody(mesh, { type: 'fixed', follow: true, colliders }), TypeError);
  assert.throws(() => physics.addBody(null, { type: 'kinematicPosition', follow: true, colliders }), TypeError);
  assert.equal(physics.bodyCount, 0);
  physics.dispose();
  engine.dispose();
});

test('a follower goes when it is removed or its mesh is disposed, and a type change stops the following', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine, { gravity: [0, 0, 0] }),
    options = { type: 'kinematicPosition', follow: true, colliders: { shape: 'sphere', radius: 1 } },
    gone = engine.createMesh(),
    removed = physics.addBody(gone, options);
  removed.remove();
  gone.setPosition([1, 0, 0]);
  physics.step();
  assert.equal(physics.bodyCount, 0);

  const disposed = engine.createMesh();
  physics.addBody(disposed, options);
  disposed.dispose();
  physics.step();
  assert.equal(physics.bodyCount, 0);

  const freed = engine.createMesh(),
    body = physics.addBody(freed, options);
  body.setType('dynamic');
  freed.setPosition([5, 0, 0]);
  physics.step();
  physics.sync(1);
  nearVec(body.position, [0, 0, 0], 1e-6, 'a dynamic body no longer takes the mesh pose');
  nearVec([freed.position.x, freed.position.y, freed.position.z], [0, 0, 0], 1e-6, 'and it writes the mesh again');
  physics.dispose();
  engine.dispose();
});

test('a plain mesh below a scaled parent is fitted at its world scale', async () => {
  const engine = await makeEngine(),
    physics = new Physics(engine),
    parent = engine.createMesh().setScale([2, 2, 2]),
    child = engine.createMesh(parent);
  child.setGeometry(box(2, 2, 2));
  const { x } = physics.addBody(child, { type: 'fixed' }).colliders[0].halfExtents();
  assert.ok(Math.abs(x - 2) < 1e-5, `half extent ${x}`);
  physics.dispose();
  engine.dispose();
});

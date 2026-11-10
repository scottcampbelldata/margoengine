import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { meshRuntime } from '@margoengine/core/extension';
import { children, parent, worldMatrix } from '../dist/index.js';
import { attach, find, findOne, findByName, findById, localToWorld, worldToLocal,
  translateOnAxis, rotateOnAxis, rotateOnWorldAxis, traverseVisible, traverseAncestors, removeFromParent } from '../dist/graph.js';

const make = async () => new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
  await TransformStore.create(16), { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
const near = (a, b, epsilon = 2e-5) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${i}: ${v} != ${b[i]}`));
};

test('name, live slot id and predicates search inclusive depth-first and isolate scenes', async () => {
  using e = await make();
  const a = e.createMesh(), b = e.createMesh(a), c = e.createMesh(b), d = e.createMesh(a);
  a.name = 'root'; c.name = d.name = 'needle';
  e.createScene('other').createMesh().name = 'elsewhere';
  assert.equal(findByName(a, 'root'), a);
  assert.equal(findByName(a, 'needle'), c);
  assert.equal(findByName(e.scene, 'elsewhere'), null);
  assert.equal(findById(e.scene, meshRuntime(d).id), d);
  assert.deepEqual(find(a, (m) => m.name === 'needle'), [c, d]);
  let count = 0;
  assert.equal(findOne(a, () => ++count === 2), b);
  assert.equal(count, 2);
  const id = meshRuntime(c).id;
  c.dispose();
  assert.equal(findById(a, id), null);
  assert.throws(() => find(a, null), TypeError);
});

test('visible traversal prunes branches and supports disposal; ancestors use original chain', async () => {
  using e = await make();
  const a = e.createMesh(), b = e.createMesh(a), c = e.createMesh(b), d = e.createMesh(a), seen = [];
  b.visible = false;
  traverseVisible(e.scene, (m) => seen.push(m));
  assert.deepEqual(seen, [a, d]);
  seen.length = 0;
  traverseAncestors(c, (m) => { seen.push(m); m.setParent(null); });
  assert.deepEqual(seen, [b, a]);
  assert.equal(removeFromParent(c), c);
  assert.equal(parent(c), null);
  assert.deepEqual(children(b), []);
  seen.length = 0;
  traverseVisible(a, (m) => { seen.push(m); m.dispose(); });
  assert.deepEqual(seen, [a]);
});

test('affine point conversions invert full sheared and mirrored parent chains before a frame', async () => {
  using e = await make();
  const a = e.createMesh().setScale([-2, 3, 4]).setRotation([0.1, 0.5, -0.4]),
    b = e.createMesh(a).setRotation([0.3, -0.6, 0.2]).setPosition([2, -1, 4]), p = [0.5, -4, 2];
  const world = localToWorld(b, p);
  near(worldToLocal(b, world), p, 1e-10);
  const object = { x: p[0], y: p[1], z: p[2] };
  assert.equal(localToWorld(b, object, object), object);
  near([object.x, object.y, object.z], world, 1e-10);
  const out = new Float64Array(3);
  assert.equal(worldToLocal(b, world, out), out);
  near([...out], p, 1e-10);
  e.render();
  const m = b.matrix;
  near(world, [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]);
  assert.throws(() => localToWorld(b, [NaN, 0, 0]), RangeError);
});

test('attach keeps complete world matrix and descendants with rotated mirrored parents', async () => {
  using e = await make();
  const a = e.createMesh().setPosition([2, 3, -1]).setScale([-2, 2, 2]).setRotation([0.2, 0.5, -0.4]),
    b = e.createMesh().setPosition([-4, 1, 2]).setScale([3, 3, 3]).setRotation([-0.1, 0.7, 0.3]),
    c = e.createMesh(a).setPosition([1, 0, 2]).setRotation([0.2, 0.3, 0.4]).setScale([1, 2, 3]),
    d = e.createMesh(c).setPosition([2, 0, 0]);
  const before = worldMatrix(c), child = worldMatrix(d);
  assert.equal(attach(b, c), c);
  near(worldMatrix(c), before);
  near(worldMatrix(d), child);
  assert.equal(parent(c), b);
  attach(null, c);
  near(worldMatrix(c), before);
  assert.throws(() => attach(d, c), /cycle/);
  assert.equal(parent(c), null);
  const foreign = e.createScene('foreign').createMesh();
  assert.throws(() => attach(foreign, c), /Foreign/);
  near(worldMatrix(c), before);
});

test('unrepresentable attach rejects before reparenting or changing any transform', async () => {
  using e = await make();
  const a = e.createMesh().setScale([2, 1, 1]), b = e.createMesh().setRotation([0, 0, Math.PI/4]);
  const before = worldMatrix(b);
  assert.throws(() => attach(a, b), /shear/);
  near(worldMatrix(b), before, 1e-12);
  assert.equal(parent(b), null);
  assert.deepEqual(children(a), []);
});

test('local and world axis operations follow independent geometric oracles', async () => {
  using e = await make();
  const parentMesh = e.createMesh().setRotation([0, 0, Math.PI / 2]), m = e.createMesh(parentMesh);
  rotateOnAxis(m, [0, 2, 0], Math.PI / 2);
  translateOnAxis(m, [0, 0, 3], 2);
  near([m.position.x, m.position.y, m.position.z], [2, 0, 0]);
  near(localToWorld(m, [0, 0, 0]), [0, 2, 0]);
  const origin = localToWorld(m, [0, 0, 0]);
  rotateOnWorldAxis(m, [0, 0, 1], Math.PI / 2);
  near(localToWorld(m, [0, 0, 0]), origin);
  near(localToWorld(m, [0, 0, 1]), [-1, 2, 0]);
  const before = worldMatrix(m);
  for (const operation of [translateOnAxis, rotateOnAxis, rotateOnWorldAxis]) {
    assert.throws(() => operation(m, [0, 0, 0], 1), RangeError);
    assert.throws(() => operation(m, [1, 0, 0], Infinity), RangeError);
    near(worldMatrix(m), before, 1e-12);
  }
});

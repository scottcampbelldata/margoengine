import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore, box, PbrMaterial } from '@margoengine/core/extension';
import { children, parent, userData, worldMatrix } from '../dist/index.js';
import { cloneSubtree } from '../dist/clone.js';

const make = async (renderer = {}) => new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
  await TransformStore.create(16), { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}, ...renderer });

test('clone copies a full subtree, exact local transforms and flags with shared resources', async () => {
  using e = await make();
  const a = e.createMesh().setPosition([1, 2, 3]).setRotation([0.4, 0.7, -0.9]).setScale([-2, 3, 1]),
    b = e.createMesh(a).setGeometry(box()).setMaterial(new PbrMaterial({ color: '#abc' })).setQuaternion([0.2, 0.3, 0.4, 0.5]),
    c = e.createMesh(b).setPosition([2, 0, 1]);
  a.name = 'tree'; b.name = 'leaf'; b.visible = false; b.receiveShadow = false;
  const shared = { values: new Uint8Array([1, 2]), nested: { a: 2 } };
  shared.self = shared;
  userData(a, { shared }); userData(b, { shared });
  const copy = cloneSubtree(a), [copyB] = children(copy), [copyC] = children(copyB);
  assert.notEqual(copy, a); assert.equal(parent(copy), null);
  assert.equal(copy.name, 'tree'); assert.equal(copyB.name, 'leaf');
  assert.equal(copyB.geometry, b.geometry); assert.equal(copyB.material, b.material);
  assert.equal(copyB.visible, false); assert.equal(copyB.receiveShadow, false);
  for (const [original, cloned] of [[a, copy], [b, copyB], [c, copyC]]) {
    assert.deepEqual(worldMatrix(cloned), worldMatrix(original));
    assert.deepEqual([cloned.rotation.x, cloned.rotation.y, cloned.rotation.z], [original.rotation.x, original.rotation.y, original.rotation.z]);
  }
  assert.notEqual(userData(copy).shared, shared);
  assert.equal(userData(copy).shared, userData(copyB).shared);
  assert.equal(userData(copy).shared.self, userData(copy).shared);
  userData(copy).shared.values[0] = 99;
  assert.equal(shared.values[0], 1);
  copy.setPosition([9, 0, 0]); assert.equal(a.position.x, 1);
  copyB.material.roughness = 0.2; assert.equal(copyB.material, b.material);
  a.dispose(); b.dispose(); c.dispose();
  assert.ok(copyB.geometry); copyB.check(); e.render();
});

test('owning scene, explicit parent, nonrecursive copy and a source-descendant parent', async () => {
  using e = await make();
  const scene = e.createScene('other'), a = scene.createMesh(), b = scene.createMesh(a), c = scene.createMesh(b);
  const copy = cloneSubtree(a, { parent: c });
  assert.equal(parent(copy), c);
  assert.equal(children(children(copy)[0]).length, 1, 'snapshot excludes newly created descendants');
  assert.equal(e.scene.meshes.size, 0);
  assert.equal(children(cloneSubtree(a, { recursive: false })).length, 0);
  assert.throws(() => cloneSubtree(a, { parent: e.createMesh() }), /source scene/);
});

test('uncloneable data rejects before allocation and allocation failure rolls back all copied meshes', async () => {
  let uploads = 0;
  using e = await make({ add() { uploads++; } });
  const a = e.createMesh(), b = e.createMesh(a);
  userData(b).callback = () => {};
  const count = e.scene.meshes.size;
  assert.throws(() => cloneSubtree(a), /structured-cloneable/);
  assert.equal(e.scene.meshes.size, count);
  delete userData(b).callback;
  const geometry = box(); b.setGeometry(geometry);
  // A partial allocation must leave no copied root behind.
  const originalCreate = e.scene.createMesh.bind(e.scene);
  let creations = 0;
  e.scene.createMesh = (...args) => { if (++creations === 2) throw new RangeError('injected allocation failure'); return originalCreate(...args); };
  assert.throws(() => cloneSubtree(a), /injected allocation failure/);
  assert.equal(e.scene.meshes.size, count);
  assert.equal(uploads, 1);
  assert.deepEqual(children(a), [b]);
});

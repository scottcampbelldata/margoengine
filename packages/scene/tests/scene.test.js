// Tree walks, world transforms and aiming on a real engine and kernel: world results are compared with `mesh.matrix`, which
// the Wasm kernel computes on its own.
import assert from 'node:assert/strict';
import { packageFolder, readmeTypeErrors } from '../../../scripts/support/readme-types.mjs';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Engine, TransformStore } from '@margoengine/core/extension';
import {
  children,
  getWorldPosition,
  getWorldQuaternion,
  getWorldScale,
  lookAt,
  parent,
  traverse,
  userData,
  worldMatrix,
} from '../dist/index.js';
import { extendMeshes } from '../dist/mesh.js';

const renderer = () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
const engine = async () =>
  new Engine(
    { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    await TransformStore.create(16),
    renderer(),
  );
const near = (actual, expected, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `[${[...actual]}] is not [${[...expected]}]`);
};
/** Three levels: moved, turned and scaled unevenly, the middle one mirrored. */
const tree = async () => {
  const e = await engine(),
    root = e.createMesh().setPosition([1, 2, 3]).setRotation([0.3, -0.4, 0.5]).setScale([2, 2, 2]),
    middle = e.createMesh(root).setPosition([-1, 0.5, 2]).setRotation([1, 0.2, -0.7]).setScale([-1.5, 1.5, 1.5]),
    leaf = e.createMesh(middle).setPosition([0.25, -2, 1]).setRotation([-0.6, 0.9, 0.1]).setScale([3, 3, 3]);
  return { e, root, middle, leaf };
};

test('children and parent follow setParent, createMesh and disposal, in attach order', async () => {
  const e = await engine(),
    a = e.createMesh(),
    b = e.createMesh(a),
    c = e.createMesh(a),
    d = e.createMesh();
  assert.deepEqual(children(a), [b, c]);
  assert.equal(parent(b), a);
  assert.equal(parent(a), null);
  d.setParent(a);
  b.setParent(d);
  assert.deepEqual(children(a), [c, d]);
  assert.deepEqual(children(d), [b]);
  assert.equal(parent(b), d);
  c.dispose();
  assert.deepEqual(children(a), [d]);
  a.dispose();
  assert.equal(parent(d), null, 'a disposed parent lets go of its children');
  assert.throws(() => children(a), /Mesh disposed/);
  assert.throws(() => parent(a), /Mesh disposed/);
});

test('the list is a copy: changing it changes nothing', async () => {
  const e = await engine(),
    a = e.createMesh(),
    b = e.createMesh(a);
  children(a).length = 0;
  assert.deepEqual(children(a), [b]);
});

test('traverse goes parents first, and a scene covers its own trees only', async () => {
  const e = await engine(),
    a = e.createMesh(),
    b = e.createMesh(a),
    c = e.createMesh(b),
    d = e.createMesh(a),
    other = e.createMesh(),
    elsewhere = e.createScene('hud').createMesh(),
    seen = [];
  traverse(a, (mesh) => seen.push(mesh));
  assert.deepEqual(seen, [a, b, c, d]);
  seen.length = 0;
  traverse(e.scene, (mesh) => seen.push(mesh));
  assert.deepEqual(seen, [a, b, c, d, other]);
  assert.ok(!seen.includes(elsewhere));
  assert.throws(() => traverse(a), TypeError);
});

test('a visitor may dispose or move meshes while the walk runs', async () => {
  const e = await engine(),
    a = e.createMesh(),
    b = e.createMesh(a),
    c = e.createMesh(a),
    below = e.createMesh(b),
    seen = [];
  traverse(a, (mesh) => {
    seen.push(mesh);
    if (mesh === b) c.dispose();
  });
  assert.deepEqual(seen, [a, b, below]);
  seen.length = 0;
  traverse(b, (mesh) => {
    seen.push(mesh);
    mesh.dispose();
  });
  assert.deepEqual(seen, [b], 'a mesh disposed by its own visit ends its branch');
  e.dispose();
  assert.throws(() => traverse(a, () => {}), /Mesh disposed/);
});

test('userData is per mesh, stays the same object, and can be replaced', async () => {
  const e = await engine(),
    a = e.createMesh(),
    b = e.createMesh();
  userData(a).health = 3;
  assert.deepEqual(userData(a), { health: 3 });
  assert.deepEqual(userData(b), {});
  const own = { team: 'red' };
  assert.equal(userData(a, own), own);
  assert.equal(userData(a), own);
  assert.throws(() => userData(a, 7), TypeError);
  a.dispose();
  assert.throws(() => userData(a), /Mesh disposed/);
  assert.deepEqual(userData(e.createMesh()), {}, 'a reused slot starts empty');
});

test('the world matrix equals the kernel, mirror and uneven parents included', async () => {
  const { e, leaf, middle } = await tree();
  e.render();
  near(worldMatrix(leaf), leaf.matrix, 2e-4);
  near(worldMatrix(middle), middle.matrix, 2e-4);
});

test('world values are right before any frame and right after a write', async () => {
  const { e, root, leaf } = await tree(),
    before = worldMatrix(leaf);
  e.render();
  near(before, leaf.matrix, 2e-4);
  root.position.x += 5;
  near(getWorldPosition(leaf), [leaf.matrix[12] + 5, leaf.matrix[13], leaf.matrix[14]], 2e-4);
  e.render();
  near(getWorldPosition(leaf), leaf.matrix.subarray(12, 15), 2e-4);
});

test('world position, rotation and scale put back the world matrix', async () => {
  const e = await engine(),
    root = e.createMesh().setPosition([1, 2, 3]).setRotation([0.3, -0.4, 0.5]).setScale([2, 2, 2]),
    leaf = e.createMesh(root).setPosition([0, 1, 0]).setRotation([1, 0, 0]).setScale([1.5, 1.5, 1.5]);
  const [x, y, z, w] = getWorldQuaternion(leaf),
    scale = getWorldScale(leaf),
    m = worldMatrix(leaf);
  near(scale, [3, 3, 3]);
  near([Math.hypot(x, y, z, w)], [1]);
  // The +Y axis of the rotation, by the quaternion formula, against the matrix column.
  near([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], [m[4] / 3, m[5] / 3, m[6] / 3]);
});

test('a mirror shows as a negative x scale', async () => {
  const e = await engine(),
    mesh = e.createMesh().setScale([-2, 3, 4]);
  near(getWorldScale(mesh), [-2, 3, 4]);
});

test('results land in the place given', async () => {
  const e = await engine(),
    mesh = e.createMesh().setPosition([1, 2, 3]).setScale([4, 5, 6]),
    list = [0, 0, 0],
    floats = new Float32Array(3),
    object = { x: 0, y: 0, z: 0 },
    turn = [0, 0, 0, 0];
  assert.equal(getWorldPosition(mesh, list), list);
  assert.deepEqual(list, [1, 2, 3]);
  assert.equal(getWorldPosition(mesh, floats), floats);
  assert.deepEqual([...floats], [1, 2, 3]);
  assert.equal(getWorldPosition(mesh, object), object);
  assert.deepEqual(object, { x: 1, y: 2, z: 3 });
  assert.equal(getWorldScale(mesh, list), list);
  near(list, [4, 5, 6]);
  assert.equal(getWorldQuaternion(mesh, turn), turn);
  near(turn, [0, 0, 0, 1]);
});

/** World +Z and +Y of a mesh after a real kernel tick. */
const axes = (e, mesh) => {
  e.render();
  const m = mesh.matrix,
    length = (a) => Math.hypot(m[a], m[a + 1], m[a + 2]);
  return {
    z: [m[8] / length(8), m[9] / length(8), m[10] / length(8)],
    y: [m[4] / length(4), m[5] / length(4), m[6] / length(4)],
    position: [m[12], m[13], m[14]],
  };
};
const towards = (from, to) => {
  const d = to.map((v, i) => v - from[i]),
    length = Math.hypot(...d);
  return d.map((v) => v / length);
};

test('lookAt points +Z at the target and keeps +Y up', async () => {
  const e = await engine(),
    mesh = e.createMesh().setPosition([1, 2, 3]);
  assert.equal(lookAt(mesh, [4, 2, 3]), mesh);
  const { z, y } = axes(e, mesh);
  near(z, [1, 0, 0]);
  near(y, [0, 1, 0]);
});

test('lookAt holds under a moved, turned and unevenly scaled parent', async () => {
  const { e, leaf } = await tree(),
    target = [7, -3, 2];
  lookAt(leaf, target);
  const { z, position } = axes(e, leaf);
  near(z, towards(position, target), 2e-4);
});

test('lookAt takes objects, meshes and another up', async () => {
  const e = await engine(),
    mesh = e.createMesh(),
    other = e.createMesh(e.createMesh().setPosition([0, 5, 0])).setPosition([5, 0, 0]);
  lookAt(mesh, { x: 0, y: 0, z: -2 });
  near(axes(e, mesh).z, [0, 0, -1]);
  lookAt(mesh, other);
  near(axes(e, mesh).z, towards([0, 0, 0], [5, 5, 0]));
  lookAt(mesh, [1, 0, 0], { up: [0, 0, 1] });
  const { z, y } = axes(e, mesh);
  near(z, [1, 0, 0]);
  near(y, [0, 0, 1]);
});

test('lookAt along up still gives a rotation, and at the target keeps the old one', async () => {
  const e = await engine(),
    mesh = e.createMesh().setRotation([0.2, 0.3, 0.4]);
  lookAt(mesh, [0, 5, 0]);
  const { z, y } = axes(e, mesh);
  near(z, [0, 1, 0]);
  near([Math.hypot(...y)], [1]);
  near([y[0] * z[0] + y[1] * z[1] + y[2] * z[2]], [0]);
  const before = [...mesh.matrix];
  lookAt(mesh, [0, 0, 0]);
  near(axes(e, mesh).y, [before[4], before[5], before[6]]);
});

test('lookAt refuses what is not a point', async () => {
  const mesh = (await engine()).createMesh();
  assert.throws(() => lookAt(mesh, null), TypeError);
  assert.throws(() => lookAt(mesh, [Number.NaN, 0, 0]), RangeError);
  assert.throws(() => lookAt(mesh, { x: 1, y: Number.POSITIVE_INFINITY, z: 0 }), RangeError);
});

test('extendMeshes adds the members, once, to meshes old and new', async () => {
  const e = await engine(),
    old = e.createMesh(),
    plain = 'children' in old;
  assert.equal(plain, false, 'importing the entry added nothing');
  extendMeshes();
  extendMeshes();
  const child = e.createMesh(old).setPosition([1, 0, 0]);
  assert.deepEqual(old.children, [child]);
  assert.equal(child.parent, old);
  child.userData.tag = 'a';
  assert.deepEqual(child.userData, { tag: 'a' });
  child.userData = { tag: 'b' };
  assert.deepEqual(userData(child), { tag: 'b' });
  const seen = [];
  old.traverse((mesh) => seen.push(mesh));
  assert.deepEqual(seen, [old, child]);
  assert.deepEqual(child.getWorldPosition(), [1, 0, 0]);
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(child.getWorldPosition(out), out);
  near(child.getWorldScale(), [1, 1, 1]);
  near(child.getWorldQuaternion(), [0, 0, 0, 1]);
  assert.equal(child.lookAt(5, 0, 0), child);
  near(axes(e, child).z, [1, 0, 0]);
  child.lookAt([1, 0, 4], { up: [1, 0, 0] });
  const { z, y } = axes(e, child);
  near(z, [0, 0, 1]);
  near(y, [1, 0, 0]);
});

test('the README examples type-check as written', () => {
  assert.deepEqual(readmeTypeErrors(packageFolder(import.meta.url)), []);
});

test('the mesh members stay out of the API reports of core', () => {
  for (const report of ['core', 'core.extension']) {
    const text = readFileSync(new URL(`../../../api/${report}.api.md`, import.meta.url), 'utf8');
    assert.ok(!text.includes('SceneGraphMembers'), report);
    assert.equal(text.split('interface Mesh {').length, 2, `${report} lists Mesh once`);
  }
});

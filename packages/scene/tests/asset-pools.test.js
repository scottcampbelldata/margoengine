// AssetPool references, preload groups and templates: counts, disposal at zero, progress, shared geometry, overrides, cycles.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore, box, PbrMaterial } from '@margoengine/core/extension';
import { children, getWorldPosition, parent, userData } from '../dist/index.js';
import { AssetPool } from '../dist/asset-pools.js';

const make = async (renderer = {}) =>
  new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(16), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
    ...renderer,
  });
const resource = (log, name) => ({ name, [Symbol.dispose]: () => log.push(name) });

test('acquire shares one load, counts references, and disposes at zero through Symbol.dispose', async () => {
  const log = [];
  let loads = 0;
  const registry = new AssetPool();
  registry.define('rock', () => (loads++, resource(log, 'rock')));
  const [a, b] = await Promise.all([registry.acquire('rock'), registry.acquire('rock')]);
  assert.equal(a, b);
  assert.equal(loads, 1);
  assert.equal(registry.refCount('rock'), 2);
  assert.equal(registry.release('rock'), 1);
  assert.deepEqual(log, []);
  assert.equal(registry.get('rock'), a);
  assert.equal(registry.release('rock'), 0);
  assert.deepEqual(log, ['rock']);
  assert.equal(registry.get('rock'), undefined);
  assert.equal(registry.has('rock'), true); // the definition stays
  await registry.acquire('rock');
  assert.equal(loads, 2);
});

test('the dispose option wins over Symbol.dispose, and runs once', async () => {
  const log = [],
    seen = [];
  const registry = new AssetPool({ dispose: (value, key) => seen.push(key) });
  registry.define('a', () => resource(log, 'a'));
  await registry.acquire('a');
  registry.release('a');
  assert.deepEqual(seen, ['a']);
  assert.deepEqual(log, []);
});

test('a release past zero and an unknown key are coded errors; a failed acquire takes no reference', async () => {
  const registry = new AssetPool();
  registry.define('x', () => ({}));
  registry.define('bad', () => Promise.reject(new Error('nope')));
  await registry.acquire('x');
  registry.release('x');
  assert.throws(() => registry.release('x'), { code: 'state', message: /released more often than it was acquired.*#scene-registry/ });
  assert.throws(() => registry.release('ghost'), { code: 'state', message: /not defined.*#scene-registry/ });
  await assert.rejects(registry.acquire('bad'), /nope/);
  assert.equal(registry.refCount('bad'), 0);
  await assert.rejects(registry.acquire('ghost'), { code: 'state' });
});

test('preload groups load through the queue with progress, hold references, and finish what failed on a repeat call', async () => {
  const registry = new AssetPool();
  let healed = false;
  registry.define('a', () => ({ a: 1 }));
  registry.define('b', () => ({ b: 1 }));
  registry.define('c', () => (healed ? { c: 1 } : Promise.reject(new Error('later'))));
  registry.defineGroup('level', ['a', 'b', 'c']);
  assert.throws(() => registry.defineGroup('level', []), { code: 'state' });
  const fractions = [];
  let result = await registry.preload('level', { concurrency: 2, onProgress: (p) => fractions.push([p.finished, p.total]) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map((t) => t.name), ['c']);
  assert.deepEqual(fractions.at(-1), [3, 3]);
  assert.ok(fractions.every(([finished], i) => i === 0 || finished >= fractions[i - 1][0]));
  assert.equal(registry.refCount('a'), 1);
  assert.equal(registry.refCount('c'), 0);
  healed = true;
  result = await registry.preload('level');
  assert.equal(result.ok, true);
  assert.equal(registry.refCount('a'), 1); // not taken twice
  assert.equal(registry.refCount('c'), 1);
  assert.equal(registry.releaseGroup('level'), 3);
  assert.equal(registry.get('a'), undefined);
  await assert.rejects(async () => registry.preload('nope'), { code: 'state' });
});

test('an aborted preload cancels what is pending and holds nothing', async () => {
  const registry = new AssetPool();
  registry.define('a', (key, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  registry.defineGroup('g', ['a']);
  const controller = new AbortController();
  const running = registry.preload('g', { signal: controller.signal });
  controller.abort(new Error('cancel'));
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(registry.refCount('a'), 0);
});

test('templates: instances share geometry and materials, apply overrides, and leave the prototype alone', async () => {
  using e = await make();
  const registry = new AssetPool();
  const material = new PbrMaterial({ color: '#abc' }),
    geometry = box();
  registry.defineTemplate('crate', () => {
    const root = e.createMesh().setGeometry(geometry).setMaterial(material);
    e.createMesh(root).setGeometry(geometry).setMaterial(material).setPosition([0, 1, 0]);
    root.visible = false;
    return root;
  });
  const paint = new PbrMaterial({ color: '#f00' });
  const one = await registry.instantiate('crate'),
    two = await registry.instantiate('crate', {
      name: 'two',
      position: [4, 0, 0],
      scale: [2, 2, 2],
      visible: true,
      material: paint,
      userData: { hp: 3 },
    });
  assert.equal(one.geometry, geometry);
  assert.equal(one.material, material);
  assert.equal(two.name, 'two');
  assert.equal(two.material, paint);
  assert.equal(children(two)[0].material, paint);
  assert.equal(two.geometry, geometry);
  assert.equal(userData(two).hp, 3);
  assert.deepEqual([...getWorldPosition(two)], [4, 0, 0]);
  assert.equal(one.visible, false); // copied from the prototype
  assert.equal(two.visible, true);
  const sibling = await registry.instantiate('crate', { parent: two });
  assert.equal(parent(sibling), two);
  // the build ran once
  const roots = [...e.meshes.values()].length;
  await registry.instantiate('crate');
  assert.equal([...e.meshes.values()].length, roots + 2);
  await assert.rejects(registry.instantiate('ghost'), { code: 'state', message: /not defined.*#scene-registry/ });
  const throwing = registry.instantiate('crate', { apply: () => { throw new Error('bad apply'); } });
  const before = [...e.meshes.values()].length;
  await assert.rejects(throwing, /bad apply/);
  assert.equal([...e.meshes.values()].length, before); // the copy was disposed
});

test('no shared geometry is freed while an instance still uses it, even after the asset is released to zero', async () => {
  const removed = [];
  using e = await make({ remove: (geometry) => removed.push(geometry) });
  const geometry = box();
  const registry = new AssetPool();
  const log = [];
  registry.define('tree', () => {
    const root = e.createMesh().setGeometry(geometry);
    return { root, [Symbol.dispose]: () => (log.push('tree'), root.dispose()) };
  });
  registry.defineTemplate('tree', ({ assets }) => assets.tree.root, { needs: ['tree'], ownsRoot: false });
  const copies = [await registry.instantiate('tree'), await registry.instantiate('tree'), await registry.instantiate('tree')];
  assert.equal(registry.refCount('tree'), 1); // the template holds it
  assert.equal(registry.releaseTemplate('tree'), true);
  assert.deepEqual(log, ['tree']); // the asset was disposed at zero: its own mesh is gone
  assert.equal(registry.refCount('tree'), 0);
  assert.deepEqual(removed, []); // but the geometry stays for the three instances
  copies[0].dispose();
  copies[1].dispose();
  assert.deepEqual(removed, []);
  copies[2].dispose();
  assert.deepEqual(removed, [geometry]); // freed exactly once, with the last user
  // the definition stays: a new instance rebuilds the prototype from a fresh load
  const again = await registry.instantiate('tree');
  assert.equal(again.geometry, geometry);
  assert.equal(registry.refCount('tree'), 1);
});

test('a template that reaches itself, directly or through another, is a coded cycle error and holds nothing', async () => {
  using e = await make();
  const registry = new AssetPool();
  registry.define('a', () => ({}));
  registry.defineTemplate('self', async ({ instantiate }) => (await instantiate('self'), e.createMesh()), { needs: ['a'] });
  registry.defineTemplate('left', async ({ instantiate }) => instantiate('right'));
  registry.defineTemplate('right', async ({ instantiate }) => instantiate('left'));
  await assert.rejects(registry.instantiate('self'), { code: 'state', message: /cycle: self -> self.*#scene-registry/ });
  await assert.rejects(registry.instantiate('left'), { code: 'state', message: /cycle: left -> right -> left/ });
  assert.equal(registry.refCount('a'), 0);
  assert.throws(() => registry.defineTemplate('self', () => e.createMesh()), { code: 'state' });
});

test('a template can build from another template, and dispose releases everything', async () => {
  using e = await make();
  const registry = new AssetPool();
  const log = [];
  registry.define('res', () => resource(log, 'res'));
  registry.defineTemplate('leaf', () => e.createMesh().setGeometry(box()), { needs: ['res'] });
  registry.defineTemplate('branch', async ({ instantiate }) => {
    const root = e.createMesh();
    const leaf = await instantiate('leaf', { parent: root, position: [0, 1, 0] });
    assert.equal(children(root)[0], leaf);
    return root;
  });
  const branch = await registry.instantiate('branch');
  assert.equal(children(branch).length, 1);
  assert.equal(registry.refCount('res'), 1);
  registry.dispose();
  assert.deepEqual(log, ['res']);
  assert.equal(registry.refCount('res'), 0);
  assert.equal([...e.meshes.values()].length, 2); // the instance and its leaf; both prototypes and their subtrees are gone
});

test('userData overrides never reach a prototype: __proto__, constructor and prototype are refused, normal keys apply', async () => {
  using e = await make();
  const registry = new AssetPool();
  registry.defineTemplate('t', () => e.createMesh());
  const before = [...e.meshes.values()].length;
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const overrides = JSON.parse(`{"userData":{"${key}":{"polluted":1}}}`);
    await assert.rejects(registry.instantiate('t', overrides), { name: 'TypeError', message: /not allowed/ });
  }
  assert.equal({}.polluted, undefined);
  assert.equal([...e.meshes.values()].length, before); // refused before anything was built
  const copy = await registry.instantiate('t', JSON.parse('{"userData":{"hp":3}}'));
  assert.equal(userData(copy).hp, 3);
  assert.equal(Object.getPrototypeOf(userData(copy)), Object.getPrototypeOf({}));
});

test('the base registry of scene/assets carries no pool method; AssetPool is an AssetRegistry', async () => {
  const { AssetRegistry } = await import('../dist/assets.js');
  for (const name of ['acquire', 'release', 'refCount', 'defineGroup', 'preload', 'releaseGroup', 'defineTemplate', 'instantiate', 'releaseTemplate', 'removeTemplate'])
    assert.equal(name in AssetRegistry.prototype, false, name);
  assert.ok(new AssetPool() instanceof AssetRegistry);
});

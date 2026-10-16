import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box, PbrMaterial } from '../packages/core/dist/index.js';

// The kernel recomputes only entities whose inputs or ancestors changed. Oracle: a fresh kernel given the same inputs
// computes everything from scratch; published matrices and visibility must match it bit for bit after every edit.
const capacity = 64;
async function oracle(store) {
  const fresh = await TransformStore.create(capacity);
  try {
    for (const key of Object.keys(store.transforms)) fresh.transforms[key].set(store.transforms[key]);
    for (const key of ['parents', 'bounds', 'planes', 'active', 'hidden', 'constrained', 'rotations', 'limits'])
      fresh[key].set(store[key]);
    fresh.tick(true);
    return { matrices: fresh.matrices.slice(), visible: fresh.visible.slice() };
  } finally {
    fresh.dispose();
  }
}
const bits = (array) =>
  Array.from(new Uint32Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength)));

test('dirty transform propagation matches a full recompute', async () => {
  const frames = [],
    renderer = {
      backend: 'webgpu',
      add() {},
      remove() {},
      render(_c, _l, batches) {
        frames.push([...batches].map((b) => ({ geometry: b.geometry, instances: b.instances.slice(0, b.count * 24) })));
      },
      dispose() {},
    };
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(capacity),
    renderer,
    { position: [0, 4, 12], target: [0, 0, 0], far: 100 },
    null,
  );
  const geometry = box(1, 1, 1),
    other = box(2, 1, 1),
    red = new PbrMaterial({ color: '#ff0000' });
  const check = async (label) => {
    engine.render();
    const expected = await oracle(engine.store),
      store = engine.store;
    for (const mesh of engine.meshes.values()) {
      assert.deepEqual(
        bits(mesh.matrix),
        bits(expected.matrices.subarray(mesh.id * 16, mesh.id * 16 + 16)),
        `${label}: matrix of ${mesh.name}`,
      );
      assert.equal(store.visible[mesh.id], expected.visible[mesh.id], `${label}: visibility of ${mesh.name}`);
    }
    // Instances drawn this frame equal a from-scratch collection in mesh order.
    const want = new Map();
    for (const mesh of engine.meshes.values())
      if (mesh.geometry && store.visible[mesh.id]) {
        const list = want.get(mesh.geometry) ?? [];
        list.push(...mesh.matrix, ...mesh.material.data.slice(0, 7), mesh.id);
        want.set(mesh.geometry, list);
      }
    for (const batch of frames.at(-1))
      assert.deepEqual(
        bits(batch.instances),
        bits(new Float32Array(want.get(batch.geometry) ?? [])),
        `${label}: instances`,
      );
  };
  try {
    const root = engine.createMesh();
    root.name = 'root';
    const arm = engine.createMesh(root).setPosition([1, 0, 0]);
    arm.name = 'arm';
    const hand = engine.createMesh(arm).setGeometry(geometry).setPosition([0, 1, 0]);
    hand.name = 'hand';
    const loose = engine.createMesh().setGeometry(geometry).setPosition([-2, 0, 0]);
    loose.name = 'loose';
    const parts = Array.from({ length: 8 }, (_, i) => {
      const m = engine
        .createMesh(i % 2 ? arm : root)
        .setGeometry(geometry)
        .setPosition([i - 4, -1, 0]);
      m.name = `part${i}`;
      return m;
    });
    await check('first frame');
    await check('unchanged frame');
    root.position.x = 0.5;
    await check('parent moves children');
    arm.setRotation([0, 0.3, 0]);
    await check('middle rotation');
    arm.scale.set(2, 1, 0.5);
    await check('scale change');
    hand.setParent(loose);
    await check('reparent');
    hand.setParent(null);
    await check('unparent');
    root.visible = false;
    await check('hide ancestor');
    root.visible = true;
    await check('show ancestor');
    parts[3].visible = false;
    await check('hide leaf');
    parts[3].dispose();
    await check('remove leaf');
    const added = engine.createMesh(arm).setGeometry(geometry).setPosition([0, 0, 1]);
    added.name = 'added';
    await check('add into freed slot');
    const recycled = engine.createMesh(root);
    recycled.name = 'recycled';
    await check('add without geometry');
    arm.dispose();
    await check('remove parent (children detach)');
    parts[0].setGeometry(other);
    await check('geometry change');
    parts[2].setMaterial(red);
    await check('material change');
    red.data[0] = 0.25;
    await check('material edited in place');
    parts[4].material = new PbrMaterial({ color: '#00ff00' });
    await check('material assigned');
    loose.position.z = 40;
    await check('move out of view');
    loose.position.z = 0;
    await check('move back into view');
    engine.camera.position = [12, 4, 0];
    await check('camera moves');
    for (let i = 0; i < 5; i++) {
      parts[6].position.y = i * 0.1;
      engine.store.tick(false);
    }
    await check('package ticks between frames');
    const before = engine.store.matrices.slice();
    engine.store.transforms.x[loose.id] = NaN;
    assert.throws(() => engine.render(), /Invalid transform/);
    assert.deepEqual(bits(engine.store.matrices), bits(before), 'a failed tick publishes nothing');
    loose.position.x = 3;
    await check('recovers after a failed tick');
  } finally {
    engine.dispose();
  }
});

// Growth on demand: the store doubles in place (drop + larger kernel at the same address, views re-bound, values copied).
const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
async function freshOutputs(store) {
  const fresh = await TransformStore.create(store.capacity);
  try {
    for (const key of Object.keys(store.transforms)) fresh.transforms[key].set(store.transforms[key]);
    for (const key of ['parents', 'bounds', 'planes', 'active', 'hidden', 'constrained', 'rotations', 'limits'])
      fresh[key].set(store[key]);
    fresh.tick(true);
    return {
      matrices: fresh.matrices.slice(),
      visible: fresh.visible.slice(),
      rotations: fresh.rotations.slice(),
      q: fresh.transforms.qw.slice(),
    };
  } finally {
    fresh.dispose();
  }
}
// Compares world matrices and visibility of every live entity with a fresh kernel's full recompute, bit for bit.
async function sameAsFresh(engine, label) {
  const store = engine.store,
    want = await freshOutputs(store),
    got = new Uint32Array(store.matrices.buffer, store.matrices.byteOffset, store.matrices.length),
    expected = new Uint32Array(want.matrices.buffer);
  let compared = 0;
  for (const id of engine.meshes.keys()) {
    for (let i = id * 16; i < id * 16 + 16; i++)
      if (got[i] !== expected[i]) assert.fail(`${label}: matrix of entity ${id}`);
    if (store.visible[id] !== want.visible[id]) assert.fail(`${label}: visibility of entity ${id}`);
    compared++;
  }
  assert.equal(compared, engine.meshes.size);
}
const changedCount = (store) => {
  let n = 0;
  for (let id = store.changed.indexOf(1); id >= 0; id = store.changed.indexOf(1, id + 1)) n++;
  return n;
};

test('the store grows in place and keeps every value; failed growth and invalid capacities change nothing', async () => {
  const store = await TransformStore.create(3);
  try {
    store.active.set([1, 1, 1]);
    store.parents.set([-1, 0, 1]);
    for (const key of ['qw', 'sx', 'sy', 'sz']) store.transforms[key].fill(1);
    store.transforms.x.set([1, 2, 3]);
    store.bounds.set([0, 0, 0, 1], 8);
    store.hidden[1] = 1;
    store.constrained[2] = 1;
    store.limits.set([-1, 1], 24);
    store.planes.fill(0);
    store.tick(false);
    const before = Object.fromEntries(
      [
        'matrices',
        'parents',
        'bounds',
        'planes',
        'active',
        'visible',
        'constrained',
        'hidden',
        'changed',
        'rotations',
        'limits',
      ].map((key) => [key, store[key].slice()]),
    );
    const x = store.transforms.x;
    store.grow(5);
    assert.equal(store.capacity, 5);
    assert.notEqual(
      store.transforms.x,
      x,
      'views are replaced (old ones are stale: detached, or aliasing the new layout when memory did not grow)',
    );
    for (const [key, values] of Object.entries(before))
      assert.deepEqual(bytes(store[key].subarray(0, values.length)), bytes(values), key);
    assert.deepEqual([...store.parents.subarray(3)], [-1, -1], 'new slots have no parent');
    assert.deepEqual([...store.active.subarray(3)], [0, 0]);
    assert.deepEqual([...store.transforms.x], [1, 2, 1, 0, 0], 'clamped by its joint limit before growing');
    for (const capacity of [5, 4, 2.5, NaN, 2 ** 23 + 1]) assert.throws(() => store.grow(capacity), /Capacity/);
    const kept = store.matrices.slice();
    store.transforms.x[0] = 7;
    assert.deepEqual(bytes(store.matrices), bytes(kept), 'a rejected growth keeps the store usable');
    store.tick(false);
    assert.deepEqual([store.matrices[12], store.matrices[16 + 12], store.matrices[32 + 12]], [7, 9, 10]);
    store.dispose();
    assert.throws(() => store.tick(), /disposed/);
  } finally {
    store.dispose();
  }
  await assert.rejects(TransformStore.create(2 ** 23 + 1), /Capacity/);
});

test('one million entities: growth, 1% moves, 63-deep chains, removal and dispose match a fresh kernel bit for bit', {
  timeout: 600_000,
}, async () => {
  const renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(1024),
    renderer,
    { position: [0, 50, 400], target: [0, 0, 0], far: 2000 },
    null,
  );
  const n = 1_000_000,
    chain = 64,
    geometry = box(0.5, 0.5, 0.5),
    meshes = new Array(n);
  try {
    // Chains of 64 (63 ancestors at the leaf, the deepest hierarchy core allows); every 4th entity has no geometry.
    for (let i = 0; i < n; i++) {
      const mesh = (meshes[i] = engine
        .createMesh(i % chain ? meshes[i - 1] : null)
        .setPosition(i % chain ? [0.01, 0.02, 0] : [((i / chain) % 250) - 125, 0, Math.floor(i / chain / 250) - 31]));
      if (i % 4) mesh.setGeometry(geometry);
      if (i % 97 === 0) mesh.setRotation([0.1, i % 7, 0]);
    }
    assert.equal(engine.store.capacity, 2 ** 20, 'doubled from 1,024 to 1,048,576');
    for (const mesh of [meshes[0], meshes[123_457], meshes[n - 1]])
      assert.equal(mesh.matrix.length, 16, 'live meshes were re-bound to the grown store');
    engine.render();
    await sameAsFresh(engine, 'created');
    assert.ok(engine.stats.visible > 0 && engine.stats.visible < n);
    engine.store.tick(true);
    assert.equal(changedCount(engine.store), 0, 'an unchanged tick recomputes nothing');
    // Move 1%: every 100th entity (chain roots included, so whole chains follow).
    for (let i = 0; i < n; i += 100) meshes[i].position.y += 0.5;
    let expected = 0;
    for (let i = 0; i < n; i += 100) expected += chain - (i % chain); // the mover and the rest of its chain
    engine.store.tick(true);
    assert.equal(changedCount(engine.store), expected, '1% moved recomputes exactly them and their descendants');
    engine.render();
    await sameAsFresh(engine, 'moved 1%');
    // Removal: chain roots (children detach) and leaves; then reuse freed slots without growing.
    for (let i = 0; i < 1000; i++) meshes[i * 997 + (i % 2 ? 0 : 63 - ((i * 997) % 64))].dispose();
    engine.render();
    await sameAsFresh(engine, 'removed');
    const alive = (mesh) => engine.meshes.get(mesh.id) === mesh;
    for (let i = 0, k = 5; i < 1000; i++, k += 64) {
      while (!alive(meshes[k])) k++;
      engine.createMesh(meshes[k]).setGeometry(geometry).setPosition([0, 1, 0]);
    }
    assert.equal(engine.store.capacity, 2 ** 20);
    engine.render();
    await sameAsFresh(engine, 'reused slots');
    // A failed tick publishes nothing at this size either.
    const before = engine.store.matrices.slice(),
      victim = meshes[500_003];
    engine.store.transforms.x[victim.id] = NaN;
    assert.throws(() => engine.render(), /Invalid transform/);
    assert.ok(bytes(engine.store.matrices).equals(bytes(before)), 'a failed tick publishes nothing');
    victim.position.x = 1;
    engine.render();
    await sameAsFresh(engine, 'recovered');
  } finally {
    engine.dispose();
  }
  assert.equal(engine.meshes.size, 0);
  assert.throws(() => engine.store.tick(), /disposed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../packages/core/dist/engine.js';
import {TransformStore} from '../packages/core/dist/kernel.js';
import {box, PbrMaterial} from '../packages/core/dist/index.js';

// The kernel recomputes only entities whose inputs or ancestors changed. Oracle: a fresh kernel given the same inputs
// computes everything from scratch; published matrices and visibility must match it bit for bit after every edit.
const capacity = 64;
async function oracle(store) {
  const fresh = await TransformStore.create(capacity);
  try {
    for (const key of Object.keys(store.transforms)) fresh.transforms[key].set(store.transforms[key]);
    for (const key of ['parents', 'bounds', 'planes', 'active', 'hidden', 'constrained', 'rotations', 'limits']) fresh[key].set(store[key]);
    fresh.tick(true);
    return {matrices: fresh.matrices.slice(), visible: fresh.visible.slice()};
  } finally {fresh.dispose();}
}
const bits = array => Array.from(new Uint32Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength)));

test('dirty transform propagation matches a full recompute', async () => {
  const frames = [], renderer = {backend: 'webgpu', add() {}, remove() {}, render(_c, _l, batches) {frames.push([...batches].map(b => ({geometry: b.geometry, instances: b.instances.slice(0, b.count * 24)})));}, dispose() {}};
  const engine = new Engine({width: 64, height: 64, clientWidth: 64, clientHeight: 64}, await TransformStore.create(capacity), renderer, {position: [0, 4, 12], target: [0, 0, 0], far: 100}, null);
  const geometry = box(1, 1, 1), other = box(2, 1, 1), red = new PbrMaterial({color: '#ff0000'});
  const check = async label => {
    engine.render();
    const expected = await oracle(engine.store), store = engine.store;
    for (const mesh of engine.meshes.values()) {
      assert.deepEqual(bits(mesh.matrix), bits(expected.matrices.subarray(mesh.id * 16, mesh.id * 16 + 16)), `${label}: matrix of ${mesh.name}`);
      assert.equal(store.visible[mesh.id], expected.visible[mesh.id], `${label}: visibility of ${mesh.name}`);
    }
    // Instances drawn this frame equal a from-scratch collection in mesh order.
    const want = new Map();
    for (const mesh of engine.meshes.values()) if (mesh.geometry && store.visible[mesh.id]) {
      const list = want.get(mesh.geometry) ?? [];list.push(...mesh.matrix, ...mesh.material.data.slice(0, 7), mesh.id);want.set(mesh.geometry, list);
    }
    for (const batch of frames.at(-1)) assert.deepEqual(bits(batch.instances), bits(new Float32Array(want.get(batch.geometry) ?? [])), `${label}: instances`);
  };
  try {
    const root = engine.createMesh();root.name = 'root';
    const arm = engine.createMesh(root).setPosition([1, 0, 0]);arm.name = 'arm';
    const hand = engine.createMesh(arm).setGeometry(geometry).setPosition([0, 1, 0]);hand.name = 'hand';
    const loose = engine.createMesh().setGeometry(geometry).setPosition([-2, 0, 0]);loose.name = 'loose';
    const parts = Array.from({length: 8}, (_, i) => {const m = engine.createMesh(i % 2 ? arm : root).setGeometry(geometry).setPosition([i - 4, -1, 0]);m.name = `part${i}`;return m;});
    await check('first frame');
    await check('unchanged frame');
    root.position.x = 0.5;await check('parent moves children');
    arm.setRotation([0, 0.3, 0]);await check('middle rotation');
    arm.scale.set(2, 1, 0.5);await check('scale change');
    hand.setParent(loose);await check('reparent');
    hand.setParent(null);await check('unparent');
    root.visible = false;await check('hide ancestor');
    root.visible = true;await check('show ancestor');
    parts[3].visible = false;await check('hide leaf');
    parts[3].dispose();await check('remove leaf');
    const added = engine.createMesh(arm).setGeometry(geometry).setPosition([0, 0, 1]);added.name = 'added';await check('add into freed slot');
    const recycled = engine.createMesh(root);recycled.name = 'recycled';await check('add without geometry');
    arm.dispose();await check('remove parent (children detach)');
    parts[0].setGeometry(other);await check('geometry change');
    parts[2].setMaterial(red);await check('material change');
    red.data[0] = 0.25;await check('material edited in place');
    parts[4].material = new PbrMaterial({color: '#00ff00'});await check('material assigned');
    loose.position.z = 40;await check('move out of view');
    loose.position.z = 0;await check('move back into view');
    engine.camera.position = [12, 4, 0];await check('camera moves');
    for (let i = 0; i < 5; i++) {parts[6].position.y = i * 0.1;engine.store.tick(false);}await check('package ticks between frames');
    const before = engine.store.matrices.slice();
    engine.store.transforms.x[loose.id] = NaN;assert.throws(() => engine.render(), /Invalid transform/);
    assert.deepEqual(bits(engine.store.matrices), bits(before), 'a failed tick publishes nothing');
    loose.position.x = 3;await check('recovers after a failed tick');
  } finally {engine.dispose();}
});

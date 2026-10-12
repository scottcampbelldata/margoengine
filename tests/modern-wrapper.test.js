import test from 'node:test';
import assert from 'node:assert/strict';
import {Stage, sphere} from '../packages/margoengine/dist/index.js';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';

async function scene(capacity = 16) {
  const store = await TransformStore.create(capacity), resources = new Set();
  const renderer = {backend: 'webgl2', add: g => resources.add(g), remove: g => resources.delete(g), render() {}, dispose() {resources.clear();}};
  const engine = new Engine({width: 400, height: 300, clientWidth: 400, clientHeight: 300}, store, renderer, undefined, null);
  return {app: new Stage(engine), engine, resources};
}

test('orb geometry has outward winding, unit normals and bounded input', () => {
  for (const segments of [3, 16, 32]) {
    const geometry = sphere(2, segments), v = geometry.vertices;
    for (let i = 0; i < v.length; i += 6) {
      assert.ok(Math.abs(Math.hypot(v[i], v[i + 1], v[i + 2]) - 2) < 1e-6);
      assert.ok(Math.abs(Math.hypot(v[i + 3], v[i + 4], v[i + 5]) - 1) < 1e-6);
    }
    for (let i = 0; i < geometry.indices.length; i += 3) {
      const [a, b, c] = geometry.indices.slice(i, i + 3).map(index => index * 6);
      const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]], w = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
      const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      assert.ok(normal.reduce((sum, n, axis) => sum + n * v[a + 3 + axis], 0) > 0, 'Degenerate or inward sphere triangle');
    }
  }
  for (const radius of [0, -1, 1e-99, NaN, Infinity, 1e39, '1']) assert.throws(() => sphere(radius), /radius/);
  for (const segments of [2, 257, 3.5, NaN]) assert.throws(() => sphere(1, segments), /segments/);
});

test('facade preserves real mesh handles, hierarchy and rollback after bad transforms', async () => {
  const {app, engine, resources} = await scene();
  try {
    const parent = app.box({name: 'root', position: [2, 0, 0]}), orb = app.sphere({parent, position: [1, 0, 0], color: '#84d6bd'});
    engine.render(); assert.equal(orb.matrix[12], 3); assert.equal(parent.name, 'root');
    assert.equal(orb.position.set(1, 2, 3), orb.position);
    orb.scale.setAll(1.2); assert.ok(Math.abs(orb.scale.z - 1.2) < 1e-6);
    assert.throws(() => orb.position.set(7, NaN, 8), /transform/); assert.equal(orb.position.x, 1);
    assert.throws(() => orb.scale.set(2, 0, 2), /transform/); assert.ok(Math.abs(orb.scale.x - 1.2) < 1e-6);
    orb.rotation.set(0.2, 0.3, 0.4); assert.throws(() => orb.rotation.set(4, 5, Infinity), /transform/); assert.ok(Math.abs(orb.rotation.x - 0.2) < 1e-6);
    orb.position.set(1, 0, 0); orb.scale.setAll(1); orb.rotation.setAll(0);
    const count = engine.meshes.size, allocated = resources.size;
    assert.throws(() => app.box({scale: [1, 0, 1]}), /nonzero/);
    assert.throws(() => app.box({size: [1, 2]}), /3 values/);
    assert.throws(() => app.sphere({roughness: NaN}), /Material/);
    assert.equal(engine.meshes.size, count); assert.equal(resources.size, allocated);
    let captured; engine.camera.fitToBoundingBox = (min, max) => {captured = {min, max};};
    app.fit([orb]); assert.ok(captured.min[0] < 2.01 && captured.max[0] > 3.99);
    orb.visible = false; assert.throws(() => app.fit([orb]), /No geometry/);
    const other = await scene();
    try {assert.throws(() => app.fit([other.app.box()]), /another engine/);} finally {other.app.dispose();}
  } finally {app.dispose();}
  assert.equal(engine.meshes.size, 0); assert.equal(resources.size, 0); app.dispose();
  assert.throws(() => app.sphere(), /disposed/);
});

test('model loading infers URL formats, fits imports, rolls back failures and aborts on disposal', async () => {
  const originalFetch = globalThis.fetch, {app, engine} = await scene();
  const obj = 'v 9 -1 0\nv 11 -1 0\nv 10 1 0\nf 1 2 3';
  globalThis.fetch = async () => new Response(obj);
  try {
    const model = await app.load('https://example.invalid/assembly.OBJ?download=1');
    assert.equal(model.position, model.root.position); model.position.set(2, 0, 0); model.scale.setAll(1);
    const bounds = model.bounds; assert.deepEqual([...bounds], [11, -1, 0, 13, 1, 0]);
    model.position.x = 3; assert.equal(model.bounds, bounds); assert.equal(bounds[0], 12);
    model.position.x = 2; model.visible = false; assert.equal(model.root.visible, false); assert.equal(model.bounds[0], 11);
    assert.equal(model.raw, null); model.visible = true;
    assert.throws(() => {model.visible = 'yes';}, /Visibility/);
    assert.equal(Object.getOwnPropertyDescriptor(model, 'bounds').set, undefined);
    app.fit(model.meshes);
    engine.render({delta: 0.5}); assert.ok(Math.abs(engine.camera.target[0] - 12) < 0.01);
    model.destroy(); model.destroy(); assert.equal(engine.meshes.size, 0); assert.throws(() => model.bounds, /disposed/);
    const vertices = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    const gltf = {asset: {version: '2.0'}, buffers: [{byteLength: 36, uri: `data:application/octet-stream;base64,${Buffer.from(vertices.buffer).toString('base64')}`}], bufferViews: [{buffer: 0, byteLength: 36}], accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3'}], meshes: [{primitives: [{attributes: {POSITION: 0}}]}], nodes: [{mesh: 0}]};
    globalThis.fetch = async () => new Response(JSON.stringify(gltf));
    const triangle = await app.load('https://example.invalid/model.gltf'); assert.equal(triangle.meshes.length, 1); triangle.destroy();
    globalThis.fetch = async () => new Response(obj);
    const copy = await app.load('https://example.invalid/download', {format: 'obj', fit: false}); copy.destroy();
    await assert.rejects(app.load('https://example.invalid/model.fbx'), /Specify/);
    await assert.rejects(app.load('https://example.invalid/model.obj', {signal: AbortSignal.abort('cancelled')}), error => error === 'cancelled');
    const fit = app.fit; app.fit = () => {throw new Error('fit failed');};
    await assert.rejects(app.load('https://example.invalid/model.obj'), /fit failed/); assert.equal(engine.meshes.size, 0); app.fit = fit;
    let started; const ready = new Promise(resolve => {started = resolve;});
    globalThis.fetch = (_, {signal}) => new Promise((resolve, reject) => {signal.addEventListener('abort', () => reject(signal.reason), {once: true}); started();});
    const pending = app.load('https://example.invalid/slow.obj'); await ready; app.dispose();
    await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(engine.meshes.size, 0);
  } finally {globalThis.fetch = originalFetch; app.dispose();}
});

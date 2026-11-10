import test from 'node:test';
import assert from 'node:assert/strict';
import { SDFScene2D } from '../dist/sdf.js';
import { GILighting2D } from '../dist/gi.js';

test('painted scene validates options and mutated fields with coded help', () => {
  assert.throws(() => new SDFScene2D(), TypeError);
  for (const options of [
    { alphaThreshold: -1 }, { alphaThreshold: 1.01 }, { alphaThreshold: NaN },
    { emissionIntensity: -1 }, { emissionIntensity: Infinity }, { camera: { x: 0, y: 0, zoom: 0 } },
  ]) assert.throws(() => new SDFScene2D({ source: {}, ...options }), RangeError);
  const scene = new SDFScene2D({ source: {} });
  scene.alphaThreshold = 2;
  assert.throws(() => scene.encode({}, {}), /alphaThreshold/);
  scene.alphaThreshold = .5;
  scene.emissionIntensity = NaN;
  assert.throws(() => scene.encode({}, {}), /emissionIntensity/);
  scene.dispose();
  scene.dispose();
  assert.throws(() => scene.encode({}, {}), { code: 'disposed' });
});

test('painted scene rejects incompatible textures and overflow before allocating', () => {
  const source = { width: 3, height: 4, dimension: '2d', depthOrArrayLayers: 1, sampleCount: 1, usage: 4, format: 'rgba8unorm' };
  for (const patch of [{ sampleCount: 4 }, { dimension: '3d' }, { usage: 16 }, { format: 'rgba8uint' }, { depthOrArrayLayers: 2 }]) {
    const scene = new SDFScene2D({ source: { ...source, ...patch } });
    assert.throws(() => scene.encode({}, {}), /single-sample/);
  }
  assert.throws(() => new SDFScene2D({ source, emission: { ...source, width: 2 } }).encode({}, {}), /dimensions/);
  assert.throws(() => new SDFScene2D({ source }).encode({ limits: { maxStorageBufferBindingSize: 16 } }, {}), /buffer limit/);
  assert.throws(() => new SDFScene2D({ source }).bindGroup({}, {}), { code: 'state' });
});

test('painted GI retains explicit WebGPU-only setup', () => {
  const pass = new GILighting2D({ target: {}, painted: new SDFScene2D({ source: {} }) });
  assert.throws(() => pass.setup({ backend: 'webgl2' }), { code: 'unsupported' });
  assert.throws(() => pass.setup({ backend: 'webgpu', gpu: null }), { code: 'unsupported' });
});

test('GI temporal configuration is explicit and resettable', () => {
  assert.equal(new GILighting2D({ target: {} }).temporal, true);
  assert.equal(new GILighting2D({ target: {}, temporal: false }).temporal, false);
  assert.throws(() => new GILighting2D({ target: {}, temporal: 1 }), /temporal/);
  const pass = new GILighting2D({ target: {} });
  pass.resetHistory();
  pass.dispose();
});

test('GI disposal removes only its owning scene registration', () => {
  const removed = [];
  const owner = { removePlugin: name => removed.push(name) };
  const engine = { backend: 'webgpu', gpu: {}, frameGraph: { add() {} }, sceneOf: () => owner,
    removePlugin() { assert.fail('must use owner, not active scene'); } };
  const pass = new GILighting2D({ name: 'owned-gi', target: {} });
  pass.setup(engine);
  pass.dispose(); pass.dispose();
  assert.deepEqual(removed, ['owned-gi']);
  const detached = new GILighting2D({ name: 'detached', target: {} });
  detached.setup({ ...engine, sceneOf: () => undefined });
  detached.dispose();
});

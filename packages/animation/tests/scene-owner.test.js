import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { fixtures, ownerEngine } from './owner-lifetime.fixture.js';
import { GeometryCachePlayer, encodeGeometryCache } from '../dist/geometry-cache.js';

for (const fixture of await fixtures()) {
  test(`${fixture.name} releases its registered scene and preserves a same-name default plugin`, async (t) => {
    const engine = await ownerEngine(t), scene = engine.createScene('animation-owner');
    let pending, handle;
    scene.use({ name: 'create-animation', setup() {
      pending = fixture.create({ engine, scene, dependency: (fn) => fn() });
    } });
    scene.removePlugin('create-animation');
    try {
      handle = await pending;
      if (!engine.sceneOf(handle.plugin)) scene.use(handle.plugin);
      assert.equal(engine.sceneOf(handle.plugin), scene);
      if (handle.plugin instanceof GeometryCachePlayer) assert.equal(handle.plugin.model.root.scene, scene);
      const sentinel = { name: handle.plugin.name, setup() {} };
      engine.use(sentinel);
      handle.dispose();
      handle.dispose();
      assert.equal(scene.plugins.has(handle.plugin.name), false);
      assert.equal(engine.sceneOf(handle.plugin), undefined);
      assert.equal(engine.plugins.get(sentinel.name), sentinel);
    } finally { handle?.dispose(); await handle?.cleanup?.(); }
  });
}

const file = () => encodeGeometryCache(1, [{ frameCount: 1,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }]);

test('failed first cache read releases the external signal listener', async (t) => {
  const engine = await ownerEngine(t), signal = new AbortController().signal;
  await assert.rejects(GeometryCachePlayer.attach(engine, new Uint8Array(), { signal }), /cache|header|chunk/i);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(engine.plugins.size, 0);
});

test('disposing the originating scene during the first read never attaches to the default scene', async (t) => {
  const engine = await ownerEngine(t), scene = engine.createScene('cache-loading');
  let release, pending;
  const ready = new Promise((resolve) => { release = resolve; });
  const source = async function* () { await ready; yield file(); };
  const signal = new AbortController().signal;
  scene.use({ name: 'load-cache', setup() {
    pending = GeometryCachePlayer.attach(engine, source(), { signal });
  } });
  scene.removePlugin('load-cache');
  scene.dispose();
  release();
  await assert.rejects(pending, { name: 'TypeError',
    message: 'Unknown scene: use engine.createScene(); see https://margoengine.com/errors#scene' });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(engine.scene.plugins.size, 0);
});

test('disposing a cache player releases the external signal listener', async (t) => {
  const engine = await ownerEngine(t), signal = new AbortController().signal;
  const player = await GeometryCachePlayer.attach(engine, file(), { signal });
  await player.done;
  assert.equal(getEventListeners(signal, 'abort').length, 1);
  player.dispose();
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

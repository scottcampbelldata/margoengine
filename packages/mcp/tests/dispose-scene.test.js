import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { AssetInstaller } from '../dist/assets-page.js';

// One triangle, its positions in a data URI.
const triangle = () => ({
  asset: { version: '2.0' },
  buffers: [
    {
      uri: `data:application/octet-stream;base64,${Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64')}`,
      byteLength: 36,
    },
  ],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
});

// Regression for the wrong-scene dispose bug: `engine.removePlugin(name)` acts on the active scene, so cleaning up an
// installed model while another scene was active removed that scene's same-name plugin and left the model installed.
test("dispose removes an installed model from its own scene, not the active scene's same-name plugin", async (t) => {
  const h = optionalGPU(),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(64), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    fetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(triangle()), { headers: { 'content-type': 'model/gltf+json' } });
  t.after(() => {
    globalThis.fetch = fetch;
    engine.dispose();
    h.cleanup();
  });
  const installer = new AssetInstaller(engine),
    { plugin: name } = await installer.load(
      { kind: 'model', url: 'http://app.test/empty.gltf' },
      new AbortController().signal,
    ),
    model = engine.plugins.get(name),
    other = engine.createScene('other'),
    kept = { name, disposed: 0, setup() {}, dispose: () => kept.disposed++ };
  assert.ok(model, 'the model is installed in the default scene');
  other.use(kept);
  // Cleaned up while the second scene is active, as from one of its plugins' dispose.
  other.use({ name: 'within', setup() {}, dispose: () => installer.dispose() });
  other.removePlugin('within');
  assert.equal(other.plugins.get(name), kept, 'the active scene lost its own same-name plugin');
  assert.equal(kept.disposed, 0);
  assert.equal(engine.scene.plugins.has(name), false, 'the installed model stayed in its scene');
});

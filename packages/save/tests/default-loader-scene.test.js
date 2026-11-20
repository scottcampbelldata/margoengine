// KB-OWN-ASYNC3: restoreScene's default model loader built the model after loading gltf/pbr, in the scene active then
// and not in the `scene` the save was restored into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { captureScene, restoreScene } from '../dist/engine.js';

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

async function rig(t) {
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
  return engine;
}
/** A save with one model entity, as captureScene writes it for a stand-in with a model's shape. */
function saveOf(engine) {
  const root = engine.createMesh(),
    plugin = {
      name: 'gltf/pbr:stand-in',
      root,
      nodes: [],
      ownedMeshes: [root],
      asset: { baseURL: 'https://example.test/t.gltf', doc: { nodes: [] } },
      setup() {},
      dispose() {
        engine.removePlugin(this.name);
        root.dispose();
      },
    };
  engine.use(plugin);
  const document = captureScene(engine);
  plugin.dispose();
  return document;
}

test('restoreScene into a second scene loads its models there with the default loader', async (t) => {
  const engine = await rig(t),
    other = engine.createScene('other'),
    document = saveOf(engine),
    { models } = await restoreScene(engine, document, { scene: other });
  assert.equal(models.size, 1);
  const [model] = models.values();
  assert.ok(engine.sceneOf(model) === other, 'the model plugin is not in the second scene');
  assert.ok(model.root.scene === other, 'the model root is not in the second scene');
  assert.deepEqual([...engine.scene.plugins.keys()], [], 'a plugin landed in the default scene');
  assert.equal(engine.scene.meshes.size, 0, 'meshes landed in the default scene');
});

test('an aborted restoreScene into a second scene leaves nothing in either scene', async (t) => {
  const engine = await rig(t),
    other = engine.createScene('other'),
    document = saveOf(engine),
    controller = new AbortController(),
    pending = restoreScene(engine, document, { scene: other, signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  for (const scene of [engine.scene, other]) {
    assert.deepEqual([...scene.plugins.keys()], [], `scene ${scene.name} holds plugins`);
    assert.equal(scene.meshes.size, 0, `scene ${scene.name} holds meshes`);
  }
});

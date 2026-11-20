import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { headless } from '../../../tests/support/pbr-snapshot.js';

// KB-OWN-ASYNC1: loadOBJ reads the OBJ and its libraries, then makes the mesh. A load started in a second scene's setup
// makes its mesh in that scene, not in the default scene that is active again once the awaits are over. The stand-in
// createMesh acts on the engine as materials' createMesh does: a core mesh and a model plugin in the active scene.
// Run with --experimental-test-module-mocks.
class Material {
  dispose() {}
}
class Texture {
  dispose() {}
}
mock.module('@margoengine/materials', {
  namedExports: {
    Material,
    Texture,
    loadTexture: async () => {
      throw new Error('pass loadTexture');
    },
    createMesh(engine, geometry, materials) {
      const node = engine.createMesh(),
        plugin = { name: `obj-model-${node.id}`, setup() {} };
      engine.use(plugin);
      return {
        node,
        plugin,
        materials,
        // A real materials mesh is a model with onDispose; loadOBJ ties its materials to it.
        onDispose: () => () => {},
        destroy() {
          engine.sceneOf(plugin)?.removePlugin(plugin.name);
          node.dispose();
        },
      };
    },
  },
});
const { loadOBJ } = await import('../dist/mtl.js');
const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const fetch = async () => new Response(obj);
const url = 'https://example.com/models/tri.obj';
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
}
const owned = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'loader');

test('loadOBJ started in a second scene makes its mesh there', async () => {
  const engine = await headless();
  try {
    const { scene, started } = inSecondScene(engine, () => loadOBJ(engine, url, { fetch })),
      loaded = await started;
    assert.ok(loaded.mesh.node.scene === scene, `the mesh is in scene ${loaded.mesh.node.scene.name}`);
    assert.ok(engine.sceneOf(loaded.mesh.plugin) === scene, 'the mesh plugin is not in the second scene');
    assert.equal(engine.scene.meshes.size, 0, 'a mesh landed in the default scene');
    assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
    loaded.dispose();
    assert.equal(scene.meshes.size, 0);
    assert.deepEqual(owned(scene), []);
  } finally {
    engine.dispose();
  }
});

test('a loadOBJ started outside any setup stays in the default scene', async () => {
  const engine = await headless();
  try {
    const loaded = await loadOBJ(engine, url, { fetch });
    assert.ok(loaded.mesh.node.scene === engine.scene);
    assert.ok(engine.sceneOf(loaded.mesh.plugin) === engine.scene);
    loaded.dispose();
  } finally {
    engine.dispose();
  }
});

test('an aborted loadOBJ started in a second scene leaves nothing in either scene', async () => {
  const engine = await headless();
  try {
    const controller = new AbortController(),
      { scene, started } = inSecondScene(engine, () => loadOBJ(engine, url, { fetch, signal: controller.signal }));
    controller.abort(new Error('stop'));
    await assert.rejects(started, /aborted/);
    for (const each of [scene, engine.scene]) {
      assert.equal(each.meshes.size, 0, `scene ${each.name} holds meshes`);
      assert.deepEqual(owned(each), [], `scene ${each.name} holds plugins`);
    }
  } finally {
    engine.dispose();
  }
});

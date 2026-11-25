import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGLTF, parseGLTFAsync } from '../dist/index.js';
import { textured } from '../dist/textured.js';
import { documentOf, gpuEngine, headlessEngine, withBitmaps } from './helpers.js';

// KB-OWN-GLTF1: a load started in a second scene's setup finishes after its awaits, when the default scene is active.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs = new Float32Array([0, 0, 1, 0, 0, 1]),
  png = new Uint8Array([137, 80, 78, 71]);
const plain = () =>
  documentOf([positions, normals], {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    nodes: [{ mesh: 0 }],
  });
const withTexture = () =>
  documentOf([positions, normals, uvs, png], {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
  });
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({
    name: 'loader',
    setup() {
      started = start();
    },
  });
  return { scene, started };
}
// A failed deepEqual on scenes would print the whole engine; compare identity and name the scene instead.
const inside = (mesh, scene, what) =>
  assert.ok(mesh.scene === scene, `${what} is in scene ${mesh.scene.name}, not ${scene.name}`);
const sceneOfMeshes = (scene) => [...scene.meshes.values()];
const names = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'loader');

test('parseGLTFAsync started in a second scene builds its meshes there', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = plain(),
      { scene, started } = inSecondScene(engine, () =>
        parseGLTFAsync(engine, doc, [bytes], { extensions: [{ handles: [], load: async () => {} }] }),
      );
    const model = await started;
    inside(model.meshes[0], scene, 'the mesh');
    inside(model.root, scene, 'the root');
    assert.equal(sceneOfMeshes(scene).length, 3);
    assert.equal(sceneOfMeshes(engine.scene).length, 0);
    model.dispose();
    assert.equal(sceneOfMeshes(scene).length, 0);
  } finally {
    engine.dispose();
  }
});

test('a load started in the default scene stays there and one started outside any setup too', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = plain(),
      model = await parseGLTFAsync(engine, doc, [bytes], { extensions: [{ handles: [], load: async () => {} }] });
    inside(model.root, engine.scene, 'the root');
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test("the textured draw of a load started in a second scene is that scene's plugin", async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const { doc, bytes } = withTexture(),
      { scene, started } = inSecondScene(engine, () =>
        parseGLTFAsync(engine, doc, [bytes], { extensions: [textured] }),
      ),
      model = await started;
    assert.deepEqual(names(scene), ['gltf-textured']);
    assert.deepEqual([...engine.scene.plugins.keys()], []);
    inside(model.meshes[0], scene, 'the mesh');
    // The temporary plugin that carried the build is gone, and disposing the model takes the draw with it.
    model.dispose();
    assert.deepEqual(names(scene), []);
    assert.equal(sceneOfMeshes(scene).length, 0);
  } finally {
    engine.dispose();
  }
});

test('loadGLTF started in a second scene builds there, textured draw included', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const { doc, bytes } = withTexture();
    doc.buffers[0].uri = 'm.bin';
    const get = async (url) => new Response(String(url).endsWith('.bin') ? bytes : JSON.stringify(doc)),
      { scene, started } = inSecondScene(engine, () =>
        loadGLTF(engine, 'https://example.test/m.gltf', { fetch: get, extensions: [textured] }),
      ),
      model = await started;
    inside(model.meshes[0], scene, 'the mesh');
    assert.deepEqual(names(scene), ['gltf-textured']);
    assert.equal(sceneOfMeshes(engine.scene).length, 0);
    assert.deepEqual([...engine.scene.plugins.keys()], []);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('two loads in flight in two scenes each land in their own', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = plain(),
      gate = Promise.withResolvers(),
      slow = { handles: [], load: () => gate.promise },
      first = inSecondScene(engine, () => parseGLTFAsync(engine, doc, [bytes], { extensions: [slow] })),
      other = engine.createScene('c');
    let second;
    other.use({ name: 'loader', setup: () => (second = parseGLTFAsync(engine, doc, [bytes], { extensions: [slow] })) });
    const third = parseGLTFAsync(engine, doc, [bytes], { extensions: [slow] });
    gate.resolve();
    const models = await Promise.all([first.started, second, third]);
    assert.deepEqual(
      models.map((m) => m.root.scene.name),
      [first.scene.name, other.name, engine.scene.name],
    );
    for (const model of models) model.dispose();
  } finally {
    engine.dispose();
  }
});

test('an abort mid-load leaves nothing in either scene', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const { doc, bytes } = withTexture(),
      controller = new AbortController(),
      slow = {
        handles: [],
        load: async () => {
          controller.abort();
          await Promise.resolve();
        },
      },
      { scene, started } = inSecondScene(engine, () =>
        parseGLTFAsync(engine, doc, [bytes], { extensions: [textured, slow], signal: controller.signal }),
      );
    await assert.rejects(started, { name: 'AbortError' });
    for (const where of [scene, engine.scene]) {
      assert.equal(sceneOfMeshes(where).length, 0);
      assert.deepEqual(names(where), []);
    }
  } finally {
    engine.dispose();
  }
});

test('a scene disposed during the load fails the load and leaves no mesh in the default scene', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = plain(),
      gate = Promise.withResolvers(),
      { scene, started } = inSecondScene(engine, () =>
        parseGLTFAsync(engine, doc, [bytes], { extensions: [{ handles: [], load: () => gate.promise }] }),
      );
    scene.dispose();
    gate.resolve();
    await assert.rejects(started, TypeError);
    assert.equal(sceneOfMeshes(engine.scene).length, 0);
  } finally {
    engine.dispose();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGLTF, parseGLTFAsync } from '../dist/pbr.js';
import { loadGLTFProgressive } from '../dist/progressive.js';
import { applyGLTFPhysics } from '../dist/physics.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

// KB-OWN-GLTF1: a load started in a second scene's setup finishes after its awaits, when the default scene is active.
const dataURI = (bytes) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
function embedded() {
  const { doc, buffers } = materialQuad();
  doc.buffers.forEach((def, index) => {
    const buffer = buffers[index];
    def.uri = dataURI(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  });
  return doc;
}
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
}
// A failed assertion on scenes would print the whole engine; compare identity and name the scene instead.
const inside = (mesh, scene, what) =>
  assert.ok(mesh.scene === scene, `${what} is in scene ${mesh.scene.name}, not ${scene.name}`);
const owned = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'loader');
const empty = (...scenes) => {
  for (const scene of scenes) {
    assert.equal(scene.meshes.size, 0, `scene ${scene.name} holds meshes`);
    assert.deepEqual(owned(scene), [], `scene ${scene.name} holds plugins`);
  }
};
const landed = (engine, scene, model) => {
  inside(model.root, scene, 'the root');
  for (const node of model.nodes) inside(node, scene, 'a node');
  assert.ok(engine.sceneOf(model) === scene, 'the model plugin is not in the second scene');
  assert.equal(engine.scene.meshes.size, 0, 'meshes landed in the default scene');
  assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
};
const withEngine = (run) =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      return await run(engine);
    } finally {
      engine.dispose();
    }
  });

test('parseGLTFAsync started in a second scene builds the model there (options overload)', () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () => parseGLTFAsync(engine, embedded(), {})),
      model = await started;
    landed(engine, scene, model);
    model.dispose();
    empty(scene, engine.scene);
  }));

test('parseGLTFAsync started in a second scene builds the model there (buffers overload)', () =>
  withEngine(async (engine) => {
    const { doc, buffers } = materialQuad(),
      { scene, started } = inSecondScene(engine, () => parseGLTFAsync(engine, doc, buffers)),
      model = await started;
    landed(engine, scene, model);
    model.dispose();
    empty(scene, engine.scene);
  }));

test('a parseGLTFAsync started outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    const model = await parseGLTFAsync(engine, embedded(), {});
    inside(model.root, engine.scene, 'the root');
    assert.ok(engine.sceneOf(model) === engine.scene);
    model.dispose();
  }));

test("a static batch baked after the load is a node of the model's own scene", () =>
  withEngine(async (engine) => {
    // loadGLTFProgressive bakes its batches from a frame callback, long after the load began and in whatever scene is active.
    const { scene, started } = inSecondScene(engine, () => parseGLTFAsync(engine, embedded(), {})),
      model = await started,
      node = model['batchNode']();
    inside(node, scene, 'the batch node');
    model.dispose();
    empty(scene, engine.scene);
  }));

test('loadGLTF started in a second scene builds the model there', () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () =>
        loadGLTF(engine, 'https://example.test/m.gltf', {
          fetch: async () => new Response(JSON.stringify(embedded())),
        }),
      ),
      model = await started;
    landed(engine, scene, model);
    model.dispose();
    empty(scene, engine.scene);
  }));

test('loadGLTFProgressive on its whole-file path builds the model in the scene it started in', () =>
  withEngine(async (engine) => {
    // A `fetch` option sends the load down the plain loadGLTF path, which finishes after the download.
    const { scene, started } = inSecondScene(engine, () =>
        loadGLTFProgressive(engine, 'https://example.test/m.gltf', {
          fetch: async () => new Response(JSON.stringify(embedded())),
        }),
      ),
      model = await (await started).complete;
    landed(engine, scene, model);
    model.dispose();
    empty(scene, engine.scene);
  }));

test('an abort mid-load leaves nothing in either scene', () =>
  withEngine(async (engine) => {
    const controller = new AbortController(),
      { scene, started } = inSecondScene(engine, () =>
        loadGLTF(engine, 'https://example.test/m.gltf', {
          signal: controller.signal,
          fetch: async () => {
            controller.abort();
            return new Response(JSON.stringify(embedded()));
          },
        }),
      );
    await assert.rejects(started, { name: 'AbortError' });
    empty(scene, engine.scene);
    const again = new AbortController(),
      second = inSecondScene(engine, () => {
        const load = parseGLTFAsync(engine, embedded(), { signal: again.signal });
        again.abort();
        return load;
      });
    await assert.rejects(second.started, { name: 'AbortError' });
    empty(second.scene, engine.scene);
  }));

test('the splat clouds of a file are made in the scene the load started in', () =>
  withEngine(async (engine) => {
    const { GLTFAsset } = await import('../dist/pbr.js'),
      { gaussianSplats } = await import('../dist/splats.js'),
      NAME = 'KHR_gaussian_splatting',
      data = [
        [new Float32Array([1, 2, 3]), 'VEC3'],
        [new Float32Array([0, 0, 0, 1]), 'VEC4'],
        [new Float32Array([1, 1, 1]), 'VEC3'],
        [new Float32Array([0.5]), 'SCALAR'],
        [new Float32Array([0, 0, 0]), 'VEC3'],
      ],
      names = ['POSITION', `${NAME}:ROTATION`, `${NAME}:SCALE`, `${NAME}:OPACITY`, `${NAME}:SH_DEGREE_0_COEF_0`],
      width = { SCALAR: 1, VEC3: 3, VEC4: 4 },
      bytes = new Uint8Array(data.reduce((sum, [array]) => sum + array.byteLength, 0)),
      views = [];
    let offset = 0;
    data.forEach(([array], i) => {
      bytes.set(new Uint8Array(array.buffer), offset);
      views.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength });
      offset += array.byteLength;
    });
    const doc = {
        asset: { version: '2.0' },
        extensionsUsed: [NAME],
        buffers: [{ byteLength: bytes.length }],
        bufferViews: views,
        accessors: data.map(([array, type], i) => ({
          bufferView: i,
          componentType: 5126,
          count: array.length / width[type],
          type,
        })),
        meshes: [
          {
            primitives: [
              {
                attributes: Object.fromEntries(names.map((name, i) => [name, i])),
                mode: 0,
                extensions: { [NAME]: { kernel: 'ellipse', colorSpace: 'srgb_rec709_display' } },
              },
            ],
          },
        ],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
      },
      asset = new GLTFAsset(doc, [bytes], undefined, { splats: gaussianSplats }),
      identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // The clouds' own setup needs a GPU; what is under test is the scene each `engine.use` is called in.
    const placed = [],
      use = engine.use;
    engine.use = function (plugin, scene) {
      if (plugin.name?.startsWith('scene-scope:') || plugin.name === 'loader') return use.call(this, plugin, scene);
      placed.push(this.plugins);
      return this;
    };
    const { scene, started } = inSecondScene(engine, () =>
        gaussianSplats.attach(engine, asset, [{ primitive: doc.meshes[0].primitives[0], matrix: identity }]),
      ),
      clouds = await started;
    assert.equal(clouds.length, 1);
    assert.equal(placed.length, 1);
    assert.ok(placed[0] === scene.plugins, 'the cloud was added to the default scene');
    for (const { cloud } of clouds) cloud.dispose();
  }));

// KB-OWN-BLEND2: applyGLTFPhysics made its world with World.attach(engine) after `await import` and the solver load, so
// the physics plugin went into whatever scene was active then (the default one), not the model's scene.
test("applyGLTFPhysics attaches its world in the model's scene, after its awaits", () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () => parseGLTFAsync(engine, embedded(), {})),
      model = await started,
      gltf = await applyGLTFPhysics(model);
    assert.ok(engine.sceneOf(gltf.physics) === scene, 'the physics world is not in the model scene');
    assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
    gltf.dispose();
    model.dispose();
    empty(scene, engine.scene);
  }));

test('applyGLTFPhysics started in a second scene for a model there attaches its world there', () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () => parseGLTFAsync(engine, embedded(), {})),
      model = await started;
    let applying;
    scene.use({ name: 'physics-loader', setup: () => (applying = applyGLTFPhysics(model)) });
    scene.removePlugin('physics-loader');
    const gltf = await applying;
    assert.ok(engine.sceneOf(gltf.physics) === scene, 'the physics world is not in the model scene');
    assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
    gltf.dispose();
    model.dispose();
    empty(scene, engine.scene);
  }));

test('applyGLTFPhysics for a model in the default scene keeps its world there', () =>
  withEngine(async (engine) => {
    const model = await parseGLTFAsync(engine, embedded(), {}),
      gltf = await applyGLTFPhysics(model);
    assert.ok(engine.sceneOf(gltf.physics) === engine.scene);
    gltf.dispose();
    model.dispose();
  }));

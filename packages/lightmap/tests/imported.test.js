import test from 'node:test';
import assert from 'node:assert/strict';
import { readLightmap, applyLightmap, ImportedLightmapInstallation } from '../dist/imported.js';
test('external bakes keep linear HDR scale and copy pixels', () => {
  const data = new Uint8Array([128, 64, 32, 255]);
  const map = readLightmap({ width: 1, height: 1, data, scale: 12 });
  data[0] = 0;
  assert.equal(map.data[0], 128);
  assert.equal(map.scale, 12);
  assert.equal(readLightmap({ width: 1, height: 1, data }).scale, 1);
  assert.equal(typeof applyLightmap, 'function');
  assert.equal(typeof ImportedLightmapInstallation, 'function');
});
test('invalid external irradiance fails before GPU work', () => {
  const input = { width: 1, height: 1, data: new Uint8Array(4) };
  for (const scale of [0, -1, NaN, Infinity, 1e21]) assert.throws(() => readLightmap({ ...input, scale }), RangeError);
  for (const width of [0, 1.5, 4097, NaN]) assert.throws(() => readLightmap({ ...input, width }), RangeError);
  assert.throws(() => readLightmap({ ...input, data: new Uint8Array(3) }), RangeError);
});

test('attach applies a bake through the model engine and restores it on disposal', () => {
  const primitive = { material: {}, definition: { attributes: { TEXCOORD_1: 1 } }, nodeIndex: 0 };
  const plugins = new Map(),
    engine = {
      use(plugin) {
        plugins.set(plugin.name, plugin);
      },
      removePlugin(name) {
        plugins.delete(name);
      },
      sceneOf(plugin) {
        return plugins.get(plugin.name) === plugin ? this : undefined;
      },
    };
  const model = { root: { engine }, primitives: [primitive], nodes: [{}] };
  const lightmap = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]), scale: 1 };
  const installation = ImportedLightmapInstallation.attach(model, lightmap, [0]);
  assert.equal(plugins.get(installation.name), installation);
  assert.deepEqual(installation.lightmap.data, lightmap.data);
  installation.dispose();
  assert.equal(plugins.size, 0);
  assert.equal(primitive.extension, undefined);
  const failure = new Error('registration failed');
  engine.use = () => {
    throw failure;
  };
  assert.throws(
    () => ImportedLightmapInstallation.attach(model, lightmap),
    (e) => e === failure,
  );
});

// Batch 132 audit: the engine's removePlugin acts on the active scene. An installation attached while another scene
// was active must leave its own scene, and must not remove the active scene's same-name plugin.
test('dispose removes the installation from its own scene, not the active scene', () => {
  const primitive = { material: {}, definition: { attributes: { TEXCOORD_1: 1 } }, nodeIndex: 0 };
  const calls = [];
  let installed;
  const own = { removePlugin: (name) => calls.push(['own scene', name]) };
  const engine = {
    use(plugin) {
      installed = plugin;
    },
    removePlugin: (name) => calls.push(['active scene', name]),
    sceneOf: (plugin) => (plugin === installed ? own : undefined),
  };
  const model = { root: { engine }, primitives: [primitive], nodes: [{}] };
  const lightmap = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]), scale: 1 };
  const installation = ImportedLightmapInstallation.attach(model, lightmap, [0]);
  installation.dispose();
  assert.deepEqual(calls, [['own scene', installation.name]]);
});

// KB-OWN-LIGHTMAP2: engine.use joins the active scene. A bake applied to a model of another scene (or after an await,
// once another scene is active) must install in the model's scene, and leave the active scene's plugins alone.
test('applyLightmap installs in the model scene, not the active scene', () => {
  const primitive = { material: {}, definition: { attributes: { TEXCOORD_1: 1 } }, nodeIndex: 0 };
  let active;
  const scene = (label) => ({
    label,
    plugins: new Map(),
    use(plugin) {
      const previous = active;
      active = this;
      this.plugins.set(plugin.name, plugin);
      try {
        // The stand-in runs only the scope's setup: the installation's own setup needs a GPU.
        if (plugin.name.startsWith('scene-scope:')) plugin.setup();
      } finally {
        active = previous;
      }
    },
    removePlugin(name) {
      this.plugins.delete(name);
    },
  });
  const modelScene = scene('model'),
    other = scene('active');
  const engine = {
    plugins: new Map(),
    use: (plugin) => active.use(plugin),
    removePlugin: (name) => active.removePlugin(name),
    sceneOf: (plugin) => [modelScene, other].find((s) => s.plugins.get(plugin.name) === plugin),
  };
  const model = { name: 'model', root: { engine }, primitives: [primitive], nodes: [{}] };
  modelScene.plugins.set(model.name, model);
  active = other;
  const installation = applyLightmap(model, { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }, [0]);
  assert.equal(engine.sceneOf(installation), modelScene);
  assert.equal(other.plugins.size, 0);
  assert.equal(active, other);
  installation.dispose();
  assert.deepEqual([...modelScene.plugins.keys()], ['model']);
});

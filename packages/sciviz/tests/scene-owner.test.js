import assert from 'node:assert/strict';
import test from 'node:test';
import { inSceneOf } from '../src/scene-owner.ts';
import { VolumeDepthCapture } from '../src/volume-depth.ts';

// An engine with two scenes: `use(plugin, scene)` runs setup with that scene active, as core does.
function sceneEngine() {
  const own = { name: 'default', plugins: new Map() },
    other = { name: 'other', plugins: new Map() },
    engine = {
      scene: own,
      active: own,
      backend: 'webgpu',
      gpu: {},
      owners: new Map(),
      sceneOf: (plugin) => engine.owners.get(plugin),
      use(plugin, scene = engine.active) {
        const outer = engine.active;
        engine.active = scene;
        scene.plugins.set(plugin.name, plugin);
        engine.owners.set(plugin, scene);
        try {
          plugin.setup(engine);
          plugin.registerPasses?.({ add() {} });
        } finally {
          engine.active = outer;
        }
      },
      removePlugin(name, scene = engine.active) {
        const plugin = scene.plugins.get(name);
        scene.plugins.delete(name);
        if (plugin) engine.owners.delete(plugin);
        plugin?.dispose?.();
      },
    };
  return { engine, own, other };
}

test('inSceneOf makes a plugin in the scene its owner lives in, not the active one', () => {
  const { engine, own, other } = sceneEngine();
  const owner = { name: 'owner', setup() {} };
  engine.use(owner, other);
  const made = inSceneOf(engine, owner, () => {
    const plugin = { name: 'made', setup() {} };
    engine.use(plugin);
    return plugin;
  });
  assert.equal(engine.sceneOf(made), other, 'the plugin joined the owner scene');
  assert.ok(!own.plugins.has('made'), 'and not the engine scene');
  assert.deepEqual([...other.plugins.keys()], ['owner', 'made'], 'the short-lived scope plugin is gone again');
});

test('inSceneOf just runs the function in the engine scene, or on an engine with no scenes', () => {
  const { engine, own } = sceneEngine();
  const owner = { name: 'owner', setup() {} };
  engine.use(owner, own);
  assert.equal(
    inSceneOf(engine, owner, () => 7),
    7,
  );
  assert.deepEqual([...own.plugins.keys()], ['owner']);
  assert.equal(
    inSceneOf({ use() {} }, owner, () => 8),
    8,
  );
});

test('a depth capture is made per scene and taken out of its scene once no layer uses it', () => {
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const { engine, other } = sceneEngine();
  const owner = { name: 'owner', setup() {} };
  engine.use(owner, other);
  try {
    const attach = () => inSceneOf(engine, owner, () => VolumeDepthCapture.attach(engine, owner));
    const capture = attach();
    assert.equal(engine.sceneOf(capture), other, 'the capture joined the owner scene');
    assert.equal(attach(), capture, 'a second layer in the scene shares it');
    capture.members.add({ visible: true });
    VolumeDepthCapture.release(engine, capture);
    assert.equal(engine.sceneOf(capture), other, 'a capture a layer still uses stays');
    capture.members.clear();
    VolumeDepthCapture.release(engine, capture);
    assert.equal(engine.sceneOf(capture), undefined, 'an idle capture leaves its scene');
    const next = attach();
    assert.notEqual(next, capture, 'the next layer makes a new one');
    assert.equal(engine.sceneOf(next), other);
  } finally {
    globalThis.GPUTextureUsage = usage;
  }
});

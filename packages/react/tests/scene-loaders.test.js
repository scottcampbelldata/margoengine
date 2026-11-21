import { assertCore, coreRequirement } from '../../core/dist/version.js';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode, Suspense } from 'react';

const engines = [],
  models = [],
  requests = [],
  worlds = [];
let deferred = false;
// A named <Scene>'s world: its plugins' setup runs while it is the active scene, as core's scene plugins do.
let active = null;
function world(engine, name) {
  const scene = {
    name,
    engine,
    plugins: new Map(),
    background: null,
    disposed: false,
    use(plugin) {
      this.plugins.set(plugin.name, plugin);
      const outer = active;
      active = this;
      try {
        plugin.setup?.(engine);
      } finally {
        active = outer;
      }
      return this;
    },
    removePlugin(key) {
      const plugin = this.plugins.get(key);
      this.plugins.delete(key);
      plugin?.dispose?.();
    },
    dispose() {
      this.disposed = true;
      for (const key of [...this.plugins.keys()]) this.removePlugin(key);
    },
  };
  worlds.push(scene);
  return scene;
}
function mesh(engine) {
  const node = {
    engine,
    id: engine.next++,
    visible: true,
    setPosition(v) {
      this.position = [...v];
      return this;
    },
    setRotation(v) {
      this.rotation = [...v];
      return this;
    },
    setScale(v) {
      this.scale = [...v];
      return this;
    },
    setParent(parent) {
      this.parent = parent;
      return this;
    },
    dispose() {
      engine.meshes.delete(this.id);
    },
  };
  engine.meshes.set(node.id, node);
  return node;
}
mock.module('@margoengine/core/extension', {
  namedExports: {
    assertCore,
    coreRequirement,
    Engine: {
      async create(canvas) {
        const engine = {
          canvas,
          next: 0,
          meshes: new Map(),
          plugins: new Map(),
          callbacks: new Set(),
          camera: {},
          disposed: false,
          start() {},
          onFrame(callback) {
            this.callbacks.add(callback);
            return () => this.callbacks.delete(callback);
          },
          use(plugin) {
            // Inside a scene's setup, core adds the plugin to that scene.
            if (active) return active.use(plugin);
            assert.ok(!this.plugins.has(plugin.name));
            this.plugins.set(plugin.name, plugin);
            return this;
          },
          removePlugin(name) {
            const plugin = this.plugins.get(name);
            this.plugins.delete(name);
            plugin?.dispose();
          },
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            for (const name of this.plugins.keys()) this.removePlugin(name);
            this.callbacks.clear();
          },
          createMesh() {
            return mesh(this);
          },
          createScene(name) {
            return world(this, name);
          },
        };
        engines.push(engine);
        return engine;
      },
    },
    Mesh: class {},
    PbrMaterial: class {},
    box() {},
    engineRuntime: (engine) => engine,
    meshRuntime: (node) => node,
  },
});
function model(engine, asset = { doc: { images: [] } }) {
  const result = {
    name: 'loader:' + models.length,
    asset,
    // The scene the model was built in (null: the default scene), as core's meshes and plugins are.
    scene: active,
    root: mesh(engine),
    nodes: [],
    primitives: [],
    disposed: false,
    disposals: 0,
    addLighting() {
      return () => {};
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.disposals++;
      (this.scene ?? engine).removePlugin(this.name);
      this.root.dispose();
    },
  };
  models.push(result);
  return result;
}
async function load(kind, engine, src, { signal }) {
  const request = { kind, engine, src, signal };
  requests.push(request);
  if (deferred) await new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
  const result = model(engine);
  engine.use(result);
  return result;
}
mock.module('@margoengine/gltf/pbr', {
  namedExports: {
    PBRModel: class {
      constructor(engine, asset) {
        return model(engine, asset);
      }
    },
    loadGLTF: (...args) => load('gltf', ...args),
  },
});
mock.module('@margoengine/fbx', { namedExports: { loadFBX: (...args) => load('fbx', ...args) } });
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const { render, act, cleanup } = await import('@testing-library/react');
const { Canvas } = await import('@margoengine/react');
const { Fbx } = await import('@margoengine/react/fbx');
const { Gltf, Model } = await import('@margoengine/react/gltf');
const tree = (child) =>
  React.createElement(
    StrictMode,
    null,
    React.createElement(
      Canvas,
      null,
      React.createElement(Suspense, { fallback: React.createElement('p', null, 'Loading') }, child),
    ),
  );
const flush = () => act(async () => {});
afterEach(async () => {
  cleanup();
  deferred = false;
  for (const request of requests) request.resolve?.();
  await flush();
  assert.ok(models.every((value) => value.disposals === 1));
  assert.ok(engines.every((value) => value.disposed && value.meshes.size === 0 && value.plugins.size === 0));
  assert.ok(worlds.every((value) => value.disposed && value.plugins.size === 0));
});

test('instantiateModel builds the model and its draw plugin in the scene it is given', async () => {
  const { instantiateModel } = await import('../dist/model-assets.js');
  const engine = {
    next: 0,
    meshes: new Map(),
    plugins: new Map(),
    createMesh() {
      return mesh(this);
    },
    use(plugin) {
      if (active) return active.use(plugin);
      this.plugins.set(plugin.name, plugin);
      return this;
    },
    removePlugin(name) {
      const plugin = this.plugins.get(name);
      this.plugins.delete(name);
      plugin?.dispose?.();
    },
  };
  const PBRModel = class {
    constructor(engine, asset) {
      return model(engine, asset);
    }
  };
  const source = () => ({ api: { PBRModel }, asset: { doc: { images: [] } }, images: [], first: null });
  const scene = world(engine, 'item');
  const inScene = await instantiateModel(source(), engine, scene);
  assert.equal(inScene.scene, scene, 'created while the named scene is active');
  assert.deepEqual([...scene.plugins.values()], [inScene], 'its draw plugin joins the named scene');
  assert.equal(engine.plugins.size, 0, 'nothing reaches the default scene');
  const atDefault = await instantiateModel(source(), engine);
  assert.equal(atDefault.scene, null, 'no scene given: the default scene');
  assert.deepEqual([...engine.plugins.values()], [atDefault]);
  // A first model built in the default scene cannot serve a named scene: it is disposed and a new one is built.
  const first = model(engine, { doc: { images: [] } });
  engine.use(first);
  const replaced = await instantiateModel({ ...source(), first }, engine, scene);
  assert.equal(first.disposals, 1, 'the default-scene first model is disposed');
  assert.equal(replaced.scene, scene);
  inScene.dispose();
  replaced.dispose();
  atDefault.dispose();
  scene.dispose();
});

test('Gltf keeps the existing Model identity and native FBX loader suspends once in StrictMode', async () => {
  assert.equal(Gltf, Model);
  deferred = true;
  const before = requests.length,
    loaded = [];
  const view = render(
    tree(React.createElement(Fbx, { src: '/character.fbx', position: [1, 2, 3], onLoad: (node) => loaded.push(node) })),
  );
  await flush();
  assert.equal(view.getByText('Loading').tagName, 'P');
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).kind, 'fbx');
  await act(async () => requests.at(-1).resolve());
  await flush();
  assert.equal(view.queryByText('Loading'), null);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].position, [1, 2, 3]);
});
test('an empty Model still completes its load callback with the transformed root', async () => {
  const loaded = [];
  render(
    tree(
      React.createElement(Model, { src: '/empty-audit.glb', position: [2, 3, 4], onLoad: (node) => loaded.push(node) }),
    ),
  );
  await flush();
  assert.equal(models.at(-1).primitives.length, 0);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0], models.at(-1).root);
  assert.deepEqual(loaded[0].position, [2, 3, 4]);
});

test('FBX preload and independent remounts share the native URL cache', async () => {
  const before = requests.length;
  const view = render(tree(null));
  await flush();
  await act(async () => Fbx.preload('/preloaded.FBX?version=1'));
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).kind, 'fbx');
  assert.ok(models.at(-1).disposed, 'preloading must not display an attached model');
  view.rerender(tree(React.createElement(Fbx, { src: '/preloaded.FBX?version=1', position: [4, 0, 0] })));
  await flush();
  const first = models.at(-1);
  assert.deepEqual(first.root.position, [4, 0, 0]);
  view.rerender(tree(null));
  await flush();
  assert.equal(first.disposals, 1);
  view.rerender(tree(React.createElement(Fbx, { src: '/preloaded.FBX?version=1', position: [5, 0, 0] })));
  await flush();
  assert.notEqual(models.at(-1), first);
  assert.deepEqual(models.at(-1).root.position, [5, 0, 0]);
  assert.equal(requests.length, before + 1);
});
test('removing a pending FBX aborts without notifying onLoad and disposes a late model', async () => {
  deferred = true;
  let loaded = 0;
  const view = render(tree(React.createElement(Fbx, { src: '/aborted.fbx', onLoad: () => loaded++ })));
  await flush();
  const request = requests.at(-1);
  view.rerender(tree(null));
  await flush();
  assert.equal(request.signal.aborted, true);
  await act(async () => request.resolve());
  assert.equal(loaded, 0);
  assert.equal(models.at(-1).disposals, 1);
});
test('FBX load errors report through both component and Canvas callbacks without a retry loop', async () => {
  deferred = true;
  const errors = [],
    failure = new Error('Invalid native FBX');
  const view = render(
    React.createElement(
      Canvas,
      { onError: (error) => errors.push(error) },
      React.createElement(
        Suspense,
        { fallback: 'Loading' },
        React.createElement(Fbx, { src: '/invalid.fbx', onError: (error) => errors.push(error) }),
      ),
    ),
  );
  await flush();
  await act(async () => requests.at(-1).reject(failure));
  await flush();
  assert.deepEqual(errors, [failure, failure]);
  assert.match(view.getByRole('alert').textContent, /Invalid native FBX/);
});

test('Shadows inside a named <Scene> shadow that scene, apart from the Canvas shadows, and leave with it', async () => {
  const made = [];
  mock.module('@margoengine/shadows', {
    namedExports: {
      Shadows: class {
        static attach(engine) {
          const effect = new this();
          effect.owner = engine;
          effect.name = 'shadows:' + made.length;
          effect.options = {};
          effect.disposed = false;
          engine.use(effect);
          made.push(effect);
          return effect;
        }
        dispose() {
          this.disposed = true;
        }
      },
    },
  });
  const { Scene } = await import('@margoengine/react');
  const { Shadows } = await import('@margoengine/react/shadows');
  const view = render(
    React.createElement(
      StrictMode,
      null,
      React.createElement(
        Canvas,
        null,
        React.createElement(Scene, { name: 'item' }, React.createElement(Shadows, { mapSize: 512 })),
      ),
    ),
  );
  await flush();
  await flush();
  const engine = engines.at(-1),
    item = worlds.findLast((value) => value.name === 'item');
  assert.equal(made.length, 1, 'one shadows, for the Scene alone');
  assert.ok(item.plugins.get(made[0].name) === made[0], 'the shadows are in the named scene');
  assert.ok(!engine.plugins.has(made[0].name), 'the default scene does not hold them');
  assert.equal(made[0].options.mapSize, 512, 'its options apply');
  view.unmount();
  await flush();
  assert.equal(made[0].disposed, true, 'unmount disposes them');
});

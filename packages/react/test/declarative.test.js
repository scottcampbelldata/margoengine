import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';

const engines = [],
  models = [],
  environments = [],
  backgrounds = [],
  controls = [],
  shadows = [],
  requests = [],
  imageRequests = [],
  observers = [];
let deferModel = false,
  deferEnvironment = false,
  modelFailure = null;
const pendingModels = [],
  pendingEnvironments = [];
function resource() {
  return {
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  };
}
function mesh(engine) {
  const node = {
    engine,
    id: engine.next++,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    disposed: false,
    setPosition(value) {
      this.position = [...value];
      return this;
    },
    setRotation(value) {
      this.rotation = [...value];
      return this;
    },
    setScale(value) {
      if (value.includes(0)) throw new RangeError('Scale must be nonzero');
      this.scale = [...value];
      return this;
    },
    setParent(parent) {
      this.parent = parent;
      return this;
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      engine.meshes.delete(this.id);
    },
  };
  engine.meshes.set(node.id, node);
  return node;
}
mock.module('@margoengine/core/extension', {
  namedExports: {
    Engine: {
      async create(canvas, options) {
        const engine = {
          canvas,
          options,
          next: 0,
          meshes: new Map(),
          plugins: new Map(),
          callbacks: new Set(),
          errors: [],
          disposed: false,
          disposals: 0,
          camera: { position: [0, 2, 5], target: [0, 0, 0], fov: 60, ...options.camera },
          lighting: { direction: new Float32Array([1, 2, 3, 2]), radiance: new Float32Array([0.8, 0.7, 0.6, 0.2]) },
          createMesh() {
            return mesh(this);
          },
          // Core's scenes: their meshes live in the engine-wide map, each knowing its scene.
          scenes: [],
          createScene(name) {
            const engine = this,
              scene = {
                name,
                disposed: false,
                createMesh() {
                  const node = mesh(engine);
                  node.scene = scene;
                  return node;
                },
                dispose() {
                  scene.disposed = true;
                  for (const node of [...engine.meshes.values()]) if (node.scene === scene) node.dispose();
                },
              };
            this.scenes.push(scene);
            return scene;
          },
          start() {
            this.started = true;
          },
          use(plugin) {
            assert.ok(!this.disposed);
            assert.ok(!this.plugins.has(plugin.name));
            plugin.setup?.(this);
            this.plugins.set(plugin.name, plugin);
            return this;
          },
          removePlugin(name) {
            const plugin = this.plugins.get(name);
            this.plugins.delete(name);
            plugin?.dispose?.();
          },
          hasPlugin(name) {
            return this.plugins.has(name);
          },
          onFrame(callback) {
            this.callbacks.add(callback);
            return () => this.callbacks.delete(callback);
          },
          dispose() {
            if (this.disposed) return;
            this.disposals++;
            this.disposed = true;
            for (const name of this.plugins.keys()) this.removePlugin(name);
            for (const node of this.meshes.values()) node.dispose();
            this.callbacks.clear();
          },
        };
        engines.push(engine);
        return engine;
      },
    },
    Mesh: class {},
    box() {},
    PbrMaterial: class {},
    engineRuntime: (engine) => engine,
    meshRuntime: (node) => node,
  },
});
function makeModel(engine, asset = { doc: { images: [] } }) {
  const material = {
    name: 'Upper',
    base: [1, 0.5, 0.25, 0.8],
    factors: [0.6, 0.4, 1, 1],
    emission: [0, 0, 0],
    settings: [0, 0.5, 0, 0],
    maps: [],
  };
  const model = {
    name: 'model:' + models.length,
    asset,
    root: mesh(engine),
    nodes: [mesh(engine)],
    primitives: [{ material }, { material }],
    lighting: new Set(),
    disposed: false,
    disposals: 0,
    buffers: [resource(), resource()],
    textures: [resource()],
    addLighting(effect) {
      assert.ok(!this.disposed);
      this.lighting.add(effect);
      return () => this.lighting.delete(effect);
    },
    get shadowPrimitives() {
      return [];
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.disposals++;
      engine.removePlugin(this.name);
      this.lighting.clear();
      this.root.dispose();
      for (const node of this.nodes) node.dispose();
      for (const owned of [...this.buffers, ...this.textures]) owned.destroy();
    },
  };
  models.push(model);
  return model;
}
mock.module('@margoengine/gltf-pro', {
  namedExports: {
    PBRModel: class {
      constructor(engine, asset) {
        return makeModel(engine, asset);
      }
    },
    async loadGLTF(engine, src, { signal }) {
      requests.push({ src, signal });
      if (modelFailure) throw modelFailure;
      const model = makeModel(engine);
      engine.use(model);
      if (deferModel) await new Promise((resolve) => pendingModels.push(resolve));
      return model;
    },
  },
});
mock.module('@margoengine/environment', {
  namedExports: {
    async loadEnvironmentImage(src, { signal }) {
      imageRequests.push({ src, signal });
      return {};
    },
    Environment: {
      async create(engine) {
        const environment = {
          name: 'environment',
          intensity: 1,
          disposed: false,
          disposals: 0,
          version: 0,
          listeners: new Set(),
          buffers: [resource(), resource()],
          textures: [resource(), resource(), resource()],
          onChange(callback) {
            this.listeners.add(callback);
            return () => this.listeners.delete(callback);
          },
          restore() {
            this.version++;
            for (const callback of this.listeners) callback(this);
          },
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.disposals++;
            for (const owned of [...this.buffers, ...this.textures]) owned.destroy();
            this.listeners.clear();
          },
        };
        environments.push(environment);
        if (deferEnvironment) await new Promise((resolve) => pendingEnvironments.push(resolve));
        return environment;
      },
    },
    EnvironmentBackground: class {
      constructor(environment) {
        this.name = 'environment:background';
        this.environment = environment;
        this.exposure = 1;
        this.buffer = resource();
        backgrounds.push(this);
      }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.buffer.destroy();
      }
    },
    IBL_WGSL: 'fn iblShade() {}',
    iblBindGroupEntries: (environment) =>
      [4, 5, 6, 7, 8].map((binding) => ({ binding, resource: { version: environment.version } })),
    // EnvironmentLighting's contract: a plugin and a gltf-pro lighting effect whose bindings follow the environment's
    // version, whose shader() patches the PBR source, and whose dispose() detaches it.
    EnvironmentLighting: class {
      constructor(environment) {
        this.name = 'environment:lighting';
        this.environment = environment;
        this.disposed = false;
        this.version = -1;
        this.disposals = 0;
      }
      setup(engine) {
        this.engine = engine;
      }
      bindings() {
        if (this.disposed) return [];
        if (this.version !== this.environment.version) {
          this.cached = [4, 5, 6, 7, 8].map((binding) => ({
            binding,
            resource: { version: this.environment.version },
          }));
          this.version = this.environment.version;
        }
        return this.cached;
      }
      shader(source) {
        return 'fn iblShade() {}\n' + source.replace('+s.emissive;', '+s.emissive+iblShade();');
      }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.disposals++;
        if (this.engine?.plugins.has(this.name)) this.engine.removePlugin(this.name);
      }
    },
  },
});
// The real controls' shape: defaults (a prop removed again restores them), events, profiles and key listening.
class MockControls {
  enabled = true;
  autoRotate = false;
  autoRotateSpeed = 2;
  enableDamping = false;
  minDistance = 0;
  maxDistance = Infinity;
  zoomToCursor = false;
  listeners = new Map();
  profile = null;
  keyTarget = null;
  addEventListener(type, listener) {
    this.listeners.set(listener, type);
  }
  removeEventListener(_type, listener) {
    this.listeners.delete(listener);
  }
  emit(type) {
    for (const [listener, kind] of this.listeners) if (kind === type) listener({ type, target: this });
  }
  constructor(camera, canvas, options) {
    this.camera = camera;
    this.canvas = canvas;
    this.options = options;
    this.updates = [];
    this.listener = () => {};
    canvas.addEventListener('pointerdown', this.listener);
    this.disposals = 0;
    controls.push(this);
  }
  setProfile(profile) {
    this.profile = profile;
    this.zoomToCursor = profile.zoomToCursor;
    return this;
  }
  listenToKeyEvents(target) {
    this.keyTarget = target;
  }
  stopListenToKeyEvents() {
    this.keyTarget = null;
  }
  update(delta) {
    this.updates.push(delta);
  }
  dispose() {
    if (this.disposals) return;
    this.disposals++;
    this.canvas.removeEventListener('pointerdown', this.listener);
  }
}
const profiles = {
  margo: { name: 'margo', zoomToCursor: false },
  solidworks: { name: 'solidworks', zoomToCursor: true },
};
mock.module('@margoengine/controls', {
  namedExports: {
    OrbitControls: class OrbitControls extends MockControls {},
    MapControls: class MapControls extends MockControls {},
    ArcballControls: class ArcballControls extends MockControls {
      minZoom = 0;
      maxZoom = Infinity;
    },
    PROFILES: profiles,
  },
});
mock.module('@margoengine/cameras/layers', {
  namedExports: {
    setRenderLayers(node, mask) {
      node.layers = mask;
    },
  },
});
mock.module('@margoengine/shadows', {
  namedExports: {
    Shadows: class {
      static attach(engine) {
        const effect = new this();
        effect.owner = engine;
        effect.name = 'shadows';
        effect.sources = new Set();
        effect.buffer = resource();
        effect.texture = resource();
        effect.disposals = 0;
        engine.use(effect);
        shadows.push(effect);
        return effect;
      }
      options = {};
      add(source, options = {}) {
        this.sources.add(source);
        this.added = { source, options };
        return () => this.sources.delete(source);
      }
      bindings() {
        return [1, 2, 3].map((binding) => ({ binding, resource: {} }));
      }
      shader(source) {
        const result = source.replace('direct+ambient(s)', 'direct*shadowVisibility(i.position,s.n)+ambient(s)');
        assert.notEqual(result, source);
        return result;
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.owner.removePlugin(this.name);
        this.sources.clear();
        this.buffer.destroy();
        this.texture.destroy();
      }
    },
  },
});
const {
  MargoCanvas,
  Model,
  Environment,
  OrbitControls,
  MapControls,
  CadControls,
  ArcballControls,
  Shadows,
  Mesh,
  useMargo,
  useMargoStage,
  useFrame,
  useEngine,
  useCamera,
  useLoader,
  useProgress,
  Scene,
  RenderView,
} = await import('../dist/index.js');
test('SSR skips all optional resources and hooks reject missing canvas providers', () => {
  const result = renderToString(
    React.createElement(
      MargoCanvas,
      null,
      React.createElement(Model, { src: '/model.glb' }),
      React.createElement(Environment, { src: '/studio.hdr' }),
      React.createElement(OrbitControls),
    ),
  );
  assert.match(result, /aria-label/);
  assert.equal(engines.length, 0);
  assert.equal(requests.length, 0);
  function Outside() {
    useMargo();
    return null;
  }
  assert.throws(() => renderToString(React.createElement(Outside)), {
    code: 'state',
    message: /requires <MargoCanvas>/,
  });
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(canvas) {
    this.canvas = canvas;
  }
  disconnect() {
    this.disconnected = true;
  }
};
const { render, act, cleanup } = await import('@testing-library/react');
const flush = () => act(async () => {});
function tree(children, props = {}) {
  return React.createElement(StrictMode, null, React.createElement(MargoCanvas, props, children));
}
afterEach(async () => {
  cleanup();
  deferModel = deferEnvironment = false;
  modelFailure = null;
  for (const finish of pendingModels.splice(0)) finish();
  for (const finish of pendingEnvironments.splice(0)) finish();
  await flush();
  assert.ok(
    engines.every(
      (engine) =>
        engine.disposed &&
        engine.disposals === 1 &&
        engine.callbacks.size === 0 &&
        engine.meshes.size === 0 &&
        engine.plugins.size === 0,
    ),
  );
  for (const owned of [...models, ...environments]) {
    assert.equal(owned.disposals, 1);
    for (const value of [...owned.buffers, ...owned.textures]) assert.equal(value.destroyed, 1);
  }
  assert.ok(backgrounds.every((background) => background.disposed && background.buffer.destroyed === 1));
  assert.ok(controls.every((control) => control.disposals === 1));
  assert.ok(observers.every((observer) => observer.disconnected));
});
test('StrictMode provides the Stage facade, preserves the imperative hook and forwards delta unchanged', async () => {
  let context, kernel, created, delta;
  function Child() {
    context = useMargo();
    kernel = useMargoStage();
    useFrame((engine, value) => {
      assert.equal(engine, kernel);
      delta = value;
    });
    return null;
  }
  const view = render(
    tree(React.createElement(Child), {
      camera: { position: [1, 2, 6], fov: 42 },
      onCreated: (stage) => {
        created = stage;
        assert.deepEqual(stage.engine.camera.position, [1, 2, 6]);
      },
    }),
  );
  await flush();
  const engine = engines.at(-1),
    callback = engine.callbacks.values().next().value;
  assert.equal(context.stage, created);
  assert.equal(context.stage.engine, kernel);
  assert.equal(context.canvas, engine.canvas);
  assert.equal(context.ready, true);
  assert.equal(engine.callbacks.size, 1);
  for (let i = 0; i < 100; i++) callback(engine, 0.0125);
  assert.equal(delta, 0.0125);
  assert.equal(engine.callbacks.values().next().value, callback);
  view.rerender(tree(React.createElement(Child), { camera: { position: [2, 3, 7], target: [1, 0, 0], fov: 35 } }));
  assert.equal(engines.at(-1), engine);
  assert.deepEqual(engine.camera.position, [2, 3, 7]);
  assert.equal(engine.camera.fov, 35);
  view.unmount();
  assert.equal(created.engine.disposals, 1);
});
test('Model prop mutations preserve the load, synchronize transforms and restore removed material overrides', async () => {
  const before = requests.length,
    loaded = [];
  const child = (props) => React.createElement(Model, { src: '/a.glb', onLoad: (node) => loaded.push(node), ...props });
  const view = render(
    tree(child({ position: [1, 2, 3], materials: { Upper: { baseColor: [0.2, 0.3, 0.4], roughness: 0.2 } } })),
  );
  await flush();
  const model = models.at(-1),
    material = model.primitives[0].material;
  assert.equal(requests.length, before + 1);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0], model.root);
  assert.deepEqual(model.root.position, [1, 2, 3]);
  assert.deepEqual(material.base, [0.2, 0.3, 0.4, 0.8]);
  view.rerender(
    tree(
      child({
        position: [4, 5, 6],
        rotation: [0.1, 0.2, 0.3],
        scale: [2, 3, 4],
        materials: { Upper: { metalness: 0.9, emissive: [0.1, 0, 0], doubleSided: true } },
      }),
    ),
  );
  assert.equal(requests.length, before + 1);
  assert.equal(models.at(-1), model);
  assert.deepEqual(model.root.position, [4, 5, 6]);
  assert.deepEqual(model.root.rotation, [0.1, 0.2, 0.3]);
  assert.deepEqual(model.root.scale, [2, 3, 4]);
  assert.deepEqual(material.base, [1, 0.5, 0.25, 0.8]);
  assert.equal(material.factors[0], 0.6);
  assert.equal(material.factors[1], 0.9);
  assert.equal(material.settings[2], 1);
  view.rerender(tree(child({})));
  assert.deepEqual(model.root.position, [0, 0, 0]);
  assert.deepEqual(model.root.scale, [1, 1, 1]);
  assert.equal(material.factors[1], 0.4);
  assert.equal(material.settings[2], 0);
  view.rerender(tree(null));
  await flush();
  assert.equal(model.disposals, 1);
  assert.equal(engines.at(-1).meshes.size, 0);
  assert.equal(engines.at(-1).hasPlugin(model.name), false);
});
test('changing src or removing Model aborts pending loads and disposes late results without onLoad', async () => {
  deferModel = true;
  const loaded = [];
  const view = render(tree(React.createElement(Model, { src: '/old.glb', onLoad: (node) => loaded.push(node) })));
  await flush();
  const old = models.at(-1),
    oldRequest = requests.at(-1);
  view.rerender(
    tree(React.createElement(Model, { src: '/new.glb', position: [3, 0, 0], onLoad: (node) => loaded.push(node) })),
  );
  await flush();
  const current = models.at(-1);
  assert.ok(oldRequest.signal.aborted);
  await act(async () => pendingModels.shift()());
  assert.equal(old.disposals, 1);
  assert.equal(loaded.length, 0);
  await act(async () => pendingModels.shift()());
  assert.equal(loaded[0], current.root);
  assert.deepEqual(current.root.position, [3, 0, 0]);
  view.rerender(tree(React.createElement(Model, { src: '/late.glb', onLoad: (node) => loaded.push(node) })));
  await flush();
  const late = models.at(-1),
    lateRequest = requests.at(-1);
  view.rerender(tree(null));
  await flush();
  assert.ok(lateRequest.signal.aborted);
  await act(async () => pendingModels.shift()());
  assert.equal(late.disposals, 1);
  assert.equal(loaded.length, 1);
});
test('pending Model reads the latest props and callback on completion', async () => {
  deferModel = true;
  let first = 0,
    second = 0;
  const view = render(tree(React.createElement(Model, { src: '/pending.glb', onLoad: () => first++ })));
  await flush();
  view.rerender(
    tree(
      React.createElement(Model, {
        src: '/pending.glb',
        position: [8, 0, 0],
        materials: { Upper: { roughness: 0.1 } },
        onLoad: () => second++,
      }),
    ),
  );
  await act(async () => pendingModels.shift()());
  assert.equal(first, 0);
  assert.equal(second, 1);
  assert.deepEqual(models.at(-1).root.position, [8, 0, 0]);
  assert.equal(models.at(-1).primitives[0].material.factors[0], 0.1);
});
test('model errors and throwing onLoad report through the canvas and release all resources', async () => {
  const errors = [];
  modelFailure = new Error('fetch failed');
  const view = render(
    tree(React.createElement(Model, { src: '/missing.glb' }), { onError: (error) => errors.push(error) }),
  );
  await flush();
  assert.match(view.getByRole('alert').textContent, /fetch failed/);
  modelFailure = null;
  view.rerender(
    tree(
      React.createElement(Model, {
        src: '/callback.glb',
        onLoad() {
          throw new Error('callback failed');
        },
      }),
      { onError: (error) => errors.push(error) },
    ),
  );
  await flush();
  assert.match(view.getByRole('alert').textContent, /callback failed/);
  assert.equal(models.at(-1).disposals, 1);
  assert.equal(errors.length, 2);
});
test('invalid initial material overrides report and dispose the model', async () => {
  const view = render(
    tree(React.createElement(Model, { src: '/invalid.glb', materials: { Upper: { baseColor: [NaN, 0, 0] } } })),
  );
  await flush();
  assert.match(view.getByRole('alert').textContent, /Invalid base color/);
  assert.equal(models.at(-1).disposals, 1);
});
test('studio exposure changes in place and unmount restores previous directional lighting', async () => {
  const before = environments.length;
  const view = render(tree(React.createElement(Environment, { exposure: 2 })));
  await flush();
  const engine = engines.at(-1);
  assert.equal(environments.length, before);
  assert.deepEqual([...engine.lighting.radiance], [2, 2, 2, Math.fround(0.3)]);
  view.rerender(tree(React.createElement(Environment, { exposure: 0.5, background: false })));
  assert.deepEqual([...engine.lighting.radiance], [0.5, 0.5, 0.5, Math.fround(0.075)]);
  view.rerender(tree(null));
  assert.deepEqual([...engine.lighting.direction], [1, 2, 3, 2]);
  assert.deepEqual(
    [...engine.lighting.radiance],
    [Math.fround(0.8), Math.fround(0.7), Math.fround(0.6), Math.fround(0.2)],
  );
});
test('HDR exposure and background mutate without reload, models join IBL regardless of mounting order', async () => {
  const before = imageRequests.length;
  const children = (exposure, background, showModel = true) => [
    React.createElement(Environment, { key: 'env', src: '/studio.hdr', exposure, background }),
    showModel && React.createElement(Model, { key: 'model', src: '/lit.glb' }),
  ];
  const view = render(tree(children(1, true)));
  await flush();
  const environment = environments.at(-1),
    model = models.at(-1),
    background = backgrounds.at(-1),
    effect = [...model.lighting][0];
  assert.equal(model.lighting.size, 1);
  const entries = effect.bindings();
  assert.equal(effect.bindings(), entries);
  environment.restore();
  assert.notEqual(effect.bindings(), entries);
  assert.equal(effect.bindings()[0].resource.version, 1);
  view.rerender(tree(children(2, true)));
  assert.equal(environment.intensity, 2);
  assert.equal(background.exposure, 2);
  assert.equal(backgrounds.at(-1), background);
  assert.equal(imageRequests.length, before + 1);
  view.rerender(tree(children(0.5, false)));
  assert.equal(background.disposed, true);
  assert.equal(environment.intensity, 0.5);
  assert.equal(model.lighting.size, 1);
  view.rerender(tree(children(0.5, true, false)));
  await flush();
  assert.equal(model.disposals, 1);
  view.rerender(tree(children(0.5, true)));
  await flush();
  assert.equal(models.at(-1).lighting.size, 1);
  view.rerender(tree(React.createElement(Model, { src: '/lit.glb' })));
  await flush();
  assert.equal(environment.disposals, 1);
  assert.equal(models.at(-1).lighting.size, 0);
  assert.equal(environment.listeners.size, 0);
});
test('Environment src replacement and unmount destroy environments finishing asynchronously', async () => {
  deferEnvironment = true;
  const view = render(tree(React.createElement(Environment, { src: '/old.hdr' })));
  await flush();
  const old = environments.at(-1),
    oldRequest = imageRequests.at(-1);
  view.rerender(tree(React.createElement(Environment, { src: '/new.hdr', exposure: 3, background: false })));
  await flush();
  assert.ok(oldRequest.signal.aborted);
  await act(async () => pendingEnvironments.shift()());
  assert.equal(old.disposals, 1);
  await act(async () => pendingEnvironments.shift()());
  assert.equal(environments.at(-1).intensity, 3);
  view.rerender(tree(React.createElement(Environment, { src: '/late.hdr' })));
  await flush();
  const late = environments.at(-1);
  view.unmount();
  await act(async () => pendingEnvironments.shift()());
  assert.equal(late.disposals, 1);
});
test('shadow flags update registration independently and HDR composes with the shadow shader', async () => {
  const children = (castShadow, receiveShadow) => [
    React.createElement(Model, { key: 'model', src: '/shadow.glb', castShadow, receiveShadow }),
    React.createElement(Environment, { key: 'env', src: '/studio.hdr', background: false }),
  ];
  const view = render(tree(children(true, true), { shadows: true }));
  await flush();
  const model = models.at(-1),
    effect = shadows.at(-1);
  assert.equal(effect.sources.size, 1);
  assert.equal(model.lighting.size, 2);
  assert.ok(model.lighting.has(effect));
  // The IBL beside the shadows is the environment package's own EnvironmentLighting (its shader patching, binding
  // layout and caching are tested there), attached as a plugin so core meshes are lit too.
  const ibl = [...model.lighting].find((value) => value !== effect),
    engine = engines.at(-1);
  assert.equal(ibl.constructor.name, 'EnvironmentLighting');
  assert.equal(ibl.environment, environments.at(-1));
  assert.equal(engine.plugins.get('environment:lighting'), ibl);
  view.rerender(tree(children(false, true), { shadows: true }));
  assert.equal(effect.sources.size, 0);
  assert.ok(model.lighting.has(effect));
  view.rerender(tree(children(true, false), { shadows: true }));
  assert.equal(effect.sources.size, 1);
  assert.equal(model.lighting.has(effect), false);
  view.rerender(tree(children(true, true), { shadows: false }));
  await flush();
  assert.equal(effect.disposals, 1);
  assert.equal(effect.sources.size, 0);
  assert.equal(model.lighting.size, 1);
});
test('OrbitControls retains listeners and its frame subscription across prop mutations, then disposes both', async () => {
  const view = render(
    tree(
      React.createElement(OrbitControls, { autoRotate: true, enableDamping: true, minDistance: 1, maxDistance: 20 }),
    ),
  );
  await flush();
  const control = controls.at(-1),
    engine = engines.at(-1),
    callback = engine.callbacks.values().next().value;
  assert.equal(control.camera, engine.camera);
  assert.equal(control.canvas, engine.canvas);
  assert.equal(engine.callbacks.size, 1);
  callback(engine, 0.02);
  assert.deepEqual(control.updates, [0.02]);
  view.rerender(tree(React.createElement(OrbitControls, { autoRotateSpeed: 4, minDistance: 2, maxDistance: 8 })));
  assert.equal(controls.at(-1), control);
  assert.equal(engine.callbacks.values().next().value, callback);
  assert.equal(control.autoRotate, false);
  assert.equal(control.enableDamping, false);
  assert.equal(control.autoRotateSpeed, 4);
  assert.equal(control.minDistance, 2);
  assert.equal(control.maxDistance, 8);
  view.rerender(tree(null));
  // Released a microtask after the effect cleanup, so a StrictMode replay keeps the same controls.
  await flush();
  assert.equal(control.disposals, 1);
  assert.equal(engine.callbacks.size, 1);
});

test('CadControls applies a CAD profile and key listening; a removed prop restores the default', async () => {
  const ref = React.createRef();
  const view = render(tree(React.createElement(CadControls, { ref, profile: 'solidworks', minDistance: 2 })));
  await flush();
  const control = controls.at(-1);
  assert.equal(control.constructor.name, 'OrbitControls');
  assert.equal(ref.current, control, 'the ref is the live controls');
  assert.equal(control.profile.name, 'solidworks');
  assert.equal(control.zoomToCursor, true, 'the profile sets its own bindings');
  assert.equal(control.keyTarget, window, 'CAD keys listen on window by default');
  assert.equal(control.minDistance, 2);
  view.rerender(tree(React.createElement(CadControls, { ref, keyEvents: false })));
  assert.equal(controls.at(-1), control, 'prop changes keep the same controls');
  assert.equal(control.profile.name, 'margo', 'the default profile is margo');
  assert.equal(control.keyTarget, null);
  assert.equal(control.minDistance, 0, 'removing minDistance restores the default');
  assert.throws(
    () => view.rerender(tree(React.createElement(CadControls, { profile: 'unknown' }))),
    /Unknown navigation profile 'unknown'; use one of margo,solidworks/,
  );
  view.unmount();
  await flush();
  assert.equal(control.disposals, 1);
  assert.equal(ref.current, null, 'the ref is cleared when the controls are disposed');
});

test('MapControls and ArcballControls mount their own class, forward events and refuse bad distances', async () => {
  const changes = [],
    arcball = React.createRef();
  const view = render(
    tree([
      React.createElement(MapControls, { key: 'map', enableDamping: true }),
      React.createElement(ArcballControls, {
        key: 'arcball',
        ref: arcball,
        minZoom: 0.5,
        projection: null,
        onChange: (event) => changes.push(event.type),
      }),
    ]),
  );
  await flush();
  const map = controls.find((control) => control.constructor.name === 'MapControls'),
    ball = controls.find((control) => control.constructor.name === 'ArcballControls');
  assert.equal(map.enableDamping, true);
  assert.equal(arcball.current, ball);
  assert.deepEqual(ball.options, { projection: null });
  assert.equal(ball.minZoom, 0.5);
  ball.emit('change');
  ball.emit('start');
  assert.deepEqual(changes, ['change'], 'onChange hears only change events');
  const engine = engines.at(-1);
  for (const callback of engine.callbacks) callback(engine, 0.016);
  assert.equal(ball.updates.length, 1, 'the Canvas frame loop drives the controls');
  ball.enabled = false;
  for (const callback of engine.callbacks) callback(engine, 0.016);
  assert.equal(ball.updates.length, 1, 'disabled controls are not updated');
  assert.throws(
    () =>
      view.rerender(
        tree([
          React.createElement(MapControls, { key: 'map' }),
          React.createElement(ArcballControls, { key: 'arcball', projection: null, minDistance: 5, maxDistance: 1 }),
        ]),
      ),
    /Invalid ArcballControls distances: need 0 <= minDistance <= maxDistance/,
  );
});

test('Shadows turns the Canvas shadows on, applies live options and restores removed ones; Mesh casts on request', async () => {
  const view = render(
    tree([
      React.createElement(Shadows, { key: 'shadows', distance: 40, bias: 0.001, filter: 'pcf' }),
      React.createElement(Mesh, { key: 'mesh', castShadow: true }),
    ]),
  );
  await flush();
  const effect = shadows.at(-1),
    engine = engines.at(-1),
    [caster] = engine.meshes.values();
  assert.equal(effect.owner, engine);
  assert.deepEqual(effect.options, { distance: 40, bias: 0.001, filter: 'pcf' });
  assert.equal(effect.added.source, caster);
  assert.deepEqual(effect.added.options, { castShadow: true, receiveShadow: true });
  view.rerender(
    tree([
      React.createElement(Shadows, { key: 'shadows', distance: 80 }),
      React.createElement(Mesh, { key: 'mesh', castShadow: true }),
    ]),
  );
  assert.equal(shadows.at(-1), effect, 'option changes keep the same shadows');
  assert.deepEqual(effect.options, { distance: 80 }, 'removed props return to the defaults');
  view.rerender(tree(React.createElement(Mesh, { key: 'mesh' })));
  await flush();
  assert.equal(effect.disposals, 1, 'shadows switch off with their last request');
});

test('useEngine and useCamera return the Canvas engine and camera', async () => {
  let seen;
  function Probe() {
    seen = { engine: useEngine(), camera: useCamera() };
    return null;
  }
  render(tree(React.createElement(Probe)));
  await flush();
  const engine = engines.at(-1);
  assert.equal(seen.engine, engine);
  assert.equal(seen.camera, engine.camera);
});

test('useLoader suspends, shares one load per URL, counts fetches in useProgress, and keeps a failure', async () => {
  const fetches = [],
    saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    if (String(url).includes('broken')) return new Response('', { status: 500 });
    return new Response('1 2 3', { headers: { 'content-length': '5' } });
  };
  let calls = 0,
    progress;
  const numbers = async (url, { fetch, signal, engine }) => {
    calls++;
    assert.equal(engine, engines.at(-1));
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return (await response.text()).split(' ').map(Number);
  };
  function Values({ url }) {
    return React.createElement('output', null, useLoader(numbers, url).join(','));
  }
  function Bar() {
    progress = useProgress();
    return null;
  }
  class Boundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
      return { error };
    }
    render() {
      return this.state.error ? React.createElement('p', null, String(this.state.error.message)) : this.props.children;
    }
  }
  try {
    const view = render(
      React.createElement(
        MargoCanvas,
        null,
        React.createElement(Bar),
        React.createElement(
          React.Suspense,
          { fallback: React.createElement('span', null, 'loading') },
          React.createElement(Values, { url: '/a.txt' }),
          React.createElement(Values, { url: '/a.txt' }),
        ),
      ),
    );
    await flush();
    await flush();
    assert.equal(view.getAllByText('1,2,3').length, 2);
    assert.equal(calls, 1, 'two components share one load');
    assert.deepEqual(fetches, ['/a.txt']);
    assert.equal(progress.active, false);
    assert.equal(progress.total, 1);
    assert.equal(progress.loaded, 1);
    assert.equal(progress.progress, 100);
    view.rerender(
      React.createElement(
        MargoCanvas,
        null,
        React.createElement(Bar),
        React.createElement(
          Boundary,
          null,
          React.createElement(React.Suspense, { fallback: null }, React.createElement(Values, { url: '/broken.txt' })),
        ),
      ),
    );
    await flush();
    await flush();
    assert.ok(view.getByText('HTTP 500 for /broken.txt'));
    assert.deepEqual(progress.errors, ['/broken.txt']);
    assert.equal(calls, 2, 'a failed load is not retried by every render');
  } finally {
    globalThis.fetch = saved;
  }
});

test('Scene creates its meshes in its own engine scene and View lists the Canvas views in order', async () => {
  const errors = [],
    overlay = { name: 'overlay camera' };
  const children = (hud) => [
    React.createElement(RenderView, { key: 'main' }),
    React.createElement(RenderView, {
      key: 'hud',
      order: 1,
      scene: 'hud',
      camera: overlay,
      viewport: [0.7, 0, 0.3, 0.3],
      clear: { color: false },
      layers: 2,
    }),
    hud &&
      React.createElement(
        Scene,
        { key: 'scene', name: 'hud', background: null },
        React.createElement(Mesh, { position: [1, 0, 0] }),
      ),
    React.createElement(Mesh, { key: 'world' }),
  ];
  const view = render(tree(children(true), { onError: (error) => errors.push(error) }));
  await flush();
  const engine = engines.at(-1),
    [hud] = engine.scenes.filter((scene) => !scene.disposed),
    nodes = [...engine.meshes.values()];
  assert.equal(hud.name, 'hud');
  assert.equal(hud.background, null);
  assert.equal(nodes.filter((node) => node.scene === hud).length, 1, 'the Scene child is created in the hud scene');
  assert.equal(nodes.filter((node) => !node.scene).length, 1, 'the other mesh stays in the default scene');
  assert.equal(engine.views.length, 2);
  assert.equal(engine.views[0].camera, engine.camera, 'a View without camera keeps the main camera');
  assert.deepEqual(engine.views[0].viewport, [0, 0, 1, 1]);
  assert.equal(engine.views[1].camera, overlay);
  assert.equal(engine.views[1].scene, hud);
  assert.deepEqual(engine.views[1].clear, { color: false });
  assert.equal(engine.views[1].layers, 2);
  view.rerender(tree(children(false), { onError: (error) => errors.push(error) }));
  await flush();
  assert.equal(hud.disposed, true, 'unmounting the Scene disposes it and its meshes');
  assert.equal(engine.views.length, 1, 'a View naming a missing scene is left out');
  assert.match(String(errors.at(-1)), /names no <Scene name="hud">/);
  view.rerender(tree([], { onError: (error) => errors.push(error) }));
  await flush();
  assert.equal(engine.views, undefined, 'no View: the engine draws its full-canvas camera view again');
});

test('Mesh layers set the render-layer mask, and removing the prop sets layer 1', async () => {
  const view = render(tree(React.createElement(Mesh, { layers: 6 })));
  await flush();
  const [node] = engines.at(-1).meshes.values();
  assert.equal(node.layers, 6);
  view.rerender(tree(React.createElement(Mesh, {})));
  await flush();
  assert.equal(node.layers, 1);
});

test('Environment rotation turns the environment and blur softens the background, both live', async () => {
  const child = (rotation, blur) => React.createElement(Environment, { src: '/turn.hdr', rotation, blur });
  const view = render(tree(child(0.5, 0.25)));
  await flush();
  await flush();
  const environment = environments.at(-1),
    background = backgrounds.at(-1);
  assert.equal(environment.rotation, 0.5);
  assert.equal(background.blur, 0.25);
  view.rerender(tree(child(1.5, 0)));
  await flush();
  assert.equal(environments.at(-1), environment, 'no reload');
  assert.equal(environment.rotation, 1.5);
  assert.equal(background.blur, 0);
});

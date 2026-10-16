import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import React, { StrictMode, Suspense } from 'react';
import { transformWithOxc } from 'vite';

const engines = [],
  models = [],
  modelRequests = [],
  imageRequests = [],
  environments = [],
  overlays = [],
  observers = [],
  controls = [],
  pickers = [];
let deferModels = false,
  deferImages = false,
  sourceImages = [];
class Material {
  constructor(options = {}) {
    Object.assign(this, options);
  }
}
class Node {
  constructor(engine) {
    this.engine = engine;
    this.id = engine.next++;
    this.parent = null;
    this.geometry = null;
    this.position = [0, 0, 0];
    this.rotation = [0, 0, 0];
    this.scale = [1, 1, 1];
    this.disposals = 0;
    engine.meshes.set(this.id, this);
  }
  setPosition(value) {
    this.position = [...value];
    return this;
  }
  setRotation(value) {
    this.rotation = [...value];
    return this;
  }
  setScale(value) {
    this.scale = [...value];
    return this;
  }
  setParent(value) {
    this.parent = value;
    return this;
  }
  setGeometry(value) {
    this.geometry = value;
    return this;
  }
  setMaterial(value) {
    this.material = value;
    return this;
  }
  dispose() {
    if (this.disposals) return;
    this.disposals++;
    this.engine.meshes.delete(this.id);
    this.parent = null;
  }
}
mock.module('@margoengine/core/extension', {
  namedExports: {
    Engine: {
      async create(canvas, options) {
        const engine = {
          canvas,
          options,
          backend: options.backend === 'auto' ? 'webgpu' : options.backend,
          next: 0,
          meshes: new Map(),
          plugins: new Map(),
          callbacks: new Set(),
          picks: [],
          frames: [],
          starts: 0,
          stops: 0,
          disposals: 0,
          disposed: false,
          camera: { position: [0, 2, 5], target: [0, 0, 0], ...options.camera },
          lighting: { direction: new Float32Array([1, 2, 3, 2]), radiance: new Float32Array([1, 1, 1, 0.2]) },
          createMesh() {
            return new Node(this);
          },
          start() {
            this.starts++;
          },
          stop() {
            this.stops++;
          },
          render(options = {}) {
            assert.equal(this.disposed, false);
            this.frames.push(options);
          },
          async pick(x, y) {
            this.picks.push([x, y]);
            return this.hit ?? null;
          },
          onFrame(callback) {
            this.callbacks.add(callback);
            return () => this.callbacks.delete(callback);
          },
          use(plugin) {
            assert.equal(this.plugins.has(plugin.name), false, 'plugins must not overwrite an active name');
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
          dispose() {
            if (this.disposed) return;
            this.disposals++;
            this.disposed = true;
            for (const name of this.plugins.keys()) this.removePlugin(name);
            for (const mesh of this.meshes.values()) mesh.dispose();
            this.callbacks.clear();
          },
        };
        engines.push(engine);
        return engine;
      },
    },
    Mesh: Node,
    PbrMaterial: Material,
    box: (...args) => ({ args }),
    engineRuntime: (engine) => engine,
    meshRuntime: (node) => node,
  },
});
function makeModel(engine, asset = { doc: { images: [] } }, images = []) {
  const root = engine.createMesh(),
    node = engine.createMesh();
  node.setParent(root);
  const material = {
    name: 'Body',
    base: [1, 1, 1, 1],
    factors: [0.5, 0, 1, 1],
    emission: [0, 0, 0],
    settings: [0, 0.5, 0, 0],
    maps: [],
  };
  const model = {
    name: 'model:' + models.length,
    asset,
    ownedImages: images,
    image: (index) => images[index],
    root,
    nodes: [node],
    primitives: [{ node, material }],
    lighting: new Set(),
    shadowPrimitives: [],
    disposed: false,
    disposals: 0,
    addLighting(effect) {
      this.lighting.add(effect);
      return () => this.lighting.delete(effect);
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.disposals++;
      engine.removePlugin(this.name);
      this.root.dispose();
      for (const node of this.nodes) node.dispose();
      for (const image of images) image?.close?.();
      this.lighting.clear();
    },
  };
  models.push(model);
  return model;
}
mock.module('@margoengine/gltf-pro', {
  namedExports: {
    PBRModel: class {
      constructor(engine, asset, images) {
        return makeModel(engine, asset, images);
      }
    },
    async loadGLTF(engine, src, { signal }) {
      const request = { engine, src, signal };
      modelRequests.push(request);
      if (deferModels) await new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
      const model = makeModel(engine, { doc: { images: sourceImages.map(() => ({})) } }, sourceImages);
      engine.use(model);
      return model;
    },
  },
});
mock.module('@margoengine/selection', {
  namedExports: {
    Picking: class {
      static forEngine(engine) {
        return pickers.find((picker) => picker.engine === engine && !picker.disposals);
      }
      static attach(engine, options) {
        const picker = new this();
        Object.assign(picker, { name: 'picking', engine, options, sources: new Set(), disposals: 0 });
        pickers.push(picker);
        engine.use(picker);
        return picker;
      }
      add(model) {
        this.sources.add(model);
        return () => this.sources.delete(model);
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.sources.clear();
        this.engine.removePlugin(this.name);
      }
    },
  },
});
mock.module('@margoengine/controls', {
  namedExports: {
    OrbitControls: class {
      constructor(camera, canvas) {
        this.camera = camera;
        this.canvas = canvas;
        this.updates = [];
        this.disposals = 0;
        controls.push(this);
      }
      update(delta) {
        this.updates.push(delta);
      }
      dispose() {
        if (!this.disposals) this.disposals++;
      }
    },
  },
});
mock.module('@margoengine/environment', {
  namedExports: {
    async loadEnvironmentImage(src, { signal }) {
      const request = { src, signal };
      imageRequests.push(request);
      if (deferImages) await new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
      return {};
    },
    Environment: {
      async create() {
        const environment = {
          name: 'environment',
          intensity: 1,
          disposed: false,
          disposals: 0,
          onChange() {
            return () => {};
          },
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.disposals++;
          },
        };
        environments.push(environment);
        return environment;
      },
    },
    EnvironmentBackground: class {
      constructor(environment) {
        this.name = 'environment:background';
        this.environment = environment;
      }
      dispose() {
        this.disposed = true;
      }
    },
    IBL_WGSL: '',
    iblBindGroupEntries: () => [],
  },
});
mock.module('@margoengine/html', {
  namedExports: {
    HTML: class {
      static attach(engine, options) {
        const overlay = new this();
        overlay.name = 'html:' + overlays.length;
        overlay.engine = engine;
        overlay.options = options;
        overlay.labels = new Set();
        overlay.disposals = 0;
        overlay.root = engine.canvas.ownerDocument.createElement('div');
        engine.canvas.parentElement.appendChild(overlay.root);
        overlays.push(overlay);
        engine.use(overlay);
        return overlay;
      }
      add(element, options) {
        const label = {
          element,
          ...options,
          setMesh(mesh) {
            this.mesh = mesh;
            return this;
          },
          setPosition(value) {
            this.position = value;
            return this;
          },
          setOffset(value) {
            this.offset = value;
            return this;
          },
          dispose: () => this.remove(label),
        };
        this.labels.add(label);
        this.root.appendChild(element);
        return label;
      }
      remove(label) {
        this.labels.delete(label);
        label.element.remove();
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.engine.removePlugin(this.name);
        for (const label of this.labels) this.remove(label);
        this.root.remove();
      }
    },
  },
});

const Margo = await import('../dist/index.js');
const { Canvas, Stage, Mesh, BoxGeometry, Model, Environment, useMargo, useFrame } = Margo;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(element) {
    this.element = element;
  }
  disconnect() {
    this.disconnected = true;
  }
};
const { render, act, cleanup } = await import('@testing-library/react');
const flush = () => act(async () => {});
const tree = (children, props = {}) =>
  React.createElement(StrictMode, null, React.createElement(Canvas, props, React.createElement(Stage, null, children)));
const fallback = React.createElement('span', { 'data-testid': 'loading' }, 'Loading asset');
const suspense = (children) => React.createElement(Suspense, { fallback }, children);
async function pointer(canvas, type, x, y, pointerId = 1) {
  await act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    canvas.dispatchEvent(event);
  });
}
async function resolve(request) {
  assert.equal(typeof request?.resolve, 'function');
  await act(async () => {
    request.resolve();
  });
}

afterEach(async () => {
  cleanup();
  deferModels = deferImages = false;
  sourceImages = [];
  for (const request of [...modelRequests, ...imageRequests])
    if (request.resolve) {
      request.resolve();
      delete request.resolve;
    }
  await flush();
  assert.ok(
    engines.every(
      (engine) => engine.disposed && engine.disposals === 1 && engine.callbacks.size === 0 && engine.meshes.size === 0,
    ),
  );
  assert.ok(models.every((model) => model.disposals === 1));
  assert.ok(environments.every((environment) => environment.disposals === 1));
  assert.ok(controls.every((control) => control.disposals === 1));
  assert.ok(observers.every((observer) => observer.disconnected));
});

test('the exact R3F target snippet renders Canvas, Stage, clickable Mesh and suspended Model', async () => {
  const documentation = await readFile(new URL('../../../docs/react-r3f.md', import.meta.url), 'utf8');
  const source = /```tsx\r?\n([\s\S]*?)```/.exec(documentation)?.[1];
  assert.ok(source);
  const { code } = await transformWithOxc(source, 'react-r3f-example.tsx', { jsx: { runtime: 'automatic' } });
  const resolved = code
    .replaceAll('@margoengine/react', new URL('../dist/index.js', import.meta.url).href)
    .replaceAll('react/jsx-runtime', import.meta.resolve('react/jsx-runtime'))
    .replaceAll("from 'react'", `from '${import.meta.resolve('react')}'`)
    .replaceAll('from "react"', `from '${import.meta.resolve('react')}'`);
  const { App } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
  const before = modelRequests.length;
  const view = render(React.createElement(StrictMode, null, React.createElement(App)));
  await flush();
  const engine = engines.at(-1),
    node = [...engine.meshes.values()].find((mesh) => mesh.geometry);
  assert.equal(view.container.querySelectorAll('canvas').length, 1);
  assert.deepEqual(node.position, [0, 1, 0]);
  assert.deepEqual(node.geometry.args, [1, 1, 1]);
  assert.equal(node.material.color, '#84d6bd');
  assert.deepEqual(engine.camera.position, [0, 2, 5]);
  assert.equal(modelRequests.length, before + 1);
  assert.equal(models.at(-1).disposed, false);
});

test('StrictMode clicks fire once, use canvas-local pick coordinates and reject cumulative drags', async () => {
  let clicked = 0;
  const view = render(tree(React.createElement(Mesh, { onClick: () => clicked++ })));
  await flush();
  const engine = engines.at(-1),
    canvas = engine.canvas;
  engine.hit = [...engine.meshes.values()][0];
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 });
  await pointer(canvas, 'pointerdown', 30, 40);
  await pointer(canvas, 'pointerup', 33, 40);
  assert.equal(clicked, 1);
  assert.deepEqual(engine.picks.at(-1), [23, 20]);
  await pointer(canvas, 'pointerdown', 30, 40);
  await pointer(canvas, 'pointermove', 35, 40);
  await pointer(canvas, 'pointermove', 30, 40);
  await pointer(canvas, 'pointerup', 30, 40);
  assert.equal(clicked, 1, 'returning to the origin after a drag is still a drag');
  await pointer(canvas, 'pointerdown', 30, 40);
  await pointer(canvas, 'pointerup', 34, 40);
  assert.equal(clicked, 1);
  await pointer(canvas, 'pointerup', 30, 40);
  assert.equal(clicked, 1, 'pointerup without pointerdown is not a click');
  view.unmount();
  await pointer(canvas, 'pointerdown', 30, 40);
  await pointer(canvas, 'pointerup', 30, 40);
  assert.equal(clicked, 1);
});

test('hover enters once per mesh, leaves the prior mesh and ignores stale asynchronous picks', async () => {
  const events = [];
  render(
    tree([
      React.createElement(Mesh, {
        key: 'a',
        onPointerOver: () => events.push('a over'),
        onPointerOut: () => events.push('a out'),
      }),
      React.createElement(Mesh, {
        key: 'b',
        onPointerOver: () => events.push('b over'),
        onPointerOut: () => events.push('b out'),
      }),
    ]),
  );
  await flush();
  const engine = engines.at(-1),
    [a, b] = [...engine.meshes.values()],
    canvas = engine.canvas;
  engine.hit = a;
  await pointer(canvas, 'pointermove', 10, 10);
  await pointer(canvas, 'pointermove', 11, 10);
  assert.deepEqual(events, ['a over']);
  engine.hit = b;
  await pointer(canvas, 'pointermove', 12, 10);
  assert.deepEqual(events, ['a over', 'a out', 'b over']);
  let late;
  engine.hit = new Promise((resolve) => {
    late = resolve;
  });
  await pointer(canvas, 'pointermove', 13, 10);
  engine.hit = null;
  await pointer(canvas, 'pointermove', 14, 10);
  await act(async () => late(a));
  assert.deepEqual(events, ['a over', 'a out', 'b over', 'b out']);
  engine.hit = a;
  await pointer(canvas, 'pointermove', 15, 10);
  await pointer(canvas, 'pointerleave', 500, 500);
  assert.deepEqual(events.slice(-2), ['a over', 'a out']);
});

test('canvas serializes picking, coalesces pointermove bursts and preserves queued clicks', async () => {
  let clicks = 0,
    overs = 0;
  render(tree(React.createElement(Mesh, { onClick: () => clicks++, onPointerOver: () => overs++ })));
  await flush();
  const engine = engines.at(-1),
    canvas = engine.canvas,
    node = [...engine.meshes.values()][0],
    pending = [],
    coordinates = [];
  let active = 0,
    peak = 0;
  engine.pick = (x, y) => {
    coordinates.push([x, y]);
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) => pending.push(resolve)).finally(() => active--);
  };
  await pointer(canvas, 'pointermove', 1, 1);
  await pointer(canvas, 'pointermove', 2, 2);
  await pointer(canvas, 'pointerdown', 10, 10);
  await pointer(canvas, 'pointerup', 10, 10);
  await pointer(canvas, 'pointerdown', 20, 20);
  await pointer(canvas, 'pointerup', 20, 20);
  await pointer(canvas, 'pointermove', 3, 3);
  assert.equal(coordinates.length, 1);
  assert.equal(peak, 1);
  await act(async () => pending.shift()(node));
  assert.deepEqual(coordinates[1], [10, 10]);
  assert.equal(overs, 0);
  await act(async () => pending.shift()(node));
  assert.deepEqual(coordinates[2], [20, 20]);
  assert.equal(clicks, 1);
  await act(async () => pending.shift()(node));
  assert.deepEqual(coordinates[3], [3, 3]);
  assert.equal(clicks, 2);
  await act(async () => pending.shift()(node));
  assert.equal(peak, 1);
  assert.equal(overs, 1);
  assert.equal(coordinates.length, 4);
});

test('canvas skips picking without handlers and on an unsupported WebGL backend', async () => {
  const first = render(tree(React.createElement(Mesh)));
  await flush();
  const idle = engines.at(-1);
  await pointer(idle.canvas, 'pointermove', 1, 1);
  await pointer(idle.canvas, 'pointerdown', 1, 1);
  await pointer(idle.canvas, 'pointerup', 1, 1);
  assert.equal(idle.picks.length, 0);
  first.unmount();
  const errors = [];
  render(
    tree(React.createElement(Mesh, { onClick: () => {}, onPointerOver: () => {} }), {
      backend: 'webgl2',
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  const webgl = engines.at(-1);
  await pointer(webgl.canvas, 'pointermove', 1, 1);
  await pointer(webgl.canvas, 'pointerdown', 1, 1);
  await pointer(webgl.canvas, 'pointerup', 1, 1);
  assert.equal(webgl.picks.length, 0);
  assert.deepEqual(errors, []);
});

test('Model pointer handlers dispatch for a loaded primitive and update without reloading', async () => {
  let first = 0,
    second = 0;
  const hover = [],
    beforePickers = pickers.length;
  const child = (onClick) =>
    suspense(
      React.createElement(Model, {
        src: '/pointer-model.glb',
        onClick,
        onPointerOver: () => hover.push('over'),
        onPointerOut: () => hover.push('out'),
      }),
    );
  const view = render(tree(child(() => first++)));
  await flush();
  const engine = engines.at(-1),
    model = models.at(-1),
    before = modelRequests.length;
  engine.hit = model.nodes[0];
  await pointer(engine.canvas, 'pointerdown', 4, 5);
  await pointer(engine.canvas, 'pointerup', 4, 5);
  assert.equal(first, 1);
  view.rerender(tree(child(() => second++)));
  await flush();
  await pointer(engine.canvas, 'pointerdown', 4, 5);
  await pointer(engine.canvas, 'pointerup', 4, 5);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(modelRequests.length, before);
  await pointer(engine.canvas, 'pointermove', 4, 5);
  engine.hit = null;
  await pointer(engine.canvas, 'pointermove', 6, 5);
  assert.deepEqual(hover, ['over', 'out']);
  assert.equal(pickers.length, beforePickers + 1);
  assert.equal(pickers.at(-1).options.capture, false);
  assert.deepEqual([...pickers.at(-1).sources], [model]);
  view.unmount();
  await flush();
  assert.equal(pickers.at(-1).disposals, 1);
  assert.equal(pickers.at(-1).sources.size, 0);
});

test('Suspense retains fallback until Model resolves and caches the in-flight URL across retries', async () => {
  deferModels = true;
  const before = modelRequests.length,
    loaded = [];
  const child = (position) =>
    suspense(React.createElement(Model, { src: '/suspense.glb', position, onLoad: (mesh) => loaded.push(mesh) }));
  const view = render(tree(child([1, 2, 3])));
  await flush();
  assert.equal(view.getByTestId('loading').textContent, 'Loading asset');
  assert.equal(modelRequests.length, before + 1);
  view.rerender(tree(child([4, 5, 6])));
  await flush();
  assert.equal(modelRequests.length, before + 1);
  assert.ok(view.getByTestId('loading'));
  await resolve(modelRequests.at(-1));
  await flush();
  assert.equal(view.queryByTestId('loading'), null);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].position, [4, 5, 6]);
  view.rerender(tree(child([7, 8, 9])));
  await flush();
  assert.equal(modelRequests.length, before + 1);
  assert.deepEqual(loaded[0].position, [7, 8, 9]);
});

test('resolved Model URLs survive remounts and create independent transformed model instances', async () => {
  const before = modelRequests.length;
  const child = (show, position) => show && suspense(React.createElement(Model, { src: '/remounted.glb', position }));
  const view = render(tree(child(true, [1, 0, 0])));
  await flush();
  const first = models.at(-1);
  view.rerender(tree(child(false)));
  await flush();
  assert.equal(first.disposals, 1);
  view.rerender(tree(child(true, [2, 0, 0])));
  await flush();
  const second = models.at(-1);
  assert.notEqual(second, first);
  assert.equal(second.disposed, false);
  assert.deepEqual(second.root.position, [2, 0, 0]);
  assert.equal(modelRequests.length, before + 1);
});

test('simultaneous Models share a URL load and retain independent transforms and ownership', async () => {
  deferModels = true;
  const before = modelRequests.length,
    loaded = [];
  const view = render(
    tree(
      suspense([
        React.createElement(Model, {
          key: 'first',
          src: '/shared-model.glb',
          position: [1, 0, 0],
          onLoad: (node) => loaded.push(node),
        }),
        React.createElement(Model, {
          key: 'second',
          src: '/shared-model.glb',
          position: [2, 0, 0],
          onLoad: (node) => loaded.push(node),
        }),
      ]),
    ),
  );
  await flush();
  assert.equal(modelRequests.length, before + 1);
  assert.ok(view.getByTestId('loading'));
  await resolve(modelRequests.at(-1));
  await flush();
  assert.equal(view.queryByTestId('loading'), null);
  assert.equal(loaded.length, 2);
  assert.notEqual(loaded[0], loaded[1]);
  assert.deepEqual(loaded.map((node) => node.position[0]).sort(), [1, 2]);
  assert.equal(modelRequests.length, before + 1);
  view.unmount();
  assert.ok(models.filter((model) => loaded.includes(model.root)).every((model) => model.disposals === 1));
});

test('preload warms the same URL promise consumed by a later Model', async () => {
  deferModels = true;
  const view = render(tree(null));
  await flush();
  const before = modelRequests.length;
  let preloaded;
  await act(async () => {
    preloaded = Margo.preload('/preloaded.glb');
  });
  await flush();
  assert.equal(modelRequests.length, before + 1);
  view.rerender(tree(suspense(React.createElement(Model, { src: '/preloaded.glb' }))));
  await flush();
  assert.ok(view.getByTestId('loading'));
  assert.equal(modelRequests.length, before + 1);
  await resolve(modelRequests.at(-1));
  await act(async () => preloaded);
  await flush();
  assert.equal(view.queryByTestId('loading'), null);
  assert.equal(modelRequests.length, before + 1);
});

test('preload before Canvas queues one promise and shares its result with a mounted Model', async () => {
  deferModels = true;
  const before = modelRequests.length,
    preloaded = Margo.preload('/early-preload.glb');
  assert.equal(Margo.preload('/early-preload.glb'), preloaded);
  assert.equal(modelRequests.length, before);
  const view = render(tree(null));
  await flush();
  assert.equal(modelRequests.length, before + 1);
  await resolve(modelRequests.at(-1));
  await act(async () => preloaded);
  assert.equal(models.at(-1).disposed, true, 'a preloaded model stays out of the rendered scene');
  view.rerender(tree(suspense(React.createElement(Model, { src: '/early-preload.glb' }))));
  await flush();
  assert.equal(modelRequests.length, before + 1);
  assert.equal(models.at(-1).disposed, false);
  assert.equal(models.at(-1).root.visible, true);
  assert.equal(view.queryByTestId('loading'), null);
});

test('preload infers HDR URLs and Environment remounts share the resolved image cache', async () => {
  deferImages = true;
  const view = render(tree(null));
  await flush();
  const beforeImages = imageRequests.length,
    beforeModels = modelRequests.length,
    src = '/cached-environment.HDR?lighting=1';
  let preloaded;
  await act(async () => {
    preloaded = Margo.preload(src);
  });
  await flush();
  assert.equal(imageRequests.length, beforeImages + 1);
  assert.equal(modelRequests.length, beforeModels);
  await resolve(imageRequests.at(-1));
  await act(async () => preloaded);
  const child = (show) => show && suspense(React.createElement(Environment, { src, background: false }));
  view.rerender(tree(child(true)));
  await flush();
  const first = environments.at(-1);
  assert.equal(first.disposed, false);
  assert.equal(view.queryByTestId('loading'), null);
  view.rerender(tree(child(false)));
  await flush();
  assert.equal(first.disposals, 1);
  view.rerender(tree(child(true)));
  await flush();
  assert.notEqual(environments.at(-1), first);
  assert.equal(environments.at(-1).disposed, false);
  assert.equal(imageRequests.length, beforeImages + 1);
});

test('cached glTF bitmap, KTX2 and compressed sources retain independent image ownership through remounts', async () => {
  const bitmap = {
      width: 2,
      height: 2,
      closes: 0,
      close() {
        this.closes++;
      },
    },
    ktx2 = {
      ktx2: true,
      width: 2,
      height: 2,
      levels: [new Uint8Array([1, 2, 3, 4])],
      closes: 0,
      close() {
        this.closes++;
      },
    },
    copies = [];
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (source) => {
    const copy = {
      width: source.width,
      height: source.height,
      source,
      closes: 0,
      close() {
        this.closes++;
      },
    };
    copies.push(copy);
    return copy;
  };
  const compressed = {
    width: 2,
    height: 2,
    format: 'rgba8unorm',
    mipmaps: [{ width: 2, height: 2, data: new Uint8Array(16) }],
  };
  sourceImages = [bitmap, ktx2, undefined, compressed];
  try {
    const before = modelRequests.length,
      child = (show) => show && suspense(React.createElement(Model, { src: '/textured-model.glb' }));
    const view = render(tree(child(true)));
    await flush();
    const first = models.at(-1);
    assert.equal(first.ownedImages[0], bitmap);
    assert.equal(first.ownedImages[1], ktx2);
    assert.equal(first.ownedImages[3], compressed);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].closes, 0);
    view.rerender(tree(child(false)));
    await flush();
    assert.equal(bitmap.closes, 1);
    assert.equal(ktx2.closes, 1);
    assert.equal(copies[0].closes, 0, 'the cache keeps its own decoded bitmap alive');
    view.rerender(tree(child(true)));
    await flush();
    const second = models.at(-1);
    assert.notEqual(second, first);
    assert.equal(copies.length, 2);
    assert.equal(second.ownedImages[0], copies[1]);
    assert.notEqual(second.ownedImages[1], ktx2);
    assert.equal(second.ownedImages[1].levels, ktx2.levels);
    assert.notEqual(second.ownedImages[3], compressed);
    assert.equal(second.ownedImages[3].mipmaps, compressed.mipmaps);
    assert.equal(second.ownedImages[2], undefined);
    assert.equal(modelRequests.length, before + 1);
    view.unmount();
    await flush();
    assert.equal(bitmap.closes, 1);
    assert.equal(ktx2.closes, 1);
    assert.deepEqual(
      copies.map((copy) => copy.closes),
      [1, 1],
    );
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previous;
  }
});

test('unmounting a suspended Model aborts the in-flight load and disposes a late result', async () => {
  deferModels = true;
  let loaded = 0;
  const view = render(tree(suspense(React.createElement(Model, { src: '/abort-model.glb', onLoad: () => loaded++ }))));
  await flush();
  const request = modelRequests.at(-1);
  assert.ok(view.getByTestId('loading'));
  view.unmount();
  assert.equal(request.signal.aborted, true);
  await resolve(request);
  await flush();
  assert.equal(loaded, 0);
  assert.equal(models.at(-1).disposals, 1);
});

test('removing a suspended Model while its Canvas stays mounted aborts the abandoned load', async () => {
  deferModels = true;
  const view = render(tree(suspense(React.createElement(Model, { src: '/abandoned-model.glb' }))));
  await flush();
  const request = modelRequests.at(-1),
    engine = engines.at(-1);
  view.rerender(tree(null));
  await flush();
  assert.equal(engine.disposed, false);
  assert.equal(request.signal.aborted, true);
  await resolve(request);
  await flush();
  assert.equal(models.at(-1).disposals, 1);
});

test('Environment suspends on image loading and aborts an unmounted pending image', async () => {
  deferImages = true;
  const before = imageRequests.length;
  const child = (src) => suspense(React.createElement(Environment, { src, background: false }));
  const view = render(tree(child('/suspense.hdr')));
  await flush();
  assert.ok(view.getByTestId('loading'));
  assert.equal(imageRequests.length, before + 1);
  await resolve(imageRequests.at(-1));
  await flush();
  assert.equal(view.queryByTestId('loading'), null);
  assert.equal(environments.at(-1).disposed, false);
  view.rerender(tree(child('/abort.hdr')));
  await flush();
  assert.ok(view.getByTestId('loading'));
  const request = imageRequests.at(-1);
  view.unmount();
  assert.equal(request.signal.aborted, true);
  await resolve(request);
});

test('Suspense Model failures reach onError once and remove the loading fallback', async () => {
  deferModels = true;
  const failure = new Error('asset unavailable'),
    errors = [];
  const view = render(
    tree(suspense(React.createElement(Model, { src: '/failed-model.glb' })), {
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  await act(async () => modelRequests.at(-1).reject(failure));
  await flush();
  assert.deepEqual(errors, [failure]);
  assert.match(view.getByRole('alert').textContent, /asset unavailable/);
  assert.equal(view.queryByTestId('loading'), null);
});

test('useMargo exposes engine aliases, measured size, elapsed clock and one demand frame per invalidation', async () => {
  let context;
  const ticks = [];
  function Probe() {
    context = useMargo();
    useFrame((engine, delta) => ticks.push({ engine, delta, clock: context.clock }));
    return null;
  }
  const view = render(tree(React.createElement(Probe), { frameloop: 'demand' }));
  await flush();
  const engine = engines.at(-1),
    canvas = engine.canvas;
  assert.equal(engine.starts, 0);
  assert.equal(context.camera, engine.camera);
  assert.equal(context.gl, engine);
  assert.equal(context.clock, 0);
  assert.equal(typeof context.invalidate, 'function');
  assert.equal(Margo.useThree, undefined);
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 360 });
  await act(async () => observers.at(-1).callback());
  assert.deepEqual(context.size, { width: 640, height: 360 });
  await act(async () => context.invalidate());
  assert.equal(engine.frames.length, 1);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].engine, engine);
  assert.equal(ticks[0].clock, context.clock);
  await act(async () => context.invalidate());
  assert.equal(engine.frames.length, 2);
  assert.equal(ticks.length, 2);
  assert.ok(context.clock >= 0);
  const invalidate = context.invalidate;
  view.unmount();
  invalidate();
  assert.equal(engine.frames.length, 2);
});

test('clock advances once per engine frame and is current inside every useFrame callback', async () => {
  let context;
  const clocks = [];
  function Probe() {
    context = useMargo();
    useFrame((_, delta) => clocks.push([delta, context.clock]));
    useFrame(() => clocks.push(['second', context.clock]));
    return null;
  }
  render(tree(React.createElement(Probe)));
  await flush();
  const engine = engines.at(-1);
  assert.equal(context.clock, 0);
  assert.equal(engine.callbacks.size, 1);
  await act(async () => {
    for (const callback of engine.callbacks) callback(engine, 0.125);
  });
  assert.equal(context.clock, 0.125);
  await act(async () => {
    for (const callback of engine.callbacks) callback(engine, 0.25);
  });
  assert.equal(context.clock, 0.375);
  assert.deepEqual(clocks, [
    [0.125, 0.125],
    ['second', 0.125],
    [0.25, 0.375],
    ['second', 0.375],
  ]);
});

test('demand invalidation advances OrbitControls exactly once and releases its frame subscription', async () => {
  let context;
  function Probe() {
    context = useMargo();
    return null;
  }
  const child = (show) => [
    React.createElement(Probe, { key: 'probe' }),
    show && React.createElement(Margo.OrbitControls, { key: 'controls', autoRotate: true }),
  ];
  const view = render(tree(child(true), { frameloop: 'demand' }));
  await flush();
  const engine = engines.at(-1),
    control = controls.at(-1);
  assert.equal(engine.starts, 0);
  assert.equal(control.camera, engine.camera);
  assert.equal(control.canvas, engine.canvas);
  assert.equal(control.updates.length, 0);
  await act(async () => context.invalidate());
  await act(async () => context.invalidate());
  assert.equal(engine.frames.length, 2);
  assert.equal(control.updates.length, 2);
  assert.ok(control.updates.every((delta) => Number.isFinite(delta) && delta >= 0));
  view.rerender(tree(child(false), { frameloop: 'demand' }));
  await flush();
  assert.equal(control.disposals, 1);
  await act(async () => context.invalidate());
  assert.equal(engine.frames.length, 3);
  assert.equal(control.updates.length, 2);
});

test('group aliases Mesh and reparents child transforms without geometry or DOM tags', async () => {
  assert.equal(Margo.Group, Mesh);
  assert.equal(Margo.group, Mesh);
  const view = render(
    tree(
      React.createElement(
        Margo.group,
        { position: [1, 2, 3] },
        React.createElement(Mesh, { position: [0, 4, 0] }, React.createElement(BoxGeometry)),
      ),
    ),
  );
  await flush();
  const engine = engines.at(-1),
    nodes = [...engine.meshes.values()],
    parent = nodes.find((node) => !node.geometry),
    child = nodes.find((node) => node.geometry);
  assert.equal(nodes.length, 2);
  assert.equal(child.parent, parent);
  assert.deepEqual(parent.position, [1, 2, 3]);
  assert.deepEqual(child.position, [0, 4, 0]);
  assert.equal(view.container.querySelector('group'), null);
});

test('Html imports the optional peer, shares an overlay and releases portal anchors on unmount', async () => {
  const before = overlays.length;
  const view = render(
    tree(
      React.createElement(
        Mesh,
        null,
        React.createElement(
          Margo.Html,
          { key: 'first', position: [0, 2, 0], className: 'first-label' },
          React.createElement('strong', null, 'Mesh label'),
        ),
        React.createElement(Margo.Html, { key: 'second' }, React.createElement('span', null, 'Second label')),
      ),
    ),
  );
  await flush();
  const engine = engines.at(-1),
    overlay = overlays.at(-1),
    mesh = [...engine.meshes.values()][0];
  assert.equal(overlays.length, before + 1);
  assert.equal(overlay.engine, engine);
  assert.equal(overlay.labels.size, 2);
  assert.equal(view.getByText('Mesh label').tagName, 'STRONG');
  assert.ok(view.getByText('Second label'));
  const first = [...overlay.labels].find((label) => label.element.querySelector('.first-label'));
  assert.ok(first);
  assert.equal(first.mesh, mesh);
  assert.deepEqual(first.offset, [0, 2, 0]);
  view.rerender(
    tree(
      React.createElement(
        Mesh,
        null,
        React.createElement(
          Margo.Html,
          { key: 'first', position: [0, 3, 0], className: 'first-label' },
          React.createElement('strong', null, 'Updated label'),
        ),
      ),
    ),
  );
  await flush();
  assert.equal(overlay.labels.size, 1);
  assert.equal(overlay.disposals, 0);
  assert.deepEqual(first.offset, [0, 3, 0]);
  assert.ok(view.getByText('Updated label'));
  assert.equal(overlays.length, before + 1);
  view.rerender(tree(null));
  await flush();
  assert.equal(engine.disposed, false);
  assert.equal(overlay.labels.size, 0);
  assert.equal(overlay.disposals, 1);
  view.unmount();
  assert.equal(overlay.labels.size, 0);
  assert.equal(overlay.disposals, 1);
  assert.equal(dom.window.document.body.textContent, '');
});

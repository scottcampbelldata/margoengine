import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode } from 'react';

// The optional packages' shapes: X.attach(engine, options) builds and attaches a plugin, dispose() detaches it.
const created = [];
function plugin(kind, extra = {}) {
  return class Plugin {
    static attach(engine, ...args) {
      const value = new Plugin();
      Object.assign(value, { kind, engine, args, disposals: 0, sources: new Set(), ...extra });
      value.name = kind + ':' + created.length;
      engine.use(value);
      created.push(value);
      return value;
    }
    add(source) {
      this.sources.add(source);
      return () => this.sources.delete(source);
    }
    dispose() {
      if (this.disposals) return;
      this.disposals++;
      this.engine.removePlugin(this.name);
    }
  };
}
const Batch = plugin('batch');
Object.assign(Batch.prototype, {
  add(geometry, options) {
    this.items ??= new Map();
    this.next ??= 0;
    this.items.set(this.next, { geometry, ...options, matrix: [...options.matrix] });
    return this.next++;
  },
  remove(id) {
    this.items.delete(id);
  },
  setMatrix(id, matrix) {
    this.items.get(id).matrix = [...matrix];
    return this;
  },
  setColor(id, color) {
    this.items.get(id).color = color;
    return this;
  },
  setVisible(id, visible) {
    this.items.get(id).visible = visible;
    return this;
  },
});
mock.module('@margoengine/materials/batched', { namedExports: { BatchedMesh: Batch } });
mock.module('@margoengine/materials', {
  namedExports: {
    Material: class {
      plain = true;
    },
  },
});
const Depth = plugin('depth', { texture: { name: 'depth' }, distance: { name: 'distance' } });
Depth.prototype.onResize = function (listener) {
  this.listeners ??= new Set();
  this.listeners.add(listener);
  return () => this.listeners.delete(listener);
};
mock.module('@margoengine/post/depth', { namedExports: { DepthTexture: Depth } });
mock.module('@margoengine/post/mrt', { namedExports: { SceneTargets: plugin('targets') } });
const Section = plugin('section');
mock.module('@margoengine/environment', {
  namedExports: {
    AmbientLight: plugin('ambient', { color: '#ffffff', intensity: 1 }),
    HemisphereLight: plugin('hemisphere', { sky: '#ffffff', ground: undefined, intensity: 1 }),
    Fog: plugin('fog', {
      color: '#ffffff',
      near: 1,
      far: 1000,
      density: 0,
      heightFalloff: 0,
      height: 0,
      enabled: true,
    }),
  },
});
const Renderer = plugin('voxels', { daylight: 1, blockLightColor: [1, 0.8, 0.6], lightmap: undefined });
const lightings = [];
mock.module('@margoengine/voxel/render', { namedExports: { VoxelRenderer: Renderer } });
mock.module('@margoengine/voxel/light', {
  namedExports: {
    VoxelLighting: {
      attach(world, options) {
        const lighting = {
          world,
          options,
          updates: 0,
          disposals: 0,
          update() {
            this.updates++;
          },
          dispose() {
            this.disposals++;
          },
        };
        lightings.push(lighting);
        return lighting;
      },
    },
  },
});
mock.module('@margoengine/machinery/section', {
  namedExports: {
    SectionPlanes: class extends Section {
      static attach(engine, options) {
        const value = super.attach(engine, options);
        value.options = options;
        value.enabled = true;
        return value;
      }
    },
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { Context } = await import('../dist/internal.js');
const { BatchedMesh, BatchedItem } = await import('@margoengine/react/materials');
const { DepthTexture, SceneTargets } = await import('@margoengine/react/post');
const { SectionPlanes } = await import('@margoengine/react/machinery');
const { Sun } = await import('@margoengine/react');
const { AmbientLight, HemisphereLight, Fog } = await import('@margoengine/react/environment');
const { Voxels } = await import('@margoengine/react/voxel');
const { render, act, cleanup } = await import('@testing-library/react');
const flush = () => act(async () => {});
const h = React.createElement;
const scenes = [];
function scene() {
  const plugins = new Map(),
    errors = [];
  const value = {
    engine: {
      backend: 'webgpu',
      disposed: false,
      onError: (error) => errors.push(error),
      plugins,
      use(effect) {
        assert.equal(plugins.has(effect.name), false);
        plugins.set(effect.name, effect);
      },
      removePlugin(name) {
        const effect = plugins.get(name);
        plugins.delete(name);
        effect?.dispose();
      },
      hasPlugin: (name) => plugins.has(name),
      lighting: {
        direction: new Float32Array([3, 5, 4, 3]),
        radiance: new Float32Array([1, 1, 1, 0.15]),
        ambient: new Float32Array([1, 1, 1]),
      },
    },
    resources: { models: new Set(), lighting: new Map() },
    frames: { callbacks: new Set() },
    shadows: null,
    requestShadows: () => () => {},
    errors,
  };
  scenes.push(value);
  return value;
}
const tree = (value, children) => h(StrictMode, null, h(Context.Provider, { value }, children));
afterEach(async () => {
  cleanup();
  await flush();
  for (const value of scenes) {
    assert.equal(value.engine.plugins.size, 0, 'every plugin detached');
    assert.equal(value.frames.callbacks.size, 0, 'every frame callback removed');
    assert.deepEqual(value.errors, []);
  }
  scenes.length = 0;
  assert.ok(created.every((value) => value.disposals >= 1));
});

test('BatchedMesh keeps one batch through prop changes and moves, tints, hides and removes items in place', async () => {
  const value = scene(),
    ref = React.createRef(),
    box = { positions: [0, 0, 0], normals: [0, 1, 0] },
    other = { positions: [1, 1, 1], normals: [0, 1, 0] };
  const items = (x, color, visible, geometry = box) => [
    h(BatchedItem, { key: 'a', geometry, position: [x, 0, 0], color, visible }),
    h(BatchedItem, { key: 'b', geometry: other, matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] }),
  ];
  const view = render(tree(value, h(BatchedMesh, { ref, maxItems: 4, maxVertices: 30 }, items(1, '#ff0000', true))));
  await flush();
  const batch = ref.current;
  assert.equal(batch.kind, 'batch');
  assert.equal(batch.args[0].plain, true, 'a default material');
  assert.deepEqual(batch.args[1], { maxItems: 4, maxVertices: 30, maxIndices: undefined, renderOrder: undefined });
  assert.equal(batch.items.size, 2);
  const [first, second] = batch.items.values();
  assert.equal(first.matrix[12], 1, 'position becomes the translation');
  assert.equal(second.matrix[0], 2, 'an explicit matrix is used as given');
  view.rerender(tree(value, h(BatchedMesh, { ref, maxItems: 4, maxVertices: 30 }, items(5, [0, 1, 0], false))));
  await flush();
  assert.equal(ref.current, batch, 'item changes keep the batch');
  assert.equal(batch.items.size, 2, 'and the items: no re-add');
  assert.equal(first.matrix[12], 5);
  assert.deepEqual(first.color, [0, 1, 0]);
  assert.equal(first.visible, false);
  view.rerender(
    tree(value, h(BatchedMesh, { ref, maxItems: 4, maxVertices: 30 }, items(5, [0, 1, 0], false).slice(1))),
  );
  await flush();
  assert.equal(batch.items.size, 1, 'an unmounted item is removed');
  view.rerender(tree(value, h(BatchedMesh, { ref, maxItems: 8, maxVertices: 30 })));
  await flush();
  assert.notEqual(ref.current, batch, 'a new capacity recreates the batch');
  assert.equal(batch.disposals, 1);
  assert.throws(
    () => render(h(BatchedItem, { geometry: box })),
    /BatchedItem is outside a BatchedMesh; render it inside <BatchedMesh>/,
  );
});

test('DepthTexture and SceneTargets add every PBR model, now and later, and recreate only on fixed options', async () => {
  const value = scene(),
    depth = React.createRef(),
    targets = React.createRef(),
    resized = [],
    first = { disposed: false },
    later = { disposed: false };
  value.resources.models.add(first);
  const children = (outputs) => [
    h(DepthTexture, { key: 'd', ref: depth, onResize: (d) => resized.push(d) }),
    h(SceneTargets, { key: 't', ref: targets, outputs }),
  ];
  const view = render(tree(value, children({ albedo: 'albedo' })));
  await flush();
  assert.deepEqual([...depth.current.sources], [first]);
  assert.deepEqual([...targets.current.sources], [first]);
  value.resources.models.add(later);
  for (const callback of value.frames.callbacks) callback(value.engine, 0);
  assert.deepEqual([...depth.current.sources], [first, later]);
  first.disposed = true;
  for (const callback of value.frames.callbacks) callback(value.engine, 0);
  assert.deepEqual([...targets.current.sources], [later]);
  for (const listener of depth.current.listeners) listener();
  assert.deepEqual(resized, [depth.current]);
  const kept = targets.current;
  view.rerender(tree(value, children({ albedo: 'albedo' })));
  await flush();
  assert.equal(targets.current, kept, 'equal outputs keep the targets');
  view.rerender(tree(value, children({ albedo: 'albedo', normal: 'normal' })));
  await flush();
  assert.notEqual(targets.current, kept, 'new outputs recreate them');
  assert.deepEqual(targets.current.args[0].outputs, { albedo: 'albedo', normal: 'normal' });
});

test('SectionPlanes moves planes live and recreates only when the plane count or cap options change', async () => {
  const value = scene(),
    ref = React.createRef();
  const view = render(tree(value, h(SectionPlanes, { ref, planes: [[1, 0, 0, 0]], color: '#00ff00' })));
  await flush();
  const section = ref.current;
  assert.deepEqual(section.options.planes, [[1, 0, 0, 0]]);
  assert.equal(section.options.color, '#00ff00');
  view.rerender(tree(value, h(SectionPlanes, { ref, planes: [[1, 0, 0, -2]], color: '#00ff00', enabled: false })));
  await flush();
  assert.equal(ref.current, section, 'new plane values keep the section');
  assert.deepEqual(section.options.planes, [[1, 0, 0, -2]]);
  assert.equal(section.enabled, false);
  view.rerender(
    tree(
      value,
      h(SectionPlanes, {
        ref,
        planes: [
          [1, 0, 0, -2],
          [0, 1, 0, 0],
        ],
        color: '#00ff00',
      }),
    ),
  );
  await flush();
  assert.notEqual(ref.current, section, 'a second plane recreates it');
  assert.equal(section.disposals, 1);
});

test('Sun sets the sun in linear colour and restores the previous sun on unmount', async () => {
  const value = scene(),
    lighting = value.engine.lighting;
  const view = render(tree(value, h(Sun, { direction: [0, 1, 0], color: '#ff0000', intensity: 2 })));
  await flush();
  assert.deepEqual([...lighting.direction], [0, 1, 0, 2]);
  assert.deepEqual([...lighting.radiance], [1, 0, 0, Math.fround(0.15)], 'sRGB red is linear red; ambient untouched');
  view.rerender(tree(value, h(Sun, { color: [0, 0.5, 0] })));
  await flush();
  assert.deepEqual([...lighting.direction], [3, 5, 4, 3], 'defaults');
  assert.deepEqual([...lighting.radiance].slice(0, 3), [0, 0.5, 0], 'a linear colour is used as given');
  view.unmount();
  await flush();
  assert.deepEqual([...lighting.direction], [3, 5, 4, 3]);
  assert.deepEqual([...lighting.radiance], [1, 1, 1, Math.fround(0.15)], 'the previous sun is back');
  // StrictMode runs the effect twice, so React reports both RangeErrors together.
  assert.throws(
    () => render(tree(value, h(Sun, { intensity: -1 }))),
    (error) => [error, ...(error.errors ?? [])].some((e) => /intensity must be a finite number/.test(e.message)),
  );
});

test('AmbientLight, HemisphereLight and Fog attach once, light every PBR model and take live props', async () => {
  const value = scene(),
    first = { disposed: false },
    ambient = React.createRef(),
    hemisphere = React.createRef(),
    fog = React.createRef();
  value.resources.models.add(first);
  const children = (props) => [
    h(AmbientLight, { key: 'a', ref: ambient, color: '#202020', intensity: props.intensity }),
    h(HemisphereLight, { key: 'h', ref: hemisphere, sky: '#88aaff', ground: '#443322' }),
    h(Fog, { key: 'f', ref: fog, color: '#ccddee', near: props.near, far: 80 }),
  ];
  const view = render(tree(value, children({ intensity: 0.5, near: 10 })));
  await flush();
  for (const light of [ambient.current, hemisphere.current, fog.current])
    assert.deepEqual([...light.sources], [first], `${light.kind} lights the PBR model`);
  assert.equal(ambient.current.intensity, 0.5);
  assert.equal(hemisphere.current.ground, '#443322');
  assert.equal(fog.current.near, 10);
  const kept = [ambient.current, hemisphere.current, fog.current];
  view.rerender(tree(value, children({ intensity: 2, near: undefined })));
  await flush();
  assert.deepEqual([ambient.current, hemisphere.current, fog.current], kept, 'prop changes keep the plugins');
  assert.equal(ambient.current.intensity, 2);
  assert.equal(fog.current.near, 1, 'a removed fog option returns to its default');
});

test('Voxels attaches the renderer and lighting, updates light from the frame loop, and keeps them through live props', async () => {
  const value = scene(),
    ref = React.createRef(),
    world = { name: 'world' },
    textures = { name: 'textures' };
  const view = render(tree(value, h(Voxels, { ref, world, textures, daylight: 0.4, fancyLeaves: false })));
  await flush();
  const renderer = ref.current,
    lighting = lightings.at(-1);
  assert.equal(renderer.kind, 'voxels');
  assert.deepEqual(renderer.args[0], {
    world,
    textures,
    workers: undefined,
    maxQuadBytes: undefined,
    fancyLeaves: false,
    bevel: undefined,
    daylight: 0.4,
    lightmap: undefined,
  });
  assert.equal(lighting.world, world, 'VoxelLighting lights the same world');
  for (const callback of value.frames.callbacks) callback(value.engine, 0.016);
  assert.equal(lighting.updates, 1, 'light updates run from the Canvas frame loop');
  view.rerender(
    tree(value, h(Voxels, { ref, world, textures, daylight: 0.1, blockLightColor: [1, 0.5, 0.2], fancyLeaves: false })),
  );
  await flush();
  assert.equal(ref.current, renderer, 'live props keep the renderer');
  assert.equal(renderer.daylight, 0.1);
  assert.deepEqual(renderer.blockLightColor, [1, 0.5, 0.2]);
  view.rerender(tree(value, h(Voxels, { ref, world, textures, fancyLeaves: true, lighting: false })));
  await flush();
  assert.notEqual(ref.current, renderer, 'a construction option recreates it');
  assert.equal(renderer.disposals, 1);
  assert.equal(lighting.disposals, 1, 'and disposes its lighting');
  assert.equal(lightings.at(-1), lighting, 'lighting: false attaches none');
  assert.equal(value.frames.callbacks.size, 0);
});

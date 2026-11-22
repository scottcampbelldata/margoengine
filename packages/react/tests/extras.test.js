import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode } from 'react';

// The optional packages' shapes: X.attach(engine, options) builds and attaches a plugin, dispose() detaches it.
const created = [];
function plugin(kind, extra = {}) {
  return class Plugin {
    // `new X()` then `scene.use(x)` (how a binding attaches to the enclosing Scene) or `X.attach(engine, ...args)`.
    constructor() {
      Object.assign(this, { kind, args: [], disposals: 0, sources: new Set(), ...extra });
      this.name = kind + ':' + created.length;
      created.push(this);
    }
    static attach(engine, ...args) {
      const value = new Plugin();
      value.args = args;
      engine.use(value);
      return value;
    }
    add(source) {
      this.sources.add(source);
      return () => this.sources.delete(source);
    }
    dispose() {
      if (this.disposals) return;
      this.disposals++;
      this.owner.removePlugin(this.name);
    }
  };
}
// A plugin owner (the default scene or a named one): `use` records the owner, as core's sceneOf does.
function owner(target) {
  const plugins = new Map();
  return Object.assign(target, {
    plugins,
    use(effect) {
      assert.equal(plugins.has(effect.name), false);
      plugins.set(effect.name, effect);
      effect.owner = target;
      effect.engine ??= target.engine ?? target;
    },
    removePlugin(name) {
      const effect = plugins.get(name);
      plugins.delete(name);
      effect?.dispose();
    },
    hasPlugin: (name) => plugins.has(name),
  });
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
const environmentMock = {
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
};
// The bindings import /main and /load (KB-REACT-ENVDECODERS1); mock every specifier they may use.
for (const id of [
  '@margoengine/environment',
  '@margoengine/environment/main',
  '@margoengine/environment/loaders',
  '@margoengine/environment/load',
])
  mock.module(id, environmentMock);
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
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { Context } = await import('../dist/internal.js');
const { BatchedMesh, BatchedItem } = await import('@margoengine/react/materials');
const { DepthTexture, SceneTargets } = await import('@margoengine/react/post');
const { Sun } = await import('@margoengine/react');
const { AmbientLight, HemisphereLight, Fog } = await import('@margoengine/react/environment');
const { Voxels } = await import('@margoengine/react/voxel');
const { render, act, cleanup } = await import('@testing-library/react');
const flush = () => act(async () => {});
const h = React.createElement;
const scenes = [];
function scene() {
  const errors = [];
  const value = {
    engine: owner({
      backend: 'webgpu',
      disposed: false,
      onError: (error) => errors.push(error),
      lighting: {
        direction: new Float32Array([3, 5, 4, 3]),
        radiance: new Float32Array([1, 1, 1, 0.15]),
        ambient: new Float32Array([1, 1, 1]),
      },
    }),
    world: null,
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

test('AmbientLight, HemisphereLight and Fog inside a <Scene> light that scene, not the default one', async () => {
  const value = scene(),
    world = owner({ engine: value.engine }),
    model = { disposed: false },
    lights = [React.createRef(), React.createRef(), React.createRef()];
  value.resources.models.add(model);
  render(
    tree({ ...value, world }, [
      h(AmbientLight, { key: 'a', ref: lights[0], intensity: 0.4 }),
      h(HemisphereLight, { key: 'h', ref: lights[1], sky: '#88aaff' }),
      h(Fog, { key: 'f', ref: lights[2], far: 50 }),
    ]),
  );
  await flush();
  assert.equal(value.engine.plugins.size, 0, 'nothing in the default scene');
  assert.deepEqual(
    [...world.plugins.values()],
    lights.map((ref) => ref.current),
    'each in the named scene',
  );
  for (const ref of lights)
    assert.equal(ref.current.sources.size, 0, `${ref.current.kind} leaves default-scene models alone`);
  assert.equal(lights[0].current.intensity, 0.4, 'live props still apply');
  cleanup();
  await flush();
  assert.equal(world.plugins.size, 0, 'unmount detaches them from the named scene');
});

test('BatchedMesh and Voxels inside a <Scene> attach their plugin to that scene, not the default one', async () => {
  const value = scene(),
    world = owner({ engine: value.engine }),
    base = value.engine.use,
    batch = React.createRef(),
    voxels = React.createRef();
  // Core's scene scope: while a scene sets a plugin up, `engine.use` adds to that scene.
  let active = null;
  value.engine.use = (effect) => (active ? active.use(effect) : base.call(value.engine, effect));
  const use = world.use;
  world.use = (effect) => {
    const outer = active;
    active = world;
    try {
      use(effect);
      effect.setup?.(value.engine);
    } finally {
      active = outer;
    }
  };
  world.removePlugin = (name) => {
    const effect = world.plugins.get(name);
    world.plugins.delete(name);
    effect?.dispose?.();
  };
  value.world = world;
  render(
    tree(value, [
      h(BatchedMesh, { key: 'b', ref: batch, maxItems: 2, maxVertices: 9 }),
      h(Voxels, {
        key: 'v',
        ref: voxels,
        world: { name: 'voxel world' },
        textures: { name: 'textures' },
        lighting: false,
      }),
    ]),
  );
  await flush();
  assert.equal(value.engine.plugins.size, 0, 'nothing in the default scene');
  assert.deepEqual([...world.plugins.values()], [batch.current, voxels.current], 'both in the named scene');
  cleanup();
  await flush();
  assert.equal(world.plugins.size, 0, 'unmount removes them from the named scene');
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

test('DepthTexture and SceneTargets inside a <Scene> attach to that scene and leave the default scene models alone', async () => {
  const value = scene(),
    world = owner({ engine: value.engine }),
    base = value.engine.use;
  // Core's scene scope: while a scene sets a plugin up, `engine.use` adds to that scene.
  let active = null;
  value.engine.use = (effect) => (active ? active.use(effect) : base.call(value.engine, effect));
  const use = world.use;
  world.use = (effect) => {
    const outer = active;
    active = world;
    try {
      use(effect);
      effect.setup?.(value.engine);
    } finally {
      active = outer;
    }
  };
  world.removePlugin = (name) => {
    const effect = world.plugins.get(name);
    world.plugins.delete(name);
    effect?.dispose?.();
  };
  value.world = world;
  value.resources.models.add({ disposed: false });
  const view = render(tree(value, [h(DepthTexture, { key: 'd' }), h(SceneTargets, { key: 't', outputs: ['normal'] })]));
  await flush();
  assert.equal(value.engine.plugins.size, 0, 'nothing in the default scene');
  const inWorld = [...world.plugins.values()];
  assert.deepEqual(
    inWorld.map((plugin) => plugin.kind),
    ['depth', 'targets'],
    'both in the named scene',
  );
  for (const plugin of inWorld) assert.equal(plugin.sources.size, 0, 'the default scene models are left alone');
  view.unmount();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.plugins.size, 0, 'unmount removes them from the named scene');
});

test('SpriteLayer and Figure inside a <Scene> draw in that scene, not the default one', async () => {
  mock.module('@margoengine/sprites', { namedExports: { SpriteLayer: plugin('sprites') } });
  mock.module('@margoengine/sciviz', { namedExports: { Figure: plugin('figure', { ready: async () => {} }) } });
  const { SpriteLayer, Figure } = await import('@margoengine/react/ui');
  const value = scene(),
    world = owner({ engine: value.engine }),
    base = value.engine.use;
  // Core's scene scope: while a scene sets a plugin up, `engine.use` adds to that scene.
  let active = null;
  value.engine.use = (effect) => (active ? active.use(effect) : base.call(value.engine, effect));
  const use = world.use;
  world.use = (effect) => {
    const outer = active;
    active = world;
    try {
      use(effect);
      effect.setup?.(value.engine);
    } finally {
      active = outer;
    }
  };
  world.removePlugin = (name) => {
    const effect = world.plugins.get(name);
    world.plugins.delete(name);
    effect?.dispose?.();
  };
  value.world = world;
  const view = render(
    tree(value, [
      h(SpriteLayer, { key: 's', atlas: { width: 1, height: 1, data: new Uint8Array(4) } }),
      h(Figure, { key: 'f' }),
    ]),
  );
  await flush();
  assert.equal(value.engine.plugins.size, 0, 'nothing in the default scene');
  assert.deepEqual(
    [...world.plugins.values()].map((plugin) => plugin.kind),
    ['sprites', 'figure'],
    'both in the named scene',
  );
  view.unmount();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.plugins.size, 0, 'unmount removes them from the named scene');
});

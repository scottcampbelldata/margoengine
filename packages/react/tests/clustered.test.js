import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode } from 'react';

// The natives are replaced by recorders: what these tests prove is the binding (one shared lighting per Canvas or
// Scene, the combined light list, the lifetime). The native light maths has its own tests in packages/clustered.
const made = { clustered: [], area: [] };
class FakeClustered {
  static fail = false;
  name = 'clustered';
  calls = [];
  models = new Set();
  disposals = 0;
  casters = new Set();
  constructor(options) {
    if (FakeClustered.fail) throw new Error('Clustered cannot be created');
    if (options?.maxLights < 1) throw new RangeError('Invalid maxLights');
    this.options = options;
    made.clustered.push(this);
  }
  addShadowCaster(source) {
    if (source.refused) throw new TypeError('Invalid local shadow source');
    assert.equal(this.casters.has(source), false, 'a caster is added once');
    this.casters.add(source);
    return () => this.casters.delete(source);
  }
  setLights(list) {
    if (list.some((light) => light.intensity < 0)) throw new RangeError('Invalid light intensity');
    this.calls.push(list);
    return this;
  }
  add(model) {
    assert.equal(this.models.has(model), false, 'a model is added once');
    this.models.add(model);
    return () => this.models.delete(model);
  }
  dispose() {
    this.disposals++;
  }
}
class FakeArea {
  name = 'clustered:area';
  calls = [];
  disposals = 0;
  constructor(options) {
    this.lights = options.lights;
    made.area.push(this);
  }
  setLights(list) {
    this.calls.push(list);
    return this;
  }
  dispose() {
    this.disposals++;
  }
}
mock.module('@margoengine/clustered', { namedExports: { Clustered: FakeClustered } });
mock.module('@margoengine/clustered/area', { namedExports: { AreaLights: FakeArea } });
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { Context } = await import('../dist/internal.js');
const { ClusteredLighting, PointLight, SpotLight, RectAreaLight } = await import('../dist/clustered.js');
const { casters } = await import('../dist/casters.js');
const { render, act, cleanup } = await import('@testing-library/react');
const flush = async () => {
  await act(async () => {});
  await act(async () => {});
};
const h = React.createElement;
const scenes = [];
function owner(plugins) {
  return {
    use(plugin) {
      assert.equal(plugins.has(plugin.name), false, `${plugin.name} is attached once`);
      plugins.set(plugin.name, plugin);
      return this;
    },
    removePlugin(name) {
      plugins.get(name)?.dispose();
      plugins.delete(name);
    },
  };
}
function scene(named = false) {
  const plugins = new Map(),
    errors = [];
  const base = owner(plugins);
  const value = {
    engine: { ...base, disposed: false, onError: (error) => errors.push(error), plugins },
    world: named ? { ...owner(plugins), plugins } : null,
    resources: { models: new Set(), lighting: new Map() },
    frames: { callbacks: new Set() },
    errors,
    plugins,
  };
  scenes.push(value);
  return value;
}
const tree = (value, children) => h(StrictMode, null, h(Context.Provider, { value }, children));
afterEach(async () => {
  cleanup();
  await flush();
  for (const value of scenes.splice(0)) {
    assert.equal(value.plugins.size, 0, 'no plugin stays attached');
    assert.equal(value.frames.callbacks.size, 0);
  }
  made.clustered.length = made.area.length = 0;
  FakeClustered.fail = false;
});

test('point and spot lights share one Clustered per Canvas and hand it one list, colours linear', async () => {
  const value = scene();
  render(
    tree(value, [
      h(PointLight, { key: 'a', position: [1, 2, 3], color: '#ff0000', intensity: 4, range: 10 }),
      h(PointLight, { key: 'b' }),
      h(SpotLight, { key: 'c', direction: [0, 0, -1], angle: 0.5, penumbra: 0.25, color: [0.1, 0.2, 0.3] }),
    ]),
  );
  await flush();
  assert.equal(made.clustered.length, 1, 'StrictMode and three lights make one lighting');
  const [lights] = made.clustered;
  assert.equal(lights.calls.length, 1, 'the mount sets the list once');
  assert.deepEqual(lights.calls[0], [
    { position: [1, 2, 3], range: 10, color: [1, 0, 0], intensity: 4, decay: 2, radius: 0 },
    { position: [0, 0, 0], range: 0, color: [1, 1, 1], intensity: 1, decay: 2, radius: 0 },
    {
      position: [0, 0, 0],
      direction: [0, 0, -1],
      range: 0,
      color: [0.1, 0.2, 0.3],
      intensity: 1,
      decay: 2,
      radius: 0,
      angle: 0.5,
      penumbra: 0.25,
    },
  ]);
  assert.deepEqual(value.errors, []);
});

test('a prop change, an added light and a removed light update the list in place', async () => {
  const value = scene();
  const child = (intensity, extra) => [
    h(PointLight, { key: 'a', intensity }),
    ...(extra ? [h(SpotLight, { key: 'b' })] : []),
  ];
  const view = render(tree(value, child(1, false)));
  await flush();
  const [lights] = made.clustered;
  view.rerender(tree(value, child(3, false)));
  await flush();
  assert.equal(lights.calls.at(-1)[0].intensity, 3);
  view.rerender(tree(value, child(3, true)));
  await flush();
  assert.equal(lights.calls.at(-1).length, 2);
  view.rerender(tree(value, child(3, false)));
  await flush();
  assert.equal(lights.calls.at(-1).length, 1);
  assert.equal(made.clustered.length, 1);
  view.unmount();
  await flush();
  assert.equal(value.plugins.size, 0);
  assert.ok(lights.disposals >= 1);
});

test('rect area lights go to AreaLights on the same Clustered, and it goes with the last one', async () => {
  const value = scene();
  const child = (rect) => [
    h(PointLight, { key: 'p' }),
    ...(rect ? [h(RectAreaLight, { key: 'r', width: 2, height: 3, twoSided: true, color: '#00ff00' })] : []),
  ];
  const view = render(tree(value, child(true)));
  await flush();
  assert.equal(made.area.length, 1);
  const [area] = made.area;
  assert.equal(area.lights, made.clustered[0]);
  assert.deepEqual(area.calls.at(-1), [
    { position: [0, 0, 0], direction: [0, -1, 0], width: 2, height: 3, color: [0, 1, 0], intensity: 1, twoSided: true },
  ]);
  assert.equal(made.clustered[0].calls.at(-1).length, 1, 'point lights stay on Clustered');
  view.rerender(tree(value, child(false)));
  await flush();
  assert.deepEqual(area.calls.at(-1), [], 'a removed rect light leaves the list');
  view.unmount();
  await flush();
  assert.ok(area.disposals >= 1 && made.clustered[0].disposals >= 1);
  assert.equal(value.plugins.size, 0);
  // A new light after teardown builds a new lighting.
  render(tree(value, h(PointLight, { key: 'again' })));
  await flush();
  assert.equal(made.clustered.length, 2);
});

// A PBR model as the bindings see it: addLighting returns its remover.
function model() {
  const lit = new Set();
  return {
    lit,
    addLighting(effect) {
      assert.equal(lit.has(effect), false, 'a lighting is added once');
      lit.add(effect);
      return () => lit.delete(effect);
    },
  };
}
test("the Canvas's PBR models take the lights through the lighting registry; a named Scene's do not", async () => {
  const value = scene(),
    first = model();
  value.resources.models.add(first);
  render(tree(value, h(PointLight, { key: 'a' })));
  await flush();
  const [lights] = made.clustered;
  assert.deepEqual([...first.lit], [lights], 'a model already loaded is lit');
  // A model that loads later is lit by the binding that loads it, from the registry.
  const registered = value.resources.lighting.get(lights);
  assert.ok(registered.has(first));
  cleanup();
  await flush();
  assert.equal(first.lit.size, 0, 'the last light unmounting unlights the models');
  assert.equal(value.resources.lighting.size, 0, 'and leaves the registry');
  const named = scene(true),
    other = model();
  named.resources.models.add(other);
  render(tree(named, h(PointLight, { key: 'a' })));
  await flush();
  assert.equal(other.lit.size, 0);
  assert.equal(named.resources.lighting.size, 0);
  assert.ok(named.world.plugins.has('clustered'), 'a named Scene attaches its own lighting to its world');
});

test('an invalid light list and a lighting that cannot load reach onError and the engine', async () => {
  const value = scene(),
    errors = [];
  render(tree(value, h(PointLight, { key: 'a', intensity: -1, onError: (error) => errors.push(error) })));
  await flush();
  assert.equal(errors.length > 0 && value.errors.length > 0, true);
  assert.match(errors[0].message, /Invalid light intensity/);
  cleanup();
  await flush();
  const broken = scene(),
    reported = [];
  FakeClustered.fail = true;
  render(tree(broken, h(PointLight, { key: 'a', onError: (error) => reported.push(error) })));
  await flush();
  assert.match(reported[0].message, /cannot be created/);
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.plugins.size, 0);
});

test('without ClusteredLighting, and with one that sets nothing, Clustered gets no option: its own defaults apply', async () => {
  const value = scene();
  const view = render(tree(value, h(PointLight, { key: 'a' })));
  await flush();
  assert.deepEqual(made.clustered[0].options, {});
  view.rerender(tree(value, [h(ClusteredLighting, { key: 'l' }), h(PointLight, { key: 'a' })]));
  await flush();
  assert.equal(made.clustered.length, 1, 'no option set: the lighting stays');
  assert.equal(made.clustered[0].disposals, 0);
  assert.equal(value.frames.callbacks.size, 0, 'no shadow maps, no caster sync');
});

test('ClusteredLighting hands grid, maxLights and shadows to Clustered as given', async () => {
  const value = scene();
  render(
    tree(value, [
      h(ClusteredLighting, {
        key: 'l',
        grid: [8, 6, 12],
        maxLights: 4096,
        shadows: { resolution: 1024, maxLights: 2 },
      }),
      h(SpotLight, { key: 'a' }),
    ]),
  );
  await flush();
  assert.equal(made.clustered.length, 1, 'StrictMode makes one lighting');
  assert.deepEqual(made.clustered[0].options, {
    grid: [8, 6, 12],
    maxLights: 4096,
    shadows: { resolution: 1024, maxLights: 2 },
  });
  cleanup();
  await flush();
  const plain = scene();
  render(tree(plain, [h(PointLight, { key: 'a' }), h(ClusteredLighting, { key: 'l', shadows: true })]));
  await flush();
  assert.deepEqual(made.clustered.at(-1).options, { shadows: {} }, 'shadows: true is the engine default maps');
});

test('a changed option, and ClusteredLighting unmounting, make the lighting again with the same lights', async () => {
  const value = scene(),
    lit = model();
  value.resources.models.add(lit);
  const child = (maxLights) => [
    ...(maxLights ? [h(ClusteredLighting, { key: 'l', maxLights })] : []),
    h(PointLight, { key: 'p', intensity: 5 }),
    h(RectAreaLight, { key: 'r' }),
  ];
  const view = render(tree(value, child(2048)));
  await flush();
  const [first] = made.clustered;
  view.rerender(tree(value, child(2048)));
  await flush();
  assert.equal(made.clustered.length, 1, 'the same options keep the lighting');
  view.rerender(tree(value, child(8192)));
  await flush();
  assert.equal(made.clustered.length, 2);
  const second = made.clustered[1];
  assert.ok(first.disposals >= 1 && made.area[0].disposals >= 1, 'the old lighting and its area lights are disposed');
  assert.deepEqual(second.options, { maxLights: 8192 });
  assert.equal(second.calls.at(-1)[0].intensity, 5, 'the lights are set on the new one');
  assert.equal(made.area.at(-1).lights, second, 'the area lights follow');
  assert.equal(made.area.at(-1).calls.at(-1).length, 1);
  assert.deepEqual([...lit.lit], [second], 'the models are lit by the new one only');
  assert.equal(value.plugins.get('clustered'), second);
  view.rerender(tree(value, child(0)));
  await flush();
  assert.equal(made.clustered.length, 3);
  assert.deepEqual(made.clustered[2].options, {}, 'unmounted: back to the defaults');
  assert.deepEqual(value.errors, []);
});

test('ClusteredLighting alone makes no lighting; its options reach the one the first light makes', async () => {
  const value = scene();
  const child = (light) => [
    h(ClusteredLighting, { key: 'l', maxLights: 2 }),
    ...(light ? [h(PointLight, { key: 'p' })] : []),
  ];
  const view = render(tree(value, child(false)));
  await flush();
  assert.equal(made.clustered.length, 0);
  view.rerender(tree(value, child(true)));
  await flush();
  assert.deepEqual(made.clustered[0].options, { maxLights: 2 });
  view.rerender(tree(value, child(false)));
  await flush();
  assert.equal(value.plugins.size, 0, 'the last light unmounting removes the lighting');
  view.rerender(tree(value, child(true)));
  await flush();
  assert.deepEqual(made.clustered[1].options, { maxLights: 2 }, 'and a later light gets the options again');
});

test('a light shadow reaches the list as given, and is left out when unset or false', async () => {
  const value = scene();
  render(
    tree(value, [
      h(ClusteredLighting, { key: 'l', shadows: true }),
      h(PointLight, { key: 'a', range: 9, shadow: true }),
      h(SpotLight, { key: 'b', shadow: { near: 0.2, far: 8, bias: 0.001, normalBias: 0.05, resolution: [256, 128] } }),
      h(PointLight, { key: 'c', shadow: false }),
    ]),
  );
  await flush();
  const [a, b, c] = made.clustered[0].calls.at(-1);
  assert.equal(a.shadow, true);
  assert.deepEqual(b.shadow, { near: 0.2, far: 8, bias: 0.001, normalBias: 0.05, resolution: [256, 128] });
  assert.equal('shadow' in c, false);
});

test("with shadows, the Canvas's castShadow meshes and models cast until they leave or the lighting goes", async () => {
  const value = scene(),
    set = casters(value.engine),
    source = { shadowPrimitives: [] },
    refused = { shadowPrimitives: [], refused: true },
    errors = [];
  set.add(source);
  set.add(refused);
  const frame = () => {
    for (const callback of [...value.frames.callbacks]) callback(value.engine, 0.016);
  };
  const child = (shadows) => [
    h(ClusteredLighting, { key: 'l', shadows, onError: (error) => errors.push(error) }),
    h(PointLight, { key: 'p', range: 5, shadow: shadows }),
  ];
  const view = render(tree(value, child(true)));
  await flush();
  const [lights] = made.clustered;
  frame();
  frame();
  assert.deepEqual([...lights.casters], [source]);
  assert.equal(errors.length, 1, 'a refused caster is reported once, not every frame');
  assert.match(errors[0].message, /Invalid local shadow source/);
  const later = { shadowPrimitives: [] };
  set.add(later);
  set.delete(source);
  frame();
  assert.deepEqual([...lights.casters], [later]);
  view.rerender(tree(value, child(false)));
  await flush();
  assert.equal(lights.casters.size, 0, 'the casters leave with the lighting that had the maps');
  assert.equal(value.frames.callbacks.size, 0);
  assert.equal(made.clustered[1].casters.size, 0);
  set.clear();
});

test('an invalid option reaches the onError of ClusteredLighting; a valid one then makes the lighting', async () => {
  const value = scene(),
    errors = [];
  const child = (maxLights) => [
    h(ClusteredLighting, { key: 'l', maxLights, onError: (error) => errors.push(error) }),
    h(PointLight, { key: 'p' }),
  ];
  const view = render(tree(value, child(0)));
  await flush();
  assert.match(errors[0].message, /Invalid maxLights/);
  assert.equal(made.clustered.length, 0);
  assert.equal(value.plugins.size, 0);
  view.rerender(tree(value, child(16)));
  await flush();
  assert.deepEqual(made.clustered[0].options, { maxLights: 16 });
  assert.equal(made.clustered[0].calls.at(-1).length, 1);
});

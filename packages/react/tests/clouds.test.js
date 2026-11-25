// <Clouds> and <Cloud> on a real core engine with the real @margoengine/vfx/clouds plugin (its GPU draw has its own
// suite, packages/vfx/test/clouds-check.mjs) and the scene depth of @margoengine/post replaced by a recorder.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { JSDOM } from 'jsdom';
const depths = [];
class FakeDepth {
  static attach(engine) {
    const made = new FakeDepth();
    made.engine = engine;
    depths.push(made);
    return made;
  }
  texture = { label: 'scene depth' };
  disposed = false;
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/post/depth', { namedExports: { DepthTexture: FakeDepth } });
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { optionalGPU } = await import('../../../tests/support/optional-gpu.js');
const { Context } = await import('../dist/internal.js');
const { createAssetCache } = await import('../dist/assets.js');
const { Clouds, Cloud } = await import('../dist/clouds.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  // Clouds is WebGPU only and refuses the small WebGL2 preview, so the scene has a WebGPU-shaped engine (the fake GPU).
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: optionalGPU().engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const value = {
    engine,
    world: null,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
    assetCache: createAssetCache(engine),
  };
  scenes.push(value);
  return value;
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) s.engine.dispose();
  scenes.length = 0;
  depths.length = 0;
});
const frames = async (s, n = 3) => {
  for (let i = 0; i < n; i++)
    await act(async () => {
      for (const callback of [...s.frames.callbacks]) callback(s.engine, 1 / 60);
    });
};

test('Clouds draws every child Cloud with one native Clouds; options, seeds and world matrices follow the props', async () => {
  const s = await scene(),
    ready = [];
  const ui = (x, segments, color) =>
    tree(
      s,
      h(
        Clouds,
        { limit: 50, material: 'unlit', position: [0, 10, 0], onReady: (c) => ready.push(c) },
        h(Cloud, { position: [x, 0, 0], segments, color, speed: 0.4 }),
        h(Cloud, { bounds: [2, 2, 2], seed: 7 }),
      ),
    );
  const view = render(ui(3, 8, '#ff0000'));
  await frames(s);
  const clouds = ready.at(-1);
  assert.equal(
    [...s.engine.plugins.values()].filter((p) => p.name.startsWith('clouds:')).length,
    1,
    'one native Clouds',
  );
  assert.equal(clouds.options.limit, 50);
  assert.equal(clouds.options.shading, 'unlit');
  assert.equal(clouds.clouds.length, 2);
  const [first, second] = clouds.clouds;
  assert.equal(first.options.segments, 8);
  assert.equal(first.options.color, '#ff0000');
  assert.equal(second.options.seed, 7);
  assert.equal(typeof first.options.seed, 'number', 'a Cloud with no seed gets a stable one');
  const seed = first.options.seed;
  assert.deepEqual([...first.matrix.slice(12, 15)], [3, 10, 0], 'world position: the Cloud inside the Clouds group');
  view.rerender(ui(-2, 12, '#00ff00'));
  await frames(s);
  assert.equal(clouds.clouds[0].options.segments, 12);
  assert.equal(clouds.clouds[0].options.seed, seed, 'the seed stays');
  assert.deepEqual([...clouds.clouds[0].matrix.slice(12, 15)], [-2, 10, 0]);
  assert.equal(clouds.puffs().length, 12 + 20);
  view.unmount();
  assert.equal(clouds.clouds.length, 0);
});

test('a Cloud on its own makes its own Clouds', async () => {
  const s = await scene();
  const view = render(tree(s, h(Cloud, { segments: 4, position: [1, 2, 3] })));
  await frames(s);
  const attached = [...s.engine.plugins.values()].filter((p) => p.name.startsWith('clouds:'));
  assert.equal(attached.length, 1, 'one clouds plugin on the engine');
  assert.equal(attached[0].clouds.length, 1);
  assert.equal(attached[0].clouds[0].options.segments, 4);
  assert.deepEqual([...attached[0].clouds[0].matrix.slice(12, 15)], [1, 2, 3]);
  view.unmount();
  assert.equal([...s.engine.plugins.values()].filter((p) => p.name.startsWith('clouds:')).length, 0, 'released');
});

test('a texture URL draws nothing until it decodes; softness adds the scene depth', async () => {
  const s = await scene(),
    ready = [];
  let resolve;
  const bitmap = { width: 2, height: 2 };
  globalThis.fetch = mock.fn(async () => ({ ok: true, blob: async () => 'blob' }));
  globalThis.createImageBitmap = mock.fn(() => new Promise((r) => (resolve = r)));
  render(
    tree(
      s,
      h(Clouds, { texture: '/puff.png', softness: 0.5, onReady: (c) => ready.push(c) }, h(Cloud, { segments: 3 })),
    ),
  );
  await frames(s);
  const clouds = ready.at(-1);
  assert.equal(clouds.options.range, 0, 'nothing drawn while the texture loads');
  assert.equal(globalThis.fetch.mock.calls[0].arguments[0], '/puff.png');
  await act(async () => resolve(bitmap));
  await frames(s);
  assert.equal(clouds.options.texture, bitmap);
  assert.equal(clouds.options.range, undefined);
  assert.equal(clouds.options.softness, 0.5);
  const live = depths.filter((d) => !d.disposed);
  assert.equal(live.length, 1);
  assert.equal(clouds.options.depth(), live[0].texture);
  delete globalThis.fetch;
  delete globalThis.createImageBitmap;
});

test('a texture URL loads through the Canvas tracker, and each decoded bitmap is closed once it is no longer drawn (KB-REACT-CLOUDS-TEXTURE)', async () => {
  const s = await scene(),
    ready = [],
    made = [];
  globalThis.fetch = mock.fn(async () => ({ ok: true, status: 200, headers: new Map(), blob: async () => 'blob' }));
  globalThis.createImageBitmap = mock.fn(async () => {
    const bitmap = {
      width: 2,
      height: 2,
      closed: 0,
      close() {
        this.closed++;
      },
    };
    made.push(bitmap);
    return bitmap;
  });
  const props = (texture) => h(Clouds, { texture, onReady: (c) => ready.push(c) }, h(Cloud, { segments: 3 }));
  const view = render(tree(s, props('/a.png')));
  await frames(s);
  const clouds = ready.at(-1),
    first = clouds.options.texture;
  assert.ok(made.includes(first), 'the decoded bitmap is drawn');
  assert.ok(s.assetCache.tracker.state.total >= 1, 'useProgress counted the texture load');
  assert.equal(first.closed, 0, 'not closed while drawn');
  view.rerender(tree(s, props('/b.png')));
  await frames(s);
  const second = clouds.options.texture;
  assert.notEqual(second, first);
  assert.equal(first.closed, 1, 'the replaced bitmap is closed once');
  assert.equal(second.closed, 0);
  view.unmount();
  assert.equal(second.closed, 1, 'unmount closes the last one');
  assert.ok(
    made.every((b) => b.closed === 1),
    'every decoded bitmap closed exactly once',
  );
  delete globalThis.fetch;
  delete globalThis.createImageBitmap;
});

test('Clouds inside a named <Scene> attaches its native Clouds to that scene, not the default one', async () => {
  const s = await scene(),
    world = s.engine.createScene('item'),
    ready = [];
  s.world = world;
  render(tree(s, h(Clouds, { onReady: (c) => ready.push(c) }, h(Cloud, {}))));
  await frames(s);
  const named = (plugins) => [...plugins.values()].filter((p) => p.name.startsWith('clouds:'));
  assert.equal(named(world.plugins).length, 1, 'the native Clouds is in the named scene');
  assert.equal(named(s.engine.plugins).length, 0, 'none in the default scene');
  cleanup();
  assert.equal(named(world.plugins).length, 0, 'unmount removes it from the named scene');
});

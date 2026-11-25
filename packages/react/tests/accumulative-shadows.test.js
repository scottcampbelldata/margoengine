// <AccumulativeShadows> and <RandomizedLight> on a real core engine with the studio catcher replaced by a recorder (its
// GPU accumulation has its own suites): drei's props mapped onto AmbientShadows, the Canvas's castShadow meshes added as
// casters, live props, the ref and invalid input.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const made = [];
class FakeShadows {
  static attach(engine, options) {
    const shadows = new FakeShadows(options);
    made.push(shadows);
    return shadows;
  }
  constructor(options) {
    this.options = { ...options };
    this.casters = new Set();
    this.invalidated = 0;
    this.disposed = false;
  }
  add(target) {
    assert.ok(!this.casters.has(target), 'each caster once');
    this.casters.add(target);
    return () => this.casters.delete(target);
  }
  invalidate() {
    this.invalidated++;
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/studio/accumulate-ambient', { namedExports: { AmbientShadows: FakeShadows } });
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { AccumulativeShadows, RandomizedLight, accumulativeOptions } = await import('../dist/accumulative-shadows.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  const canvas = document.createElement('canvas'),
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
    });
  const value = {
    engine,
    world: null,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
  };
  scenes.push(value);
  return value;
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) s.engine.dispose();
  scenes.length = 0;
  made.length = 0;
});
const frames = async (s, n = 3) => {
  for (let i = 0; i < n; i++)
    await act(async () => {
      for (const callback of [...s.frames.callbacks]) callback(s.engine, 1 / 60);
    });
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const light = (o = {}) => ({
  position: [5, 5, -10],
  radius: 5,
  amount: 8,
  intensity: 1,
  ambient: 0.5,
  bias: 0,
  mapSize: 512,
  size: 10,
  near: 0.5,
  far: 500,
  ...o,
});

test('drei props map onto the studio catcher: directional lights far along their direction, frames times amount', () => {
  const m = identity.slice();
  m[12] = 1;
  m[14] = 2;
  const o = accumulativeOptions(m, [light()], { scale: 6 });
  assert.deepEqual(o.position, [1, 0, 2]);
  assert.deepEqual(o.up, [0, 1, 0]);
  assert.equal(o.size, 6);
  const reach = 999 * Math.hypot(5, 5, -10);
  assert.deepEqual(o.lights, [
    {
      position: [5001, 5000, -9998],
      radius: 5000,
      intensity: 1,
      bias: 0,
      size: 10,
      mapSize: 512,
      near: 0.5 + reach,
      far: 500 + reach,
    },
  ]);
  assert.equal(o.samples, 8, 'drei takes every light sample of a frame in one rendered frame');
  assert.equal(o.alphaTest, 0.65);
  assert.equal(o.colorBlend, 2);
  assert.equal(o.toneMapped, true);
  const tuned = accumulativeOptions(identity, [light({ bias: 0.001, near: 1, far: 11 })], {
    alphaTest: 0.2,
    colorBlend: 0,
    toneMapped: false,
  });
  assert(Math.abs(tuned.lights[0].bias - 0.01) < 1e-12, 'bias in normalized depth: 0.001 x (11 - 1)');
  assert.deepEqual([tuned.alphaTest, tuned.colorBlend, tuned.toneMapped], [0.2, 0, false]);
  assert.equal(o.height, 0.999 * 5000, 'the caster slab reaches just under the lowest light');
  assert.equal(o.frames, 320, 'drei renders amount lights per frame: 40 x 8');
  assert.equal(o.blend, undefined);
  assert.equal(o.temporal, false);
  assert.equal(o.opacity, 1);
  assert.equal(o.resolution, 1024);
  assert.deepEqual(o.color, [0, 0, 0]);
  assert.equal(o.ambient, 0.5);
  assert.equal(accumulativeOptions(identity, [light({ amount: 200 })], {}).frames, 1024, 'capped at 1024 samples');
  const two = accumulativeOptions(identity, [light({ ambient: 1 }), light({ intensity: 3, ambient: 0 })], {});
  assert.equal(two.ambient, 0.25, 'intensity-weighted mean of the lights');
  assert.equal(two.frames, 640);
  const endless = accumulativeOptions(identity, [light()], { frames: Infinity });
  assert.equal(endless.frames, Infinity);
  assert.equal(endless.blend, 800, 'blend frames times amount');
  assert.equal(accumulativeOptions(identity, [light()], { frames: Infinity, limit: 10, blend: 20 }).frames, 80);
  const scaled = identity.slice();
  scaled[0] = scaled[5] = scaled[10] = 2;
  const big = accumulativeOptions(scaled, [light()], {});
  assert.equal(big.size, 20, 'the group scale scales the plane');
  assert.equal(big.lights[0].radius, 10000);
  assert.equal(big.lights[0].size, 10, 'the shadow camera window stays in world units');
  assert.deepEqual(accumulativeOptions(identity, [light()], { color: '#ffffff' }).color, [1, 1, 1]);
  for (const bad of [
    [[light({ position: [5, 0, 0] })], {}],
    [[light({ position: [5, -1, 0] })], {}],
    [[light({ amount: 0 })], {}],
    [[light()], { frames: 0 }],
    [[light()], { blend: 0.5 }],
    [[light()], { limit: NaN }],
  ])
    assert.throws(() => accumulativeOptions(identity, ...bad), /AccumulativeShadows: frames, blend, limit/);
});

test('AccumulativeShadows adds every castShadow mesh, follows props and lights and releases on unmount', async () => {
  const s = await scene(),
    ref = createRef(),
    ready = [];
  const ui = ({
    opacity = 1,
    cast = true,
    frames: count,
    lights = [h(RandomizedLight, { key: 'a', position: [0, 4, 0] })],
  } = {}) =>
    tree(
      s,
      h(
        React.Fragment,
        null,
        h(
          AccumulativeShadows,
          { ref, position: [0, -1, 0], opacity, frames: count, onReady: (c) => ready.push(c) },
          ...lights,
        ),
        h(Mesh, { castShadow: cast, position: [0, 0.5, 0] }, h(BoxGeometry)),
        h(Mesh, { position: [3, 0.5, 0] }, h(BoxGeometry)),
      ),
    );
  const view = render(ui());
  await frames(s);
  assert.equal(made.length, 1);
  const shadows = ready[0];
  assert.equal(ref.current.shadows, shadows);
  assert.deepEqual(shadows.options.position, [0, -1, 0]);
  assert.deepEqual(shadows.options.lights[0].position, [0, 3999, 0]);
  assert.equal(shadows.casters.size, 1, 'only the castShadow mesh casts');
  const [caster] = shadows.casters;
  assert.deepEqual([...caster.matrix].slice(12, 15), [0, 0.5, 0]);
  assert.equal(ref.current.getMesh().id >= 0, true, 'getMesh gives the group');

  view.rerender(ui({ opacity: 0.4 }));
  await frames(s);
  assert.equal(shadows.options.opacity, 0.4, 'live props');
  assert.equal(made.length, 1, 'no new catcher for a prop change');

  const before = shadows.invalidated;
  ref.current.reset();
  await frames(s, 1);
  assert.equal(shadows.invalidated, before + 1);
  ref.current.update(2);
  await frames(s, 1);
  assert.equal(shadows.options.frames, 16, 'update(frames) restarts for that many frames');

  view.rerender(ui({ opacity: 0.4, cast: false }));
  await frames(s);
  assert.equal(shadows.casters.size, 0, 'castShadow off removes the caster');

  const three = (count) =>
    ui({
      frames: count,
      lights: [
        h(RandomizedLight, { key: 'a', position: [0, 4, 0], ambient: 1 }),
        h(RandomizedLight, { key: 'b', position: [0, 2, 0], amount: 2, ambient: 0 }),
        h(RandomizedLight, { key: 'c', position: [0, 9, 0], castShadow: false }),
      ],
    });
  view.rerender(three());
  await frames(s);
  assert.equal(shadows.options.lights.length, 2, 'castShadow false leaves a light out');
  assert.equal(shadows.options.ambient, 0.5);
  assert.equal(shadows.options.frames, 20, 'update(2) holds, 2 frames of 8 + 2 samples');
  view.rerender(three(40));
  await frames(s);
  assert.equal(shadows.options.frames, 400, 'a new frames prop ends the update override');
  view.rerender(three(3));
  await frames(s);
  assert.equal(shadows.options.frames, 30, 'the frames prop counts: 3 frames of 8 + 2 samples');
  assert.equal(shadows.options.samples, 10, 'every light sample of a frame in one rendered frame');
  assert.equal(shadows.options.height, 0.999 * 2000, 'the lowest light bounds the caster slab');

  view.rerender(ui({ lights: [] }));
  await frames(s);
  assert.equal(shadows.disposed, true, 'no lights, no plane');
  view.unmount();
});

test('a RandomizedLight under the plane is reported, not drawn', async () => {
  const s = await scene(),
    errors = [];
  s.engine.onError = () => {};
  render(
    tree(s, h(AccumulativeShadows, { onError: (e) => errors.push(e) }, h(RandomizedLight, { position: [0, -2, 0] }))),
  );
  await frames(s, 1);
  assert.equal(made.length, 0);
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /each light above the plane/);
});

test('a castShadow model source is a caster too', async () => {
  const { casters } = await import('../dist/casters.js');
  const s = await scene();
  const source = { shadowPrimitives: [], disposed: false };
  casters(s.engine).add(source);
  render(tree(s, h(AccumulativeShadows, null, h(RandomizedLight, { position: [1, 3, 0] }))));
  await frames(s);
  assert.ok(made[0].casters.has(source));
  casters(s.engine).delete(source);
  await frames(s, 1);
  assert.equal(made[0].casters.size, 0);
});

test('a mesh drawn through a materials owner casts through its materials mesh', async () => {
  const s = await scene(),
    ref = createRef();
  render(
    tree(
      s,
      h(
        React.Fragment,
        null,
        h(AccumulativeShadows, null, h(RandomizedLight, { position: [1, 3, 0] })),
        h(Mesh, { ref, castShadow: true }, h(BoxGeometry)),
      ),
    ),
  );
  await frames(s);
  assert.ok(made[0].casters.has(ref.current));
  // What <TextureMaterial> does: the core mesh's geometry goes, the materials mesh (shadowPrimitives) draws it.
  const materials = { shadowPrimitives: [], disposed: false };
  Object.defineProperty(ref.current, Symbol.for('margoengine.pbr-source.v1'), { value: materials, configurable: true });
  await frames(s, 1);
  assert.deepEqual([...made[0].casters], [materials]);
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
import { createField } from '../dist/effect-field.js';

test('seeded fields stay in their distributions and absolute-time animation is repeatable', () => {
  const stars = createField({ kind: 'stars', count: 2000, radius: 10, depth: 2, seed: 123, speed: 0 });
  let meanY = 0;
  for (let i = 0; i < 2000; i++) { const p = stars.positions.subarray(i * 3, i * 3 + 3), r = Math.hypot(...p); assert.ok(r >= 10 - 1e-6 && r <= 12 + 1e-6); meanY += p[1] / r; }
  assert.ok(Math.abs(meanY / 2000) < 0.05);
  const colors = stars.colors.slice(); stars.step(100); assert.deepEqual(stars.colors, colors);
  const options = { kind: 'sparkles', count: 20, scale: [2, 4, 6], noise: [0, 0, 0], size: new Float32Array(20).fill(3), opacity: 0.5 };
  const a = createField(options), b = createField(options); a.step(2); b.step(2); assert.deepEqual(a.positions, b.positions); assert.deepEqual(a.colors, b.colors); assert.deepEqual(a.sizes, b.sizes);
  for (let i = 0; i < 20; i++) { assert.ok(Math.abs(a.positions[i * 3]) <= 1 && Math.abs(a.positions[i * 3 + 1]) <= 2 && Math.abs(a.positions[i * 3 + 2]) <= 3); assert.ok(a.colors[i * 4 + 3] <= 0.5); assert.equal(a.sizes[i], 3); }
  assert.throws(() => createField({ kind: 'stars', count: -1 }), RangeError);
  assert.throws(() => createField({ kind: 'sparkles', count: 3, size: new Float32Array(2) }), RangeError);
  assert.throws(() => createField({ kind: 'sparkles', count: 1, color: new Float32Array([1, NaN, 0]) }), RangeError);
  const perPoint = createField({ kind: 'sparkles', count: 2, noise: new Float32Array([0, 0, 0, 1, 1, 1]) });
  const initial = perPoint.positions.slice(); perPoint.step(2); assert.deepEqual(perPoint.positions.slice(0, 3), initial.slice(0, 3)); assert.notDeepEqual(perPoint.positions.slice(3), initial.slice(3));
});

const nativePoints = await import('@margoengine/points'), nativeLines = await import('@margoengine/lines'), plugins = [];
class Plugin {
  constructor(options) { this.name = options.name; this.items = new Set(); plugins.push(this); }
  setup(engine) { this.engine = engine; }
  add(item) { this.items.add(item); }
  onPreUpdate(delta) { for (const item of this.items) item.update?.(this.engine, delta); }
  dispose() { this.disposed = true; }
}
mock.module('@margoengine/points', { namedExports: { ...nativePoints, PointsPlugin: Plugin } });
mock.module('@margoengine/lines', { namedExports: { ...nativeLines, Lines: Plugin } });
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context, createViews } = await import('../dist/internal.js');
const { FrameCallbacks, advanceFrames } = await import('../dist/frame-priority.js');
const { Stars, Sparkles, Trail, Edges, Decal } = await import('@margoengine/react/effects-extra');
const { Mesh, BoxGeometry } = await import('@margoengine/react');

test('all five bindings own native resources, parent transforms and StrictMode cleanup', async () => {
  const engine = await Engine.create(document.createElement('canvas'), { backend: 'webgl2', fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }) });
  const frames = { callbacks: new FrameCallbacks(), elapsed: 0, last: null, mode: 'always' }, errors = [];
  engine.onError = error => errors.push(error);
  const scene = { engine, frames, registry: null, world: null, views: createViews(engine), resources: { models: new Set(), lighting: new Map() }, pointerHandlers: new Map() };
  const stars = createRef(), sparkles = createRef(), trail = createRef(), moving = createRef();
  let view;
  try {
    await act(async () => { view = render(React.createElement(StrictMode, null, React.createElement(Context.Provider, { value: scene },
      React.createElement(Stars, { count: 12, ref: stars }), React.createElement(Sparkles, { count: 8, ref: sparkles }),
      React.createElement(Trail, { ref: trail }, React.createElement(Mesh, { ref: moving }, React.createElement(BoxGeometry))),
      React.createElement(Mesh, { position: [2, 0, 0] }, React.createElement(BoxGeometry), React.createElement(Edges), React.createElement(Decal, { position: [0, 0, 0.51], scale: 0.5, color: '#ff0000' }))))); });
    await act(async () => advanceFrames(frames, engine, 0.1));
    await act(async () => advanceFrames(frames, engine, 0.1));
    assert.deepEqual(errors, []); assert.equal(stars.current.count, 12); assert.equal(sparkles.current.count, 8); assert.equal(trail.current.target, moving.current);
    const edges = plugins.flatMap(p => [...p.items]).find(item => item.mode === 'segments'); assert.equal(edges.segmentCount, 12, 'box has twelve welded edges');
    assert.equal(engine.meshes.size, 4, 'trail group, moving mesh, decal target and decal mesh');
    const decal = [...engine.meshes.values()].find(mesh => mesh.geometry && mesh !== moving.current && engine.store.parents[mesh.id] >= 0);
    assert.ok(decal); engine.store.tick(false); assert.equal(decal.matrix[12], 2, 'decal inherits the target transform once');
    const before = sparkles.current.positions.slice(); await act(async () => advanceFrames(frames, engine, 0.5)); assert.notDeepEqual(sparkles.current.positions, before);
    await act(async () => view.unmount()); assert.equal(engine.meshes.size, 0); assert.equal(engine.plugins.size, 0); assert.equal(frames.callbacks.size, 0); assert.equal(stars.current, null); assert.equal(trail.current, null); assert.ok(plugins.every(p => p.disposed));
  } finally { cleanup(); engine.dispose(); }
});

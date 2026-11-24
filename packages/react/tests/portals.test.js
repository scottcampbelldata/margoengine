import test from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Hud, RenderTexture } = await import('@margoengine/react/portals');
const { Mesh, BoxGeometry, useCamera } = await import('@margoengine/react');
const { Context, createViews } = await import('../dist/internal.js');
const { FrameCallbacks, advanceFrames } = await import('../dist/frame-priority.js');

test('portal cameras and scenes are isolated, native view order preserves main and every resource releases', async () => {
  const textures = [], published = [], errors = [], gpu = { limits: { maxTextureDimension2D: 4096 }, createTexture(desc) {
    const texture = { width: desc.size[0], height: desc.size[1], format: desc.format, mipLevelCount: 1, depthOrArrayLayers: 1, dimension: '2d', usage: desc.usage, createView() { return {}; }, destroy() { this.destroyed = true; } }; textures.push(texture); return texture;
  } };
  const canvas = document.createElement('canvas');
  const engine = await Engine.create(canvas, { backend: 'webgl2', fallback: () => ({ backend: 'webgl2', gpu, add() {}, remove() {}, render() {}, dispose() {} }) });
  engine.onError = e => errors.push(e);
  const frames = { callbacks: new FrameCallbacks(), elapsed: 0, last: null, mode: 'always' }, views = createViews(engine);
  const scene = { engine, frames, views, registry: null, world: null, resources: { models: new Set(), lighting: new Map() }, pointerHandlers: new Map(), cameraOverrides: new Set() };
  const output = createRef(), cameras = [];
  function Child() { cameras.push(useCamera()); return React.createElement(Mesh, null, React.createElement(BoxGeometry)); }
  const tree = width => React.createElement(StrictMode, null, React.createElement(Context.Provider, { value: scene },
    React.createElement(RenderTexture, { width, height: 32, ref: output, cameraOptions: { position: [0, 0, 4] }, onTexture: texture => published.push(texture) }, React.createElement(Child)),
    React.createElement(Hud, { cameraOptions: { position: [0, 0, 8] } }, React.createElement(Child)),
    React.createElement(Hud, { renderPriority: 2 }, React.createElement(Child))));
  let view;
  try {
    await act(async () => { view = render(tree(64)); });
    assert.deepEqual(errors, []); assert.ok(output.current?.texture); assert.equal(output.current.target.width, 64);
    assert.equal(engine.scenes.size, 4); assert.equal(engine.meshes.size, 3);
    assert.equal(engine.views.length, 4); assert.equal(engine.views[0].target.color, output.current.target);
    assert.equal(engine.views[1].camera, engine.camera); assert.equal(engine.views[2].clear.color, false); assert.equal(engine.views[3].clear.depth, true);
    assert.ok(cameras.every(camera => camera !== engine.camera)); assert.deepEqual(engine.camera.position, [0, 2, 5]);
    const first = output.current.target;
    await act(async () => view.rerender(tree(128)));
    assert.equal(output.current.target.width, 128); assert.equal(first.destroyed, true);
    advanceFrames(frames, engine, 1 / 60); assert.equal(engine.views[0].target.color.width, 128);
    const resized = output.current.target;
    engine.renderer.gpu = { ...gpu };
    await act(async () => { for (const plugin of output.current.scene.plugins.values()) plugin.onDeviceRestored?.(engine); });
    advanceFrames(frames, engine, 1 / 60);
    assert.notEqual(output.current.target, resized); assert.equal(resized.destroyed, true);
    assert.equal(engine.views[0].target.color, output.current.target, 'restored views use the replacement attachment');
    const explicit = {};
    views.entries.set(explicit, { order: 0, serial: views.serial++, view: { camera: engine.camera, viewport: [0, 0, 1, 1] } });
    advanceFrames(frames, engine, 1 / 60); assert.equal(engine.views.length, 4, 'an explicit canvas view replaces the implicit main view');
    views.entries.delete(explicit); advanceFrames(frames, engine, 1 / 60); assert.equal(engine.views.length, 4, 'main returns after the explicit view leaves');
    await act(async () => view.unmount());
    assert.equal(engine.views, undefined); assert.equal(engine.scenes.size, 1); assert.equal(engine.meshes.size, 0);
    assert.equal(frames.callbacks.size, 0); assert.equal(output.current, null); assert.equal(published.at(-1), null); assert.ok(textures.every(t => t.destroyed));
  } finally { cleanup(); engine.dispose(); }
});

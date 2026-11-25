// useFBO on a real core engine with a recording GPU device: canvas or fixed size, resize, depth, restore and release.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { useFBO } = await import('@margoengine/react/portals');
const { Context, createViews } = await import('../dist/internal.js');
const { FrameCallbacks, advanceFrames } = await import('../dist/frame-priority.js');

async function setup() {
  const textures = [],
    errors = [],
    gpu = {
      limits: { maxTextureDimension2D: 4096 },
      createTexture(desc) {
        const texture = {
          width: desc.size[0],
          height: desc.size[1],
          format: desc.format,
          sampleCount: desc.sampleCount ?? 1,
          mipLevelCount: 1,
          depthOrArrayLayers: 1,
          dimension: '2d',
          usage: desc.usage,
          createView() {
            return {};
          },
          destroy() {
            this.destroyed = true;
          },
        };
        textures.push(texture);
        return texture;
      },
    };
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 150;
  const engine = await Engine.create(canvas, {
    backend: 'webgl2',
    fallback: () => ({
      backend: 'webgl2',
      gpu,
      target: { format: 'bgra8unorm', depthFormat: 'depth32float', samples: 4 },
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
  });
  engine.onError = (e) => errors.push(e);
  const frames = { callbacks: new FrameCallbacks(), elapsed: 0, last: null, mode: 'always' },
    views = createViews(engine);
  const scene = {
    engine,
    frames,
    views,
    registry: null,
    world: null,
    resources: { models: new Set(), lighting: new Map() },
    pointerHandlers: new Map(),
    cameraOverrides: new Set(),
  };
  return { engine, frames, scene, textures, errors, gpu };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('useFBO follows the canvas size, keeps a fixed size, frees replaced and unmounted targets', async () => {
  const { engine, frames, scene, textures, errors } = await setup(),
    seen = [];
  function Probe(props) {
    seen.push(useFBO(...props.args));
    return null;
  }
  const tree = (args) =>
    React.createElement(
      StrictMode,
      null,
      React.createElement(Context.Provider, { value: scene }, React.createElement(Probe, { args })),
    );
  let view;
  try {
    await act(async () => {
      view = render(tree([]));
    });
    let fbo = seen.at(-1);
    assert.deepEqual(errors, []);
    assert.equal(fbo.width, 300);
    assert.equal(fbo.height, 150);
    assert.equal(fbo.target.color.format, 'rgba8unorm');
    assert.equal(fbo.target.depth, undefined);
    assert.equal(fbo.texture.disposed ?? false, false);
    const first = fbo.target.color;
    engine.canvas.width = 400;
    await act(async () => {
      advanceFrames(frames, engine, 1 / 60);
      await flush();
    });
    fbo = seen.at(-1);
    assert.equal(fbo.width, 400, 'a canvas-sized target follows the canvas');
    assert.equal(first.destroyed, true, 'the replaced target is freed');
    await act(async () => view.rerender(tree([64, 32, { format: 'rgba16float', depth: true }])));
    await act(flush);
    fbo = seen.at(-1);
    assert.equal(fbo.width, 64);
    assert.equal(fbo.target.color.format, 'rgba16float');
    assert.equal(fbo.target.depth.format, 'depth32float', 'depth in the scene depth format');
    assert.equal(fbo.target.depth.sampleCount, 4, 'and its sample count');
    engine.canvas.width = 500;
    await act(async () => advanceFrames(frames, engine, 1 / 60));
    assert.equal(seen.at(-1), fbo, 'a fixed size ignores the canvas');
    await act(async () => view.unmount());
    await act(flush);
    assert.ok(
      textures.every((t) => t.destroyed),
      'every texture is freed',
    );
    assert.equal(frames.callbacks.size, 0);
    assert.equal(
      [...engine.scene.plugins.keys()].some((name) => name.startsWith('react-fbo')),
      false,
    );
  } finally {
    cleanup();
    engine.dispose();
  }
});
test('useFBO recreates its target after device restoration, and reports a size past the device', async () => {
  const { engine, scene, errors, gpu } = await setup(),
    seen = [];
  function Probe(props) {
    seen.push(useFBO(props.size, props.size));
    return null;
  }
  const tree = (size) => React.createElement(Context.Provider, { value: scene }, React.createElement(Probe, { size }));
  try {
    let view;
    await act(async () => {
      view = render(tree(16));
    });
    const before = seen.at(-1);
    engine.renderer.gpu = { ...gpu };
    await act(async () => {
      for (const plugin of engine.scene.plugins.values()) plugin.onDeviceRestored?.(engine);
      await flush();
    });
    assert.notEqual(seen.at(-1), before);
    assert.equal(before.target.color.destroyed, true);
    await act(async () => view.rerender(tree(8192)));
    await act(flush);
    assert.match(String(errors.at(-1)), /useFBO exceeds device limits/);
  } finally {
    cleanup();
    engine.dispose();
  }
});

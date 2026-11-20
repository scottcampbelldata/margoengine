// useDepthBuffer on a real core engine with a recording GPU device: a depth view before the main view, for `frames` frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { useDepthBuffer } = await import('@margoengine/react/portals');
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

test('useDepthBuffer draws the scene depth into its own texture before the main view, for `frames` frames', async () => {
  const { engine, frames, scene, textures, errors } = await setup(),
    seen = [];
  function Probe({ options }) {
    seen.push(useDepthBuffer(options));
    return null;
  }
  const tree = (options) =>
    React.createElement(
      StrictMode,
      null,
      React.createElement(Context.Provider, { value: scene }, React.createElement(Probe, { options })),
    );
  let view;
  try {
    await act(async () => {
      view = render(tree({ size: 64, frames: 2 }));
    });
    await act(async () => {
      await flush();
    });
    const depth = seen.at(-1);
    assert.deepEqual(errors, []);
    assert.equal(depth.width, 64);
    assert.equal(depth.height, 64);
    assert.equal(depth.format, 'depth32float');
    assert.equal(depth.sampleCount, 4, 'the scene sample count, so the view can draw into it');
    const shape = () =>
      (engine.views ?? []).map((v) => (v.target ? (v.target.depth === depth ? 'depth' : 'other') : 'main'));
    for (const expected of [['depth', 'main'], ['depth', 'main'], ['main'], ['main']]) {
      await act(async () => advanceFrames(frames, engine, 1 / 60));
      assert.deepEqual(shape(), expected);
      assert.equal(engine.views.at(-1).camera, engine.camera);
    }
    await act(async () => view.rerender(tree({ size: 32 })));
    await act(async () => {
      await flush();
    });
    const next = seen.at(-1);
    assert.equal(next.width, 32);
    assert.ok(depth.destroyed, 'the replaced target is freed');
    for (let i = 0; i < 3; i++) {
      await act(async () => advanceFrames(frames, engine, 1 / 60));
      assert.equal(engine.views[0].target.depth, next, 'frames defaults to every frame');
    }
    await act(async () => view.unmount());
    assert.equal(engine.views, undefined, 'unmount leaves the engine default view');
    assert.ok(textures.every((t) => t.destroyed));
  } finally {
    cleanup();
    engine.dispose();
  }
});
test('useDepthBuffer refuses a bad size or frame count', async () => {
  const { engine, scene } = await setup();
  const probe = (options) => () => {
    function Probe() {
      useDepthBuffer(options);
      return null;
    }
    render(React.createElement(Context.Provider, { value: scene }, React.createElement(Probe)));
  };
  try {
    assert.throws(probe({ size: 0 }), /useDepthBuffer size must be a positive integer/);
    assert.throws(probe({ frames: 0.5 }), /useDepthBuffer frames must be a positive integer or Infinity/);
  } finally {
    cleanup();
    engine.dispose();
  }
});

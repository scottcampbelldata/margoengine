import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as Runtime from '@margoengine/core/extension';

export const engines = [];
const warmup = await Runtime.TransformStore.create(1);
warmup.dispose();
mock.module('@margoengine/core/extension', {
  namedExports: {
    ...Runtime,
    Engine: {
      async create(canvas, options) {
        const store = await Runtime.TransformStore.create(128),
          renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
          engine = new Runtime.Engine(canvas, store, renderer, options.camera, null);
        engine.starts = 0;
        engine.start = () => {
          engine.starts++;
        };
        engine.errors = [];
        engine.onError = (error) => engine.errors.push(error);
        engines.push(engine);
        return engine;
      },
    },
  },
});
export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
export const { render, act, cleanup } = await import('@testing-library/react');
export const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
export const close = async () => {
  cleanup();
  await flush();
  for (const engine of engines) {
    assert.equal(engine.disposed, true);
    assert.equal(engine.meshes.size, 0);
  }
};
export const near = (actual, expected, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

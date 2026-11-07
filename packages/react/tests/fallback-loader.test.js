// Graceful degradation in the Canvas: `loadFallback` runs only without WebGPU, `fallbackContent` replaces the text.
// Also the Canvas's engine options: `powerPreference` reaches Engine.create.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';

const created = [];
mock.module('@margoengine/core/extension', {
  namedExports: {
    // Like core: WebGPU needs `navigator.gpu`; otherwise the fallback factory, or a coded 'unsupported' error.
    Engine: {
      async create(canvas, options) {
        const webgpu =
          options.backend !== 'webgl2' && (await globalThis.navigator.gpu?.requestAdapter().catch(() => null));
        if (!webgpu && !options.fallback) {
          throw Object.assign(new Error('WebGPU unavailable'), { code: 'unsupported' });
        }
        const engine = {
          canvas,
          options,
          disposed: false,
          disposals: 0,
          camera: { ...options.camera },
          meshes: new Map(),
          createdMeshes: [],
          geometryReferences: new Map(),
          plugins: new Map(),
          callbacks: new Set(),
          maxDelta: 0.1,
          start() {},
          use(plugin) {
            this.plugins.set(plugin.name, plugin);
            return this;
          },
          removePlugin(name) {
            this.plugins.delete(name);
          },
          dispose() {
            this.disposals++;
            this.disposed = true;
          },
          onFrame(fn) {
            this.callbacks.add(fn);
            return () => this.callbacks.delete(fn);
          },
        };
        created.push(engine);
        return engine;
      },
    },
    Mesh: class {},
    box: () => ({}),
    PbrMaterial: class {},
    engineRuntime: (engine) => engine,
    meshRuntime: (mesh) => mesh,
  },
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const gpu = (value) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: value } });
const { render, act, cleanup } = await import('@testing-library/react');
const { Canvas } = await import('../dist/index.js');
const h = React.createElement;
const webglRenderer = () => ({ backend: 'webgl2' });
const adapter = { requestAdapter: async () => ({}) };
const flush = () => act(async () => {});

afterEach(() => {
  cleanup();
  created.length = 0;
});

test('loadCompat installs the layer first: one engine on WebGPU, and the preview loader stays unused', async () => {
  gpu(undefined);
  let fallbacks = 0,
    installs = 0,
    made = 0;
  const canvases = [],
    compat = async () => ({
      install: async () => {
        installs++;
        gpu(adapter);
      },
    }),
    view = render(
      h(Canvas, {
        loadCompat: compat,
        loadFallback: async () => (fallbacks++, webglRenderer),
        onCreated: (stage) => (made++, canvases.push(stage.engine.canvas)),
      }),
    );
  await flush();
  assert.equal(installs, 1);
  assert.equal(fallbacks, 0);
  assert.equal(made, 1, 'the scene is set up once');
  assert.equal(created.length, 1);
  assert.equal(created[0].options.fallback, undefined);
  assert.equal(canvases[0], view.container.querySelector('canvas'), 'the same element, so listeners stay');
});

test('loadCompat does nothing with WebGPU there, or when the app asks for the preview', async () => {
  gpu(adapter);
  let calls = 0;
  const compat = async () => (calls++, { install: async () => {} });
  render(h(Canvas, { loadCompat: compat }));
  await flush();
  assert.equal(calls, 0);
  cleanup();
  gpu(undefined);
  render(h(Canvas, { backend: 'webgl2', fallback: webglRenderer, loadCompat: compat }));
  await flush();
  assert.equal(calls, 0);
});

test('a refused layer falls to loadFallback, and with none the refusal reaches onError', async () => {
  gpu(undefined);
  const refusal = Object.assign(new Error('WebGL2 is too old'), { code: 'unsupported' }),
    compat = async () => ({ install: async () => { throw refusal; } }),
    errors = [];
  render(h(Canvas, { loadCompat: compat, loadFallback: async () => webglRenderer }));
  await flush();
  assert.equal(created[0].options.fallback, webglRenderer);
  cleanup();
  created.length = 0;
  render(h(Canvas, { loadCompat: compat, onError: (error) => errors.push(error) }));
  await flush();
  assert.deepEqual(errors, [refusal]);
  assert.equal(created.length, 0);
});

test('a broken loadCompat is not hidden by loadFallback', async () => {
  gpu(undefined);
  const broken = new Error('chunk failed to load'),
    errors = [];
  render(
    h(Canvas, {
      loadCompat: async () => {
        throw broken;
      },
      loadFallback: async () => webglRenderer,
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  assert.deepEqual(errors, [broken]);
});

test('with WebGPU the loader never runs and the engine gets no fallback', async () => {
  gpu(adapter);
  let calls = 0;
  const view = render(h(Canvas, { loadFallback: async () => (calls++, webglRenderer), fallbackContent: 'Poster' }));
  await flush();
  assert.equal(calls, 0);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(created.length, 1);
  assert.equal(created[0].options.fallback, undefined);
});

for (const [label, value] of [
  ['no navigator.gpu', undefined],
  ['requestAdapter answers null', { requestAdapter: async () => null }],
  ['requestAdapter rejects', { requestAdapter: async () => Promise.reject(new Error('lost')) }],
]) {
  test(`${label}: the loader runs once and its factory reaches Engine.create`, async () => {
    gpu(value);
    let calls = 0,
      signal;
    render(
      h(Canvas, {
        loadFallback: async (given) => ((signal = given), calls++, { webglRenderer }),
      }),
    );
    await flush();
    assert.equal(calls, 1);
    assert.equal(signal.aborted, false);
    assert.equal(created.length, 1);
    assert.equal(created[0].options.fallback, webglRenderer);
  });
}

test('a loader that resolves the factory itself works, and a new loader function does not recreate the engine', async () => {
  gpu(undefined);
  const view = render(h(Canvas, { loadFallback: async () => webglRenderer }));
  await flush();
  assert.equal(created[0].options.fallback, webglRenderer);
  view.rerender(h(Canvas, { loadFallback: async () => webglRenderer }));
  await flush();
  assert.equal(created.length, 1);
});

test('backend webgl2 loads the fallback without asking WebGPU; backend webgpu and an explicit fallback never load', async () => {
  gpu(adapter);
  let calls = 0;
  const loadFallback = async () => (calls++, webglRenderer);
  render(h(Canvas, { backend: 'webgl2', loadFallback }));
  await flush();
  assert.equal(calls, 1);
  assert.equal(created[0].options.fallback, webglRenderer);
  cleanup();
  gpu(undefined);
  const explicit = () => ({});
  render(h(Canvas, { fallback: explicit, loadFallback }));
  await flush();
  assert.equal(calls, 1);
  assert.equal(created.at(-1).options.fallback, explicit);
  cleanup();
  const errors = [];
  render(h(Canvas, { backend: 'webgpu', loadFallback, onError: (error) => errors.push(error) }));
  await flush();
  assert.equal(calls, 1);
  assert.equal(errors[0].code, 'unsupported');
});

test('a rejected loader becomes the coded unsupported error, onError and the plain message', async () => {
  gpu(undefined);
  const cause = new TypeError('Failed to fetch dynamically imported module');
  const errors = [];
  const view = render(
    h(Canvas, {
      loadFallback: async () => Promise.reject(cause),
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  assert.equal(created.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'unsupported');
  assert.equal(errors[0].cause, cause);
  assert.match(errors[0].message, /loadFallback failed/);
  assert.match(view.getByRole('alert').textContent, /needs a browser with WebGPU/);
});

test('a loader that resolves something else is an unsupported error too', async () => {
  gpu(undefined);
  const errors = [];
  render(h(Canvas, { loadFallback: async () => ({}), onError: (error) => errors.push(error) }));
  await flush();
  assert.equal(errors[0].code, 'unsupported');
  assert.match(errors[0].message, /renderer factory/);
});

test('unmount while the loader is pending aborts its signal, sets no state and creates no engine', async () => {
  gpu(undefined);
  let release, signal;
  const errors = [],
    problems = [];
  const log = console.error;
  console.error = (...args) => problems.push(args);
  try {
    const view = render(
      h(Canvas, {
        loadFallback: (given) => {
          signal = given;
          return new Promise((resolve) => (release = resolve));
        },
        onError: (error) => errors.push(error),
      }),
    );
    await flush();
    view.unmount();
    assert.equal(signal.aborted, true);
    await act(async () => release({ webglRenderer }));
    assert.equal(created.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(problems, []);
  } finally {
    console.error = log;
  }
});

test('fallbackContent replaces the default text when WebGPU is missing; onError still gets the coded error', async () => {
  gpu(undefined);
  const errors = [];
  const view = render(
    h(Canvas, {
      fallbackContent: h('img', { alt: 'Pre-rendered scene', src: 'scene.png' }),
      onError: (error) => errors.push(error),
    }),
  );
  await flush();
  assert.equal(errors[0].code, 'unsupported');
  const alert = view.getByRole('alert');
  assert.ok(alert.querySelector('img[alt="Pre-rendered scene"]'));
  assert.doesNotMatch(alert.textContent, /needs a browser with WebGPU/);
});

test('without fallbackContent the default message stays, and a failed loader shows fallbackContent too', async () => {
  gpu(undefined);
  const plain = render(h(Canvas));
  await flush();
  assert.match(plain.getByRole('alert').textContent, /needs a browser with WebGPU/);
  cleanup();
  const view = render(
    h(Canvas, {
      loadFallback: async () => Promise.reject(new Error('offline')),
      fallbackContent: h('i', null, 'Poster'),
    }),
  );
  await flush();
  assert.equal(view.getByRole('alert').textContent, 'Poster');
});

test('powerPreference reaches Engine.create; unset passes nothing; a new value applies to the next engine', async () => {
  gpu(adapter);
  const view = render(h(Canvas, { powerPreference: 'low-power' }));
  await flush();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.powerPreference, 'low-power');
  // A new value alone keeps the engine; the next engine (here after a backend change) gets it.
  view.rerender(h(Canvas, { powerPreference: 'high-performance' }));
  await flush();
  assert.equal(created.length, 1);
  view.rerender(h(Canvas, { powerPreference: 'high-performance', backend: 'webgpu' }));
  await flush();
  assert.equal(created.length, 2);
  assert.equal(created[1].options.powerPreference, 'high-performance');
  cleanup();
  render(h(Canvas));
  await flush();
  assert.equal(created[2].options.powerPreference, undefined);
});

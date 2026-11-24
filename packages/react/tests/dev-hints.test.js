import { assertCore, coreRequirement } from '../../core/dist/version.js';
// Development-only hints in the Canvas: lowercase R3F tags, pointer handlers on the WebGL2 fallback, and `maxDpr`.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';

const created = [];
mock.module('@margoengine/core/extension', {
  namedExports: {
    assertCore, coreRequirement,
    Engine: {
      async create(canvas, options) {
        const engine = {
          canvas,
          options,
          backend: globalThis.testBackend ?? 'webgpu',
          margoLowAtCreate: globalThis.margoLow,
          disposed: false,
          camera: { ...options.camera },
          meshes: new Map(),
          plugins: new Map(),
          maxDelta: 0.1,
          createdMeshes: [],
          geometryReferences: new Map(),
          use(plugin) {
            this.plugins.set(plugin.name, plugin);
            return this;
          },
          removePlugin(name) {
            this.plugins.delete(name);
          },
          start() {},
          dispose() {
            this.disposed = true;
          },
          onFrame: () => () => {},
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
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'MutationObserver'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node', gpu: { requestAdapter: async () => ({}) } },
});
const { render, act, cleanup } = await import('@testing-library/react');
const { Canvas } = await import('../dist/index.js');
const { Context } = await import('../dist/internal.js');
const h = React.createElement;
const flush = () => act(async () => {});
const warnings = [];
mock.method(console, 'warn', (...args) => warnings.push(args[0]));

afterEach(() => {
  cleanup();
  created.length = 0;
  warnings.length = 0;
  delete globalThis.testBackend;
  delete globalThis.margoLow;
});

test('a lowercase R3F tag inside the Canvas warns once, naming the Margo component', async () => {
  render(h(Canvas, null, h('mesh', null, h('boxGeometry'))));
  await flush();
  const mine = warnings.filter((w) => w?.code === 'state' && /<mesh>/.test(w.message));
  assert.equal(mine.length, 1);
  assert.match(mine[0].message, /<Mesh>/);
  assert.match(mine[0].message, /Margo\.mesh/);
  cleanup();
  render(h(Canvas, null, h('mesh')));
  await flush();
  assert.equal(warnings.filter((w) => /<mesh>/.test(w?.message)).length, 1, 'printed once per page');
});

test('a lowercase tag that appears after the first render warns too', async () => {
  const view = render(h(Canvas, null));
  await flush();
  assert.equal(warnings.length, 0);
  view.rerender(h(Canvas, null, h('group')));
  await flush();
  const mine = warnings.filter((w) => /<group>/.test(w?.message));
  assert.equal(mine.length, 1);
  assert.match(mine[0].message, /<Group>/);
});

function Handlers() {
  const scene = React.useContext(Context);
  React.useEffect(() => {
    scene.pointerHandlers.set(7, { onClick() {} });
  }, [scene]);
  return null;
}

test('pointer handlers on the WebGL2 fallback warn once with the limit and the fix', async () => {
  globalThis.testBackend = 'webgl2';
  render(h(Canvas, null, h(Handlers)));
  await flush();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'unsupported');
  assert.match(warnings[0].message, /engine\.pick needs WebGPU/);
  assert.match(warnings[0].message, /fallbackContent/);
  cleanup();
  render(h(Canvas, null, h(Handlers)));
  await flush();
  assert.equal(warnings.length, 1, 'printed once per page');
});

test('pointer handlers on the WebGL2 fallback with webglPicking do not warn', async () => {
  globalThis.testBackend = 'webgl2';
  const onCreated = (stage) => stage.engine.use({ name: 'webgl-pick', setup() {} });
  render(h(Canvas, { onCreated }, h(Handlers)));
  await flush();
  assert.equal(warnings.length, 0);
});

test('pointer handlers on WebGPU do not warn', async () => {
  render(h(Canvas, null, h(Handlers)));
  await flush();
  assert.equal(warnings.length, 0);
});

test('maxDpr lowers the pixel-ratio cap while the Canvas lives and restores the previous value', async () => {
  globalThis.margoLow = 1.5;
  const view = render(h(Canvas, { maxDpr: 1 }));
  await flush();
  assert.equal(created[0].margoLowAtCreate, 1);
  assert.equal(globalThis.margoLow, 1);
  view.unmount();
  assert.equal(globalThis.margoLow, 1.5);
});

test('maxDpr never raises a margoLow you set, two canvases use the lowest, and 2 or more changes nothing', async () => {
  globalThis.margoLow = 1;
  render(h(Canvas, { maxDpr: 1.5 }));
  await flush();
  assert.equal(globalThis.margoLow, 1);
  cleanup();
  delete globalThis.margoLow;
  const a = render(h(Canvas, { maxDpr: 1.5 }));
  const b = render(h(Canvas, { maxDpr: 1 }));
  await flush();
  assert.equal(globalThis.margoLow, 1);
  b.unmount();
  assert.equal(globalThis.margoLow, 1.5);
  a.unmount();
  assert.equal(globalThis.margoLow, undefined);
  render(h(Canvas, { maxDpr: 3 }));
  await flush();
  assert.equal(globalThis.margoLow, undefined);
});

test('an invalid maxDpr reaches onError as a RangeError', async () => {
  const errors = [];
  render(h(Canvas, { maxDpr: 0, onError: (error) => errors.push(error) }));
  await flush();
  assert.ok(errors[0] instanceof RangeError);
  assert.match(errors[0].message, /maxDpr/);
});

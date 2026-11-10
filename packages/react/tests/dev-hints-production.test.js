import { assertCore, coreRequirement } from '../../core/dist/version.js';
// In a production build (NODE_ENV=production) the development hints never print.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';

process.env.NODE_ENV = 'production';
mock.module('@margoengine/core/extension', {
  namedExports: {
    assertCore, coreRequirement,
    Engine: {
      async create(canvas) {
        return {
          canvas,
          backend: 'webgl2',
          disposed: false,
          camera: {},
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
          dispose() {},
          onFrame: () => () => {},
        };
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
const { render, act } = await import('@testing-library/react');
const { Canvas } = await import('../dist/index.js');
const { Context } = await import('../dist/internal.js');
const h = React.createElement;
const warnings = [];
mock.method(console, 'warn', (...args) => warnings.push(args[0]));

function Handlers() {
  const scene = React.useContext(Context);
  React.useEffect(() => {
    scene.pointerHandlers.set(1, { onClick() {} });
  }, [scene]);
  return null;
}

test('production: no lowercase-tag hint and no WebGL2 picking hint', async () => {
  render(h(Canvas, null, h('mesh'), h(Handlers)));
  await act(async () => {});
  assert.equal(warnings.filter((w) => w?.name === 'MargoError').length, 0);
});

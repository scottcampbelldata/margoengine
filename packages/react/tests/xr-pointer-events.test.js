// <XRPointerEvents> attaches the native pointers once and keeps them for an equal inline `types` array.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
const attached = [];
mock.module('@margoengine/xr', { namedExports: { XR: { create: async () => ({ dispose() {} }) } } });
mock.module('@margoengine/xr/pointer', {
  namedExports: {
    XRPointerEvents: {
      attach(manager, picker, options) {
        const pointers = {
          options,
          disposed: false,
          dispose() {
            pointers.disposed = true;
          },
        };
        attached.push(pointers);
        return pointers;
      },
    },
  },
});
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Context } = await import('../dist/internal.js');
const { XR } = await import('../dist/xr.js');
const { XRPointerEvents } = await import('../dist/xr-pointer.js');
const h = React.createElement;
afterEach(() => {
  cleanup();
  attached.length = 0;
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
test('XRPointerEvents keeps its pointers for an equal inline types array and attaches again for a different one', async () => {
  const scene = {
    engine: { disposed: false, onError() {}, meshes: new Map(), store: { parents: new Int32Array(0) } },
    frames: { callbacks: new Set(), mode: 'always', elapsed: 0, last: null },
    pointerHandlers: new Map(),
  };
  const picker = () => null;
  const tree = (types) => h(Context.Provider, { value: scene }, h(XR, null, h(XRPointerEvents, { picker, types })));
  const view = render(tree(['touch', 'ray']));
  await settle();
  assert.equal(attached.length, 1);
  view.rerender(tree(['touch', 'ray']));
  await settle();
  assert.equal(attached.length, 1, 'a new array with the same types is no change');
  assert.equal(attached[0].disposed, false);
  view.rerender(tree(['grab']));
  await settle();
  assert.equal(attached.length, 2, 'other types attach again');
  assert.equal(attached[0].disposed, true);
  view.unmount();
  await settle();
  assert.ok(attached.every((pointers) => pointers.disposed));
});

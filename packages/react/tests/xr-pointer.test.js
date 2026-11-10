import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { dispatchXRPointer } from '../dist/xr-pointer.js';

test('XR selection events bubble through existing Mesh handlers and preserve capture and source data', (t) => {
  const { window } = new JSDOM();
  const previous = globalThis.PointerEvent;
  globalThis.PointerEvent = window.PointerEvent ?? window.MouseEvent;
  t.after(() => {
    globalThis.PointerEvent = previous;
    window.close();
  });
  const parent = { id: 0 },
    mesh = { id: 1 },
    calls = [],
    parents = new Int32Array([-1, 0]);
  const scene = {
    engine: {
      meshes: new Map([
        [0, parent],
        [1, mesh],
      ]),
      store: { parents },
      disposed: false,
    },
    pointerHandlers: new Map([
      [
        0,
        {
          onClick(e) {
            calls.push(e);
          },
        },
      ],
      [
        1,
        {
          onClick(e) {
            calls.push(e);
            e.setPointerCapture();
          },
        },
      ],
    ]),
  };
  let captured = false;
  const event = {
    type: 'click',
    pointerId: 1000,
    pointerType: 'ray',
    target: mesh,
    stopped: false,
    buttons: 1,
    inputSource: {},
    hit: { mesh },
    setPointerCapture() {
      captured = true;
    },
    releasePointerCapture() {
      captured = false;
    },
    hasPointerCapture() {
      return captured;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };
  dispatchXRPointer(scene, event);
  assert.deepEqual(
    calls.map((e) => e.currentTarget),
    [mesh, parent],
  );
  assert.ok(calls.every((e) => e.xr === event && e.target === mesh));
  assert.equal(captured, true);
  calls.length = 0;
  scene.pointerHandlers.set(1, {
    onClick(e) {
      calls.push(e);
      e.stopPropagation();
    },
  });
  dispatchXRPointer(scene, event);
  assert.equal(calls.length, 1);
});

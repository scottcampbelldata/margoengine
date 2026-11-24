import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from '../dist/test.js';
import { OffscreenCanvas } from '../dist/offscreen.js';
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const scene = new URL('data:text/javascript,' + encodeURIComponent(`export function createScene({canvas,data,mode,signal}) {
  canvas.dataset.mode=mode; canvas.dataset.value=data.value; canvas.dataset.aborted=String(signal.aborted);
  return {dispose(){canvas.dataset.closed='true'}};
}`));

test('React stays in the DOM and shared scene falls back without workers; StrictMode, restart and unmount own separate canvases', async () => {
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host), made = [], errors = [];
  const first = { value: 'first' }, second = { value: 'second' };
  const tree = data => React.createElement(StrictMode, null, React.createElement(OffscreenCanvas, {
    scene, data, label: 'Worker scene', onCreated: s => made.push(s), onError: e => errors.push(e),
  }, React.createElement('button', null, 'Main thread')));
  await act(async () => { root.render(tree(first)); });
  assert.equal(made.length, 1); assert.equal(made[0].mode, 'page'); assert.equal(made[0].fallbackReason.code, 'unsupported');
  const canvas = host.querySelector('canvas'); assert.equal(canvas.dataset.value, 'first');
  assert.equal(canvas.getAttribute('aria-label'), 'Worker scene'); assert.equal(host.querySelector('button').textContent, 'Main thread');
  await act(async () => { root.render(tree(second)); });
  assert.equal(made.length, 2); assert.equal(made[0].disposed, true); assert.equal(canvas.dataset.closed, 'true');
  assert.notEqual(host.querySelector('canvas'), canvas); assert.equal(host.querySelector('canvas').dataset.value, 'second');
  await act(async () => root.unmount()); assert.equal(made[1].disposed, true); assert.deepEqual(errors, []); host.remove();
});

test('startup errors render an alert; abort while starting does not call onCreated', async () => {
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host), errors = [];
  const bad = new URL('data:text/javascript,export function createScene(){throw new Error("scene failed")}');
  await act(async () => root.render(React.createElement(OffscreenCanvas, { scene: bad, mode: 'page', onError: e => errors.push(e) })));
  assert.match(host.querySelector('[role=alert]').textContent, /scene failed/); assert.equal(errors.length, 1);
  const controller = new AbortController(); controller.abort();
  await act(async () => root.render(React.createElement(OffscreenCanvas, { scene, signal: controller.signal, onCreated: () => assert.fail('aborted scene started') })));
  await act(async () => root.unmount()); host.remove();
});

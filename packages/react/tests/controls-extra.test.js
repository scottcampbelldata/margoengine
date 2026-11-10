import test from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { KeyboardControls, useKeyboardControls, ScrollControls, Scroll, useScroll, PresentationControls } = await import('@margoengine/react/controls-extra');
const { Engine } = await import('@margoengine/core/extension');
const { Context, createViews } = await import('../dist/internal.js');
const { FrameCallbacks, advanceFrames } = await import('../dist/frame-priority.js');
const { Mesh, BoxGeometry } = await import('@margoengine/react');

test('keyboard aliases, simultaneous keys, keyup with changed modifiers, latch and focus cleanup', async () => {
  const map = [{ name: 'forward', keys: ['KeyW', 'ArrowUp'] }, { name: 'jump', keys: [' '] }, { name: 'latch', keys: ['KeyL'], up: false }];
  const changes = [], selected = []; let api, renders = 0, release;
  function Poll() { renders++; api = useKeyboardControls(); return null; }
  function Selected() { const pressed = useKeyboardControls(s => s.forward); selected.push(pressed); return null; }
  const key = async (type, code, value) => act(async () => window.dispatchEvent(new window.KeyboardEvent(type, { code, key: value })));
  const view = render(React.createElement(StrictMode, null, React.createElement(KeyboardControls, { map, onChange: (...args) => changes.push(args) }, React.createElement(Poll), React.createElement(Selected))));
  const initial = renders;
  const observed = []; release = api[0](s => s.forward, (next, prev) => observed.push([next, prev]));
  await key('keydown', 'KeyW', 'W'); await key('keydown', 'ArrowUp', 'ArrowUp');
  await key('keyup', 'KeyW', 'w'); assert.equal(api[1]().forward, true);
  await key('keyup', 'ArrowUp', 'ArrowUp'); assert.equal(api[1]().forward, false);
  await key('keydown', 'Space', ' '); assert.equal(api[1]().jump, true);
  await key('keydown', 'KeyL', 'l'); await key('keyup', 'KeyL', 'l'); assert.equal(api[1]().latch, true);
  await act(async () => window.dispatchEvent(new window.Event('blur')));
  assert.deepEqual(api[1](), { forward: false, jump: false, latch: false });
  assert.deepEqual(observed, [[true, false], [false, true]]); assert.equal(renders, initial);
  assert.ok(selected.includes(true)); assert.ok(Object.isFrozen(api[1]()));
  release(); await act(async () => view.unmount());
  const count = changes.length; await key('keydown', 'KeyW', 'w'); assert.equal(changes.length, count); cleanup();
});

test('native scroller, HTML portal and presentation group survive StrictMode and release their resources', async () => {
  const canvas = document.createElement('canvas'), host = document.createElement('div'); host.append(canvas); document.body.append(host);
  const engine = await Engine.create(canvas, { backend: 'webgl2', fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }) });
  const frames = { callbacks: new FrameCallbacks(), elapsed: 0, last: null, mode: 'always' };
  const scene = { engine, frames, registry: null, world: null, views: createViews(engine), resources: { models: new Set(), lighting: new Map() }, pointerHandlers: new Map() };
  let scroll, scrollMesh;
  function Read() { scroll = useScroll(); return React.createElement(React.Fragment, null, React.createElement(Scroll, { html: true }, React.createElement('strong', null, 'Scrollable content')), React.createElement(Scroll, null, React.createElement(Mesh, { ref: value => { scrollMesh = value; } }))); }
  const tree = enabled => React.createElement(StrictMode, null, React.createElement(Context.Provider, { value: scene }, React.createElement(ScrollControls, { pages: 3, damping: 0, enabled }, React.createElement(Read)), React.createElement(PresentationControls, { global: true, enabled }, React.createElement(Mesh, null, React.createElement(BoxGeometry)))));
  let view;
  try {
    await act(async () => { view = render(tree(true)); });
    assert.ok(scroll); assert.equal(host.querySelectorAll('[role=region]').length, 1); assert.equal(host.querySelector('strong').textContent, 'Scrollable content');
    Object.defineProperties(scroll.el, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
    await act(async () => { scroll.el.scrollTop = 100; scroll.el.dispatchEvent(new window.Event('scroll')); advanceFrames(frames, engine, 1 / 60); });
    assert.equal(scroll.offset, 0.5); assert.equal(scroll.range(0, 1), 0.5); assert.equal(scroll.curve(0, 1), 1); assert.equal(scroll.visible(0.4, 0.2), true);
    engine.camera.project = out => { out.fill(0); out[0] = out[5] = 0.5; out[15] = 1; };
    await act(async () => advanceFrames(frames, engine, 1 / 60));
    assert.equal(engine.meshes.get(engine.store.parents[scrollMesh.id]).position.y, 4, 'orthographic scroll uses the actual projection extent');
    const listeners = frames.callbacks.size; assert.equal(listeners, 4); assert.equal(engine.meshes.size, 4);
    await act(async () => view.rerender(tree(false))); assert.equal(scroll.el.style.pointerEvents, 'none');
    await act(async () => view.unmount());
    assert.equal(host.querySelectorAll('[role=region]').length, 0); assert.equal(frames.callbacks.size, 0); assert.equal(engine.meshes.size, 0); assert.equal(canvas.style.cursor, '');
  } finally { cleanup(); engine.dispose(); host.remove(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Engine, TransformStore, box, PbrMaterial} from '../../packages/core/dist/extension.js';
import {projectPoint} from '../../packages/labels/dist/index.js';
import {HTML} from '../../packages/html/dist/index.js';
import {optionalGPU} from '../../tests/support/optional-gpu.js';
import {createWorkload as gizmo} from './gizmo.js';
import {createWorkload as inspector} from './inspector.js';
import {createWorkload as labels} from './labels.js';
import {createWorkload as html} from './html.js';

async function mount(t, factory) {
  const dom = new JSDOM('<body><div id="stage"><canvas width="800" height="600"></canvas></div><section id="ui"></section></body>');
  const document = dom.window.document, canvas = document.querySelector('canvas'), parent = document.querySelector('#ui');
  Object.defineProperties(canvas, {clientWidth: {value: 800}, clientHeight: {value: 600}});
  canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 600});
  canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {}; canvas.hasPointerCapture = () => true;
  const store = await TransformStore.create(16), engine = new Engine(canvas, store, {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}}, {position: [0, 3, 8], target: [0, 0.5, 0]}, null);
  const workload = factory(4), geometry = box(0.22, 0.22, 0.22), meshes = Array.from({length: 4}, () => engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial()));
  const paint = () => meshes.forEach((mesh, i) => mesh.position.set(...workload.points.subarray(i * 4, i * 4 + 3)));
  const render = () => {workload.step(0); paint(); engine.render({culling: false}); workload.overlay?.update();};
  paint(); engine.render(); workload.mount({engine, meshes, parent, stage: canvas.parentElement, render}); render();
  t.after(() => {workload.dispose(); engine.dispose(); dom.window.close();});
  return {dom, document, canvas, parent, workload, meshes, render, paint, engine};
}
const change = (dom, element, value, type = 'change') => {element.value = value; element.dispatchEvent(new dom.window.Event(type, {bubbles: true}));};

test('Gizmo workload translates through actual pointer events, retains edits, resets and removes handlers', async t => {
  const h = await mount(t, gizmo), {workload: w, meshes, canvas, dom} = h, frame = w.gizmo.frame();
  const world = frame.origin.map((value, axis) => value + frame.axes[0][axis] * frame.size * 0.5);
  const p = projectPoint(h.engine.camera.matrix, ...world, 800, 600, 'webgl2'); assert.equal(w.gizmo.pick(p.x, p.y), 'X');
  const initial = meshes[0].position.x;
  for (const [type, x] of [['pointerdown', p.x], ['pointermove', p.x + 80], ['pointerup', p.x + 80]]) {
    const event = new dom.window.MouseEvent(type, {clientX: x, clientY: p.y, button: 0}); Object.defineProperties(event, {pointerId: {value: 1}, pointerType: {value: 'mouse'}}); canvas.dispatchEvent(event);
  }
  assert.ok(Math.abs(meshes[0].position.x - initial) > 0.1); assert.ok(w.details().objectChanges > 0);
  const edited = meshes[0].position.x; w.step(0.1); h.paint(); assert.equal(meshes[0].position.x, edited);
  change(dom, h.parent.querySelector('[data-ui-mode]'), 'scale'); assert.equal(w.gizmo.mode, 'scale');
  h.parent.querySelector('[data-ui-reset]').click(); assert.equal(meshes[0].position.x, initial);
  w.dispose(); assert.equal(w.gizmo.object, null); assert.equal(w.gizmo.element, null); assert.equal(h.parent.children.length, 0);
});

test('Inspector workload edits independent material and transforms, uses its hierarchy and cleans the panel', async t => {
  const h = await mount(t, inspector), w = h.workload, field = key => w.inspector.root.querySelector(`[data-property="${key}"]`);
  change(h.dom, field('position.x'), '1.25'); w.step(0.1); h.paint(); assert.equal(h.meshes[0].position.x, 1.25);
  change(h.dom, field('roughness'), '0.25', 'input'); assert.equal(h.meshes[0].material.data[4], 0.25); assert.notEqual(h.meshes[1].material.data[4], 0.25);
  change(h.dom, h.parent.querySelector('[data-ui-actor]'), '2'); assert.equal(w.inspector.selected, h.meshes[1]); assert.equal(w.details().hierarchyItems, 4);
  w.inspector.root.querySelector('[aria-selected=true]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
  assert.equal(w.inspector.selected, h.meshes[2]); assert.equal(w.details().selectedActor, 3);
  assert.equal(field('bounds').disabled, true, 'GL fallback must not invent GPU debug support');
  w.dispose(); assert.equal(h.document.querySelector('[data-margo-inspector]'), null); assert.equal(h.parent.children.length, 0);
});

test('Labels workload projects actual moving mesh anchors and CSS3D, clicks, toggles and reuses removed elements', async t => {
  const h = await mount(t, labels), w = h.workload, before = w.labels[1].screen.y;
  assert.equal(w.overlay.size, 5); assert.ok(w.details().labelsOnScreen > 0); assert.equal(w.details().css3dOnScreen, true);
  w.step(0.1); h.render(); assert.notEqual(w.labels[1].screen.y, before); assert.match(w.labels[1].element.style.transform, /translate/);
  w.labels[1].element.click(); assert.equal(w.details().selectedActor, 2);
  h.parent.querySelector('[data-ui-toggle]').click(); assert.equal(w.labels[1].onScreen, false);
  const element = w.labels[0].element, readd = h.parent.querySelector('[data-ui-readd]'); readd.click(); assert.equal(element.isConnected, false); assert.equal(w.overlay.size, 4);
  readd.click(); assert.equal(w.labels[0].element, element); assert.equal(w.overlay.size, 5); element.click(); assert.equal(w.details().selectedActor, 1);
  w.dispose(); assert.equal(h.document.querySelector('[data-margoengine-labels]'), null); assert.equal(h.parent.children.length, 0);
});

test('HTML workload uses the actual HTML subclass, bounded anchors and honest GL fallback; disposal removes DOM', async t => {
  const h = await mount(t, html), w = h.workload; assert.ok(w.overlay instanceof HTML);
  assert.equal(w.overlay.size, 8); assert.equal(w.details().depthAvailable, false); assert.equal(w.probes[0].offset[1], 0);
  h.parent.querySelector('[data-ui-depth]').click(); assert.equal(w.probes[0].offset[1], 1); assert.equal(w.details().anchorsInside, false);
  w.labels[2].element.click(); assert.equal(w.details().selectedActor, 3);
  w.dispose(); assert.equal(h.document.querySelector('[data-margoengine-labels]'), null); assert.equal(h.parent.children.length, 0);
});

test('UI factories reject unbounded counts and retain pose arrays across frames', () => {
  for (const factory of [gizmo, inspector, labels, html]) {
    assert.throws(() => factory(0), /count/); assert.throws(() => factory(65), /count/);
    const w = factory(4), points = w.points; for (let i = 0; i < 20; i++) w.step(1 / 60);
    assert.equal(w.points, points); assert.ok([...points].every(Number.isFinite)); w.dispose();
  }
});

test('HTML paused settling is bounded to two previews and page disposal cancels late completion', async t => {
  const h = await mount(t, html); h.workload.dispose();
  const gpu = optionalGPU(), queue = gpu.engine.gpu.queue, callbacks = new Map(); let next = 0, finish, previews = 0, waits = 0;
  queue.onSubmittedWorkDone = () => {waits++; return new Promise(resolve => {finish = resolve;});};
  Object.defineProperties(h.engine, {backend: {value: 'webgpu'}, gpu: {value: gpu.engine.gpu}});
  h.canvas.getContext = () => ({getConfiguration: () => ({device: gpu.engine.gpu})});
  h.dom.window.requestAnimationFrame = callback => {callbacks.set(++next, callback); return next;};
  h.dom.window.cancelAnimationFrame = id => callbacks.delete(id);
  const w = html(4); w.mount({engine: h.engine, meshes: h.meshes, parent: h.parent, stage: h.canvas.parentElement, render: () => {previews++; return true;}});
  t.after(() => {w.dispose(); gpu.cleanup();});
  w.afterReady(); await Promise.resolve(); assert.equal(waits, 1); finish(); await Promise.resolve();
  for (let i = 0; i < 2; i++) {const [id, callback] = callbacks.entries().next().value; callbacks.delete(id); callback();}
  assert.equal(previews, 3, 'Initial selection preview plus exactly two settling previews'); assert.equal(callbacks.size, 0); assert.equal(w.details().previewSettling, false);
  w.afterReady(); await Promise.resolve(); w.dispose(); finish(); await Promise.resolve();
  assert.equal(callbacks.size, 0); assert.equal(previews, 3); assert.equal(w.details().previewSettling, false);
});

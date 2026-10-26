// Inspector depth: undo/redo, search, colour and double-sided editing, click picking, snapshots, resources, shader view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore, box, PbrMaterial } from '@margoengine/core/extension';
import { Inspector, EditHistory } from '../dist/index.js';
import { EditHistory as History } from '@margoengine/inspector/history';
import { snapshotMeshes, restoreSnapshot, parseSnapshot } from '@margoengine/inspector/snapshot';
import { describeEngine } from '@margoengine/inspector/resources';

async function scene(t, options = {}) {
  const dom = new JSDOM('<body><canvas width="200" height="200"></canvas></body>'),
    canvas = dom.window.document.querySelector('canvas');
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(canvas, store, renderer, undefined, null),
    effects = { exposure: 0, bloom: 0.5 };
  const inspector = Inspector.attach(engine, { parent: dom.window.document.body, effects, ...options });
  t.after(() => {
    engine.dispose();
    dom.window.close();
  });
  return { engine, inspector, dom, effects, canvas };
}
const field = (inspector, key) => inspector.root.querySelector(`[data-property="${key}"]`);
const button = (inspector, id) => inspector.root.querySelector(`[data-action="${id}"]`);
function edit(dom, input, value, event = 'change') {
  input.value = value;
  input.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
}
const key = (dom, target, init) =>
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

test('EditHistory undoes and redoes in order, clears redo on a new edit and honours its limit', () => {
  let x = 0;
  const set = (v, label = 'Set x') => {
    const old = x;
    x = v;
    return { label, undo: () => (x = old), redo: () => (x = v) };
  };
  const h = new History(3);
  assert.equal(h.undo(), false);
  assert.equal(h.redo(), false);
  for (const v of [1, 2, 3, 4]) h.record(set(v));
  assert.equal(h.undoCount, 3, 'The oldest edit was dropped');
  assert.equal(h.nextUndo, 'Set x');
  h.undo();
  h.undo();
  assert.equal(x, 2);
  assert.equal(h.redoCount, 2);
  h.redo();
  assert.equal(x, 3);
  h.record(set(9, 'Nine'));
  assert.equal(h.redoCount, 0, 'A new edit forgets the redo side');
  assert.equal(h.nextUndo, 'Nine');
  h.undo();
  assert.equal(x, 3);
  h.clear();
  assert.deepEqual([h.undoCount, h.redoCount], [0, 0]);
});

test('EditHistory merges edits of one key inside the window, never across a replay, and validates', () => {
  let now = 0,
    x = 0;
  const h = new History(10, 100, () => now);
  const set = (v) => {
    const old = x;
    x = v;
    h.record({ label: 'Drag', key: 'x', undo: () => (x = old), redo: () => (x = v) });
  };
  set(1);
  now = 50;
  set(2);
  now = 90;
  set(3);
  assert.equal(h.undoCount, 1, 'A drag is one step');
  now = 400;
  set(4);
  assert.equal(h.undoCount, 2, 'A pause starts a new step');
  h.undo();
  assert.equal(x, 3);
  h.undo();
  assert.equal(x, 0, 'The merged step takes back to before the drag');
  h.redo();
  now = 410;
  set(7);
  assert.equal(h.redoCount, 0);
  assert.equal(h.undoCount, 2, 'An edit after a redo is a new step even inside the window');
  assert.throws(() => new History(0), RangeError);
  assert.throws(() => new History(1.5), RangeError);
  assert.throws(() => new History(5, -1), RangeError);
  assert.throws(() => h.record({ label: 'x' }), TypeError);
  assert.throws(() => h.onChange(1), TypeError);
});

test('EditHistory notifies listeners, refuses recording during a replay and keeps a failing edit', () => {
  const h = new History();
  let calls = 0;
  const off = h.onChange(() => calls++);
  h.record({ label: 'a', undo() {}, redo() {} });
  h.undo();
  h.redo();
  h.clear();
  assert.equal(calls, 4);
  off();
  h.clear();
  assert.equal(calls, 4);
  h.record({ label: 'nested', undo: () => h.record({ label: 'x', undo() {}, redo() {} }), redo() {} });
  assert.throws(
    () => h.undo(),
    (e) => e.code === 'state' && /outside undo and redo/.test(e.message),
  );
  assert.equal(h.undoCount, 1, 'The edit that threw stays on the stack');
  const g = new History();
  g.record({ label: 'reenter', undo: () => g.undo(), redo() {} });
  assert.throws(
    () => g.undo(),
    (e) => e.code === 'state',
  );
});

test('panel edits undo and redo, from the buttons and the keyboard, and a slider drag is one step', async (t) => {
  const { engine, inspector, dom, effects } = await scene(t),
    mesh = engine.createMesh().setGeometry(box());
  inspector.select(mesh);
  assert.equal(button(inspector, 'undo').disabled, true);
  edit(dom, field(inspector, 'position.x'), '4');
  edit(dom, field(inspector, 'name'), 'Renamed');
  field(inspector, 'visible').checked = false;
  field(inspector, 'visible').dispatchEvent(new dom.window.Event('change'));
  edit(dom, field(inspector, 'roughness'), '0.2', 'input');
  edit(dom, field(inspector, 'roughness'), '0.3', 'input');
  edit(dom, field(inspector, 'roughness'), '0.4', 'input');
  edit(dom, field(inspector, 'exposure'), '2', 'input');
  assert.equal(inspector.history.undoCount, 5, 'Three roughness inputs made one step');
  assert.match(button(inspector, 'undo').title, /Set exposure/);
  button(inspector, 'undo').click();
  assert.equal(effects.exposure, 0);
  button(inspector, 'undo').click();
  assert.ok(Math.abs(mesh.material.data[4] - 0.5) < 1e-6, 'Roughness back to before the drag');
  assert.equal(field(inspector, 'roughness').value, '0.5', 'The panel shows it');
  inspector.undo();
  assert.equal(mesh.visible, true);
  inspector.undo();
  assert.equal(mesh.name, '');
  inspector.undo();
  assert.equal(mesh.position.x, 0);
  assert.equal(inspector.undo(), false);
  assert.equal(button(inspector, 'undo').disabled, true);
  assert.equal(button(inspector, 'redo').disabled, false);
  key(dom, inspector.element, { key: 'z', ctrlKey: true, shiftKey: true });
  assert.equal(mesh.position.x, 4, 'Ctrl+Shift+Z redoes');
  key(dom, inspector.element, { key: 'y', metaKey: true });
  assert.equal(mesh.name, 'Renamed', 'Cmd+Y redoes');
  key(dom, inspector.element, { key: 'z', ctrlKey: true });
  assert.equal(mesh.name, '', 'Ctrl+Z undoes');
  const typed = field(inspector, 'name'),
    event = new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
  typed.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'In a text field the browser keeps its own undo');
  assert.equal(mesh.name, '');
});

test('an edit that the engine rejects is not recorded, and undo skips a mesh that was disposed', async (t) => {
  const { engine, inspector, dom } = await scene(t),
    mesh = engine.createMesh().setGeometry(box());
  inspector.select(mesh);
  edit(dom, field(inspector, 'scale.y'), '0');
  assert.equal(inspector.history.undoCount, 0);
  edit(dom, field(inspector, 'position.y'), '3');
  mesh.dispose();
  assert.doesNotThrow(() => inspector.undo());
  assert.doesNotThrow(() => inspector.redo());
});

test('colour and double-sided edit the core material, share it and undo', async (t) => {
  const { engine, inspector, dom } = await scene(t),
    mesh = engine.createMesh().setGeometry(box());
  mesh.material = new PbrMaterial({ color: '#ff0000', doubleSided: false });
  inspector.select(mesh);
  assert.equal(field(inspector, 'color').value, '#ff0000');
  assert.equal(field(inspector, 'doubleSided').checked, false);
  edit(dom, field(inspector, 'color'), '#00ff00', 'input');
  assert.deepEqual(
    [...mesh.material.data.slice(0, 3)].map((v) => Math.round(v)),
    [0, 1, 0],
  );
  assert.equal(field(inspector, 'color').value, '#00ff00');
  field(inspector, 'doubleSided').checked = true;
  field(inspector, 'doubleSided').dispatchEvent(new dom.window.Event('change'));
  assert.equal(mesh.material.data[6], 1);
  inspector.undo();
  assert.equal(mesh.material.data[6], 0);
  inspector.undo();
  assert.equal(field(inspector, 'color').value, '#ff0000');
  // An sRGB mid grey round-trips through the linear value the material stores.
  edit(dom, field(inspector, 'color'), '#808080', 'input');
  assert.ok(Math.abs(mesh.material.data[0] - 0.2158605) < 1e-5);
  assert.equal(field(inspector, 'color').value, '#808080');
});

test('search keeps matching entities and their parents and hides the rest', async (t) => {
  const { engine, inspector, dom } = await scene(t),
    root = engine.createMesh(),
    keep = engine.createMesh(root),
    drop = engine.createMesh(root),
    other = engine.createMesh();
  root.name = 'Rig';
  keep.name = 'Left Wheel';
  drop.name = 'Body';
  other.name = 'Ground';
  inspector.refresh();
  const search = inspector.root.querySelector('[data-search]'),
    shown = () =>
      [...inspector.root.querySelectorAll('[role=treeitem]')]
        .filter((i) => !i.hidden)
        .map((i) => i.querySelector('.name').textContent);
  assert.deepEqual(shown(), ['Rig', 'Left Wheel', 'Body', 'Ground']);
  edit(dom, search, ' WHEEL ', 'input');
  assert.deepEqual(shown(), ['Rig', 'Left Wheel'], 'Case and outer spaces do not matter; the parent stays');
  edit(dom, search, 'nothing', 'input');
  assert.deepEqual(shown(), []);
  edit(dom, search, '', 'input');
  assert.equal(shown().length, 4);
});

test('a click on the canvas selects what it hits, a drag does not, and the last click wins', async (t) => {
  const { engine, inspector, dom, canvas } = await scene(t),
    a = engine.createMesh().setGeometry(box()),
    b = engine.createMesh().setGeometry(box());
  const calls = [];
  let release;
  t.mock.method(engine, 'pick', (x, y) => {
    calls.push([x, y]);
    return calls.length === 1 ? new Promise((resolve) => (release = () => resolve(a))) : Promise.resolve(b);
  });
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 200 });
  const mouse = (type, x, y, init = {}) =>
    canvas.dispatchEvent(
      new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...init }),
    );
  mouse('pointerdown', 50, 60);
  mouse('pointerup', 90, 90);
  assert.equal(calls.length, 0, 'A 50 px move is a drag');
  mouse('pointerdown', 50, 60);
  mouse('pointerup', 52, 61);
  assert.deepEqual(calls[0], [42, 41], 'Canvas pixels, from the element rectangle');
  mouse('pointerdown', 70, 70);
  mouse('pointerup', 70, 70);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(inspector.selected, b);
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(inspector.selected, b, 'A slow earlier pick does not override a later one');
  mouse('pointerdown', 70, 70, { button: 2 });
  mouse('pointerup', 70, 70, { button: 2 });
  assert.equal(calls.length, 2, 'Only the primary button picks');
  const ticket = calls.length;
  mouse('pointerdown', 1, 1);
  mouse('pointerup', 1, 1);
  inspector.dispose();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, ticket + 1);
  mouse('pointerdown', 1, 1);
  mouse('pointerup', 1, 1);
  assert.equal(calls.length, ticket + 1, 'No listeners after dispose');
});

test('pick: false leaves the canvas alone and pick must be a boolean', async (t) => {
  const { engine, canvas, dom } = await scene(t, { pick: false }),
    parent = dom.window.document.body;
  const calls = [];
  t.mock.method(engine, 'pick', async () => calls.push(1));
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true }));
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerup', { button: 0, bubbles: true }));
  assert.equal(calls.length, 0);
  assert.throws(
    () => new Inspector({ parent, pick: 'yes' }),
    (e) => e instanceof TypeError && /boolean/.test(e.message),
  );
  assert.throws(() => new Inspector({ parent, historyLimit: 0 }), RangeError);
});

test('snapshots round-trip the scene as JSON and restore is one undoable step', async (t) => {
  const { engine, inspector } = await scene(t),
    parent = engine.createMesh(),
    child = engine.createMesh(parent).setGeometry(box());
  parent.name = 'Parent';
  child.name = 'Child';
  child.position.x = 2;
  child.rotation.y = 0.5;
  child.scale.z = 3;
  child.material = new PbrMaterial({ color: '#336699', roughness: 0.2, metalness: 1, doubleSided: false });
  const saved = JSON.parse(JSON.stringify(inspector.snapshot()));
  assert.deepEqual(saved, JSON.parse(JSON.stringify(snapshotMeshes(engine, [...engine.scene.meshes.values()]))));
  assert.equal(saved.format, 'margoengine.scene-snapshot');
  assert.equal(saved.version, 1);
  assert.equal(saved.meshes.length, 2);
  const c = saved.meshes.find((m) => m.name === 'Child');
  assert.equal(c.parent, parent.id);
  assert.deepEqual(c.position, [2, 0, 0]);
  assert.deepEqual(c.scale, [1, 1, 3]);
  assert.equal(c.material.metalness, 1);
  child.position.x = 9;
  child.name = 'Changed';
  child.visible = false;
  child.material.set({ color: '#ffffff', metalness: 0 });
  const result = inspector.restore(saved);
  assert.deepEqual(result, { applied: 2, missing: [] });
  assert.equal(child.position.x, 2);
  assert.equal(child.name, 'Child');
  assert.equal(child.visible, true);
  assert.equal(child.material.data[5], 1);
  assert.equal(inspector.history.undoCount, 1);
  inspector.undo();
  assert.equal(child.position.x, 9, 'Undo returns to the state before the load');
  assert.equal(child.name, 'Changed');
  inspector.redo();
  assert.equal(child.name, 'Child');
  child.dispose();
  assert.deepEqual(inspector.restore(saved).missing, [child.id], 'A mesh that is gone is reported, not an error');
  assert.match(inspector.root.querySelector('[role=status]').textContent, /1 not in this scene/);
});

test('restore checks the whole snapshot first and rolls back a value the engine rejects', async (t) => {
  const { engine, inspector } = await scene(t),
    a = engine.createMesh().setGeometry(box()),
    b = engine.createMesh().setGeometry(box());
  a.position.x = 1;
  const good = inspector.snapshot();
  const bad = structuredClone(good);
  bad.meshes[0].position = [5, 5, 5];
  bad.meshes[1].scale = [0, 1, 1];
  assert.throws(() => restoreSnapshot(engine, bad));
  assert.equal(a.position.x, 1, 'The first mesh was put back after the second failed');
  assert.equal(b.scale.x, 1);
  assert.equal(inspector.history.undoCount, 0);
  const rejects = (data, type, text) =>
    assert.throws(
      () => parseSnapshot(data),
      (e) => e instanceof type && text.test(e.message),
    );
  rejects(null, TypeError, /Not a scene snapshot/);
  rejects({ format: 'x' }, TypeError, /Not a scene snapshot/);
  rejects({ ...good, version: 2 }, RangeError, /version 2/);
  rejects({ ...good, meshes: 5 }, TypeError, /meshes array/);
  rejects({ ...good, meshes: [{ ...good.meshes[0], position: [1, 2] }] }, TypeError, /position/);
  rejects({ ...good, meshes: [{ ...good.meshes[0], rotation: [1, NaN, 2] }] }, TypeError, /rotation/);
  rejects({ ...good, meshes: [{ ...good.meshes[0], id: 1.5 }] }, TypeError, /integer id/);
  rejects({ ...good, meshes: [{ ...good.meshes[0], material: { color: [1, 1, 1] } }] }, TypeError, /doubleSided/);
  assert.throws(
    () => inspector.restore('{}'),
    (e) => e instanceof TypeError,
  );
});

test('snapshot and restore need an attached, live inspector', async (t) => {
  const { engine, inspector } = await scene(t);
  const loose = new Inspector({ parent: engine.canvas.ownerDocument.body });
  assert.throws(
    () => loose.snapshot(),
    (e) => e.code === 'state' && /not attached/.test(e.message),
  );
  assert.throws(
    () => loose.resources(),
    (e) => e.code === 'state',
  );
  loose.dispose();
  assert.throws(
    () => loose.snapshot(),
    (e) => e.code === 'disposed',
  );
  assert.throws(
    () => loose.undo(),
    (e) => e.code === 'disposed',
  );
  assert.throws(
    () => restoreSnapshot({ disposed: true }, inspector.snapshot()),
    (e) => e.code === 'state',
  );
});

test('resources count distinct geometry and materials and draw only when the section is open', async (t) => {
  const { engine, inspector } = await scene(t),
    shared = box(),
    material = new PbrMaterial(),
    a = engine.createMesh().setGeometry(shared),
    b = engine.createMesh().setGeometry(shared),
    c = engine.createMesh().setGeometry(box());
  a.material = b.material = material;
  c.visible = false;
  const r = inspector.resources();
  assert.equal(r.backend, 'webgl2');
  assert.equal(r.meshes, 3);
  assert.equal(r.visibleMeshes, 2);
  assert.equal(r.geometries, 2);
  assert.equal(r.materials, 2);
  assert.equal(r.vertices, (shared.vertices.length / 6) * 2);
  assert.equal(r.triangles, (shared.indices.length / 3) * 2, 'Instances count each time; the hidden mesh not at all');
  assert.deepEqual(r.canvas, { width: 200, height: 200 });
  assert.ok(r.plugins.includes('inspector'));
  assert.deepEqual(describeEngine(engine, [a]).meshes, 1);
  assert.throws(() => describeEngine({}), TypeError);
  const out = inspector.root.querySelector('[data-output="resources"]');
  assert.equal(out.textContent, '', 'A closed section builds no text');
  const details = inspector.root.querySelector('[data-section="resources"]');
  details.open = true;
  inspector.refresh();
  assert.match(out.textContent, /3 meshes \(2 visible\)/);
  assert.match(out.textContent, /2 geometries/);
  assert.match(out.textContent, /Plugins: inspector/);
});

test('the shader view shows the scene WGSL from the last WebGPU frame', async (t) => {
  const { engine, inspector } = await scene(t);
  Object.defineProperty(engine, 'backend', { value: 'webgpu', configurable: true });
  assert.equal(inspector.shaderSource, '');
  const details = inspector.root.querySelector('[data-section="shader"]'),
    out = inspector.root.querySelector('[data-output="shader"]');
  details.open = true;
  inspector.refresh();
  assert.match(out.textContent, /Waiting for the first frame/);
  engine.frameGraph.execute({ backend: 'webgpu', draw() {}, shader: '@vertex fn vertex() {}' });
  assert.equal(inspector.shaderSource, '@vertex fn vertex() {}');
  inspector.refresh();
  assert.equal(out.textContent, '@vertex fn vertex() {}');
  inspector.dispose();
  assert.equal(inspector.shaderSource, '');
});

test('a failing panel action shows in the status line instead of throwing out of the handler', async (t) => {
  const { engine, inspector } = await scene(t);
  engine.createMesh().setGeometry(box());
  t.mock.method(URL, 'createObjectURL', () => {
    throw new Error('blocked by test');
  });
  assert.doesNotThrow(() => button(inspector, 'save').click());
  assert.equal(inspector.root.querySelector('[role=status]').textContent, 'blocked by test');
  assert.equal(EditHistory, History, 'The root and the history entry share one class');
});

test('a canvas without pointer events or a rectangle (OffscreenCanvas, a stand-in) attaches without picking', async (t) => {
  const { engine } = await scene(t);
  const loose = new Inspector({ parent: engine.canvas.ownerDocument.body });
  for (const canvas of [
    { width: 4, height: 4 },
    { width: 4, height: 4, addEventListener() {} },
  ]) {
    const stop = loose.watchPicks({ canvas });
    assert.equal(typeof stop, 'function');
    assert.doesNotThrow(stop);
  }
  loose.dispose();
});

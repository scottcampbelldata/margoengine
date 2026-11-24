import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore, box } from '@margoengine/core/extension';
import { Inspector } from '../dist/index.js';
import { SceneEditor } from '../dist/edit.js';
import { InspectorGizmo } from '../dist/gizmo.js';
import { EditHistory } from '../dist/history.js';

async function setup(t, options = {}) {
  const dom = new JSDOM('<body><canvas width="800" height="600"></canvas></body>'),
    canvas = dom.window.document.querySelector('canvas');
  const engine = new Engine(
    canvas,
    await TransformStore.create(64),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 5, 10], target: [0, 0, 0] },
    null,
  );
  const inspector = Inspector.attach(engine, { parent: dom.window.document.body, pick: false, ...options });
  const editor = SceneEditor.attach(engine, inspector);
  t.after(() => {
    engine.dispose();
    dom.window.close();
  });
  return { dom, engine, inspector, editor };
}
test('all primitive kinds, subtree duplicate/delete/reparent and full history round trip', async (t) => {
  const { engine, inspector, editor } = await setup(t);
  for (const kind of [
    'box',
    'sphere',
    'plane',
    'cylinder',
    'cone',
    'capsule',
    'torus',
    'circle',
    'ring',
    'torusKnot',
  ]) {
    const mesh = editor.createPrimitive(kind);
    assert.ok(mesh.geometry.indices.length > 0, kind);
    inspector.undo();
    assert.equal(mesh.geometry, null);
    inspector.redo();
    assert.ok(mesh.geometry.indices.length > 0);
  }
  inspector.history.clear();
  const parent = editor.createPrimitive(),
    child = editor.createPrimitive('sphere', parent);
  parent.name = 'Parent';
  child.name = 'Child';
  parent.setPosition([2, 1, -1]).setQuaternion([0.1, 0.3, 0.2, 0.9]);
  child.setScale([2, 3, 4]);
  child.setMaterial(parent.material);
  const copy = editor.duplicate(parent),
    copiedChild = [...engine.scene.meshes.values()].find((m) => engine.store.parents[m.id] === copy.id);
  assert.equal(copy.name, 'Parent copy');
  assert.equal(copiedChild.name, 'Child');
  assert.equal(copy.geometry, parent.geometry);
  assert.notEqual(copy.material, parent.material);
  assert.equal(copiedChild.material, copy.material);
  assert.deepEqual([...copy.material.data], [...parent.material.data]);
  assert.equal(copiedChild.scale.y, 3);
  editor.reparent(child, copy);
  assert.equal(engine.store.parents[child.id], copy.id);
  assert.throws(() => editor.reparent(copy, child), /below itself/);
  inspector.undo();
  assert.equal(engine.store.parents[child.id], parent.id);
  editor.delete(copy);
  assert.equal(copy.geometry, null);
  assert.equal(copiedChild.geometry, null);
  assert.equal(inspector.root.querySelector(`[data-entity="${copy.id}"]`), null);
  inspector.undo();
  assert.equal(inspector.selected, copy);
  assert.ok(copiedChild.geometry);
  inspector.redo();
  inspector.history.clear();
  assert.throws(() => copy.check(), /disposed/i);
  assert.throws(() => copiedChild.check(), /disposed/i);
  parent.check();
  child.check();
});
test('regression: delete/restore preserves prior property and gizmo command identity, and never touches reused ids', async (t) => {
  const { dom, engine, inspector, editor } = await setup(t);
  const mesh = engine.createMesh().setGeometry(box());
  inspector.select(mesh);
  const input = inspector.root.querySelector('[data-property="position.x"]');
  input.value = '3';
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const gizmo = InspectorGizmo.attach(engine, inspector);
  gizmo.controls.dispatchEvent({ type: 'mouseDown' });
  mesh.setPosition([6, 0, 0]);
  gizmo.controls.dispatchEvent({ type: 'mouseUp' });
  editor.delete(mesh);
  assert.equal(mesh.geometry, null);
  inspector.undo();
  assert.equal(inspector.selected, mesh);
  assert.ok(mesh.geometry);
  inspector.undo();
  assert.equal(mesh.position.x, 3);
  inspector.undo();
  assert.equal(mesh.position.x, 0);
  inspector.redo();
  inspector.redo();
  inspector.redo();
  inspector.history.clear();
  assert.throws(() => mesh.check(), /disposed/i);
  const reused = engine.createMesh().setPosition([42, 0, 0]);
  assert.equal(reused.id, mesh.id);
  assert.equal(inspector.undo(), false);
  assert.equal(reused.position.x, 42);
  gizmo.dispose();
});
test('history eviction, abandoned redo and clear release each retained deleted resource exactly once', async (t) => {
  const { editor, inspector } = await setup(t, { historyLimit: 1 });
  const mesh = editor.createPrimitive();
  inspector.undo();
  editor.createPrimitive('sphere');
  assert.throws(() => mesh.check(), /disposed/i);
  const deleted = inspector.selected;
  editor.delete(deleted);
  inspector.undo();
  deleted.check();
  assert.ok(deleted.geometry);
  inspector.redo();
  editor.createPrimitive();
  assert.throws(() => deleted.check(), /disposed/i);
  const calls = [],
    history = new EditHistory(1);
  const edit = (n) => ({ label: String(n), undo() {}, redo() {}, discard: () => calls.push(n) });
  history.record(edit(1));
  history.record(edit(2));
  history.undo();
  history.record(edit(3));
  history.clear();
  history.clear();
  assert.deepEqual(calls, [1, 2, 3]);
});
test('tree drag, root drop, shortcuts, scene isolation, abort and editor teardown', async (t) => {
  const { dom, engine, editor, inspector } = await setup(t);
  const a = editor.createPrimitive(),
    b = editor.createPrimitive('sphere');
  const tree = inspector.root.querySelector('[role="tree"]');
  const event = (type, target) => target.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
  event('dragstart', tree.querySelector(`[data-entity="${b.id}"]>.row`));
  event('drop', tree.querySelector(`[data-entity="${a.id}"]>.row`));
  assert.equal(engine.store.parents[b.id], a.id);
  event('dragstart', tree.querySelector(`[data-entity="${b.id}"]>.row`));
  event('drop', tree);
  assert.equal(engine.store.parents[b.id], -1);
  inspector.select(b);
  tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
  assert.equal(inspector.selected.name, 'sphere copy');
  tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal(inspector.selected, null);
  const other = engine.createScene();
  assert.throws(() => editor.reparent(a, other.createMesh()), /inspector scene/);
  const ac = new AbortController();
  editor.dispose();
  const e = SceneEditor.attach(engine, inspector, { signal: ac.signal });
  ac.abort();
  assert.equal(e.element.isConnected, false);
  assert.equal(
    [...engine.plugins.keys()].some((n) => n.startsWith('inspector:edit:')),
    false,
  );
});
test('ambient lights are real scene contributions with copied settings, parent visibility and undo', async (t) => {
  const { editor, inspector, engine } = await setup(t);
  const before = [...engine.lighting.ambient, engine.lighting.radiance[3]];
  const mesh = editor.createLight('ambient', { color: [1, 0, 0], intensity: 2 });
  assert.ok(engine.lighting.ambient[0] > 2);
  editor.setLight(mesh, { intensity: 3 });
  assert.ok(engine.lighting.ambient[0] > 3);
  inspector.undo();
  assert.ok(engine.lighting.ambient[0] < 3);
  const copy = editor.duplicate(mesh);
  assert.deepEqual(editor.light(copy), editor.light(mesh));
  editor.delete(copy);
  editor.delete(mesh);
  assert.deepEqual([...engine.lighting.ambient, engine.lighting.radiance[3]], before);
  inspector.undo();
  assert.ok(engine.lighting.ambient[0] > 2);
  assert.throws(() => editor.setLight(mesh, { intensity: -1 }), /Light needs/);
  assert.throws(() => editor.createLight('point'), /WebGPU/);
});

test('invalid history finalizers reject before abandoning redo or releasing resources', () => {
  const history = new EditHistory(), released = [];
  history.record({ label: 'Existing', undo() {}, redo() {}, discard: () => released.push('existing') });
  history.undo();
  assert.throws(() => history.record({ label: 'Invalid', undo() {}, redo() {}, discard: 42 }), TypeError);
  assert.equal(history.undoCount, 0);
  assert.equal(history.redoCount, 1);
  assert.deepEqual(released, []);
  history.redo();
  history.clear();
  assert.deepEqual(released, ['existing']);
});

test('an editor attached while the inspector parent is detached survives until the inspector is removed', async (t) => {
  const dom = new JSDOM('<body><canvas width="800" height="600"></canvas></body>'),
    doc = dom.window.document;
  const engine = new Engine(
    doc.querySelector('canvas'),
    await TransformStore.create(64),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 5, 10], target: [0, 0, 0] },
    null,
  );
  t.after(() => {
    engine.dispose();
    dom.window.close();
  });
  const panel = doc.createElement('div');
  const inspector = Inspector.attach(engine, { parent: panel, pick: false });
  const editor = SceneEditor.attach(engine, inspector);
  const mesh = editor.createPrimitive();
  await new Promise((resolve) => setTimeout(resolve, 0));
  doc.body.append(panel);
  editor.refresh();
  assert.ok(editor.createPrimitive('sphere', mesh));
  assert.equal(editor.element.isConnected, true);
  inspector.element.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => editor.createPrimitive(), /disposed/);
});

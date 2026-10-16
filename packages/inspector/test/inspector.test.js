import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore, box } from '@margoengine/core/extension';
import { Inspector } from '../dist/index.js';

async function scene(t) {
  const dom = new JSDOM('<body><canvas width="200" height="200"></canvas></body>'),
    canvas = dom.window.document.querySelector('canvas');
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(canvas, store, renderer, undefined, null),
    effects = { exposure: 0, bloom: 0.5 };
  const inspector = Inspector.attach(engine, { parent: dom.window.document.body, effects });
  t.after(() => {
    engine.dispose();
    dom.window.close();
  });
  return { engine, inspector, dom, effects };
}
const field = (inspector, key) => inspector.root.querySelector(`[data-property="${key}"]`);
function edit(dom, input, value, event = 'change') {
  input.value = value;
  input.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
}

test('hierarchy nests entities, escapes names and supports keyboard expansion and selection', async (t) => {
  const { engine, inspector, dom } = await scene(t),
    parent = engine.createMesh(),
    child = engine.createMesh(parent).setGeometry(box());
  parent.name = '<script>Root</script>';
  child.name = 'Child';
  inspector.refresh();
  const tree = inspector.root.querySelector('[role=tree]'),
    first = tree.querySelector('[role=treeitem]');
  assert.equal(first.getAttribute('aria-expanded'), 'true');
  assert.equal(first.querySelector('[role=group]').children.length, 1);
  assert.equal(tree.querySelector('script'), null);
  assert.match(tree.textContent, /<script>Root<\/script>/);
  first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(inspector.selected, child);
  const selected = tree.querySelector('[aria-selected=true]');
  selected.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(inspector.selected, parent);
  tree
    .querySelector('[aria-selected=true]')
    .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(tree.querySelector('[aria-selected=true]').getAttribute('aria-expanded'), 'false');
  inspector.select(child);
  assert.equal(tree.querySelector('[role=treeitem]').getAttribute('aria-expanded'), 'true');
});
test('duplicate attachment removes only the rejected overlay', async (t) => {
  const { engine, inspector, dom } = await scene(t);
  assert.throws(() => Inspector.attach(engine, { parent: dom.window.document.body }), {
    name: 'TypeError',
    message: 'Invalid plugin',
  });
  assert.equal(dom.window.document.querySelectorAll('[data-margo-inspector]').length, 1);
  assert.equal(inspector.element.isConnected, true);
});

test('live properties update transforms, PBR values and bound effects and reject invalid transforms', async (t) => {
  const { engine, inspector, dom, effects } = await scene(t),
    mesh = engine.createMesh().setGeometry(box());
  inspector.select(mesh);
  edit(dom, field(inspector, 'name'), 'Renamed');
  assert.equal(mesh.name, 'Renamed');
  edit(dom, field(inspector, 'position.x'), '4');
  assert.equal(mesh.position.x, 4);
  edit(dom, field(inspector, 'scale.y'), '0');
  assert.equal(mesh.scale.y, 1);
  assert.equal(field(inspector, 'scale.y').validity.valid, false);
  edit(dom, field(inspector, 'roughness'), '0.25', 'input');
  edit(dom, field(inspector, 'metallic'), '0.75', 'input');
  assert.equal(mesh.material.data[4], 0.25);
  assert.equal(mesh.material.data[5], 0.75);
  edit(dom, field(inspector, 'exposure'), '2', 'input');
  edit(dom, field(inspector, 'bloom'), '1', 'input');
  assert.deepEqual(effects, { exposure: 2, bloom: 1 });
  const visible = field(inspector, 'visible');
  visible.checked = false;
  visible.dispatchEvent(new dom.window.Event('change'));
  assert.equal(mesh.visible, false);
  assert.equal(field(inspector, 'bounds').disabled, true);
  assert.throws(() => inspector.setDebug('normals', true), /WebGPU/);
  assert.throws(() => inspector.setDebug('toString', true), /Invalid/);
});

test('entity disposal, slot reuse, foreign handles and teardown do not leave stale controls or passes', async (t) => {
  const { engine, inspector } = await scene(t),
    mesh = engine.createMesh();
  inspector.select(mesh);
  mesh.dispose();
  const replacement = engine.createMesh();
  inspector.refresh();
  assert.equal(inspector.selected, null);
  assert.equal(field(inspector, 'name').disabled, true);
  inspector.root.querySelector('.row').click();
  assert.equal(inspector.selected, replacement);
  assert.throws(() => inspector.select(mesh), /disposed/);
  const foreign = { engine: {}, check() {} };
  assert.throws(() => inspector.select(foreign), /another/);
  inspector.dispose();
  inspector.dispose();
  assert.equal(inspector.element.isConnected, false);
  assert.equal(engine.hasPlugin('inspector'), false);
  engine.render();
  assert.throws(() => inspector.select(replacement), /not attached/);
});

test('disabled debug rendering skips the frame mesh scan and resumes it for live helpers', async (t) => {
  const { engine, inspector } = await scene(t),
    mesh = engine.createMesh().setGeometry(box());
  // Exercise the sync pass without a native device; the Lines draw pass remains inactive.
  Object.defineProperty(engine, 'backend', { value: 'webgpu', configurable: true });
  const original = engine.meshes.values;
  let scans = 0;
  t.mock.method(engine.meshes, 'values', function () {
    scans++;
    return original.call(this);
  });
  const frame = () => engine.frameGraph.execute({ backend: 'webgpu', draw() {} });
  for (let i = 0; i < 120; i++) frame();
  assert.equal(scans, 0, 'an inspector with no debug helpers must not scan meshes each frame');
  inspector.setDebug('bounds', true);
  frame();
  assert.equal(scans, 1);
  inspector.setDebug('bounds', false);
  frame();
  assert.equal(scans, 2, 'retained helpers still synchronize visibility');
  mesh.dispose();
  frame();
  const afterCleanup = scans;
  for (let i = 0; i < 120; i++) frame();
  assert.equal(scans, afterCleanup, 'disposed debug helpers must release the steady-frame scan');
});

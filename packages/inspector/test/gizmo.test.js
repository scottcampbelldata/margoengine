import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore, box } from '@margoengine/core/extension';
import { Inspector } from '../dist/index.js';
import { InspectorGizmo } from '../dist/gizmo.js';
async function fixture(t) {
  const dom = new JSDOM('<body><canvas width="800" height="600"></canvas></body>'),
    canvas = dom.window.document.querySelector('canvas');
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const engine = new Engine(
    canvas,
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 5, 10], target: [0, 0, 0] },
    null,
  );
  const inspector = Inspector.attach(engine, { parent: dom.window.document.body, pick: false }),
    camera = { enabled: true },
    gizmo = InspectorGizmo.attach(engine, inspector, { cameraControls: camera }),
    mesh = engine.createMesh().setGeometry(box());
  inspector.select(mesh);
  gizmo.sync();
  engine.render();
  t.after(() => {
    gizmo.dispose();
    engine.dispose();
    dom.window.close();
  });
  return { dom, canvas, engine, inspector, gizmo, mesh, camera };
}
function pose(engine, mesh) {
  return ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((key) => engine.store.transforms[key][mesh.id]);
}
function pixel(engine, p) {
  const m = engine.camera.matrix,
    q = [...p, 1],
    projected = [0, 1, 2, 3].map((row) => q.reduce((v, c, col) => v + c * m[col * 4 + row], 0));
  return [(projected[0] / projected[3] + 1) * 400, (1 - projected[1] / projected[3]) * 300];
}
function end(dom, canvas) {
  const event = new dom.window.Event('pointerup');
  Object.defineProperty(event, 'pointerId', { value: null });
  canvas.dispatchEvent(event);
}
test('selection tracks tree changes and translate/rotate/scale drags share undo as whole gestures', async (t) => {
  const { dom, canvas, engine, inspector, gizmo, mesh, camera } = await fixture(t),
    controls = gizmo.controls;
  for (const mode of ['translate', 'rotate', 'scale']) {
    controls.setMode(mode);
    const f = controls.frame(),
      o = f.origin,
      r = f.size;
    controls.axis = mode === 'rotate' ? 'Y' : 'X';
    const from = [o[0] + r, o[1], o[2]],
      to = mode === 'rotate' ? [o[0], o[1], o[2] - r] : [o[0] + 2 * r, o[1], o[2]];
    const before = pose(engine, mesh);
    controls.pointerDown(...pixel(engine, from));
    assert.equal(camera.enabled, false);
    controls.pointerMove(...pixel(engine, to));
    end(dom, canvas);
    assert.equal(camera.enabled, true);
    assert.equal(inspector.history.undoCount, 1, mode);
    const after = pose(engine, mesh);
    assert.notDeepEqual(after, before, mode);
    inspector.undo();
    assert.deepEqual(pose(engine, mesh), before, mode);
    inspector.redo();
    assert.deepEqual(pose(engine, mesh), after, mode);
    inspector.undo();
    inspector.history.clear();
  }
  const second = engine.createMesh();
  inspector.select(second);
  await Promise.resolve();
  assert.equal(controls.object, second);
  second.dispose();
  gizmo.sync();
  assert.equal(controls.object, null);
  assert.equal(mesh.position.x, 0);
});
test('cancel, disposed ids, toolbar, shortcuts, abort and original tab index are safe', async (t) => {
  const { dom, canvas, engine, inspector, gizmo, mesh, camera } = await fixture(t),
    c = gizmo.controls;
  const f = c.frame(),
    r = f.size;
  c.axis = 'X';
  c.pointerDown(...pixel(engine, [r, 0, 0]));
  c.pointerMove(...pixel(engine, [2 * r, 0, 0]));
  c.cancelDrag();
  assert.equal(inspector.history.undoCount, 0);
  assert.equal(camera.enabled, true);
  assert.equal(mesh.position.x, 0);
  gizmo.element.querySelectorAll('button')[2].click();
  assert.equal(c.mode, 'scale');
  canvas.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyE' }));
  assert.equal(c.mode, 'rotate');
  inspector.select(null);
  gizmo.sync();
  assert.equal(c.object, null);
  inspector.select(mesh);
  gizmo.sync();
  c.dispatchEvent({ type: 'mouseDown' });
  mesh.setPosition([2, 0, 0]);
  c.dispatchEvent({ type: 'mouseUp' });
  mesh.dispose();
  const reused = engine.createMesh().setPosition([9, 0, 0]);
  inspector.undo();
  assert.equal(reused.position.x, 9);
  gizmo.dispose();
  assert.equal(canvas.hasAttribute('tabindex'), false);
  assert.equal(gizmo.element.isConnected, false);
  assert.equal(
    [...engine.plugins.keys()].some((n) => n.startsWith('inspector:gizmo:')),
    false,
  );
  const abort = new AbortController(),
    other = InspectorGizmo.attach(engine, inspector, { signal: abort.signal });
  abort.abort();
  assert.equal(other.element.isConnected, false);
});
test('secondary scene ownership and inspector disposal release all gizmo resources', async (t) => {
  const { dom, engine } = await fixture(t),
    other = engine.createScene('Other');
  const inspector = new Inspector({ parent: dom.window.document.body });
  other.use(inspector);
  const gizmo = InspectorGizmo.attach(engine, inspector),
    mesh = other.createMesh().setGeometry(box());
  inspector.select(mesh);
  gizmo.sync();
  assert.ok([...other.plugins.keys()].includes(gizmo.controls.pluginName));
  assert.equal([...engine.scene.plugins.keys()].includes(gizmo.controls.pluginName), false);
  inspector.dispose();
  await Promise.resolve();
  assert.equal(other.plugins.size, 0);
  assert.equal(engine.scene.plugins.has('inspector'), true, 'disposing another scene inspector keeps the default one');
  assert.equal(gizmo.element.isConnected, false);
});

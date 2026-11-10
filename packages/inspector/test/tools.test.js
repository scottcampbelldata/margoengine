import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, Camera, TransformStore, box } from '@margoengine/core/extension';
import { CameraTools } from '../dist/tools.js';
async function fixture(t) {
  const dom = new JSDOM('<body><canvas width="200" height="160"></canvas></body>'),
    engine = new Engine(
      dom.window.document.querySelector('canvas'),
      await TransformStore.create(16),
      { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
      undefined,
      null,
    ),
    mesh = engine.createMesh().setGeometry(box()),
    camera = new Camera({ position: [4, 2, 3], fov: 40 }),
    node = engine.createMesh().setPosition([3, 4, 5]),
    model = {
      name: 'Camera rig',
      root: node,
      engine,
      disposed: false,
      cameras: [
        { type: 'orthographic', name: 'Ortho', node, orthographic: { xmag: 2, ymag: 2, znear: 0.1, zfar: 100 } },
      ],
    },
    panel = CameraTools.attach(engine, {
      parent: dom.window.document.body,
      cameras: [{ id: 'side', label: 'Side view', camera }],
      models: [model],
    });
  t.after(() => {
    panel.dispose();
    engine.dispose();
    dom.window.close();
  });
  return { dom, engine, mesh, camera, model, panel };
}
test('camera list switches live app and loaded orthographic cameras, and restores the original projection', async (t) => {
  const { engine, camera, model, panel } = await fixture(t),
    home = [...engine.camera.position];
  assert.equal(panel.list().length, 3);
  await panel.select('side');
  assert.deepEqual(engine.camera.position, camera.position);
  assert.equal(engine.camera.fov, 40);
  camera.position = [8, 3, 6];
  panel.onPreUpdate();
  assert.deepEqual(engine.camera.position, camera.position);
  const loaded = panel.list().find((c) => c.label.includes('Ortho'));
  await panel.select(loaded.id);
  assert.deepEqual(engine.camera.position, [3, 4, 5]);
  assert.equal(typeof engine.camera.project, 'function');
  model.disposed = true;
  panel.onPreUpdate();
  assert.deepEqual(engine.camera.position, home);
  assert.equal(engine.camera.project, undefined);
  await panel.select('side');
  const replacement = new Camera({ position: [9, 8, 7] });
  panel.addCamera({ id: 'side', label: 'Replacement', camera: replacement });
  panel.onPreUpdate();
  assert.deepEqual(engine.camera.position, replacement.position);
  panel.removeCamera('side');
  assert.deepEqual(engine.camera.position, home);
  await assert.rejects(panel.select('missing'), /CameraTools.list/);
  model.disposed = false;
  const stale = panel.select(loaded.id);
  model.disposed = true;
  await assert.rejects(stale, /no longer available/);
});
test('screenshots return image data and unwind null encoder, abort, timeout and disposal', async (t) => {
  const { engine, panel } = await fixture(t);
  engine.canvas.toBlob = (callback) => callback(new Blob(['png'], { type: 'image/png' }));
  assert.equal((await panel.screenshot()).type, 'image/png');
  engine.canvas.toBlob = (callback) => callback(null);
  await assert.rejects(panel.screenshot(), /no image/);
  engine.canvas.toBlob = () => {};
  const controller = new AbortController(),
    pending = panel.screenshot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(panel.screenshot({ timeout: 5 }), /timed out/);
  const disposed = panel.screenshot();
  panel.dispose();
  await assert.rejects(disposed, { name: 'AbortError' });
});
test('real exporters write scene GLB and embedded glTF; missing recording support surfaces a coded error', async (t) => {
  const { panel } = await fixture(t),
    binary = await panel.exportGLTF(),
    json = await panel.exportGLTF({ binary: false });
  const data = new DataView(await binary.arrayBuffer());
  assert.equal(data.getUint32(0, true), 0x46546c67);
  assert.equal(data.getUint32(4, true), 2);
  const document = JSON.parse(await json.text());
  assert.equal(document.asset.version, '2.0');
  assert.ok(document.meshes.length > 0);
  assert.match(document.buffers[0].uri, /^data:/);
  await assert.rejects(panel.startRecording(), (error) => error.code === 'unsupported');
  await assert.rejects(panel.stopRecording(), /Start a canvas recording/);
});

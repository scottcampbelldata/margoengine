import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
browser.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const result = await browser.page.evaluate(
    async () => {
      const { Engine, box } = await import('/packages/core/dist/extension.js');
      const { Picking } = await import('/packages/selection/dist/index.js');
      const { SpatialPicking } = await import('/packages/selection/dist/spatial.js');
      const { XRController } = await import('/packages/xr/dist/index.js');
      const { XRPointerEvents } = await import('/packages/xr/dist/pointer.js');
      const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:128px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 4], target: [0, 0, 0] },
      });
      const checks = [],
        check = (value, message) => {
          if (!value) throw new Error(message);
          checks.push(message);
        };
      let pointers;
      try {
        const picking = Picking.attach(engine),
          spatial = new SpatialPicking(engine, picking);
        const mesh = engine.createMesh().setGeometry(box());
        check((await spatial.ray([0, 0, 4], [0, 0, -1]))?.mesh === mesh, 'GPU ray selects a core mesh');
        check((await spatial.sphere([0, 0, 0.6], 0.11))?.mesh === mesh, 'world sphere selects a core triangle');
        check(
          (await spatial.ray([0, 0, 4], [0, 1, 0])) === null,
          'vertical world ray misses without changing desktop camera',
        );
        const source = { handedness: 'right', targetRayMode: 'tracked-pointer', targetRaySpace: {}, profiles: [] };
        const controller = new XRController(source);
        controller.targetRay = {};
        controller.targetRayMatrix.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4, 1]);
        let frame, failure;
        const session = new EventTarget();
        session.inputSources = [source];
        const xr = {
          session,
          controllers: [controller],
          onFrame(fn) {
            frame = fn;
            return () => {
              frame = null;
            };
          },
        };
        const events = [];
        // Wait for the actual asynchronous selection result, with an independent hard browser timeout below.
        let notify;
        pointers = XRPointerEvents.attach(xr, spatial, {
          types: ['ray'],
          onEvent(e) {
            events.push(e.type);
            if (e.type === 'pointerdown' || e.type === 'click') notify?.();
          },
          onError(e) {
            failure = e;
            notify?.();
          },
        });
        controller.buttons[1] = 1;
        await new Promise((resolve) => {
          notify = resolve;
          frame({});
        });
        controller.buttons[1] = 0;
        await new Promise((resolve) => {
          notify = resolve;
          frame({});
        });
        if (failure) throw failure;
        check(
          events.includes('pointerover') &&
            events.includes('pointerdown') &&
            events.includes('pointerup') &&
            events.includes('click'),
          'XR ray delivers hover, press, release and click through real GPU selection',
        );
        pointers.dispose();
        pointers = undefined;
        mesh.dispose();
        // Real standard sample, Cesium CC BY 4.0, already recorded in exporters/tests/fixtures/NOTICE.md.
        const model = await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb');
        const hit = await spatial.ray([0, 0, 4], [0, 0, -1]);
        check(
          hit?.model === model && hit.primitiveIndex !== undefined,
          'GPU ray retains the licensed model primitive identity',
        );
        const contact = await spatial.sphere([0, 0, 0.6], 0.11);
        check(
          contact?.model === model && Math.abs(contact.distance - 0.1) < 1e-6,
          'proximity selects the licensed model in world metres',
        );
      model.dispose();
      const scene = engine.createScene('spatial-secondary');
      let scenePicker, sceneMesh;
      scene.use({ name: 'pointer-fixture', setup() {
        scenePicker = Picking.attach(engine);
        sceneMesh = engine.createMesh().setGeometry(box());
      } });
      scene.removePlugin('pointer-fixture');
      const sceneSpatial = SpatialPicking.attach(engine, scenePicker, { scene });
      check((await sceneSpatial.ray([0, 0, 4], [0, 0, -1]))?.mesh === sceneMesh,
        'secondary-scene ray uses its registered picker and preserves scene identity');
      sceneSpatial.dispose(); scenePicker.dispose(); scene.dispose();
        spatial.dispose();
        picking.dispose();
        await engine.gpu.queue.onSubmittedWorkDone();
        return checks;
      } finally {
        pointers?.dispose();
        engine.dispose();
        canvas.remove();
      }
    },
    undefined,
    { timeout: 120000 },
  );
  assert.deepEqual(errors, []);
  const mode = process.argv.includes('--compat') ? 'compat' : 'webgpu';
  await writeFile(
    `test-results/batch268-pointer-${mode}.json`,
    JSON.stringify({ hardware: browser.hardware, checks: result }, null, 2),
  );
  console.log(`${mode}: ${result.length} XR pointer GPU checks passed`);
} finally {
  await browser.close();
}

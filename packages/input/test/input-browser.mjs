import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { usePointerLock } from '../../../scripts/support/pointer-lock.mjs';
const context = await openBrowser({ startPath: '/packages/input/test/input-browser.html', port: 'free' });
const { page } = context,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.evaluate(async () => {
    const { EngineKernel, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { box } = await import('/packages/core/dist/extension.js');
    const { VectorInput, wasd } = await import('/packages/input/dist/vector.js');
    const { PointerLock } = await import('/packages/input/dist/lock.js');
    const { KeyboardLabels } = await import('/packages/input/dist/layout.js');
    const labels = new KeyboardLabels();
    await labels.refresh();
    const prompt = document.createElement('output');
    prompt.dataset.keyPrompt = '';
    prompt.textContent = labels.label({ type: 'key', code: 'KeyQ' });
    document.body.append(prompt);
    const mapped = labels.map?.get('KeyQ');
    const expectedPrompt = mapped?.trim() ? (/^[a-z]$/.test(mapped) ? mapped.toUpperCase() : mapped) : 'Q';
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 128;
    canvas.style.cssText = 'width:192px;height:128px;display:block';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 0, 4], target: [0, 0, 0] },
    });
    const mesh = engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: '#ff2020' }));
    const input = new VectorInput(
        { move: wasd() },
        { actions: { look: [{ type: 'control', id: 'lock', axis: 'x', scale: 0.02 }] } },
      ),
      lock = new PointerLock(canvas);
    lock.attach(input);
    window.inputCheck = {
      engine,
      input,
      lock,
      error: null,
      labels,
      expectedPrompt,
      async tick() {
        lock.update();
        input.update();
        mesh.setPosition([input.vector('move').x * 0.5 + input.state('look').value, 0, 0]);
        engine.render();
        await engine.gpu?.queue.onSubmittedWorkDone();
      },
    };
    document.querySelector('#lock').onclick = () =>
      lock.request({ unadjustedMovement: false }).catch((error) => {
        window.inputCheck.error = String(error);
      });
    await window.inputCheck.tick();
  });
  assert.equal(
    await page.locator('[data-key-prompt]').textContent(),
    await page.evaluate(() => window.inputCheck.expectedPrompt),
    'prompt uses the native keyboard map where available and a physical-code label otherwise',
  );
  const centroid = async () => {
    const image = await decodePNG(await page.locator('canvas').screenshot({ timeout: 10000 }));
    let count = 0,
      sum = 0;
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        if (image.data[i] > image.data[i + 1] + 30 && image.data[i] > image.data[i + 2] + 30) {
          count++;
          sum += x;
        }
      }
    assert.ok(count > 100, `rendered red geometry: ${count} pixels`);
    return sum / count;
  };
  const before = await centroid();
  const penAngles = await page.evaluate(async () => {
    const { Pen } = await import('/packages/input/dist/pen.js');
    const target = new EventTarget(),
      pen = new Pen(target);
    const read = (fields) => {
      target.dispatchEvent(Object.assign(new Event('pointermove'), { pointerType: 'pen', ...fields }));
      return [pen.latest.altitude, pen.latest.azimuth];
    };
    try {
      return {
        ambiguous: [
          [-90, -30],
          [-90, 30],
          [90, -30],
          [90, 30],
          [-30, -90],
          [30, -90],
          [-30, 90],
          [30, 90],
          [-90, -90],
          [-90, 90],
          [90, -90],
          [90, 90],
        ].map(([tiltX, tiltY]) => read({ tiltX, tiltY })),
        axes: [
          [90, 0],
          [-90, 0],
          [0, 90],
          [0, -90],
        ].map(([tiltX, tiltY]) => read({ tiltX, tiltY })),
        explicit: read({ tiltX: 90, tiltY: 90, altitudeAngle: 0, azimuthAngle: Math.PI / 4 }),
      };
    } finally {
      pen.dispose();
    }
  });
  assert.deepEqual(
    penAngles.ambiguous,
    Array.from({ length: 12 }, () => [0, 0]),
  );
  assert.deepEqual(penAngles.axes, [
    [0, 0],
    [0, Math.PI],
    [0, Math.PI / 2],
    [0, Math.PI * 1.5],
  ]);
  assert.deepEqual(penAngles.explicit, [0, Math.PI / 4]);
  // Native lock, or on a locked Mac console the documented Pointer Lock 2.0 stand-in with a printed note.
  const lockSupport = await usePointerLock(page, { label: 'input pointer lock' });
  await page.locator('#lock').click({ timeout: 10000 });
  await page.waitForFunction(() => window.inputCheck.lock.locked || window.inputCheck.error, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.inputCheck.error), null);
  await page.keyboard.down('KeyD');
  await page.evaluate(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 15, movementY: 0 }));
    await window.inputCheck.tick();
  });
  const after = await centroid();
  assert.ok(after > before + 10, `vector and locked movement drive rendered position: ${before} -> ${after}`);
  await page.keyboard.up('KeyD');
  await page.evaluate(async () => {
    window.inputCheck.lock.release();
    await window.inputCheck.tick();
  });
  assert.equal(await page.evaluate(() => window.inputCheck.lock.locked), false);
  const reset = await centroid();
  assert.ok(Math.abs(reset - before) < 1, `release/key-up returns geometry: ${before} -> ${reset}`);
  await page.evaluate(() => {
    window.inputCheck.lock.dispose();
    window.inputCheck.labels.dispose();
    window.inputCheck.input.dispose();
    window.inputCheck.engine.dispose();
  });
  assert.deepEqual(errors, []);
  console.log(
    `Input vector and pointer lock drive rendered geometry; ${lockSupport.native ? 'native' : 'stand-in'} acquisition, release and pixels pass`,
  );
} finally {
  await context.close();
}

// Capability gaps are recorded; actual rendering and selected-thread behavior are always asserted.
// WebKit on Windows is explicitly not native Safari proof.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.slice(10) ?? 'firefox';
const context = await openBrowser({
  browserName,
  startPath: '/packages/worker/tests/browser-matrix.html',
  port: 'free',
});
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const capabilities = await page.evaluate(async () => {
    const source = `onmessage = async () => {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : null;
      const gl = canvas?.getContext('webgl2');
      const result = { offscreen: Boolean(canvas), raf: typeof requestAnimationFrame === 'function',
        webgl2: Boolean(gl), webgpu: Boolean(await navigator.gpu?.requestAdapter()) };
      gl?.getExtension('WEBGL_lose_context')?.loseContext(); postMessage(result);
    };`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    try {
      const workerCapabilities = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker capability probe timed out')), 15000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage(null);
      });
      return {
        transfer: typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
        worker: workerCapabilities,
        userAgent: navigator.userAgent,
      };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });
  const state = await page.evaluate(async () => {
    const { runScene } = await import('/packages/worker/dist/auto.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const buffer = new Uint8Array([42]).buffer;
    window.scene = await runScene(canvas, new URL('/packages/worker/tests/auto-render-scene.js', location.href), {
      backend: 'webgl2',
      data: { backend: 'webgl2', buffer },
      transfer: [buffer],
    });
    return {
      mode: window.scene.mode,
      original: window.scene.canvas === canvas,
      detached: buffer.byteLength === 0,
      fallback: window.scene.fallbackReason?.code,
    };
  });
  const supported =
    capabilities.transfer && capabilities.worker.offscreen && capabilities.worker.raf && capabilities.worker.webgl2;
  assert.equal(state.mode, supported ? 'worker' : 'page');
  assert.equal(state.original, true);
  assert.equal(state.detached, supported);
  const screenshot = (await page.screenshot({ clip: { x: 0, y: 0, width: 128, height: 128 } })).toString('base64');
  const pixel = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(64, 64, 1, 1).data];
  }, screenshot);
  assert.ok(pixel[0] > 60 && pixel[0] > pixel[2] * 2, 'WebGL2 red box is displayed on the selected path');
  const disposed = await page.evaluate(async () => {
    await window.scene.dispose();
    return window.scene.disposed;
  });
  assert.equal(disposed, true);
  assert.deepEqual(errors, []);
  const result = { hardware, capabilities, state, pixel, disposed, nativeSafari: false };
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/worker-matrix-${browserName}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await context.close();
}

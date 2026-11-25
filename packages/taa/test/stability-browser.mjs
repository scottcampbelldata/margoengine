// Real-GPU temporal-stability check of TAAUpscale, built packages.
// A thin bright post stands in front of a far flat wall; the camera orbits the post by a fixed angle a frame, so
// the post's silhouette stays put on screen while the wall behind it moves. Every frame is read back, and the edge
// alternation (per pixel, the part of the second difference in time that a steady change does not explain) is
// measured round the post. History rejected at the silhouette shows the raw jittered frame there, which alternates
// with the Halton jitter (KB-OF2 in docs/limits.md, "TAAUpscale temporal stability").
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

// Measured bounds in sRGB luma levels per pixel and frame; docs/limits.md records the numbers and the reason.
const EDGE_BOUND = 0.25;
const timer = setTimeout(() => {
  console.error('stability-browser: timed out after 240 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 240_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-stability/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5383, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5383 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  if (compatRun()) await page.addInitScript(compatShim);
  await page.goto('http://127.0.0.1:5383/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { TAAUpscale } = await import('/packages/taa/dist/upscale.js');
    const canvas = document.querySelector('canvas');
    // The frame is read from the canvas texture itself, copied in the task that drew it: a canvas read in a later task
    // sees transparent black once the browser has presented it (scripts/support/canvas-frame.js), and a page screenshot
    // is blank in a browser started over SSH on Windows (session 0; all zero on the dev PC, 2026-11-15).
    // The prototype is read at each call: the compatibility layer installs its own getContext at the first requestAdapter.
    let presented;
    canvas.getContext = (type, ...rest) => {
      const context = HTMLCanvasElement.prototype.getContext.call(canvas, type, ...rest);
      if (type !== 'webgpu' || context.margoReadable) return context;
      const configure = context.configure.bind(context),
        current = context.getCurrentTexture.bind(context);
      context.configure = (options) => configure({ ...options, usage: (options.usage ?? 0x10) | 0x01 });
      context.getCurrentTexture = () => (presented = current());
      context.margoReadable = true;
      return context;
    };
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0.5, 4], target: [0, 0.5, 0] },
    });
    engine.stop();
    const readback = engine.gpu.createBuffer({ size: 640 * 4 * 480, usage: 0x01 | 0x08 });
    // One flat wall, so nothing but the post's silhouette can change from frame to frame on screen.
    engine
      .createMesh()
      .setGeometry(box(80, 40, 0.5))
      .setPosition([0, 0.5, -40])
      .setMaterial(new PbrMaterial({ color: '#182430' }));
    engine
      .createMesh()
      .setGeometry(box(0.1, 3, 0.1))
      .setPosition([0, 0.5, 0])
      .setMaterial(new PbrMaterial({ color: '#ffffff' }));
    const mover = engine
      .createMesh()
      .setGeometry(box(0.6, 0.6, 0.6))
      .setPosition([-20, 0.5, -1])
      .setMaterial(new PbrMaterial({ color: '#ff0000' }));
    window.t = {
      engine,
      up: null,
      // Draws a frame and returns its RGBA bytes, copied from the canvas texture before it is presented.
      async frame() {
        engine.render({ delta: 1 / 60 });
        const encoder = engine.gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: presented }, { buffer: readback, bytesPerRow: 640 * 4 }, [640, 480]);
        engine.gpu.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const pixels = new Uint8Array(readback.getMappedRange().slice(0));
        readback.unmap();
        if (presented.format.startsWith('bgra'))
          for (let i = 0; i < pixels.length; i += 4) [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
        return pixels;
      },
      // Orbits the post at 4 m, `step` radians a frame from -0.25 rad, and returns the frame's sRGB luma.
      async orbit(step, n) {
        const camera = engine.camera,
          a = -0.25 + step * n;
        camera.position = [4 * Math.sin(a), 0.5, 4 * Math.cos(a)];
        camera.target = [0, 0.5, 0];
        const pixels = await this.frame(),
          out = new Float32Array(640 * 480);
        for (let i = 0; i < out.length; i++)
          out[i] = 0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2];
        return out;
      },
      // Mean over the rectangle and frames of max(0, |x[t] - 2x[t-1] + x[t-2]| - |x[t] - x[t-2]|): 2|a - b| for a
      // pixel that alternates a, b, a, and 0 for one that changes steadily.
      alternation(frames, [x0, y0, x1, y1]) {
        let sum = 0,
          n = 0;
        for (let t = 2; t < frames.length; t++)
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              const i = y * 640 + x,
                a = frames[t][i],
                b = frames[t - 1][i],
                c = frames[t - 2][i];
              sum += Math.max(0, Math.abs(a - 2 * b + c) - Math.abs(a - c));
              n++;
            }
        return sum / n;
      },
      async run(options, step) {
        this.up?.dispose();
        this.up = options ? TAAUpscale.attach(engine, options) : null;
        // Warm-up on the same path, so every measured frame has a full history.
        for (let n = 0; n < 16; n++) await this.orbit(step, n);
        const frames = [];
        for (let n = 16; n < 40; n++) frames.push(await this.orbit(step, n));
        const mean = frames[0].reduce((a, b) => a + b, 0) / frames[0].length;
        return {
          // Columns round the post (about 10 px wide at the centre) and a band of wall well away from it.
          edge: this.alternation(frames, [296, 120, 344, 360]),
          wall: this.alternation(frames, [40, 120, 200, 360]),
          mean,
        };
      },
      // Disocclusion: a red box crosses the wall at speed, so red may only lie round where it is now (as in
      // upscale-browser.mjs); the wall it uncovers must drop the box's history.
      async ghost(options) {
        this.up?.dispose();
        this.up = TAAUpscale.attach(engine, options);
        engine.camera.position = [0, 0.5, 4];
        engine.camera.target = [0, 0.5, 0];
        let pixels;
        for (let i = 0; i <= 24; i++) {
          mover.setPosition([-3 + i * 0.25, 0.5, -1]);
          pixels = await this.frame();
        }
        let trail = 0,
          body = 0;
        for (let y = 0; y < 480; y++)
          for (let x = 0; x < 640; x++) {
            const i = (y * 640 + x) * 4,
              red = pixels[i] > 90 && pixels[i] > pixels[i + 1] * 2 && pixels[i] > pixels[i + 2] * 2;
            if (red && x < 640 * 0.72) trail++;
            else if (red) body++;
          }
        mover.setPosition([-20, 0.5, -1]);
        return { trail, body };
      },
    };
  });
  const run = (options, step) => page.evaluate(([o, s]) => window.t.run(o, s), [options, step]);
  const taa = { scale: 0.67, sharpen: 0 };
  const fast = await run(taa, 0.01),
    slow = await run(taa, 0.001),
    off = await run(null, 0.01),
    ghost = await page.evaluate((o) => window.t.ghost(o), taa);
  const report = { compat: compatRun(), fast, slow, off, ghost, bound: EDGE_BOUND };
  console.log(JSON.stringify(report));
  await page.evaluate(() => window.t.engine.dispose());
  assert.deepEqual(errors, []);
  assert.ok(fast.mean > 10, `the scene is drawn: mean luma ${fast.mean}`);
  assert.ok(
    fast.edge <= EDGE_BOUND,
    `the post edge alternates ${fast.edge.toFixed(3)} levels with a moving camera (bound ${EDGE_BOUND})`,
  );
  // Rejection that follows the jitter rises with camera speed; the accumulation's own jitter residue does not.
  assert.ok(
    fast.edge <= 2 * slow.edge,
    `a fast camera alternates ${fast.edge.toFixed(3)} levels against ${slow.edge.toFixed(3)} for a slow one`,
  );
  assert.ok(ghost.body > 50, `the box is drawn: ${ghost.body}`);
  assert.ok(
    ghost.trail < ghost.body * 0.15,
    `no trail behind the box: ${ghost.trail} red pixels against ${ghost.body}`,
  );
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}

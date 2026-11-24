// Real-GPU check that a still view settles (KB-TAA-STILL1), built packages..
// With the camera and the scene held still, TAA and TAAUpscale kept cycling through their Halton jitter phases: each
// frame mixed a tenth of the current phase's sample into an exponential history and clamped the history to the current
// phase's neighbourhood, so the output never stopped moving (Orrery high view: 0.21 % of pixels off by more than 2
// levels between frames 4 s apart, small highlights by up to 60). Thin posts, small rotated boxes and glossy metal
// give sub-pixel edges and highlights that the jitter finds on some phases only. After a warm-up every frame is read
// back; two frames one frame apart and two 38 frames apart must be equal. The same view with `settle: false` (the
// per-frame resolve alone, as before the fix) must still move, so the scene shows the bug. Then a box crosses the
// still view: it is drawn and leaves no red behind it (`moving`), and the back wall changes colour: the first frame
// after the change hands every pixel to the clamped history: none of the pixels the change moved by more than 20 levels
// still shows exactly what it showed before the change, as a held pixel would (`recolour`).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

// Measured bounds in 8-bit levels per channel; docs/limits.md records the numbers and the reason. A settled pixel
// shows the mean it stored and nothing else, so still frames are equal bit for bit (RTX A6000, native and on the
// WebGL2 layer: 0 levels in every case); with settle false it moves by 42 to 191 levels here (58 to 154 on the layer).
const STILL_MAX = 0;
// Pixels of the recoloured wall that show exactly their old value on the first frame after the change. The clamped
// history keeps a few where the jitter shows a post or wire over the wall and the box still holds the old colour:
// 17 to 38 with settle false, 0 to 19 with it, native and on the layer, of about 141,000; a held view would hold all.
const HELD_MAX = 50;
const timer = setTimeout(() => {
  console.error('still-browser: timed out after 540 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 540_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-still/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5384, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5384 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  if (compatRun()) await page.addInitScript(compatShim);
  await page.goto('http://127.0.0.1:5384/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { TAA } = await import('/packages/taa/dist/index.js'),
      { TAAUpscale } = await import('/packages/taa/dist/upscale.js');
    const canvas = document.querySelector('canvas');
    // The frame is read from the canvas texture in the task that drew it (as stability-browser.mjs).
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
      camera: { position: [0, 1.2, 6], target: [0, 0.4, 0] },
    });
    engine.stop();
    engine.gpu.addEventListener('uncapturederror', (event) => console.error(`GPU: ${event.error.message}`));
    const readback = engine.gpu.createBuffer({ size: 640 * 4 * 480, usage: 0x01 | 0x08 });
    engine
      .createMesh()
      .setGeometry(box(30, 0.2, 30))
      .setPosition([0, -0.1, 0])
      .setMaterial(new PbrMaterial({ color: '#40505c' }));
    const wall = engine
      .createMesh()
      .setGeometry(box(30, 10, 0.3))
      .setPosition([0, 4, -8])
      .setMaterial(new PbrMaterial({ color: '#182430' }));
    const metal = new PbrMaterial({ color: '#f0e0c0', metalness: 1, roughness: 0.15 }),
      white = new PbrMaterial({ color: '#ffffff' });
    // Thin posts and wires: under a pixel wide at this distance.
    for (let i = 0; i < 9; i++) {
      engine
        .createMesh()
        .setGeometry(box(0.015, 2, 0.015))
        .setPosition([-2.4 + i * 0.6, 1, -1])
        .setRotation([0, 0, 0.05 * i])
        .setMaterial(white);
      engine
        .createMesh()
        .setGeometry(box(4.5, 0.01, 0.01))
        .setPosition([0, 0.3 + i * 0.22, -1.5])
        .setMaterial(white);
    }
    // Small glossy metal boxes at many angles: highlights a few pixels across or less.
    for (let x = -6; x <= 6; x++)
      for (let z = 0; z < 4; z++)
        engine
          .createMesh()
          .setGeometry(box(0.07, 0.07, 0.07))
          .setPosition([x * 0.35, 0.05 + 0.12 * ((x + z) & 3), z * 0.6])
          .setRotation([0.3 * x, 0.7 * z + 0.2 * x, 0.11 * x * z])
          .setMaterial(metal);
    const mover = engine
      .createMesh()
      .setGeometry(box(0.6, 0.6, 0.6))
      .setPosition([-20, 0.6, 0.5])
      .setMaterial(new PbrMaterial({ color: '#ff0000' }));
    window.t = {
      engine,
      effect: null,
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
      compare(a, b) {
        let over = 0,
          max = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          if (d > 2) over++;
          if (d > max) max = d;
        }
        return { over: (100 * over) / (a.length / 4), max };
      },
      // Warm up `warm` frames, then compare frame warm with warm + 1 and with warm + 1 + gap.
      async still(kind, options, warm, gap) {
        this.effect?.dispose();
        this.effect = kind === 'TAA' ? TAA.attach(engine, options) : TAAUpscale.attach(engine, options);
        for (let n = 0; n < warm; n++) engine.render({ delta: 1 / 60 });
        const a = await this.frame(),
          b = await this.frame();
        for (let n = 0; n < gap; n++) engine.render({ delta: 1 / 60 });
        const c = await this.frame();
        let mean = 0;
        for (let i = 0; i < a.length; i += 4) mean += a[i + 1];
        return { next: this.compare(a, b), later: this.compare(a, c), mean: mean / (a.length / 4) };
      },
      // After the view has settled, a red box crosses it; red may only lie round where the box is now.
      async moving() {
        let pixels;
        for (let i = 0; i <= 24; i++) {
          mover.setPosition([-3 + i * 0.25, 0.6, 0.5]);
          pixels = await this.frame();
        }
        let trail = 0,
          body = 0;
        for (let y = 0; y < 480; y++)
          for (let x = 0; x < 640; x++) {
            const i = (y * 640 + x) * 4,
              red = pixels[i] > 90 && pixels[i] > pixels[i + 1] * 2 && pixels[i] > pixels[i + 2] * 2;
            if (red && x < 640 * 0.68) trail++;
            else if (red) body++;
          }
        mover.setPosition([-20, 0.6, 0.5]);
        return { trail, body };
      },
      // The settled wall turns brick red: over the pixels the change moved by more than 20 levels (against the frame
      // that settles on the new colour), the first frame after it, compared with the frame before. Then the old colour
      // comes back.
      async recolour() {
        for (let n = 0; n < 200; n++) engine.render({ delta: 1 / 60 });
        const before = await this.frame();
        wall.setMaterial(new PbrMaterial({ color: '#8a3020' }));
        const first = await this.frame();
        for (let n = 0; n < 200; n++) engine.render({ delta: 1 / 60 });
        const settled = await this.frame();
        wall.setMaterial(new PbrMaterial({ color: '#182430' }));
        let count = 0,
          held = 0,
          sum = 0;
        for (let i = 0; i < before.length; i += 4) {
          if (Math.abs(settled[i] - before[i]) <= 20) continue;
          const away = (x) => Math.max(...[0, 1, 2].map((c) => Math.abs(first[i + c] - x[i + c])));
          count++;
          sum += away(settled);
          if (away(before) === 0) held++;
        }
        return { pixels: count, held, mean: sum / count };
      },
    };
  });
  const cases = [];
  for (const settle of [true, false])
    cases.push(
      ['TAA', { settle }],
      ['TAAUpscale', { scale: 0.67, sharpen: 0, settle }],
      ['TAAUpscale', { scale: 0.5, settle }],
    );
  const report = { compat: compatRun(), bound: STILL_MAX, cases: [] };
  for (const [kind, options] of cases) {
    try {
      const still = await page.evaluate(([k, o]) => window.t.still(k, o, 240, 37), [kind, options]),
        moving = await page.evaluate(() => window.t.moving()),
        recolour = await page.evaluate(() => window.t.recolour());
      report.cases.push({ kind, options, ...still, moving, recolour });
    } catch (error) {
      throw new Error(`${kind} ${JSON.stringify(options)}: ${error.message}; page errors: ${errors.join(' | ')}`);
    }
  }
  console.log(JSON.stringify(report));
  await page.evaluate(() => window.t.engine.dispose());
  assert.deepEqual(errors, []);
  for (const { kind, options, next, later, mean, moving, recolour } of report.cases) {
    const name = `${kind} ${JSON.stringify(options)}`;
    assert.ok(mean > 10, `${name}: the scene is drawn (mean green ${mean})`);
    if (options.settle) {
      assert.ok(next.max <= STILL_MAX, `${name}: consecutive still frames differ by up to ${next.max} levels`);
      assert.ok(later.max <= STILL_MAX, `${name}: still frames 38 apart differ by up to ${later.max} levels`);
    } else
      assert.ok(
        next.max > 2 && later.max > 2,
        `${name}: without settling the view keeps moving (${next.max}, ${later.max} levels), so the scene shows the bug`,
      );
    assert.ok(moving.body > 50, `${name}: the box is drawn (${moving.body})`);
    assert.equal(moving.trail, 0, `${name}: ${moving.trail} red pixels behind the box`);
    assert.ok(recolour.pixels > 10000, `${name}: the wall changes colour (${recolour.pixels} pixels)`);
    assert.ok(
      recolour.held <= HELD_MAX,
      `${name}: ${recolour.held} pixels still show exactly what they showed before the wall changed`,
    );
  }
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}

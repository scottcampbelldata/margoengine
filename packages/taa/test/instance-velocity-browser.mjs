// Real-GPU check: TAA gives each gltf/pbr instance (PBRInstances) its own motion (KB-TAA-INSTMOTION1).
//
// TAA used to skip instanced primitives in its object velocity pass, so an instance that moved kept the camera's motion
// (none here) and smeared in history. Now TAA keeps last frame's instance rows on the GPU and moves each vertex by node x
// instance matrix now and then (reverse reprojection per instance: Nehab et al. 2007, "Accelerating real-time shading
// with reverse reprojection caching", Graphics Hardware; Yang, Liu and Salvi 2020, "A Survey of Temporal Antialiasing
// Techniques", Computer Graphics Forum 39(2), section 4.1). Two instances of Box.glb, camera and node still: the left
// one stands, the right one moves along +x. Every pixel of the right box must carry +x motion of the step's size; the
// left box must carry none.
//   node packages/taa/test/instance-velocity-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const timer = setTimeout(() => {
  console.error('instance-velocity-browser: timed out after 120 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 120_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-instance-velocity/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5348, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5348 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  if (compatRun()) await page.addInitScript(compatShim);
  await page.goto('http://127.0.0.1:5348/packages/taa/test/upscale-browser.html');
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { TAA } = await import('/packages/taa/dist/index.js'),
      { loadGLTF } = await import('/packages/gltf/dist/pbr.js'),
      { PBRInstances } = await import('/packages/gltf/dist/pbr-instancing.js');
    const engine = await Engine.create(document.querySelector('canvas'), {
      backend: 'webgpu',
      camera: { position: [0, 0.5, 7], target: [0, 0, 0] },
    });
    engine.stop();
    const device = engine.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
    const model = await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb'),
      rows = new PBRInstances(2),
      at = (x) => [1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1.5, 0, x, 0, 0, 1];
    for (const primitive of model.primitives) primitive.instances = rows;
    rows.setMatrixAt(0, at(-1.6));
    let x = 1.4;
    rows.setMatrixAt(1, at(x));
    const taa = TAA.attach(engine),
      step = 0.04;
    for (let i = 0; i < 5; i++) {
      x += step;
      rows.setMatrixAt(1, at(x));
      engine.render({ delta: 1 / 60 });
    }
    await device.queue.onSubmittedWorkDone();
    const v = taa.velocity,
      jitter = v.jitter[0],
      { width, height } = v.texture,
      bytesPerRow = Math.ceil((width * 4) / 256) * 256,
      read = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      depth = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: v.texture }, { buffer: read, bytesPerRow }, [width, height]);
    encoder.copyTextureToBuffer({ texture: v.expectedDepth }, { buffer: depth, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await Promise.all([read.mapAsync(GPUMapMode.READ), depth.mapAsync(GPUMapMode.READ)]);
    const half = new Uint16Array(read.getMappedRange()),
      expected = new Float32Array(depth.getMappedRange()),
      f16 = (h) => {
        const e = (h >> 10) & 31,
          m = h & 1023,
          s = h >> 15 ? -1 : 1;
        return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
      };
    const left = [],
      right = [];
    for (let y = 0; y < height; y++)
      for (let px = 0; px < width; px++) {
        const o = y * (bytesPerRow / 4) + px;
        // The object pass reached this pixel: it holds the previous depth of the surface (> 0).
        if (!(expected[o] > 0)) continue;
        const vx = f16(half[y * (bytesPerRow / 2) + px * 2]) - jitter;
        (px < width / 2 ? left : right).push(vx);
      }
    engine.dispose();
    return { left, right, gpuErrors };
  });
  // The moving box's own motion: the median of its pixels (its faces lie at 6.25 to 7.75 m, so the step reads 0.8 to
  // 1.2 times that). Before the fix every pixel of it held the camera's motion, 0.
  const sorted = [...result.right].sort((a, b) => a - b),
    motion = sorted[sorted.length >> 1] ?? 0,
    moving = result.right.filter((vx) => vx > motion * 0.6 && vx < motion * 1.4).length,
    still = result.left.filter((vx) => Math.abs(vx) < motion * 0.05).length;
  console.log(
    JSON.stringify({
      compat: compatRun(),
      leftPixels: result.left.length,
      rightPixels: result.right.length,
      motion,
      moving,
      still,
    }),
  );
  assert.ok(motion > 1e-3, `the moving box moves on screen (median ${motion} of the view per frame)`);
  assert.ok(result.right.length > 5_000, `the moving box covers its half (${result.right.length} pixels)`);
  assert.ok(result.left.length > 5_000, `the standing box covers its half (${result.left.length} pixels)`);
  assert.equal(moving, result.right.length, `every moving-box pixel carries the instance's motion (${moving} did)`);
  assert.equal(still, result.left.length, `no standing-box pixel moves (${still} still)`);
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(errors, []);
  console.log('instance-velocity check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}

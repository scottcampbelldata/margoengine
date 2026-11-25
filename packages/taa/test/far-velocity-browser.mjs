// Real-GPU check: TAA's object velocity reaches every pixel of a moving mesh far from the origin.
//
// TAA draws each moving mesh's motion again with depthCompare 'equal' against the depth the colour pass wrote. Two
// programs write the same depth only when both compute the clip position by the same expression on the same values and
// both declare it @invariant (W3C WGSL 12.10; 15.7.5 lets each program reassociate and fuse float operations). 1e4 m
// from the origin the equal test failed on most of the box, which then kept the camera's motion (none here) and smeared
// in history (docs/known-bugs.md). The box moves along x with the camera still, so every box pixel must carry x motion.
// Two cases: Box.glb through gltf/pbr, and a core mesh.
//   node packages/taa/test/far-velocity-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const timer = setTimeout(() => {
  console.error('far-velocity-browser: timed out after 120 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 120_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-far-velocity/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5347, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5347 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  if (compatRun()) await page.addInitScript(compatShim);
  await page.goto('http://127.0.0.1:5347/packages/taa/test/upscale-browser.html');
  const measure = (kind) =>
    page.evaluate(async (kind) => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js'),
        { loadGLTF } = await import('/packages/gltf/dist/pbr.js');
      const far = 10_000;
      // Full TAA (velocityOnly needs a PostStack's depth); its jitter difference is taken off each vector below.
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [far, 0.3, far + 6], target: [far, 0, far] },
      });
      engine.stop();
      const device = engine.gpu,
        gpuErrors = [];
      device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      // A 2 m box either way: a core mesh, or Box.glb (a 1 m box) through gltf/pbr, which draws its own colour pass.
      const mover =
        kind === 'core'
          ? engine
              .createMesh()
              .setGeometry(box(2, 2, 2))
              .setMaterial(new PbrMaterial({ color: '#ffffff', emissive: '#ffffff' }))
          : (await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb')).root.setScale([2, 2, 2]);
      mover.setRotation([0.3, 0.6, 0]).setPosition([far, 0, far]);
      const taa = TAA.attach(engine);
      let x = far;
      for (let i = 0; i < 4; i++) {
        x += 0.05;
        mover.setPosition([x, 0, far]);
        engine.render({ delta: 1 / 60 });
      }
      await device.queue.onSubmittedWorkDone();
      const v = taa.velocity,
        jitter = v.jitter[0],
        { width, height } = v.texture,
        bytesPerRow = Math.ceil((width * 4) / 256) * 256,
        read = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        depth = device.createBuffer({
          size: Math.ceil((width * 4) / 256) * 256 * height,
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
      const rowHalves = bytesPerRow / 2,
        rowFloats = bytesPerRow / 4,
        moving = [];
      for (let y = 0; y < height; y++)
        for (let px = 0; px < width; px++) {
          const vx = f16(half[y * rowHalves + px * 2]) - jitter;
          // A pixel the object pass reached holds the previous frame's depth of the surface (> 0); the camera pass alone
          // leaves the reprojected depth of what is behind (the far plane, 0, where nothing is).
          if (expected[y * rowFloats + px] > 0) moving.push(vx);
        }
      engine.dispose();
      return { width, height, moving, gpuErrors };
    }, kind);
  for (const kind of ['gltf', 'core']) {
    const result = await measure(kind),
      reached = result.moving.filter((vx) => vx > 0).length;
    console.log(JSON.stringify({ kind, boxPixels: result.moving.length, reached }));
    assert.ok(result.moving.length > 20_000, `${kind}: the box covers the view (${result.moving.length} pixels)`);
    assert.equal(
      reached,
      result.moving.length,
      `${kind}: every box pixel carries the box's motion (${reached} reached)`,
    );
    assert.deepEqual(result.gpuErrors, []);
  }
  assert.deepEqual(errors, []);
  console.log('far-velocity check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}

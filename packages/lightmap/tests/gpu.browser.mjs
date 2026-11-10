// GPU progressive baking (./gpu) on a real WebGPU device, checked against the CPU baker (./mesh) and an exact
// form factor. Run with `npm run test:gpu` (after the package build); it takes a GPU lock slot through gpu-package-tests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  root,
  cacheDir: await mkdtemp(join(results, 'lightmap-gpu-')),
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    {
      name: 'lightmap-gpu-page',
      configureServer(s) {
        s.middlewares.use('/lightmap-gpu', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>lightmap gpu</title>');
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(server.resolvedUrls.local[0] + 'lightmap-gpu');
  const r = await page.evaluate(async () => {
    const { GPULightmapBaker, bakeMeshLightmapGPU } = await import('/packages/lightmap/dist/gpu.js');
    const { bakeMeshLightmap } = await import('/packages/lightmap/dist/mesh.js');
    const adapter = await navigator.gpu.requestAdapter(),
      device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => console.error(e.error.message));
    const quad = new Uint32Array([0, 1, 2, 0, 2, 3]),
      floor = {
        positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
        uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: quad,
      },
      blocker = { positions: new Float32Array([1.5, 1, -1.5, 3, 1, -1.5, 3, 1, -3, 1.5, 1, -3]), indices: quad },
      wall = { positions: new Float32Array([0, 0, -4, 4, 0, -4, 4, 4, -4, 0, 4, -4]), indices: quad },
      lights = [
        { type: 'point', position: [1, 2, -1], intensity: 6 },
        { type: 'directional', direction: [0.3, 1, 0.2], intensity: 2 },
        { type: 'spot', position: [3, 3, -2], direction: [0, -1, 0], angle: 0.6, penumbra: 0.3, intensity: 5 },
      ],
      out = {};

    // 1. Direct light: one pass equals the CPU bake (deterministic shadows, physical radiometry has no AO factor).
    const options = { width: 32, radiometry: 'physical', lights, occluders: [blocker], dilate: 0 },
      cpu = await bakeMeshLightmap(floor, options),
      gpu = await bakeMeshLightmapGPU(device, floor, { ...options, passes: 1 });
    let close = 0,
      worst = 0;
    for (let i = 0; i < 32 * 32; i++) {
      const d = Math.abs(gpu.irradiance[i * 3] - cpu.irradiance[i * 3]);
      if (d <= 1e-3 * cpu.lightmapScale) close++;
      else worst = Math.max(worst, d);
    }
    out.direct = { samples: gpu.samples, close, worst, scale: [cpu.lightmapScale, gpu.lightmapScale] };

    // 2. AO: the mean over passes converges to the CPU estimate; 3. the live texture improves with passes.
    const aoOptions = { width: 16, lights: [{ type: 'ambient', intensity: 1 }], occluders: [wall], aoDistance: 2 },
      cpuAO = await bakeMeshLightmap(floor, { ...aoOptions, aoRays: 128, seed: 7 });
    {
      using baker = await GPULightmapBaker.create(device, floor, aoOptions);
      const rms = async () => {
        const read = await baker.read();
        let sum = 0,
          mean = 0;
        for (let i = 0; i < 256; i++) {
          const d = read.ao[i * 4] / 255 - cpuAO.ao[i * 4] / 255;
          sum += d * d;
          mean += d;
        }
        return { rms: Math.sqrt(sum / 256), mean: mean / 256, read };
      };
      await baker.step(4);
      const early = await rms();
      for (let n = 0; n < 16; n++) await baker.step(32);
      const late = await rms();
      // The live texture holds the same mean light (rgba16float) as read() before encoding.
      const bytesPerRow = 256,
        copy = device.createBuffer({
          size: bytesPerRow * 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: baker.texture }, { buffer: copy, bytesPerRow }, [16, 16]);
      device.queue.submit([encoder.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      const half = new Uint16Array(copy.getMappedRange()),
        f16 = (h) => {
          const e = (h >> 10) & 31,
            m = h & 1023;
          return (e ? (1 + m / 1024) * 2 ** (e - 15) : (m / 1024) * 2 ** -14) * (h >> 15 ? -1 : 1);
        };
      let texture = 0;
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          texture = Math.max(texture, Math.abs(f16(half[y * 128 + x * 4]) - late.read.irradiance[(y * 16 + x) * 3]));
      copy.destroy();
      out.ao = { early: early.rms, late: late.rms, mean: late.mean, passes: baker.passes, texture };
    }

    // 4. One bounce: a lit wall (albedo 0.5) lights the floor, which gets no direct light. Each floor texel receives
    // albedo * E_wall * F, F the exact point-to-polygon form factor (Lambert's contour formula).
    const bounce = await bakeMeshLightmapGPU(device, floor, {
        width: 8,
        radiometry: 'physical',
        bounces: 1,
        lights: [{ type: 'directional', direction: [0, 0, 1], intensity: 2 }],
        occluders: [{ ...wall, albedo: [0.5, 0.5, 0.5] }],
        passes: 2048,
        passesPerStep: 64,
        dilate: 0,
      }),
      sub = (a, b) => a.map((v, i) => v - b[i]),
      crossed = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      norm = (a) => Math.hypot(...a),
      corners = [
        [0, 0, -4],
        [4, 0, -4],
        [4, 4, -4],
        [0, 4, -4],
      ];
    let worstBounce = 0,
      meanBounce = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const p = [(x + 0.5) / 2, 0, -(y + 0.5) / 2];
        let f = 0;
        for (let k = 0; k < 4; k++) {
          const a = sub(corners[k], p),
            b = sub(corners[(k + 1) % 4], p),
            c = crossed(a, b),
            angle = Math.acos(
              Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b)))),
            );
          f += (angle * c[1]) / norm(c);
        }
        const expected = 0.5 * 2 * Math.abs(f / (2 * Math.PI)),
          d = bounce.irradiance[(y * 8 + x) * 3] - expected;
        worstBounce = Math.max(worstBounce, Math.abs(d));
        meanBounce += d / 64;
      }
    out.bounce = { worst: worstBounce, mean: meanBounce };

    // 5. Bounces need physical radiometry; a disposed baker refuses work.
    out.refused = await GPULightmapBaker.create(device, floor, { bounces: 1 }).then(
      () => 'created',
      (e) => e.name,
    );
    const baker = await GPULightmapBaker.create(device, floor, { width: 8 });
    baker[Symbol.dispose]();
    out.disposed = await baker.step().then(
      () => 'ran',
      (e) => e.message,
    );
    return out;
  });
  assert.deepEqual(errors, []);
  // Float32 against float64 shading: within 1e-3 of the scale everywhere but shadow-edge texels, where the watertight
  // GPU ray test and the CPU test may disagree on a ray grazing the blocker's edge: at most 2% of texels.
  assert.equal(r.direct.samples, 1024);
  assert.ok(r.direct.close >= 1004, JSON.stringify(r.direct));
  // AO: CPU 128 rays and GPU 516 paths per texel, each a Bernoulli mean (standard deviation at most 0.5 / sqrt(n)):
  // the mean signed difference over 256 texels is within 0.01, and the RMS falls as passes are added.
  assert.equal(r.ao.passes, 516);
  assert.ok(Math.abs(r.ao.mean) < 0.01 && r.ao.late < 0.06 && r.ao.late < r.ao.early * 0.6, JSON.stringify(r.ao));
  assert.ok(r.ao.texture < 2e-3, `live texture differs from read() by ${r.ao.texture}`);
  // Bounce: each sample is 0 or 1 (albedo * E_wall), 2,048 per texel: 5 standard deviations are under 0.06.
  assert.ok(r.bounce.worst < 0.06 && Math.abs(r.bounce.mean) < 0.01, JSON.stringify(r.bounce));
  assert.equal(r.refused, 'TypeError');
  assert.match(r.disposed, /disposed/);
  console.log('lightmap GPU bake: ok', JSON.stringify(r));
} finally {
  await closeAll({ browser, servers: [server] });
}

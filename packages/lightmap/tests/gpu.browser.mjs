// GPU progressive baking (./gpu) on a real WebGPU device, checked against the CPU baker (./mesh) and an exact
// form factor; then ./apply drawing a bake on materials, glTF-pro and core meshes. Run with `npm run test:gpu` (after the package build); it takes a GPU lock slot through gpu-package-tests.
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

  // ./apply: one lightmap drawn on a materials mesh, a loaded glTF-pro model, a core mesh and from the live GPU baker,
  // with every live light off, so all the light on screen is the lightmap's.
  const drawn = await page.evaluate(async () => {
    const { Engine, Geometry, PbrMaterial: CoreMaterial } = await import('/packages/core/dist/index.js');
    const { PbrMaterial, createMesh } = await import('/packages/materials/dist/index.js');
    const { parseGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { applyLightmap } = await import('/packages/lightmap/dist/apply.js');
    const { GPULightmapBaker } = await import('/packages/lightmap/dist/gpu.js');
    const size = 64,
      canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 3], target: [0, 0, 0], fov: 60 },
      }),
      errors = [];
    engine.stop();
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    engine.lighting.direction[3] = 0;
    engine.lighting.radiance.set([0, 0, 0, 0]);
    // The red channel's mean over the left and the right quarter of the middle rows, 0 to 255.
    const halves = async () => {
      for (let i = 0; i < 2; i++) {
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      }
      // Copy the canvas in the task that rendered it: once the frame is presented a WebGPU canvas may read back blank
      // (it did, at random, on Metal when read after an await).
      const c = new OffscreenCanvas(size, size),
        x = c.getContext('2d', { willReadFrequently: true });
      engine.render({ delta: 1 / 60 });
      x.drawImage(canvas, 0, 0);
      const data = x.getImageData(0, 0, size, size).data,
        mean = (from, to) => {
          let sum = 0,
            n = 0;
          for (let y = 24; y < 40; y++)
            for (let px = from; px < to; px++) {
              sum += data[(y * size + px) * 4];
              n++;
            }
          return sum / n;
        };
      return [mean(14, 24), mean(40, 50)];
    };
    // A 2 x 2 quad facing the camera (it fills the middle 37 of 64 pixels), lightmap U along +x.
    const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uv1 = [0, 1, 1, 1, 1, 0, 0, 0],
      indices = [0, 1, 2, 0, 2, 3];
    // Left half lit (255 decodes to the scale, 0.75), right half dark.
    const baked = { width: 4, height: 1, lightmap: new Uint8Array(16), lightmapScale: 0.75 };
    for (const i of [0, 1]) baked.lightmap.set([255, 255, 255, 255], i * 4);
    for (const i of [2, 3]) baked.lightmap[i * 4 + 3] = 255;
    const out = {};
    // A materials mesh.
    const material = new PbrMaterial({ color: [0.5, 0.5, 0.5], roughness: 1, metalness: 0 }),
      mesh = createMesh(engine, { positions, normals, uvs1: uv1, indices }, material);
    out.meshOff = await halves();
    let app = applyLightmap(mesh, baked);
    out.meshOn = await halves();
    app.dispose();
    out.meshBack = await halves();
    mesh.destroy();
    // The same quad as a glTF file with TEXCOORD_1, loaded by glTF-pro.
    const bytes = new Float32Array([...positions, ...normals, ...uv1]),
      index = new Uint16Array(indices),
      buffer = new Uint8Array(bytes.byteLength + index.byteLength);
    buffer.set(new Uint8Array(bytes.buffer), 0);
    buffer.set(new Uint8Array(index.buffer), bytes.byteLength);
    const model = parseGLTF(
      engine,
      {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_1: 2 }, indices: 3, material: 0 }] }],
        materials: [
          { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 1 } },
        ],
        buffers: [{ byteLength: buffer.byteLength }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 48 },
          { buffer: 0, byteOffset: 48, byteLength: 48 },
          { buffer: 0, byteOffset: 96, byteLength: 32 },
          { buffer: 0, byteOffset: 128, byteLength: 12 },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
          { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
          { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
          { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
      },
      [buffer.buffer],
    );
    out.modelOff = await halves();
    const own = model.primitives[0].material;
    app = applyLightmap(model, baked);
    out.modelCopied = model.primitives[0].material !== own && model.primitives[0].material.extension !== undefined;
    out.modelOn = await halves();
    app.dispose();
    out.modelRestored = model.primitives[0].material === own;
    out.modelBack = await halves();
    model.destroy();
    // A core mesh: core geometry has no UV1, so a materials stand-in draws it.
    const core = engine.createMesh(),
      geometry = new Geometry(positions, normals, indices);
    core.setGeometry(geometry);
    core.material = new CoreMaterial({ color: [0.5, 0.5, 0.5], roughness: 1, metalness: 0 });
    out.coreOff = await halves();
    app = applyLightmap(core, baked, { uv1 });
    out.coreHidden = core.geometry === null && app.mesh.root.engine === engine;
    out.coreOn = await halves();
    // The stand-in follows the core mesh: moved right by a quarter of the quad, the lit left half moves right.
    core.position.x = 0.5;
    out.coreMoved = await halves();
    core.position.x = 0;
    app.dispose();
    out.coreRestored = core.geometry === geometry;
    out.coreBack = await halves();
    // The live GPU bake of a lit floor drawn straight from the baker's texture, before and after more passes.
    const quad = {
        positions: new Float32Array(positions),
        uv1: new Float32Array(uv1),
        indices: new Uint32Array(indices),
      },
      baker = await GPULightmapBaker.create(engine.gpu, quad, {
        width: 16,
        lights: [{ type: 'directional', direction: [-1, 0, 1], intensity: 1 }],
      });
    await baker.step(8);
    const liveMaterial = new PbrMaterial({ color: [0.5, 0.5, 0.5], roughness: 1, metalness: 0 }),
      liveMesh = createMesh(engine, { positions, normals, uvs1: uv1, indices }, liveMaterial);
    app = applyLightmap(liveMesh, baker);
    out.live = await halves();
    app.dispose();
    liveMesh.destroy();
    baker[Symbol.dispose]();
    core.dispose();
    await engine.gpu.queue.onSubmittedWorkDone();
    out.errors = errors;
    engine.dispose();
    return out;
  });
  console.log('apply', JSON.stringify(drawn));
  assert.deepEqual(drawn.errors, []);
  // With no live light every target is black but where the lightmap lights it.
  for (const k of ['meshOff', 'meshBack', 'modelOff', 'modelBack', 'coreOff', 'coreBack'])
    assert.ok(drawn[k][0] < 1 && drawn[k][1] < 1, `${k} is dark: ${drawn[k]}`);
  // The lit left half shows, the dark right half adds nothing.
  for (const k of ['meshOn', 'modelOn', 'coreOn']) {
    assert.ok(drawn[k][0] > 40, `${k} shows the lightmap: ${drawn[k]}`);
    assert.ok(drawn[k][1] < 1, `${k} adds nothing where the lightmap is dark: ${drawn[k]}`);
  }
  // The glTF-pro hook adds the light Material.lightMap adds: same pixels within one 8-bit step.
  assert.ok(
    Math.abs(drawn.modelOn[0] - drawn.meshOn[0]) <= 1,
    `glTF-pro ${drawn.modelOn} vs materials ${drawn.meshOn}`,
  );
  assert.ok(Math.abs(drawn.coreOn[0] - drawn.meshOn[0]) <= 1, `core ${drawn.coreOn} vs materials ${drawn.meshOn}`);
  assert.ok(drawn.modelCopied && drawn.modelRestored, 'the model draws a copy and gets its own record back');
  assert.ok(drawn.coreHidden && drawn.coreRestored, 'the core mesh draws nothing while lit and gets its geometry back');
  assert.ok(
    drawn.coreMoved[1] > 40 && drawn.coreMoved[0] < drawn.coreOn[0] - 40,
    `the stand-in follows the core mesh: ${drawn.coreMoved}`,
  );
  // A light from the left (direction toward it is -x, +z) lights the floor facing +z evenly.
  assert.ok(drawn.live[0] > 5 && drawn.live[1] > 5, `the live baker's texture is drawn: ${drawn.live}`);
} finally {
  await closeAll({ browser, servers: [server] });
}

// Real-GPU check of IBLShadows (shadows/ibl), built packages; MARGO_COMPAT=1 runs the page on the WebGL2 layer.
// A cube floats over a floor under an environment of dim sky and one bright patch. After the history fills, the
// visibility each floor pixel holds (lit sum over all sum, before the spatial filter) is compared with a reference
// computed here in Node: every texel of the same image, 4 x 4 points each, against an analytic ray-box test of the
// cube. Then the map turns a quarter (rotation) and the cube moves (bvh.refit), and each is compared again; the shown
// frame only ever darkens, and a pixel the cube cannot shade keeps its value.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const W = 64,
  H = 32,
  PATCH = [32, 8],
  BIAS = 0.01;
const sky = () => {
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const base = y < H / 2 ? 0.4 : 0.05,
        hot = Math.abs(x - PATCH[0]) <= 1 && Math.abs(y - PATCH[1]) <= 1 ? 300 : 0;
      data.set([base + hot, base + hot, base + hot, 1], (y * W + x) * 4);
    }
  return data;
};
// Ray from o along d against the box lo..hi (slabs).
const hitsBox = (o, d, lo, hi) => {
  let near = 0,
    far = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < lo[a] || o[a] > hi[a]) return false;
      continue;
    }
    let t0 = (lo[a] - o[a]) / d[a],
      t1 = (hi[a] - o[a]) / d[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return false;
  }
  return true;
};
const data = sky();
const directions = (rotation) => {
  const out = [],
    c = Math.cos(rotation),
    s = Math.sin(rotation);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const L = data[(y * W + x) * 4];
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const theta = (Math.PI * (y + (j + 0.5) / 4)) / H,
            phi = 2 * Math.PI * ((x + (i + 0.5) / 4) / W - 0.5),
            ex = Math.sin(theta) * Math.sin(phi),
            ez = -Math.sin(theta) * Math.cos(phi),
            d = [c * ex + s * ez, Math.cos(theta), -s * ex + c * ez];
          if (d[1] > 0) out.push([d, L * d[1] * Math.sin(theta)]);
        }
    }
  return out;
};
const reference = (p, dirs, centre) => {
  const o = [p[0], p[1] + BIAS, p[2]],
    lo = [centre[0] - 0.5, centre[1] - 0.5, centre[2] - 0.5],
    hi = [centre[0] + 0.5, centre[1] + 0.5, centre[2] + 0.5];
  let lit = 0,
    all = 0;
  for (const [d, w] of dirs) {
    all += w;
    if (!hitsBox(o, d, lo, hi)) lit += w;
  }
  return lit / all;
};
// Floor pixels (top face, y = 0) within the floor; y within 0.02, since the 1x depth holds the nearest of a pixel's
// MSAA samples, not its centre: GPU visibility against the reference.
const compare = (read, rotation, centre) => {
  const dirs = directions(rotation);
  let n = 0,
    sum = 0,
    worst = 0,
    shaded = 0;
  const errors = [];
  for (let i = 0; i < read.weight.length; i += 7) {
    const x = read.surface[i * 4],
      y = read.surface[i * 4 + 1],
      z = read.surface[i * 4 + 2];
    if (!(read.weight[i] > 0) || Math.abs(y) > 0.02 || Math.abs(x) > 6 || Math.abs(z) > 6) continue;
    const got = read.surface[i * 4 + 3] / read.weight[i],
      want = reference([x, y, z], dirs, centre),
      e = Math.abs(got - want);
    if (want < 0.5) shaded++;
    errors.push(e);
    sum += e;
    worst = Math.max(worst, e);
    n++;
  }
  errors.sort((a, b) => a - b);
  return { n, shaded, mean: sum / n, p95: errors[Math.floor(errors.length * 0.95)], worst };
};

const timer = setTimeout(() => {
  console.error('ibl-browser: timed out after 240 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 240_000);
const port = 5437;
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/shadows-ibl/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 }),
    errors = [];
  if (compatRun()) await page.addInitScript(compatShim);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/packages/shadows/test/ibl-browser.html`);
  await page.evaluate(
    async ({ list, W, H }) => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { MeshBVH, worldTriangles } = await import('/packages/bvh/dist/index.js'),
        { IBLShadows } = await import('/packages/shadows/dist/ibl.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 3, 5], target: [0, 0, 0] } });
      engine.stop();
      const white = new PbrMaterial({ color: '#c0c0c0', roughness: 1 });
      const floor = engine
        .createMesh()
        .setGeometry(box(20, 0.1, 20))
        .setPosition([0, -0.05, 0])
        .setMaterial(white);
      const cube = engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([0, 0.6, 0])
        .setMaterial(white);
      const triangles = worldTriangles(engine, [floor, cube]),
        bvh = MeshBVH.build({ positions: triangles.vertices, indices: triangles.indices });
      const effect = new IBLShadows(
          bvh,
          { width: W, height: H, data: new Float32Array(list) },
          { rays: 8, history: 64 },
        ),
        stack = PostStack.attach(engine, [effect]);
      const device = engine.gpu;
      const readTexture = async (texture, floats) => {
        const row = texture.width * floats * 4,
          buffer = device.createBuffer({
            size: row * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const out = Array.from(new Float32Array(buffer.getMappedRange()));
        buffer.destroy();
        return out;
      };
      window.t = {
        engine,
        effect,
        stack,
        frames: async (n) => {
          for (let i = 0; i < n; i++) {
            engine.render({ delta: 1 / 60 });
            await engine.gpu.queue.onSubmittedWorkDone();
          }
        },
        read: async () => ({
          surface: await readTexture(effect.surfaces[effect.last], 4),
          weight: await readTexture(effect.weights[effect.last], 1),
        }),
        move: (position) => {
          cube.setPosition(position);
          bvh.positions.set(worldTriangles(engine, [floor, cube]).vertices);
          bvh.refit();
        },
      };
    },
    { list: Array.from(data), W, H },
  );
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  const rows = {};
  await page.evaluate(() => window.t.frames(96));
  rows.still = compare(await page.evaluate(() => window.t.read()), 0, [0, 0.6, 0]);
  const on = await shot();
  await page.evaluate(() => {
    window.t.effect.options.enabled = false;
    return window.t.frames(1);
  });
  const off = await shot();
  let darker = 0,
    brighter = 0;
  for (let i = 0; i < on.data.length; i += 4) {
    const d = on.data[i] - off.data[i];
    if (d < -8) darker++;
    if (d > 2) brighter++;
  }
  const corner = 4 * (on.width * 8 + 8);
  await page.evaluate(() => {
    window.t.effect.options.enabled = true;
    window.t.effect.options.rotation = Math.PI / 2;
    return window.t.frames(96);
  });
  rows.rotated = compare(await page.evaluate(() => window.t.read()), Math.PI / 2, [0, 0.6, 0]);
  await page.evaluate(() => {
    window.t.move([1.5, 0.6, -1]);
    return window.t.frames(96);
  });
  rows.moved = compare(await page.evaluate(() => window.t.read()), Math.PI / 2, [1.5, 0.6, -1]);
  await page.evaluate(() => window.t.engine.dispose());
  console.log(
    JSON.stringify({ compat: compatRun(), darker, brighter, corner: [on.data[corner], off.data[corner]], rows }),
  );
  assert.deepEqual(errors, []);
  for (const [name, row] of Object.entries(rows)) {
    assert.ok(row.n > 2000 && row.shaded > 50, `${name}: enough floor pixels, some in shadow: ${JSON.stringify(row)}`);
    assert.ok(row.mean < 0.03 && row.p95 < 0.08, `${name}: visibility matches the reference: ${JSON.stringify(row)}`);
  }
  assert.ok(darker > 500, `the environment's shadow darkens the frame: ${darker}`);
  assert.equal(brighter, 0, 'IBL shadows only darken');
  assert.ok(Math.abs(on.data[corner] - off.data[corner]) <= 2, 'a pixel the cube cannot shade is unchanged');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}

// GPU time of scatter's distribute (cull) pass and LOD draw in two @margoengine/scatter builds on the real GPU,
// alternating A/B, plus a parity check: the same instances in every ring. Made for the ordered cull (src/order.ts),
// which replaced the atomicAdd append; A is a build from before it. Snapshot the baseline first:
//   git stash the change (or check out the parent), npm run build -w @margoengine/scatter,
//   copy packages/scatter/dist to test-results/scatter-base, restore the change and build again. Then, on AC power:
//   node examples/package-benchmarks/scatter-cull-gpu.mjs --a=test-results/scatter-base --b=packages/scatter/dist
//     [--label=name] [--counts=10000,110000,1000000] [--rounds=8] [--frames=20] [--size=1432x768] [--commit=hash]
// The scene: unlit boxes on three LOD meshes (fade bands on) over a 512 x 512 heightmap of hills, 4 candidates per
// square metre, the camera 2 m above the ground looking along the field, drawn at 4x MSAA. The compute pass and the
// draw pass are timed with timestamp queries (--enable-webgpu-developer-features turns off Chrome's quantization).
// Writes examples/package-benchmarks/results/scatter-cull-gpu-<label>.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { acquire } from '../../scripts/gpu-lock.mjs';
import { acPower } from './parts/power.mjs';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const config = {
  a: arg('a', 'test-results/scatter-base'),
  b: arg('b', 'packages/scatter/dist'),
  label: arg('label', 'run'),
  counts: arg('counts', '10000,110000,1000000').split(',').map(Number),
  rounds: +arg('rounds', 8),
  frames: +arg('frames', 20),
  size: arg('size', '1432x768').split('x').map(Number),
};
// Benchmarks time things, so they take the GPU alone (scripts/gpu-lock.mjs; inside `gpu-lock run --exclusive` a no-op).
const releaseGpu = await acquire({ owner: 'scatter-cull-gpu', mode: 'exclusive' });
let browser;
try {
  const report = {
    recordedAt: new Date().toISOString(),
    // --commit names the build on a machine whose copy of the sources has no git history.
    commit: arg('commit') ?? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    config,
    acPowerBefore: acPower(),
  };
  assert.notEqual(report.acPowerBefore, false, 'On battery: GPU timing is throttled, run on AC power');
  browser = await openBrowser({
    startPath: '/tests/modern-game.html',
    port: 'free',
    headless: false,
    args: ['--enable-webgpu-developer-features'],
  });
  report.hardware = browser.hardware;
  report.rows = [];
  for (const count of config.counts) {
    const row = await browser.page.evaluate(measure, { ...config, a: '/' + config.a, b: '/' + config.b, count });
    report.rows.push(row);
    console.log(JSON.stringify({ count, parity: row.parity, summary: row.summary }));
    assert.deepEqual(row.errors, []);
    assert.ok(row.parity.same, `count ${count}: A and B hold the same instances in every ring`);
  }
  report.acPowerAfter = acPower();
  assert.notEqual(report.acPowerAfter, false, 'Power dropped to battery during the run; discard it');
  const out = resolve(import.meta.dirname, `results/scatter-cull-gpu-${config.label}.json`);
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  console.log('wrote', out);
} finally {
  await browser?.close();
  releaseGpu();
}

/** In the page: both builds on one device, the same frame context, the passes timed with timestamp queries. */
async function measure({ a, b, count, rounds, frames, size: [width, height] }) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Native adapter required');
  const device = await adapter.requestDevice({
      requiredFeatures: ['timestamp-query'],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    }),
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const [A, B] = await Promise.all([import(a + '/index.js'), import(b + '/index.js')]),
    { box } = await import('/packages/core/dist/index.js'),
    { Camera } = await import('/packages/core/dist/extension.js');
  // 4 candidates per square metre; the camera 2 m above the hills at the near edge, looking into the field.
  const side = Math.sqrt(count) / 2,
    ground = (x, z) => 3 * Math.sin(x / 23) * Math.cos(z / 29),
    camera = new Camera({
      position: [0, ground(0, -side / 2 + 5) + 2, -side / 2 + 5],
      target: [0, 1, 0],
      fov: 60,
      near: 0.1,
      far: 400,
    });
  camera.update(width / height, true);
  const texels = new Float32Array(512 * 512);
  for (let j = 0; j < 512; j++)
    for (let i = 0; i < 512; i++)
      texels[j * 512 + i] = ground(((i + 0.5) / 512 - 0.5) * side, ((j + 0.5) / 512 - 0.5) * side);
  const heightmap = device.createTexture({
    size: [512, 512],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: heightmap }, texels, { bytesPerRow: 2048 }, [512, 512]);
  const target = (format, usage) => device.createTexture({ size: [width, height], format, sampleCount: 4, usage });
  const color = target('rgba16float', GPUTextureUsage.RENDER_ATTACHMENT),
    depth = target('depth32float', GPUTextureUsage.RENDER_ATTACHMENT),
    colorView = color.createView(),
    depthView = depth.createView();
  const engine = {
    gpu: device,
    stats: { drawCalls: 0 },
    lighting: { direction: [0.3, 1, 0.2], radiance: [1, 1, 1] },
    removePlugin() {},
  };
  const meshes = [box(0.3, 0.6, 0.3), box(0.4, 0.5, 0.4), box(0.5, 0.4, 0.5)];
  /** One effect of a build, set up, with its two frame passes. */
  const make = (module) => {
    const effect = new module.Scatter(meshes, {
        count,
        area: [side, side],
        lod: [25, 60, 120],
        lodFade: 2,
        heightmap: () => heightmap,
      }),
      passes = [];
    effect.setup(engine);
    effect.registerPasses({ add: (p) => passes.push(p) });
    return { effect, passes: passes.sort((x, y) => x.order - y.order) };
  };
  const querySet = device.createQuerySet({ type: 'timestamp', count: 4 * frames * 2 }),
    resolved = device.createBuffer({
      size: 32 * frames * 2,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    readback = device.createBuffer({ size: 32 * frames * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  /** Records one frame of `s`: its compute pass and its draw pass, each between two timestamps from `first`. */
  const frame = (s, first) => {
    const encoder = device.createCommandEncoder(),
      timed = {
        beginComputePass: (d = {}) =>
          encoder.beginComputePass({
            ...d,
            timestampWrites: { querySet, beginningOfPassWriteIndex: first, endOfPassWriteIndex: first + 1 },
          }),
        beginRenderPass: (d) =>
          encoder.beginRenderPass({
            ...d,
            timestampWrites: { querySet, beginningOfPassWriteIndex: first + 2, endOfPassWriteIndex: first + 3 },
          }),
        clearBuffer: (...x) => encoder.clearBuffer(...x),
        copyBufferToBuffer: (...x) => encoder.copyBufferToBuffer(...x),
      };
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
      })
      .end();
    const context = {
      backend: 'webgpu',
      device,
      camera,
      width,
      height,
      format: 'rgba16float',
      color: colorView,
      depth: depthView,
      descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth32float' } },
      encoder: timed,
      shader: '',
      bindings: [],
    };
    s.effect.onPreUpdate(0);
    for (const p of s.passes) p.execute(context);
    return encoder;
  };
  /** Every ring's instances, sorted, as text (the rings hold no COPY_SRC: a kernel copies them out). */
  const rings = async (s) => {
    const encoder = frame(s, 0),
      counts = device.createBuffer({ size: 60, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(s.effect.commands, 0, counts, 0, 60);
    device.queue.submit([encoder.finish()]);
    await counts.mapAsync(GPUMapMode.READ);
    const n = new Uint32Array(counts.getMappedRange().slice(0));
    counts.destroy();
    const copy = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: '@group(0) @binding(0) var<storage,read> a:array<vec4u>;@group(0) @binding(1) var<storage,read_write> b:array<vec4u>;@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<arrayLength(&b)){b[id.x]=a[id.x];}}',
          }),
          entryPoint: 'main',
        },
      }),
      out = [];
    for (let r = 0; r < 3; r++) {
      const bytes = Math.max(32, n[r * 5 + 1] * 32),
        storage = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        mapped = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        e = device.createCommandEncoder(),
        pass = e.beginComputePass();
      pass.setPipeline(copy);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: copy.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: s.effect.instances[r] } },
            { binding: 1, resource: { buffer: storage } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(bytes / 16 / 64));
      pass.end();
      e.copyBufferToBuffer(storage, 0, mapped, 0, bytes);
      device.queue.submit([e.finish()]);
      await mapped.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(mapped.getMappedRange().slice(0)),
        entries = [];
      for (let k = 0; k < n[r * 5 + 1]; k++) entries.push(Array.from(words.subarray(k * 8, k * 8 + 8)).join(','));
      out.push(entries.sort());
      storage.destroy();
      mapped.destroy();
    }
    return { counts: [n[1], n[6], n[11]], rings: out };
  };
  const median = (v) => {
    const s = [...v].sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  const samples = { a: { cull: [], draw: [] }, b: { cull: [], draw: [] } };
  let parity;
  for (let round = 0; round < rounds; round++) {
    // Both effects made again each round; odd rounds make B first.
    const order = round % 2 ? ['b', 'a'] : ['a', 'b'],
      made = {};
    for (const k of order) made[k] = make(k === 'a' ? A : B);
    if (!parity) {
      const [ra, rb] = [await rings(made.a), await rings(made.b)];
      parity = {
        counts: { a: ra.counts, b: rb.counts },
        same: ra.counts.every((c, r) => c === rb.counts[r] && ra.rings[r].join(';') === rb.rings[r].join(';')),
      };
    }
    // Warm-up, then frames alternating A and B in one submission each.
    for (let w = 0; w < 4; w++) for (const k of order) device.queue.submit([frame(made[k], 0).finish()]);
    await device.queue.onSubmittedWorkDone();
    const encoders = [];
    for (let f = 0; f < frames; f++) order.forEach((k, j) => encoders.push([k, frame(made[k], (f * 2 + j) * 4)]));
    for (const [, e] of encoders) device.queue.submit([e.finish()]);
    const e = device.createCommandEncoder();
    e.resolveQuerySet(querySet, 0, frames * 8, resolved, 0);
    e.copyBufferToBuffer(resolved, 0, readback, 0, frames * 64);
    device.queue.submit([e.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const t = new BigUint64Array(readback.getMappedRange().slice(0));
    readback.unmap();
    encoders.forEach(([k], i) => {
      samples[k].cull.push(Number(t[i * 4 + 1] - t[i * 4]) / 1e6);
      samples[k].draw.push(Number(t[i * 4 + 3] - t[i * 4 + 2]) / 1e6);
    });
    for (const k of order) made[k].effect.dispose();
  }
  const summary = {};
  for (const k of ['a', 'b']) summary[k] = { cullMs: median(samples[k].cull), drawMs: median(samples[k].draw) };
  summary.cullRatio = summary.b.cullMs / summary.a.cullMs;
  summary.drawRatio = summary.b.drawMs / summary.a.drawMs;
  for (const t of [heightmap, color, depth]) t.destroy();
  device.destroy();
  return { count, parity, summary, samples, errors };
}

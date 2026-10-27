// Engine-free check of how this machine's GPU blends into a 4x multisampled bgra8unorm target (perf-history entry 35).
// No Margo code runs. 2,000 rectangles with edges inside pixels, 1280 x 720, a depth32float-stencil8 attachment (depth
// test always passing, write off, as the p-blending scene), drawn three ways: one render pass per draw, one pass with
// one draw per rectangle, one instanced draw. Each stored sample is read back (textureLoad of the multisampled
// texture) and compared with the value WebGPU defines, computed on the CPU per sample: blending reads the sample's
// stored value, so additive gives min(1, background + the sum of the rectangles covering that sample) whatever the
// order, and alpha blending (alpha 0.5, in draw order) gives the same mix for every split.
// A "collapsed" pixel stores the same value in its four samples although the CPU's four values differ: its samples
// were replaced by their mean. Samples within 0.001 px of a rectangle edge are left out (rasterization ties).
//   node scripts/gpu-lock.mjs run --max=8 --owner=<you> -- node scripts/gpu-blend-passes.mjs [--adapter=d3d11]
import { chromium } from '@playwright/test';
import { serve } from '../bench/lib/browser.mjs';

const adapterFlag = process.argv.find((a) => a.startsWith('--adapter='))?.slice(10);
const server = await serve({ port: 0, external: {} }),
  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: [
      '--enable-webgpu-developer-features',
      ...(adapterFlag ? ['--enable-unsafe-webgpu', `--use-webgpu-adapter=${adapterFlag}`] : []),
    ],
  });
try {
  const page = await browser.newPage();
  // Any page of the repository: WebGPU needs a secure context (127.0.0.1 is one).
  await page.goto(`${server.url}/site/errors.html`);
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
      device = await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] }),
      W = 1280,
      H = 720,
      N = 2000,
      background = [0.02, 0.02, 0.04];
    const module = device.createShaderModule({
      code: `struct D { r:vec4f, c:vec4f }
@group(0) @binding(0) var<storage> d: array<D>;
struct O { @builtin(position) p:vec4f, @location(0) @interpolate(flat) c:vec4f }
@vertex fn vs(@builtin(vertex_index) v:u32, @builtin(instance_index) i:u32) -> O {
  let q = d[i];
  let xs = array<f32,6>(q.r.x,q.r.z,q.r.x,q.r.z,q.r.z,q.r.x); let ys = array<f32,6>(q.r.y,q.r.y,q.r.w,q.r.y,q.r.w,q.r.w);
  var o:O; o.p = vec4f(xs[v] / ${W}.0 * 2.0 - 1.0, 1.0 - ys[v] / ${H}.0 * 2.0, 0.5, 1); o.c = q.c; return o; }
@fragment fn fs(i:O) -> @location(0) vec4f { return i.c; }`,
    });
    const readModule = device.createShaderModule({
      code: `@group(0) @binding(0) var t: texture_multisampled_2d<f32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= ${W}u) { return; }
  for (var s = 0u; s < 4u; s++) { o[(g.y * ${W}u + g.x) * 4u + s] = pack4x8unorm(textureLoad(t, g.xy, s)); } }`,
    });
    // Fixed-seed LCG: rectangles 5 to 40 px, colours that saturate where two or three overlap.
    let seed = 11;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const rects = Array.from({ length: N }, () => {
      const w = 5 + random() * 35,
        h = 5 + random() * 35,
        x = random() * (W - w),
        y = random() * (H - h);
      return [x, y, x + w, y + h, 0.2 + 0.6 * random(), 0.2 + 0.6 * random(), 0.2 + 0.6 * random()].map(Math.fround);
    });
    const blends = {
      additive: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
      alpha: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    };
    // Standard 4x sample positions; top-left rule for these axis-aligned edges: left and top included.
    const offsets = [
      [0.375, 0.125],
      [0.875, 0.375],
      [0.125, 0.625],
      [0.625, 0.875],
    ];
    const expected = (mode) => {
      const v = new Float64Array(W * H * 12),
        ties = new Uint8Array(W * H);
      for (let i = 0; i < W * H * 4; i++) v.set(background, i * 3);
      for (const r of rects)
        for (let y = Math.max(0, Math.floor(r[1]) - 1); y <= Math.min(H - 1, Math.ceil(r[3])); y++)
          for (let x = Math.max(0, Math.floor(r[0]) - 1); x <= Math.min(W - 1, Math.ceil(r[2])); x++)
            for (let s = 0; s < 4; s++) {
              const px = x + offsets[s][0],
                py = y + offsets[s][1];
              if (Math.min(Math.abs(px - r[0]), Math.abs(px - r[2]), Math.abs(py - r[1]), Math.abs(py - r[3])) < 1e-3)
                ties[y * W + x] = 1;
              if (px < r[0] || px >= r[2] || py < r[1] || py >= r[3]) continue;
              const o = ((y * W + x) * 4 + s) * 3;
              for (let j = 0; j < 3; j++)
                v[o + j] = mode === 'additive' ? Math.min(1, v[o + j] + r[4 + j]) : 0.5 * r[4 + j] + 0.5 * v[o + j];
            }
      return { v, ties };
    };
    const readPipe = device.createComputePipeline({
      layout: 'auto',
      compute: { module: readModule, entryPoint: 'main' },
    });
    const render = async (mode, split) => {
      const fixed = new Float32Array(N * 8);
      for (let i = 0; i < N; i++)
        fixed.set([...rects[i].slice(0, 4), ...rects[i].slice(4), mode === 'alpha' ? 0.5 : 1], i * 8);
      const storage = device.createBuffer({
        size: fixed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(storage, 0, fixed);
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm', blend: blends[mode] }] },
        multisample: { count: 4 },
        depthStencil: {
          format: 'depth32float-stencil8',
          depthWriteEnabled: false,
          depthCompare: 'greater-equal',
          depthBias: 1,
          depthBiasSlopeScale: 1,
        },
      });
      const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: storage } }],
        }),
        msaa = device.createTexture({
          size: [W, H],
          format: 'bgra8unorm',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
        depth = device.createTexture({
          size: [W, H],
          format: 'depth32float-stencil8',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        }),
        encoder = device.createCommandEncoder(),
        pass = (loadOp) =>
          encoder.beginRenderPass({
            colorAttachments: [{ view: msaa.createView(), loadOp, clearValue: [...background, 1], storeOp: 'store' }],
            depthStencilAttachment: {
              view: depth.createView(),
              depthLoadOp: loadOp,
              depthClearValue: 0,
              depthStoreOp: 'store',
              stencilLoadOp: loadOp,
              stencilClearValue: 0,
              stencilStoreOp: 'store',
            },
          }),
        open = () => {
          const p = pass('load');
          p.setPipeline(pipeline);
          p.setBindGroup(0, group);
          return p;
        };
      pass('clear').end();
      if (split === 'one pass per draw')
        for (let k = 0; k < N; k++) {
          const p = open();
          p.draw(6, 1, 0, k);
          p.end();
        }
      else {
        const p = open();
        if (split === 'one instanced draw') p.draw(6, N);
        else for (let k = 0; k < N; k++) p.draw(6, 1, 0, k);
        p.end();
      }
      const size = W * H * 16,
        out = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        c = encoder.beginComputePass();
      c.setPipeline(readPipe);
      c.setBindGroup(
        0,
        device.createBindGroup({
          layout: readPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: msaa.createView() },
            { binding: 1, resource: { buffer: out } },
          ],
        }),
      );
      c.dispatchWorkgroups(Math.ceil(W / 64), H);
      c.end();
      encoder.copyBufferToBuffer(out, 0, read, 0, size);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(read.getMappedRange().slice(0));
      read.unmap();
      return bytes;
    };
    const out = { adapter: `${adapter.info.description} (${adapter.info.backend ?? adapter.info.vendor})` };
    for (const mode of ['additive', 'alpha']) {
      const { v, ties } = expected(mode);
      let first;
      for (const split of ['one pass per draw', 'one pass, a draw per rectangle', 'one instanced draw']) {
        const b = await render(mode, split),
          off = new Set(),
          collapsed = new Set();
        let worst = 0;
        for (let p = 0; p < W * H; p++) {
          if (ties[p]) continue;
          let e = 0;
          for (let s = 0; s < 4; s++) {
            const i = p * 4 + s;
            for (let j = 0; j < 3; j++) {
              e = Math.max(e, Math.abs(b[i * 4 + j] - v[i * 3 + j] * 255));
            }
          }
          if (e <= 3) continue;
          off.add(p);
          worst = Math.max(worst, e);
          const same = [1, 2, 3].every((s) => [0, 1, 2].every((j) => b[(p * 4 + s) * 4 + j] === b[p * 16 + j])),
            cpuSpread = Math.max(
              ...[0, 1, 2].map((j) => {
                const c = [0, 1, 2, 3].map((s) => v[(p * 4 + s) * 3 + j] * 255);
                return Math.max(...c) - Math.min(...c);
              }),
            );
          if (same && cpuSpread > 3) collapsed.add(p);
        }
        let differ = 0;
        if (!first) first = b;
        for (let i = 0; i < b.length; i++) if (b[i] !== first[i]) differ++;
        out[`${mode}, ${split}`] = {
          pixelsOffMoreThan3Levels: off.size,
          collapsedPixels: collapsed.size,
          worstLevels: +worst.toFixed(1),
          bytesDifferFromOnePassPerDraw: differ,
        };
      }
    }
    return out;
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.close();
}

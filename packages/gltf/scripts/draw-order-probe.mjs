// Plain WebGPU repro (no Margo code) of a GPU whose multisample colour samples depend on the order of the draws in a
// multi-million-triangle frame (docs/known-bugs.md, "Apple M-series: multisample values of a multi-million-triangle
// frame depend on draw order"). It draws row bands of test-parts-browser.mjs's height field (2237 x 2237 vertices, 116
// cell rows a band) with one pipeline (4x MSAA, bgra8unorm, reverse-Z depth32float, greater-equal, back faces culled),
// the fragment writing fract(world position x (37, 1000, 41)), once in band order, twice more the same way and once in
// reversed band order, and prints per band range how many pixels have a sample that differs from the first frame.
// Every frame draws the same triangles with the same vertex data; only the order of the draws changes.
// Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/gltf/scripts/draw-order-probe.mjs
// RANGES='[[6,6],[6,9]]' picks the band ranges (inclusive band indices, 0 to 19; default one band, four bands and all
// twenty); SCALE='37,1000,41' the fragment's position scale (a smaller one gives a smoother output).
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

const ranges = JSON.parse(process.env.RANGES ?? '[[6,6],[6,9],[0,19]]'),
  scale = (process.env.SCALE ?? '37,1000,41').split(',').map(Number);
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const result = await browser.page.evaluate(
      async ({ ranges, scale }) => {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
          device = await adapter.requestDevice({
            requiredLimits: {
              maxBufferSize: adapter.limits.maxBufferSize,
              maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            },
          }),
          errors = [];
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const side = 2237,
          spacing = 0.01,
          W = 512,
          height = (x, y) =>
            (Math.sin(x * 0.031) * Math.cos(y * 0.027) * 4 + Math.sin(x * 0.4 + y * 0.3) * 0.2) * spacing,
          rows = 117,
          bands = [];
        for (let r0 = 0; r0 < side - 1; r0 += rows - 1) bands.push([r0, Math.min(r0 + rows - 1, side - 1)]);
        const parts = bands.map(([r0, r1]) => {
          const n = r1 - r0 + 1,
            position = new Float32Array(n * side * 4),
            index = new Uint32Array((n - 1) * (side - 1) * 6);
          for (let r = 0, v = 0; r < n; r++)
            for (let x = 0; x < side; x++, v++)
              position.set([x * spacing, height(x, r0 + r), (r0 + r) * spacing, 1], v * 4);
          for (let r = 0, i = 0; r < n - 1; r++)
            for (let x = 0; x < side - 1; x++, i += 6) {
              const a = r * side + x,
                c = a + side;
              index.set([a, c, a + 1, a + 1, c, c + 1], i);
            }
          const vertex = device.createBuffer({
              size: position.byteLength,
              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            }),
            indices = device.createBuffer({
              size: index.byteLength,
              usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
          device.queue.writeBuffer(vertex, 0, position);
          device.queue.writeBuffer(indices, 0, index);
          return { vertex, indices, count: index.length };
        });
        // The test's low view: fov 50, near 0.05, far 200, reverse Z.
        const mid = ((side - 1) * spacing) / 2,
          eye = [mid * 0.7, 0.35, mid * 0.62],
          target = [mid * 0.9, 0, mid * 0.75],
          sub = (a, b) => a.map((v, i) => v - b[i]),
          unit = (a) => a.map((v) => v / Math.hypot(...a)),
          cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
          dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
          z = unit(sub(eye, target)),
          x = unit(cross([0, 1, 0], z)),
          y = cross(z, x),
          view = [
            x[0],
            y[0],
            z[0],
            0,
            x[1],
            y[1],
            z[1],
            0,
            x[2],
            y[2],
            z[2],
            0,
            -dot(x, eye),
            -dot(y, eye),
            -dot(z, eye),
            1,
          ],
          f = 1 / Math.tan((50 * Math.PI) / 360),
          near = 0.05,
          far = 200,
          projection = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, near / (far - near), -1, 0, 0, (far * near) / (far - near), 0],
          matrix = new Float32Array(16);
        for (let c = 0; c < 4; c++)
          for (let r = 0; r < 4; r++)
            for (let k = 0; k < 4; k++) matrix[c * 4 + r] += projection[k * 4 + r] * view[c * 4 + k];
        const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniform, 0, matrix);
        const module = device.createShaderModule({
            code: `@group(0) @binding(0) var<uniform> m: mat4x4f;
struct O { @builtin(position) p: vec4f, @location(0) w: vec3f }
@vertex fn vs(@location(0) a: vec3f) -> O { return O(m * vec4f(a, 1), a); }
@fragment fn fs(o: O) -> @location(0) vec4f { return vec4f(fract(o.w * vec3f(${scale.map((v) => v.toFixed(1)).join(', ')})), 1.0); }`,
          }),
          pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
              module,
              entryPoint: 'vs',
              buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
            },
            fragment: { module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] },
            primitive: { topology: 'triangle-list', cullMode: 'back' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
            multisample: { count: 4 },
          }),
          group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniform } }],
          }),
          color = device.createTexture({
            size: [W, W],
            format: 'bgra8unorm',
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          }),
          depth = device.createTexture({
            size: [W, W],
            format: 'depth32float',
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          }),
          reader = device.createComputePipeline({
            layout: 'auto',
            compute: {
              module: device.createShaderModule({
                code: `@group(0) @binding(0) var t: texture_multisampled_2d<f32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  for (var s = 0u; s < 4u; s++) {
    let c = vec3u(round(textureLoad(t, vec2i(g.xy), s).rgb * 255.0));
    o[(g.y * ${W}u + g.x) * 4u + s] = c.r | (c.g << 8u) | (c.b << 16u);
  }
}`,
              }),
              entryPoint: 'main',
            },
          });
        // Draws the bands in `order` and returns every sample as 8-bit rgb in a u32.
        const render = async (order) => {
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginRenderPass({
              colorAttachments: [
                { view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
              ],
              depthStencilAttachment: {
                view: depth.createView(),
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 0,
              },
            });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          for (const k of order) {
            pass.setVertexBuffer(0, parts[k].vertex);
            pass.setIndexBuffer(parts[k].indices, 'uint32');
            pass.drawIndexed(parts[k].count);
          }
          pass.end();
          const out = device.createBuffer({
              size: W * W * 16,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            }),
            back = device.createBuffer({ size: W * W * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            compute = encoder.beginComputePass();
          compute.setPipeline(reader);
          compute.setBindGroup(
            0,
            device.createBindGroup({
              layout: reader.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: color.createView() },
                { binding: 1, resource: { buffer: out } },
              ],
            }),
          );
          compute.dispatchWorkgroups(W / 8, W / 8);
          compute.end();
          encoder.copyBufferToBuffer(out, 0, back, 0, W * W * 16);
          device.queue.submit([encoder.finish()]);
          await back.mapAsync(GPUMapMode.READ);
          const samples = new Uint32Array(back.getMappedRange().slice(0));
          back.unmap();
          out.destroy();
          back.destroy();
          return samples;
        };
        const differ = (a, b) => {
          let n = 0;
          for (let p = 0; p < a.length; p += 4)
            for (let s = 0; s < 4; s++)
              if (a[p + s] !== b[p + s]) {
                n++;
                break;
              }
          return n;
        };
        const out = {};
        for (const [lo, hi] of ranges) {
          const forward = bands.map((_, k) => k).filter((k) => k >= lo && k <= hi),
            first = await render(forward),
            again = await render(forward),
            third = await render(forward),
            reversed = await render([...forward].reverse());
          out[`${lo}-${hi}`] = {
            triangles: forward.reduce((n, k) => n + parts[k].count / 3, 0),
            repeated: differ(first, again),
            repeatedAgain: differ(first, third),
            reversed: differ(first, reversed),
          };
        }
        return { scale, errors, ranges: out };
      },
      { ranges, scale },
    );
    console.log(JSON.stringify({ hardware: browser.hardware, ...result }));
  },
  () => browser.close(),
);

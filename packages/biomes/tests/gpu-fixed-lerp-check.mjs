// Functional hardware proof only: node packages/biomes/tests/gpu-fixed-lerp-check.mjs
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { FIXED_LERP_WGSL, bilinearQ16Ref, lerpQ16Ref } from '../src/gpu-fixed-lerp.ts';
import { fixedLerpCases, lerpOracle, bilinearOracle, requireHardwareAdapter } from './gpu-fixed-lerp-cases.mjs';

async function check() {
  const { endTree, runSuite, watchExit } = await import('../../../scripts/support/shutdown.mjs');
  // Deadline only, never a timing measurement; kill our browser process tree if evaluation or launch hangs.
  const deadline = setTimeout(() => {
    console.error('Q16 WebGPU correctness check exceeded its five-minute bound');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const cases = fixedLerpCases();
    const result = await runSuite(
      async () => {
        const { openBrowser } = await import('../../../scripts/browser.js');
        // This existing page has no scripts, engine imports or rendering work.
        context = await openBrowser({ startPath: '/tests/wgsl-check.html', port: 'free', compat: false });
        const { page } = context;
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') pageErrors.push(message.text());
        });
        const result = await page.evaluate(
          async ({ source, cases }) => {
            // Adapter identity/fallback fields: https://www.w3.org/TR/webgpu/#gpuadapterinfo
            const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) throw new Error('No WebGPU adapter; run this check on a hardware GPU');
            const info = adapter.info;
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
            const identity = {
              name: info?.description?.trim() || renderer,
              vendor: info?.vendor,
              architecture: info?.architecture,
              device: info?.device,
              renderer,
              fallback: info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
            };
            const device = await adapter.requestDevice();
            const errors = [];
            device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
            device.lost.then((loss) => {
              if (loss.reason !== 'destroyed') errors.push(`device lost: ${loss.message}`);
            });
            const buffers = [];
            try {
              device.pushErrorScope('validation');
              const module = device.createShaderModule({
                code: `${source}
struct Case { a: i32, b: i32, c: i32, d: i32, fx: u32, fz: u32 }
struct Result { linear: i32, bilinear: i32, executed: u32 }
@group(0) @binding(0) var<storage, read> inputs: array<Case>;
@group(0) @binding(1) var<storage, read_write> outputs: array<Result>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&inputs)) { return; }
  let c = inputs[i];
  outputs[i] = Result(lerpQ16(c.a, c.b, c.fx), bilinearQ16(c.a, c.b, c.c, c.d, c.fx, c.fz), i + 1u);
}`,
              });
              const compilation = await module.getCompilationInfo();
              for (const message of compilation.messages) if (message.type === 'error') errors.push(message.message);
              const pipeline = await device.createComputePipelineAsync({
                layout: 'auto',
                compute: { module, entryPoint: 'main' },
              });
              const input = new Int32Array(cases.flat());
              const makeBuffer = (size, usage) => {
                const buffer = device.createBuffer({ size, usage });
                buffers.push(buffer);
                return buffer;
              };
              const src = makeBuffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
              const bytes = cases.length * 12;
              const dst = makeBuffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
              const readback = makeBuffer(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
              device.queue.writeBuffer(src, 0, input);
              const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: src } },
                  { binding: 1, resource: { buffer: dst } },
                ],
              });
              const encoder = device.createCommandEncoder();
              const pass = encoder.beginComputePass();
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group);
              pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
              pass.end();
              encoder.copyBufferToBuffer(dst, 0, readback, 0, bytes);
              device.queue.submit([encoder.finish()]);
              await readback.mapAsync(GPUMapMode.READ);
              const values = Array.from(new Int32Array(readback.getMappedRange()));
              readback.unmap();
              await device.queue.onSubmittedWorkDone();
              const validation = await device.popErrorScope();
              if (validation) errors.push(validation.message);
              return { identity, values, errors };
            } finally {
              for (const buffer of buffers) buffer.destroy();
              device.destroy();
            }
          },
          { source: FIXED_LERP_WGSL, cases },
        );
        const adapter = requireHardwareAdapter(result.identity);
        if (hostname().toUpperCase() === 'DEV') assert.match(adapter, /NVIDIA.*RTX A6000/i);
        assert.deepEqual(result.errors, [], 'WebGPU errors');
        assert.ok(cases.length > 0);
        assert.equal(result.values.length, cases.length * 3);
        for (let i = 0; i < cases.length; i++) {
          const [a, b, c, d, fx, fz] = cases[i];
          assert.equal(result.values[i * 3 + 2], i + 1, `GPU case ${i} was skipped`);
          assert.equal(result.values[i * 3], lerpOracle(a, b, fx), `WGSL lerp case ${i}: ${cases[i]}`);
          assert.equal(result.values[i * 3], lerpQ16Ref(a, b, fx), `CPU lerp case ${i}`);
          assert.equal(
            result.values[i * 3 + 1],
            bilinearOracle(a, b, c, d, fx, fz),
            `WGSL bilinear case ${i}: ${cases[i]}`,
          );
          assert.equal(result.values[i * 3 + 1], bilinearQ16Ref(a, b, c, d, fx, fz), `CPU bilinear case ${i}`);
        }
        return { status: 'pass', backend: 'webgpu', adapter, gpuCases: cases.length, skipped: 0 };
      },
      async () => context?.close(),
    );
    assert.deepEqual(pageErrors, [], 'Browser errors');
    watchExit();
    console.log(`AGENT_FACTORY_GPU_CHECK:${JSON.stringify(result)}`);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check();

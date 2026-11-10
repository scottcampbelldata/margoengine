// Reproduce J6's centre-texel diagnosis without changing a shader, sampler or assertion.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { runScene } from './support/composition-run.mjs';

function traceProduct() {
  const views = new Map(), modules = new Map(), pipelines = new Map(), groups = new Map(), bundles = new Map();
  const uniforms = new Map(), samplers = [], sources = [], pending = [];
  const proto = GPUDevice.prototype;
  let active = false;
  const wrap = (name, call) => {
    const original = proto[name];
    proto[name] = function (...args) { return call.call(this, original, ...args); };
  };
  wrap('createTexture', function (original, descriptor) {
    const safe = !/depth|stencil/.test(descriptor.format) && (descriptor.sampleCount ?? 1) === 1;
    const texture = original.call(this, safe ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor);
    const createView = texture.createView.bind(texture);
    texture.createView = (options = {}) => {
      const view = createView(options);
      views.set(view, { texture, descriptor, options });
      return view;
    };
    return texture;
  });
  wrap('createShaderModule', function (original, descriptor) {
    const module = original.call(this, descriptor);
    let index = sources.indexOf(descriptor.code);
    if (index < 0) index = sources.push(descriptor.code) - 1;
    modules.set(module, index);
    return module;
  });
  for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync'])
    wrap(name, function (original, descriptor) {
      const value = original.call(this, descriptor);
      const remember = (pipeline) => { pipelines.set(pipeline, descriptor); return pipeline; };
      return value.then ? value.then(remember) : remember(value);
    });
  wrap('createBindGroup', function (original, descriptor) {
    const group = original.call(this, descriptor);
    groups.set(group, descriptor);
    return group;
  });
  wrap('createSampler', function (original, descriptor = {}) {
    samplers.push(descriptor);
    return original.call(this, descriptor);
  });
  const createBuffer = proto.createBuffer;
  wrap('createBuffer', function (original, descriptor) {
    const buffer = original.call(this, descriptor);
    if (descriptor.usage & GPUBufferUsage.UNIFORM) uniforms.set(buffer, { device: this, size: descriptor.size, bytes: new Uint8Array(descriptor.size) });
    return buffer;
  });
  const writeBuffer = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buffer, offset, data, dataOffset = 0, size) {
    const record = uniforms.get(buffer);
    if (record) {
      const unit = data.BYTES_PER_ELEMENT ?? 1;
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      record.bytes.set(bytes.subarray(dataOffset * unit, size === undefined ? undefined : (dataOffset + size) * unit), offset);
    }
    return writeBuffer.apply(this, arguments);
  };
  wrap('createRenderBundleEncoder', function (original, descriptor) {
    const encoder = original.call(this, descriptor), used = [];
    const set = encoder.setPipeline.bind(encoder), finish = encoder.finish.bind(encoder);
    encoder.setPipeline = (pipeline) => { used.push(pipeline); return set(pipeline); };
    encoder.finish = (...args) => { const bundle = finish(...args); bundles.set(bundle, used); return bundle; };
    return encoder;
  });
  const formats = new Map([['rgba8unorm', 4], ['bgra8unorm', 4], ['rgba16float', 8], ['rg16float', 4], ['rgba32float', 16], ['rg32float', 8], ['r32float', 4], ['r8unorm', 1]]);
  wrap('createCommandEncoder', function (original, descriptor) {
    const encoder = original.call(this, descriptor), device = this;
    for (const name of ['beginRenderPass', 'beginComputePass']) {
      const begin = encoder[name].bind(encoder);
      encoder[name] = (descriptor = {}) => {
        const pass = begin(descriptor), used = [], bound = [];
        const set = pass.setPipeline.bind(pass), bind = pass.setBindGroup.bind(pass), end = pass.end.bind(pass);
        pass.setPipeline = (pipeline) => { used.push(pipeline); return set(pipeline); };
        pass.setBindGroup = (index, group, ...args) => { bound[index] = group; return bind(index, group, ...args); };
        if (pass.executeBundles) {
          const execute = pass.executeBundles.bind(pass);
          pass.executeBundles = (values) => { for (const value of values) used.push(...(bundles.get(value) ?? [])); return execute(values); };
        }
        pass.end = () => {
          end();
          if (!active) return;
          const targets = name === 'beginRenderPass'
            ? (descriptor.colorAttachments ?? []).filter(Boolean).map((a) => a.resolveTarget ?? a.view)
            : bound.flatMap((group) => groups.get(group)?.entries.map((entry) => entry.resource) ?? []).filter((view) => views.get(view)?.texture.usage & GPUTextureUsage.STORAGE_BINDING);
          for (const view of new Set(targets)) {
            const record = views.get(view);
            if (!record) continue;
            const { texture, options } = record, bytes = formats.get(texture.format);
            if (!bytes || texture.sampleCount !== 1 || !(texture.usage & GPUTextureUsage.COPY_SRC)) continue;
            const mipLevel = options.baseMipLevel ?? 0, width = Math.max(1, texture.width >> mipLevel), height = Math.max(1, texture.height >> mipLevel);
            const buffer = createBuffer.call(device, { size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            encoder.copyTextureToBuffer({ texture, mipLevel, origin: [Math.floor(width / 2), Math.floor(height / 2), options.baseArrayLayer ?? 0] }, { buffer, bytesPerRow: 256 }, [1, 1]);
            pending.push({ buffer, bytes, kind: name, format: texture.format, width, height, label: record.descriptor.label, shaders: used.map((pipeline) => { const d = pipelines.get(pipeline); return modules.get(d?.fragment?.module ?? d?.compute?.module); }) });
          }
        };
        return pass;
      };
    }
    return encoder;
  });
  globalThis.__productTrace = { sources, samplers, snapshots: [] };
  globalThis.__beginProductTrace = () => { active = true; };
  globalThis.__endProductTrace = async (device) => {
    active = false;
    const passes = [];
    for (const { buffer, bytes, ...record } of pending.splice(0)) {
      await buffer.mapAsync(GPUMapMode.READ);
      record.bytes = [...new Uint8Array(buffer.getMappedRange()).slice(0, bytes)];
      buffer.unmap(); buffer.destroy(); passes.push(record);
    }
    const uniformBytes = [...uniforms.values()].filter((u) => u.device === device).map((u) => ({ size: u.size, bytes: [...u.bytes] }));
    globalThis.__productTrace.snapshots.push({ passes, uniforms: uniformBytes });
  };
}

const release = await acquire({ owner: 'integration-product-trace', max: 10, waitMax: 5 });
const results = [];
try {
  for (const [backend, compat, args] of [['webgpu', false, []], ['webgl2-d3d11', true, []], ['webgl2-vulkan', true, ['--use-angle=vulkan']]]) {
    const browser = await openBrowser({ startPath: '/examples/test-pages/integration-product.html', port: 'free', compat, args });
    try {
      await browser.page.route('**/examples/integration/harness.ts*', async (route) => {
        const response = await route.fetch();
        const body = (await response.text())
          .replace(/check\(adapter, ["']adapter required["']\);/, (match) => `${match} (${traceProduct.toString()})();`)
          .replace('scene?.beforeSnapshot?.();', 'scene?.beforeSnapshot?.(); globalThis.__beginProductTrace();')
          .replace('context.drawImage(canvas, 0, 0);', 'context.drawImage(canvas, 0, 0); await globalThis.__endProductTrace(engine.gpu);');
        await route.fulfill({ response, body });
      });
      await browser.page.reload();
      await browser.page.waitForFunction(() => !!window.integration, null, { timeout: 60_000 });
      const result = await runScene(() => browser.page.evaluate(async () => ({ result: await window.integration.run(), trace: globalThis.__productTrace })), { label: `product trace ${backend}` });
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      result.trace.sources = result.trace.sources.map((source) => hash(source));
      for (const snapshot of result.trace.snapshots)
        snapshot.uniforms = snapshot.uniforms.map(({ size, bytes }) => ({ size, sha256: hash(Uint8Array.from(bytes)) }));
      results.push({ backend, ...result });
      console.log(`${backend}: ${JSON.stringify(result.result.before[1])}, ${result.trace.snapshots[0].passes.length} centre copies`);
    } finally { await browser.close(); }
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/integration-product-trace.json', `${JSON.stringify(results, null, 2)}\n`);
} finally { await release(); }

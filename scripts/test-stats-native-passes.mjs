// Hardware-only native Stats pass regression. Build Stats first, then run with the GPU lock:
//   node scripts/build-optional.js stats
//   node scripts/gpu-lock.mjs run --owner=stats-native-passes -- node scripts/test-stats-native-passes.mjs
// This is an explicit browser correctness check, not part of the fake-GPU CPU suite or an allocation benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const output = 'test-results/stats-native-passes.json', hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['packages/stats/src/index.ts', 'packages/stats/src/pass-prototypes.ts', 'packages/stats/dist/index.js', 'scripts/test-stats-native-passes.mjs', 'tests/browser/stats-native-passes.html'];
const report = { startedAt: new Date().toISOString(), sourceSHA256: {}, sourceChanges: [], errors: [] };
for (const path of paths) report.sourceSHA256[path] = hash(await readFile(path));
let app;
try {
  app = await openBrowser({ channel: 'msedge', args: [], port: 5270, startPath: '/tests/browser/stats-native-passes.html' });
  report.hardware = app.hardware;
  assert.equal(app.hardware.webgpu?.fallback, false);
  app.page.on('pageerror', error => report.errors.push(error.stack ?? error.message));
  report.proof = await app.page.evaluate(async () => {
    'use strict';
    const { Stats } = await import('/packages/stats/dist/index.js');
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    ensure(adapter && adapter.features.has('timestamp-query'), 'Native timestamp-query support required');
    const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }), queue = device.queue,
      errors = [], overlays = [], result = { cases: [], timestamp: null, gpu: null };
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const overlay = options => { const stats = new Stats({ parent: document.body, ...options }); overlays.push(stats); return stats; };
    const ordinary = overlay(), selected = overlay({ lowAllocationPasses: true, profiling: true });
    selected.enableGPUProfiling(device);
    const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }),
      descriptor = { colorAttachments: [{ view: texture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] },
      index = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }),
      indirect = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST }),
      computeIndirect = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST }),
      counter = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      readback = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    queue.writeBuffer(index, 0, new Uint32Array([0, 1, 2])); queue.writeBuffer(indirect, 0, new Uint32Array([3, 1, 0, 0, 0]));
    queue.writeBuffer(computeIndirect, 0, new Uint32Array([1, 1, 1]));
    const renderModule = device.createShaderModule({ code: '@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);} @fragment fn f()->@location(0) vec4f{return vec4f(.25,.5,.75,1);}' }),
      computeModule = device.createShaderModule({ code: '@group(0) @binding(0) var<storage,read_write> count:atomic<u32>; @compute @workgroup_size(1) fn c(){atomicAdd(&count,1u);}' });
    const [renderPipeline, computePipeline] = await Promise.all([
      device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: renderModule, entryPoint: 'v' }, fragment: { module: renderModule, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] } }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: computeModule, entryPoint: 'c' } }),
    ]);
    const group = device.createBindGroup({ layout: computePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: counter } }] });
    let expectedDispatches = 0;
    function draws(pass) {
      pass.setPipeline(renderPipeline); pass.setIndexBuffer(index, 'uint32'); pass.draw(3); pass.drawIndexed(3);
      pass.drawIndirect(indirect, 0); pass.drawIndexedIndirect(indirect, 0); pass.end();
    }
    function dispatches(pass) {
      pass.setPipeline(computePipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1); pass.dispatchWorkgroupsIndirect(computeIndirect, 0); pass.end(); expectedDispatches += 2;
    }
    const shapes = (render, compute, low) => {
      const rp = Object.getPrototypeOf(render), cp = Object.getPrototypeOf(compute);
      ensure(render instanceof GPURenderPassEncoder && compute instanceof GPUComputePassEncoder, 'Native internal brands/instanceof');
      ensure(render.constructor === GPURenderPassEncoder && compute.constructor === GPUComputePassEncoder, 'Native constructors');
      ensure(Reflect.ownKeys(render).length === (low ? 0 : 5) && Reflect.ownKeys(compute).length === (low ? 0 : 3), 'Expected own-key layouts');
      ensure(low ? Object.getPrototypeOf(rp) === GPURenderPassEncoder.prototype && Object.isFrozen(rp) : rp === GPURenderPassEncoder.prototype, 'Render prototype layout');
      ensure(low ? Object.getPrototypeOf(cp) === GPUComputePassEncoder.prototype && Object.isFrozen(cp) : cp === GPUComputePassEncoder.prototype, 'Compute prototype layout');
      return { low, renderOwnKeys: Reflect.ownKeys(render).length, computeOwnKeys: Reflect.ownKeys(compute).length,
        nativeInstanceof: true, nativeConstructors: true, prototypeLayoutVerified: true };
    };
    let ownerSymbol;
    for (const [stats, low] of [[ordinary, false], [selected, true]]) {
      const encoder = device.createCommandEncoder(); stats.track(encoder);
      const render = encoder.beginRenderPass(descriptor); draws(render);
      const compute = encoder.beginComputePass(); dispatches(compute);
      result.cases.push({ name: low ? 'actual-dist native opt-in' : 'actual-dist default', ...shapes(render, compute, low) });
      if (!low) ownerSymbol = Reflect.ownKeys(render).find(key => typeof key === 'symbol');
      ensure(stats.drawCalls === 4 && stats.dispatches === 2, 'Actual Stats counters');
      queue.submit([encoder.finish()]);
    }
    // Private helper inspection tests native fallback eligibility; no public runtime test hook is added.
    const helper = selected.passPrototypes;
    ensure(helper && typeof helper.render === 'function', 'Actual dist helper initialized');
    const nativeFactory = GPUCommandEncoder.prototype.beginRenderPass, nativePrototype = GPURenderPassEncoder.prototype,
      nativeDescriptor = Object.getOwnPropertyDescriptor(nativePrototype, 'draw');
    let getterCalls = 0, setterCalls = 0;
    const accessorEncoder = device.createCommandEncoder(), accessorPass = accessorEncoder.beginRenderPass(descriptor);
    try {
      Object.defineProperty(nativePrototype, 'draw', { configurable: true, enumerable: nativeDescriptor.enumerable,
        get() { getterCalls++; return nativeDescriptor.value; },
        set(value) { setterCalls++; Object.defineProperty(this, 'draw', { value, writable: true, configurable: true, enumerable: true }); } });
      ensure(helper.render(accessorPass, accessorEncoder, nativeFactory) === false, 'Accessor returning canonical native must fall back');
      ensure(getterCalls === 0 && setterCalls === 0, 'Eligibility guards must not invoke custom accessors');
      const custom = { beginRenderPass() { return accessorPass; }, beginComputePass() {}, finish() {} };
      ordinary.track(custom); custom.beginRenderPass(descriptor); draws(accessorPass);
      ensure(getterCalls === 1 && setterCalls === 1, 'Ordinary fallback accessor semantics');
    } finally { Object.defineProperty(nativePrototype, 'draw', nativeDescriptor); }
    queue.submit([accessorEncoder.finish()]);
    result.cases.push({ name: 'actual helper native accessor rejection / ordinary fallback', getterCalls, setterCalls });
    ensure(typeof ownerSymbol === 'symbol', 'Default owner symbol available for inherited-owner regression');
    let ownerGets = 0, ownerSets = 0;
    const ownerEncoder = device.createCommandEncoder(), ownerPass = ownerEncoder.beginRenderPass(descriptor);
    try {
      Object.defineProperty(nativePrototype, ownerSymbol, { configurable: true,
        get() { ownerGets++; return undefined; },
        set(value) { ownerSets++; Object.defineProperty(this, ownerSymbol,
          { value, writable: true, configurable: true, enumerable: true }); } });
      ensure(helper.render(ownerPass, ownerEncoder, nativeFactory) === false, 'Inherited owner must reject shared layout');
      ensure(ownerGets === 0 && ownerSets === 0, 'Inherited-owner eligibility must not invoke accessors');
      const encoder = device.createCommandEncoder(); selected.track(encoder);
      const pass = encoder.beginRenderPass(descriptor);
      ensure(ownerGets === 1 && ownerSets === 1 && Reflect.ownKeys(pass).length === 5 &&
        Object.getPrototypeOf(pass) === nativePrototype, 'Public native fallback must preserve owner accessors and layout');
      draws(pass); queue.submit([encoder.finish()]);
      Object.defineProperty(nativePrototype, ownerSymbol, { value: undefined, writable: false, configurable: true });
      ensure(helper.render(ownerPass, ownerEncoder, nativeFactory) === false, 'Inherited nonwritable owner must reject shared layout');
      const locked = { beginRenderPass() { return ownerPass; }, beginComputePass() {}, finish() {} };
      ordinary.track(locked);
      let writeFailed = false;
      try { locked.beginRenderPass(descriptor); } catch (error) { writeFailed = error instanceof TypeError; }
      ensure(writeFailed && Reflect.ownKeys(ownerPass).length === 0, 'Nonwritable owner preserves ordinary failure without partial writes');
      Object.defineProperty(nativePrototype, ownerSymbol, { value: {}, writable: true, configurable: true });
      ensure(helper.render(ownerPass, ownerEncoder, nativeFactory) === false, 'Unknown inherited owner must reject shared layout');
      const unknownEncoder = device.createCommandEncoder(); selected.track(unknownEncoder);
      const unknownPass = unknownEncoder.beginRenderPass(descriptor);
      let drawFailed = false;
      try { unknownPass.draw(3); } catch (error) { drawFailed = error instanceof TypeError; }
      ensure(drawFailed && Reflect.ownKeys(unknownPass).length === 5 &&
        Object.getPrototypeOf(unknownPass) === nativePrototype, 'Unknown owner preserves ordinary custom-record failure');
      unknownPass.end(); queue.submit([unknownEncoder.finish()]);
    } finally { delete nativePrototype[ownerSymbol]; }
    ownerPass.end(); queue.submit([ownerEncoder.finish()]);
    result.cases.push({ name: 'native inherited owner accessor / nonwritable / unknown fallback', ownerGets, ownerSets,
      eligibilityInvocations: 0, nonwritableFailurePreserved: true, unknownFailurePreserved: true });
    const lockedEncoder = device.createCommandEncoder(), lockedPass = lockedEncoder.beginRenderPass(descriptor);
    try {
      Object.defineProperty(nativePrototype, 'draw', { ...nativeDescriptor, writable: false });
      ensure(helper.render(lockedPass, lockedEncoder, nativeFactory) === false, 'Identical-value nonwritable native data must fall back');
    } finally { Object.defineProperty(nativePrototype, 'draw', nativeDescriptor); }
    draws(lockedPass); queue.submit([lockedEncoder.finish()]);
    result.cases.push({ name: 'actual helper inherited nonwritable rejection', rejected: true });
    const nestedEncoder = device.createCommandEncoder(); selected.track(nestedEncoder);
    const nestedRender = nestedEncoder.beginRenderPass(descriptor), nested = overlay({ lowAllocationPasses: true });
    const transfer = { beginRenderPass() { return nestedRender; }, beginComputePass() {}, finish() {} };
    nested.track(transfer); transfer.beginRenderPass(descriptor); draws(nestedRender);
    ensure(nested.drawCalls === 4 && selected.drawCalls === 0 && Reflect.ownKeys(nestedRender).length === 5, 'Nested Stats owner transfer');
    const nestedCompute = nestedEncoder.beginComputePass(); dispatches(nestedCompute); queue.submit([nestedEncoder.finish()]);
    result.cases.push({ name: 'actual-dist nested unknown-factory owner transfer', draws: nested.drawCalls, ownKeys: 5 });
    const overrideEncoder = device.createCommandEncoder(); selected.track(overrideEncoder);
    const overridePass = overrideEncoder.beginRenderPass(descriptor), captured = overridePass.draw, derived = Object.getPrototypeOf(overridePass);
    let customCalls = 0;
    overridePass.draw = function(...args) { customCalls++; return captured.apply(this, args); };
    ensure(Object.getOwnPropertyDescriptor(overridePass, 'draw').writable, 'Per-pass assignment creates writable own method');
    let sharedThrows = false; try { derived.draw = captured; } catch (error) { sharedThrows = error instanceof TypeError; }
    ensure(sharedThrows && Object.isFrozen(derived), 'Shared prototype mutation rejected');
    draws(overridePass); const overrideCompute = overrideEncoder.beginComputePass(); dispatches(overrideCompute); queue.submit([overrideEncoder.finish()]);
    ensure(customCalls === 1 && selected.drawCalls === 4 && selected.dispatches === 2, 'Per-pass custom method preserves actual counters');
    result.cases.push({ name: 'actual-dist per-pass assignment / frozen shared prototype', customCalls, sharedThrows });
    // Reach a sampled frame with real timestamp writes while retaining native factories.
    for (let frame = 0; frame < 16; frame++) {
      const encoder = device.createCommandEncoder(); selected.track(encoder); draws(encoder.beginRenderPass(descriptor)); dispatches(encoder.beginComputePass());
      queue.submit([encoder.finish()]);
    }
    await queue.onSubmittedWorkDone();
    for (let i = 0; i < 200 && selected.gpuSampleId === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    ensure(selected.gpuSampleId > 0 && selected.gpuPassCount === 2 && Number.isFinite(selected.gpuTime) && selected.gpuTime >= 0, 'Native timestamp readback');
    result.timestamp = { sampleId: selected.gpuSampleId, passCount: selected.gpuPassCount, milliseconds: selected.gpuTime, spanMilliseconds: selected.gpuElapsedMilliseconds };
    const iframe = document.createElement('iframe'), ready = new Promise(resolve => iframe.addEventListener('load', resolve, { once: true }));
    iframe.src = '/tests/browser/stats-native-passes.html'; document.body.append(iframe); await ready;
    const foreign = iframe.contentWindow, foreignAdapter = await foreign.navigator.gpu.requestAdapter(), foreignDevice = await foreignAdapter.requestDevice(), foreignErrors = [];
    foreignDevice.addEventListener('uncapturederror', event => foreignErrors.push(event.error.message));
    const foreignTexture = foreignDevice.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }),
      foreignEncoder = foreignDevice.createCommandEncoder();
    selected.track(foreignEncoder);
    const foreignPass = foreignEncoder.beginRenderPass({ colorAttachments: [{ view: foreignTexture.createView(), loadOp: 'clear', storeOp: 'store' }] });
    ensure(Object.getPrototypeOf(foreignPass) === foreign.GPURenderPassEncoder.prototype && Reflect.ownKeys(foreignPass).length === 5, 'Actual-dist real cross-realm fallback');
    foreignPass.end(); foreignDevice.queue.submit([foreignEncoder.finish()]); await foreignDevice.queue.onSubmittedWorkDone();
    ensure(foreignErrors.length === 0, 'Foreign native GPU validation'); foreignTexture.destroy(); foreignDevice.destroy(); iframe.remove();
    result.cases.push({ name: 'actual-dist real iframe GPU realm fallback', ownKeys: 5, nativePrototypePreserved: true });
    const check = device.createCommandEncoder(); check.copyBufferToBuffer(counter, 0, readback, 0, 4);
    check.copyTextureToBuffer({ texture }, { buffer: readback, offset: 256, bytesPerRow: 256 }, [1, 1]); queue.submit([check.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange(), actual = new Uint32Array(bytes, 0, 1)[0], pixel = [...new Uint8Array(bytes, 256, 4)]; readback.unmap();
    ensure(actual === expectedDispatches && pixel[0] === 64 && Math.abs(pixel[1] - 128) <= 1 && pixel[2] === 191 && pixel[3] === 255, 'Actual native GPU dispatch/render contents');
    result.gpu = { actualDispatches: actual, expectedDispatches, pixel, errors };
    ensure(errors.length === 0, 'Native GPU validation errors');
    for (const stats of overlays) stats.dispose();
    for (const resource of [texture, index, indirect, computeIndirect, counter, readback]) resource.destroy();
    device.destroy(); return result;
  });
  assert.deepEqual(report.errors, []);
  report.success = true;
} catch (error) { report.failure = error.stack ?? String(error); throw error; }
finally {
  await app?.close();
  for (const [path, expected] of Object.entries(report.sourceSHA256)) if (hash(await readFile(path)) !== expected) report.sourceChanges.push(path);
  report.completedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2));
}
assert.deepEqual(report.sourceChanges, []);
console.log(JSON.stringify({ output, success: report.success, proof: report.proof }, null, 2));

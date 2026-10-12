import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';

const browser = await openBrowser(), errors = [];
browser.page.on('pageerror', error => errors.push(error.message));
browser.page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
try {
  const result = await browser.page.evaluate(async () => {
    const {SkyMoonPass, SkyMoon} = await import('/packages/scenery/dist/index.js');
    const {Camera} = await import('/packages/core/dist/index.js');
    const {invert} = await import('/packages/shared/math.js');
    const assert = (condition, message) => {if (!condition) throw new Error(message);};
    const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
    assert(adapter, 'WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    const uncaptured = []; device.addEventListener('uncapturederror', event => uncaptured.push(event.error.message));
    device.pushErrorScope('validation');
    const shaderModules = [], createShaderModule = device.createShaderModule.bind(device);
    device.createShaderModule = descriptor => {const module = createShaderModule(descriptor); shaderModules.push(module); return module;};
    const size = 256, bytesPerRow = size * 4;
    const color = device.createTexture({size: [size, size], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
    const depth = device.createTexture({size: [size, size], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    const read = device.createBuffer({size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    const sky = new SkyMoonPass(device, 'rgba8unorm', 'depth32float');
    const descriptor = {colorAttachments: [{view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.25, 0, 0.25, 1]}], depthStencilAttachment: {view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0}};
    const camera = new Camera({position: [0, 0, 0], target: [0, 0, -1]}); camera.update(1, true);
    const inverse = new Float32Array(16); assert(invert(inverse, camera.matrix), 'Camera inversion failed');
    const render = async (config, matrix = inverse, time = 0, clearDepth = 0) => {
      sky.setConfig(config); sky.updateFrame(matrix, camera.position, time);
      descriptor.depthStencilAttachment.depthClearValue = clearDepth;
      const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass(descriptor);
      sky.record(pass); pass.end();
      encoder.copyTextureToBuffer({texture: color}, {buffer: read, bytesPerRow}, [size, size]);
      device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
      const image = new Uint8Array(read.getMappedRange()).slice(); read.unmap(); return image;
    };
    const litPixels = image => {let lit = 0; for (let i = 0; i < image.length; i += 4) if (image[i] > 64) lit++; return lit;};
    const difference = (a, b) => {let changed = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2) changed++; return changed;};
    const full = await render({zenithColor: [0, 0, 0], horizonColor: [0, 0, 0], moonColor: [1, 1, 1], moonDirection: [0, 0, -1], moonSize: 0.18, moonPhase: 1, glowIntensity: 0, starIntensity: 0});
    const half = await render({moonPhase: 0}), dark = await render({moonPhase: -1});
    const phases = {full: litPixels(full), half: litPixels(half), new: litPixels(dark)};
    assert(phases.full > 100 && phases.half / phases.full > 0.4 && phases.half / phases.full < 0.6 && phases.new === 0, `Incorrect lunar phases: ${JSON.stringify(phases)}`);

    const infiniteProjection = camera.matrix.slice(); infiniteProjection[10] = 0; infiniteProjection[14] = camera.near;
    const infiniteInverse = new Float32Array(16); assert(invert(infiniteInverse, infiniteProjection), 'Infinite projection inversion failed');
    const infinite = await render({moonPhase: 1}, infiniteInverse);
    assert(difference(full, infinite) < 10, 'Infinite far-plane ray differs from finite projection');
    const translatedCamera = new Camera({position: [12, 7, -3], target: [12, 7, -4]}); translatedCamera.update(1, true);
    const translatedInverse = new Float32Array(16); assert(invert(translatedInverse, translatedCamera.matrix), 'Translated camera inversion failed');
    camera.position = translatedCamera.position;
    const translated = await render({}, translatedInverse); camera.position = [0, 0, 0];
    assert(difference(full, translated) < 20, 'Sky moved under camera translation');

    const occluded = await render({}, inverse, 0, 0.5);
    for (let i = 0; i < occluded.length; i += 4) assert(occluded[i] === 64 && occluded[i + 1] === 0 && occluded[i + 2] === 64, 'Sky overwrote geometry depth');
    const depthValues = device.createBuffer({size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const depthRead = device.createBuffer({size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    const depthModule = device.createShaderModule({code: '@group(0) @binding(0) var depth:texture_depth_2d; @group(0) @binding(1) var<storage,read_write> result:array<f32>; @compute @workgroup_size(1) fn main(){result[0]=textureLoad(depth,vec2i(128,128),0);}'});
    const depthPipeline = device.createComputePipeline({layout: 'auto', compute: {module: depthModule, entryPoint: 'main'}});
    const depthGroup = device.createBindGroup({layout: depthPipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: depth.createView()}, {binding: 1, resource: {buffer: depthValues}}]});
    const measureDepth = async () => {
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(depthPipeline); pass.setBindGroup(0, depthGroup); pass.dispatchWorkgroups(1); pass.end();
      encoder.copyBufferToBuffer(depthValues, 0, depthRead, 0, 4); device.queue.submit([encoder.finish()]); await depthRead.mapAsync(GPUMapMode.READ);
      const value = new Float32Array(depthRead.getMappedRange())[0]; depthRead.unmap(); return value;
    };
    assert(await measureDepth() === 0.5, 'Occluded sky changed depth');
    await render({}); assert(await measureDepth() === 0, 'Visible sky wrote depth');
    const glow = await render({moonPhase: -1, glowIntensity: 1}); assert(difference(dark, glow) > 100, 'Corona glow missing');

    camera.target = [0, 1, -1]; camera.update(1, true); assert(invert(inverse, camera.matrix), 'Elevated camera inversion failed');
    const starBase = await render({moonDirection: [0, -1, 0], glowIntensity: 0, starIntensity: 0});
    const stars = await render({starIntensity: 1}, inverse, 1), twinkle = await render({}, inverse, 2);
    const starsChanged = difference(starBase, stars), twinkleChanged = difference(stars, twinkle);
    assert(starsChanged > 10 && twinkleChanged > 10, 'Stars or twinkling missing');
    const haze = await render({zenithColor: [0, 0, 0], horizonColor: [0.2, 0.3, 0.4], starIntensity: 0});
    assert(difference(starBase, haze) > 1000, 'Horizon haze missing');
    const polar = await render({zenithColor: [0, 0, 0], horizonColor: [0, 0, 0], moonDirection: [0, 1, 0], moonSize: 0.8, moonPhase: 1}); assert(litPixels(polar) > 100, 'Polar moon basis failed');

    const colorOnly = new SkyMoonPass(device, 'rgba8unorm');
    colorOnly.updateFrame(inverse, camera.position, 0);
    const colorDescriptor = {colorAttachments: descriptor.colorAttachments}, colorEncoder = device.createCommandEncoder(), colorPass = colorEncoder.beginRenderPass(colorDescriptor);
    colorOnly.record(colorPass); colorPass.end(); device.queue.submit([colorEncoder.finish()]); await device.queue.onSubmittedWorkDone(); colorOnly.dispose();

    const diagnostics = (await Promise.all(shaderModules.map(module => module.getCompilationInfo()))).flatMap(info => info.messages.map(message => ({type: message.type, message: message.message})));
    assert(!diagnostics.some(message => message.type === 'error'), `WGSL compilation failed: ${JSON.stringify(diagnostics)}`);
    const validation = await device.popErrorScope(); assert(!validation && uncaptured.length === 0, `GPU validation failed: ${validation?.message ?? uncaptured.join('; ')}`);
    sky.dispose(); color.destroy(); depth.destroy(); read.destroy(); depthValues.destroy(); depthRead.destroy(); device.destroy();

    await window.modern.core('webgpu');
    const engine = window.modern.state.core, plugin = new SkyMoon(); engine.use(plugin); engine.render(); await engine.gpu.queue.onSubmittedWorkDone();
    const resources = ['createBuffer', 'createBindGroup', 'createBindGroupLayout', 'createShaderModule', 'createPipelineLayout', 'createRenderPipeline'];
    const originals = resources.map(name => engine.gpu[name]), begin = GPUCommandEncoder.prototype.beginRenderPass;
    const descriptors = []; let allocations = 0;
    for (let i = 0; i < resources.length; i++) engine.gpu[resources[i]] = function (...args) {allocations++; return originals[i].apply(this, args);};
    GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {descriptors.push(descriptor); return begin.call(this, descriptor);};
    try {for (let frame = 0; frame < 5; frame++) {engine.render({delta: 0.1}); await engine.gpu.queue.onSubmittedWorkDone();}}
    finally {for (let i = 0; i < resources.length; i++) engine.gpu[resources[i]] = originals[i]; GPUCommandEncoder.prototype.beginRenderPass = begin;}
    assert(allocations === 0 && descriptors.length === 10 && descriptors.every((descriptor, i) => descriptor === descriptors[i % 2]), 'Plugin allocated resources or replaced descriptors during steady frames');
    const picked = await engine.pick(160, 120); assert(picked !== null, 'Scenery broke core picking');
    window.modern.creative({bloom: 0.3, atmosphere: {sky: false}}); await engine.gpu.queue.onSubmittedWorkDone();
    engine.canvas.style.width = '400px'; engine.canvas.style.height = '300px'; engine.render(); await engine.gpu.queue.onSubmittedWorkDone();
    const oldDevice = engine.gpu; await engine.rebootDevice(); engine.render({delta: 0.1}); await engine.gpu.queue.onSubmittedWorkDone();
    assert(engine.gpu !== oldDevice && engine.hasPlugin('sky-moon'), 'Scenery device restoration failed');
    engine.removePlugin('sky-moon'); engine.render(); await engine.gpu.queue.onSubmittedWorkDone(); engine.dispose();
    return {phases, starsChanged, twinkleChanged, diagnostics, steadyFrameResourceAllocations: allocations, checks: ['finite/infinite Reversed-Z rays', 'camera translation', 'depth occlusion and preservation', 'glow, stars, twinkle, haze, polar moon', 'color-only pass', 'engine plugin, picking, HDR composition, resize, device restoration, removal']};
  });
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-sky-moon.json', JSON.stringify({hardware: browser.hardware, ...result}, null, 2));
  console.log(JSON.stringify({hardware: browser.hardware, ...result}, null, 2));
} finally {await browser.close();}

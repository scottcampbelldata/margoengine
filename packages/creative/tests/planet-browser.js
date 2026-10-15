import { Engine, Camera, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Planet, PostProcessing } from '../dist/index.js';
import { PlanetPass } from '../src/planet-pass.ts';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function imageCanvas(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const context = canvas.getContext('2d'),
    image = context.createImageData(64, 32);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) image.data.set(typeof color === 'function' ? color(x, y) : color, (y * 64 + x) * 4);
  context.putImageData(image, 0, 0);
  return canvas;
}
const bitmap = (color) =>
  createImageBitmap(imageCanvas(color), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
const source = (color) => imageCanvas(color).toDataURL();
function difference(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 10) count++;
  return count;
}
function half(value) {
  const sign = value & 0x8000 ? -1 : 1,
    exponent = (value >> 10) & 31,
    mantissa = value & 1023;
  return (
    sign *
    (exponent === 0
      ? mantissa * 2 ** -24
      : exponent === 31
        ? mantissa
          ? NaN
          : Infinity
        : (1 + mantissa / 1024) * 2 ** (exponent - 15))
  );
}

window.runPlanetTests = async () => {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  assert(adapter, 'WebGPU adapter unavailable');
  const device = await adapter.requestDevice(),
    errors = [],
    modules = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const originalShader = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor) => {
    const module = originalShader(descriptor);
    modules.push(module);
    return module;
  };
  const camera = new Camera({ position: [0, 0, 4], target: [0, 0, 0], near: 0.1, far: 100 });
  camera.update(1, true);
  const images = {
    day: await bitmap([20, 150, 20, 255]),
    night: await bitmap([220, 5, 5, 255]),
    white: await bitmap([255, 0, 0, 255]),
    black: await bitmap([0, 0, 0, 255]),
    normal: await bitmap([235, 128, 150, 255]),
    clouds: await bitmap((x) => (x < 32 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
  };
  const size = 256;
  async function render({
    maps = { day: images.day, night: images.night },
    sun = [1, 0, 0],
    offset = 0,
    intensity = 0,
    shell = true,
    depthValue = 0,
    format = 'rgba8unorm',
  } = {}) {
    const target = device.createTexture({
      size: [size, size],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depth = device.createTexture({
      size: [size, size],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerPixel = format === 'rgba16float' ? 8 : 4;
    const output = device.createBuffer({
      size: size * size * bytesPerPixel,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const depthOutput = device.createBuffer({
      size: size * size * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const pass = new PlanetPass(device, maps, format, 'depth32float', {
      radius: 1,
      atmosphereColor: [0.15, 0.4, 1],
      atmosphereIntensity: intensity,
      nightIntensity: 3,
    });
    pass.updateFrame(camera.matrix, identity(), camera.position, sun, offset);
    const encoder = device.createCommandEncoder(),
      colorView = target.createView(),
      depthView = depth.createView();
    const clear = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: depthValue,
      },
    });
    clear.end();
    const context = {
      backend: 'webgpu',
      device,
      encoder,
      color: colorView,
      depth: depthView,
      format,
      descriptor: { multisample: { count: 1 } },
    };
    pass.record(context, false);
    if (shell) pass.record(context, true);
    encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: size * bytesPerPixel }, [
      size,
      size,
    ]);
    encoder.copyTextureToBuffer(
      { texture: depth, aspect: 'depth-only' },
      { buffer: depthOutput, bytesPerRow: size * 4 },
      [size, size],
    );
    device.queue.submit([encoder.finish()]);
    await Promise.all([output.mapAsync(GPUMapMode.READ), depthOutput.mapAsync(GPUMapMode.READ)]);
    const pixels = new Uint8Array(output.getMappedRange()).slice();
    const depths = new Float32Array(depthOutput.getMappedRange()).slice();
    output.unmap();
    depthOutput.unmap();
    pass.dispose();
    target.destroy();
    depth.destroy();
    output.destroy();
    depthOutput.destroy();
    return {
      pixels,
      depths,
      at(x, y) {
        const offset = (y * size + x) * bytesPerPixel;
        return bytesPerPixel === 4
          ? [...pixels.slice(offset, offset + 4)]
          : [...new Uint16Array(pixels.buffer, offset, 4)].map(half);
      },
    };
  }
  const terminator = await render(),
    left = terminator.at(85, 128),
    right = terminator.at(171, 128);
  assert(left[0] > left[1] * 2 && right[1] > right[0] * 2, `Day/night hemispheres incorrect: ${left} / ${right}`);
  const dayOnly = await render({ maps: { day: images.day } });
  assert(difference(terminator.pixels, dayOnly.pixels) > 1000, 'Night lights missing');
  const nightHdr = await render({
    maps: { day: images.black, night: images.night },
    format: 'rgba16float',
    shell: false,
  });
  assert(nightHdr.at(85, 128)[0] > 2, 'Night emission lost its 3x boost before tone mapping');
  assert(nightHdr.at(128, 128)[0] > 0.1, 'Night lights are missing from the twilight boundary');
  assert(terminator.at(85, 128)[0] > 210, 'Tone mapping crushed boosted night lights');
  for (let y = 90; y < 166; y++)
    for (let x = 143; x < 176; x++) {
      const a = terminator.at(x, y),
        b = dayOnly.at(x, y);
      assert(
        a.every((value, index) => value === b[index]),
        'Night lights leaked into illuminated hemisphere',
      );
    }
  const surfaceDepth = await render({ shell: false }),
    rim = await render({ intensity: 1.2 });
  assert(
    surfaceDepth.depths.every((value, index) => value === rim.depths[index]),
    'Atmosphere shell changed surface depth',
  );
  let blueRim = 0;
  for (let i = 0; i < rim.pixels.length; i += 4) if (rim.pixels[i + 2] > terminator.pixels[i + 2] + 25) blueRim++;
  assert(blueRim > 200, 'Atmospheric blue rim missing');
  const covered = await render({ depthValue: 1, intensity: 1.2 });
  assert(
    covered.pixels.every((value, index) => index % 4 === 3 || value === 0),
    'Planet overwrote closer reversed-Z geometry',
  );
  const cloudA = await render({ maps: { day: images.day, clouds: images.clouds }, sun: [0, 0, 1] }),
    cloudB = await render({ maps: { day: images.day, clouds: images.clouds }, sun: [0, 0, 1], offset: 0.5 });
  const driftPixels = difference(cloudA.pixels, cloudB.pixels);
  assert(driftPixels > 1000, 'Cloud UV drift did not change cloud coverage');
  const elevatedCloud = await render({ maps: { day: images.black, clouds: images.white }, sun: [0, 0, 1] });
  let elevatedPixels = 0;
  for (let i = 0; i < surfaceDepth.depths.length; i++)
    if (surfaceDepth.depths[i] === 0 && elevatedCloud.pixels[i * 4] > 10) elevatedPixels++;
  assert(elevatedPixels > 0, 'Cloud shell has no geometric extension beyond the surface silhouette');
  const ocean = await render({ maps: { day: images.black, specular: images.white }, sun: [0, 0, 1] }),
    land = await render({ maps: { day: images.black, specular: images.black }, sun: [0, 0, 1] });
  assert(ocean.at(128, 128)[0] > land.at(128, 128)[0] + 80, 'Ocean specular mask missing');
  const smooth = await render({ maps: { day: images.day }, sun: [0, 0, 1] }),
    relief = await render({ maps: { day: images.day, normal: images.normal }, sun: [0, 0, 1] });
  assert(difference(smooth.pixels, relief.pixels) > 1000, 'Normal map does not change surface lighting');
  const hdr = await render({
    maps: { day: images.white, specular: images.white },
    sun: [0, 0, 1],
    format: 'rgba16float',
  });
  assert(hdr.at(128, 128)[0] > 1.5, `HDR planet was tone mapped early: ${hdr.at(128, 128)}`);
  const diagnostics = (await Promise.all(modules.map((module) => module.getCompilationInfo())))
    .flatMap((info) => info.messages)
    .filter((message) => message.type === 'error');
  const validation = await device.popErrorScope();
  assert(
    diagnostics.length === 0 && !validation && errors.length === 0,
    `Planet WGSL/GPU errors: ${JSON.stringify(diagnostics)} ${validation?.message ?? errors.join('; ')}`,
  );
  Object.values(images).forEach((image) => image.close());
  device.destroy();

  const engine = await Engine.create(document.querySelector('#planet'), {
    backend: 'webgpu',
    camera: { position: [0, 0, 4], target: [0, 0, 0] },
  });
  const runtime = engineRuntime(engine),
    gpuErrors = [];
  runtime.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  runtime.gpu.pushErrorScope('validation');
  const originalFetch = window.fetch;
  let requested;
  const requestStarted = new Promise((resolve) => {
    requested = resolve;
  });
  window.fetch = (...args) => {
    requested();
    return originalFetch(...args);
  };
  const controller = new AbortController();
  const pending = Planet.create(engine, { dayMap: '/tests/slow-map.png', signal: controller.signal });
  await requestStarted;
  controller.abort();
  let canceled = false;
  try {
    await pending;
  } catch (error) {
    canceled = error.name === 'AbortError';
  } finally {
    window.fetch = originalFetch;
  }
  assert(
    canceled && !engine.hasPlugin('planet') && runtime.meshes.size === 0,
    'Browser cancellation left an attached loading planet',
  );
  let rejected = false;
  try {
    await Planet.create(engine, { dayMap: source([20, 150, 20, 255]), nightMap: 'data:image/png;base64,AA==' });
  } catch {
    rejected = true;
  }
  assert(
    rejected && !engine.hasPlugin('planet') && runtime.meshes.size === 0,
    'Image decode failure left partial planet state',
  );
  const planet = await Planet.create(engine, {
    dayMap: source([20, 150, 20, 255]),
    clouds: source((x) => (x < 32 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
    tilt: 0,
  });
  engine.render();
  await runtime.gpu.queue.onSubmittedWorkDone();
  const methods = [
    'createBuffer',
    'createTexture',
    'createBindGroup',
    'createSampler',
    'createShaderModule',
    'createRenderPipeline',
    'createPipelineLayout',
    'createBindGroupLayout',
  ];
  const originals = methods.map((name) => runtime.gpu[name]),
    begin = GPUCommandEncoder.prototype.beginRenderPass,
    draw = GPURenderPassEncoder.prototype.drawIndexed;
  const descriptors = [];
  let allocations = 0,
    draws = 0;
  for (let i = 0; i < methods.length; i++)
    runtime.gpu[methods[i]] = function (...args) {
      allocations++;
      return originals[i].apply(this, args);
    };
  GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
    descriptors.push(descriptor);
    return begin.call(this, descriptor);
  };
  GPURenderPassEncoder.prototype.drawIndexed = function (...args) {
    draws++;
    return draw.apply(this, args);
  };
  try {
    for (let i = 0; i < 8; i++) {
      planet.rotation.y += 0.01;
      planet.clouds.offsetU += 0.01;
      engine.render({ delta: 1 / 60 });
      await runtime.gpu.queue.onSubmittedWorkDone();
    }
  } finally {
    for (let i = 0; i < methods.length; i++) runtime.gpu[methods[i]] = originals[i];
    GPUCommandEncoder.prototype.beginRenderPass = begin;
    GPURenderPassEncoder.prototype.drawIndexed = draw;
  }
  assert(allocations === 0 && draws === 16, `Planet steady frames: ${allocations} resource creations, ${draws} draws`);
  const planetDescriptors = descriptors.filter(
    (value) => value === planet.pass.surfaceDescriptor || value === planet.pass.shellDescriptor,
  );
  assert(planetDescriptors.length === 16, 'Planet replaced steady-frame descriptors');

  const blocker = engine
    .createMesh()
    .setGeometry(box(1, 1, 0.1))
    .setMaterial(new PbrMaterial({ color: '#ffffff' }))
    .setPosition([0, 0, 2]);
  const effects = new PostProcessing({ grain: 0.01 });
  engine.use(effects);
  engine.render();
  await runtime.gpu.queue.onSubmittedWorkDone();
  assert(effects.target?.color.format === 'rgba16float', 'Planet did not compose into the HDR scene');
  const engineValidation = await runtime.gpu.popErrorScope();
  assert(
    !engineValidation && gpuErrors.length === 0,
    `Engine/HDR validation failed: ${engineValidation?.message ?? gpuErrors.join('; ')}`,
  );
  const prior = runtime.gpu,
    rotation = planet.rotation;
  await engine.rebootDevice();
  engine.render();
  await runtime.gpu.queue.onSubmittedWorkDone();
  assert(
    runtime.gpu !== prior && planet.rotation === rotation && engine.hasPlugin('planet'),
    'Real device restoration failed',
  );
  planet.dispose();
  assert(!engine.hasPlugin('planet'), 'Public Planet disposal left registered passes');
  blocker.dispose();
  engine.dispose();
  return {
    hardware: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      description: adapter.info.description,
      fallback: adapter.info.isFallbackAdapter,
    },
    blueRimPixels: blueRim,
    cloudDriftPixels: driftPixels,
    elevatedCloudPixels: elevatedPixels,
    steadyFrameGPUResourceCreations: allocations,
    steadyFramePlanetDraws: draws / 8,
    checks: [
      'WGSL compilation',
      'day/night and zero daytime lights',
      'ocean mask',
      'normal relief',
      'cloud drift and geometric elevation',
      'blue rim',
      'reversed-Z occlusion and shell depth preservation',
      'linear HDR output',
      'browser fetch cancellation and decode rollback',
      'core/HDR plugin composition',
      'stable uniforms/descriptors/resources',
      'real device reboot',
      'public removal',
    ],
  };
};

import { Engine, PbrMaterial, box, engineRuntime } from '@margoengine/core/extension';
import { PBRReflector, reflectorFresnel } from '../dist/reflector-pbr.js';
import { Environment, EnvironmentBackground, loadEnvironmentImage, floatToHalf } from '../dist/index.js';
import { assert, readTexture, directionAt } from './gpu-read.js';

window.runTests = async () => {
  const engine = await Engine.create(document.querySelector('canvas'), {
    backend: 'webgpu',
    camera: { position: [0, 0, 3], target: [0, 0, 0], fov: 120, near: 0.1, far: 100 },
  });
  engine.lighting.direction.set([0, 1, 0, 0]);
  engine.lighting.radiance.set([1, 1, 1, 1]);
  engine.lighting.ambient.set([1, 1, 1]);
  const errors = [];
  engine.onError = (e) => errors.push(String(e));
  const wall = engine
    .createMesh()
    .setGeometry(box(100, 100, 0.01))
    .setMaterial(new PbrMaterial({ color: [1, 1, 1] }))
    .setPosition([0, 0, 5]);
  const floor = PBRReflector.attach(engine, { width: 20, height: 20, baseColor: [0, 0, 0], autoUpdate: false });
  let device = engineRuntime(engine).gpu;
  const watch = () => {
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    device.pushErrorScope('validation');
  };
  watch();
  const prepare = () => {
    engine.render();
    assert(floor.update(), 'capture updated');
  };
  const draw = async (stripes = false) => {
    const target = device.createTexture({
      size: [96, 96],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depth = device.createTexture({
      size: [96, 96],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const encoder = device.createCommandEncoder();
    if (stripes) {
      const t = floor.texture,
        pixels = new Uint16Array(t.width * t.height * 4);
      for (let y = 0; y < t.height; y++)
        for (let x = 0; x < t.width; x++) {
          const i = (y * t.width + x) * 4,
            v = floatToHalf((x >> 1) & 1);
          pixels.set([v, v, v, 0x3c00], i);
        }
      device.queue.writeTexture({ texture: t }, pixels, { bytesPerRow: t.width * 8, rowsPerImage: t.height }, [
        t.width,
        t.height,
      ]);
      floor.mips({ device, encoder });
    }
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      })
      .end();
    const passes = [];
    floor.registerPasses({
      add(p) {
        passes.push(p);
      },
    });
    passes[0].execute({
      backend: 'webgpu',
      device,
      encoder,
      color: target.createView(),
      depth: depth.createView(),
      width: 96,
      height: 96,
      format: 'rgba16float',
      camera: engine.camera,
      delta: 0,
      descriptor: { depthStencil: { format: 'depth32float' }, multisample: { count: 1 } },
    });
    device.queue.submit([encoder.finish()]);
    const out = await readTexture(device, target);
    target.destroy();
    depth.destroy();
    return out;
  };
  prepare();
  const fresnel = await draw();
  const initialError = await device.popErrorScope();
  assert(!initialError && !errors.length, `${initialError?.message} ${errors}`);
  device.pushErrorScope('validation');
  let worst = 0;
  for (const x of [4, 16, 32, 48, 64, 80, 91]) {
    const nv = -directionAt(engine.camera, x, 48, 96, 96)[2],
      want = reflectorFresnel(nv);
    const got = fresnel.at(0, x, 48)[0];
    worst = Math.max(worst, Math.abs(got - want));
    assert(Math.abs(got - want) < 0.0005, `Fresnel ${x}: ${got} vs ${want}`);
  }
  assert(fresnel.at(0, 4, 48)[0] > fresnel.at(0, 48, 48)[0] * 1.5, 'grazing reflection rises');
  floor.baseColor = [1, 1, 1];
  floor.metalness = 1;
  floor.roughness = 1;
  floor.blurDistance = 2;
  const contrast = (pixels) => {
    const row = [];
    for (let x = 12; x < 84; x++) row.push(pixels.at(0, x, 48)[0]);
    return Math.max(...row) - Math.min(...row);
  };
  wall.setPosition([0, 0, 0.05]);
  prepare();
  const contact = contrast(await draw(true));
  wall.setPosition([0, 0, 5]);
  prepare();
  const distant = contrast(await draw(true));
  assert(contact > 0.5 && distant < 0.01, `contact stays sharp while distant geometry blurs: ${contact}, ${distant}`);
  // Live material changes keep pipelines/bindings steady once warmed.
  const shaderCount = device.createShaderModule;
  let modules = 0;
  device.createShaderModule = function (...args) {
    modules++;
    return shaderCount.apply(this, args);
  };
  floor.ior = 2;
  floor.blurDistance = 3;
  await draw();
  device.createShaderModule = shaderCount;
  assert(modules === 0, 'live uniforms compile no shaders');
  await device.queue.onSubmittedWorkDone();
  const error = await device.popErrorScope();
  assert(!error, error?.message);
  await engine.rebootDevice();
  device = engineRuntime(engine).gpu;
  watch();
  wall.setPosition([0, 0, 5]);
  floor.roughness = 0;
  floor.metalness = 0;
  floor.baseColor = [0, 0, 0];
  floor.ior = 1.5;
  prepare();
  const restored = await draw();
  assert(
    fresnel.data.every((v, i) => v === restored.data[i]),
    'exact floor pixels after device replacement',
  );
  // Real openly licensed radiance photograph also travels through the capture and glossy floor.
  wall.visible = false;
  const env = await Environment.attach(engine, await loadEnvironmentImage('./fixtures/venice_sunset_1k.hdr'), {
    size: 16,
    specularSize: 16,
    specularMips: 3,
    samples: 32,
    brdfSize: 16,
    brdfSamples: 32,
  });
  EnvironmentBackground.attach(engine, env);
  floor.roughness = 0.3;
  prepare();
  const photographed = await draw();
  assert(
    photographed.data.every(Number.isFinite) && photographed.data.some((v, i) => i % 4 !== 3 && v > 0.001),
    'real HDR floor is finite and lit',
  );
  await device.queue.onSubmittedWorkDone();
  const finalError = await device.popErrorScope();
  assert(!finalError && !errors.length, `${finalError?.message} ${errors}`);
  floor.dispose();
  engine.dispose();
  return {
    checks: [
      'HDR pixels match Schlick over view angles',
      'captured oblique depth keeps contacts sharp and blurs distant reflections',
      'live uniforms compile no shaders',
      'exact pixels after device replacement',
      'CC0 Venice Sunset capture',
    ],
    fresnelWorst: worst,
    contactContrast: contact,
    distantContrast: distant,
  };
};

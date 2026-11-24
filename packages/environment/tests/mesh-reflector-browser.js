// Real-GPU checks for MeshReflector (@margoengine/environment/reflector-pbr): the reflection blends over the mesh's own
// lit surface by the Fresnel weight (exact on an HDR target), passes the depth test on the coplanar mesh it covers
// (also a subdivided one at a grazing angle),
// leaves the mesh untouched at mixStrength 0, blurs, fades with depth and moves with reflectorOffset.
import { Engine, Geometry, PbrMaterial, box, engineRuntime } from '@margoengine/core/extension';
import { MeshReflector, reflectorFresnel } from '../dist/reflector-pbr.js';
import { Reflector } from '../dist/reflector.js';
import { floatToHalf } from '../dist/index.js';
import { assert, readTexture, directionAt } from './gpu-read.js';

// Draws the reflector's pass alone into a 96 x 96 rgba16float target cleared to `under` (the mesh's colour).
async function drawPass(engine, device, floor, under) {
  const target = device.createTexture({
    size: [96, 96],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({ size: [96, 96], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const encoder = device.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [under, under, under, 1], storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
    })
    .end();
  const passes = [];
  floor.registerPasses({ add: (p) => passes.push(p) });
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
}

async function numbers(report) {
  const engine = await Engine.create(document.querySelector('#numbers'), {
    backend: 'webgpu',
    camera: { position: [0, 0, 3], target: [0, 0, 0], fov: 120, near: 0.1, far: 100 },
  });
  const device = engineRuntime(engine).gpu,
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const floor = MeshReflector.attach(engine, { width: 20, height: 20, autoUpdate: false });
  engine.render();
  assert(floor.update(), 'capture updated');
  // A constant capture of 1: each pixel is 0.5 (1 - w) + w with w = mixStrength x Schlick(n.v), clamped to 1.
  const fill = () => {
    const t = floor.texture,
      one = floatToHalf(1),
      pixels = new Uint16Array(t.width * t.height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([one, one, one, floatToHalf(1)], i);
    device.queue.writeTexture({ texture: t }, pixels, { bytesPerRow: t.width * 8, rowsPerImage: t.height }, [t.width, t.height]);
  };
  let worst = 0;
  for (const [strength, mirror] of [
    [1, 0],
    [4, 0],
    [1, 0.5],
    [0, 1],
  ]) {
    floor.mixStrength = strength;
    floor.mirror = mirror;
    fill();
    const image = await drawPass(engine, device, floor, 0.5);
    for (const x of [4, 16, 32, 48, 64, 80, 91]) {
      const nv = -directionAt(engine.camera, x, 48, 96, 96)[2],
        f = reflectorFresnel(nv),
        w = Math.min(1, strength * (f + (1 - f) * mirror)),
        want = 0.5 * (1 - w) + w,
        got = image.at(0, x, 48)[0];
      worst = Math.max(worst, Math.abs(got - want));
      assert(Math.abs(got - want) < 0.001, `strength ${strength} mirror ${mirror} x ${x}: ${got} vs ${want}`);
    }
  }
  report.fresnelWorst = worst;
  report.checks.push('blend over the surface: 0.5 (1 - w) + w with w = strength x Schlick, mirror and strength 0 exact');
  // Contrast about 0.5 on a constant capture of 0.75: (0.75 - 0.5) x 2 + 0.5 = 1, seen at mirror 1.
  floor.mixStrength = 1;
  floor.mirror = 1;
  floor.mixContrast = 2;
  const t = floor.texture,
    v = floatToHalf(0.75),
    pixels = new Uint16Array(t.width * t.height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([v, v, v, floatToHalf(1)], i);
  device.queue.writeTexture({ texture: t }, pixels, { bytesPerRow: t.width * 8, rowsPerImage: t.height }, [t.width, t.height]);
  const contrast = (await drawPass(engine, device, floor, 0)).at(0, 48, 48)[0];
  assert(Math.abs(contrast - 1) < 0.001, `contrast 2 maps 0.75 to 1: ${contrast}`);
  report.checks.push('mixContrast about 0.5');
  assert(!errors.length, errors.join('; '));
  floor.dispose();
  engine.dispose();
}

// Reads the canvas in the same task as the render (a WebGPU canvas keeps its frame for drawImage until the task ends).
// With a manual render loop the reflector captures through update() first.
let surface = null;
function frame(engine, canvas) {
  surface?.update();
  engine.render();
  const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
  copy.drawImage(canvas, 0, 0);
  const data = copy.getImageData(0, 0, canvas.width, canvas.height).data;
  return { data, at: (x, y) => [...data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)] };
}
const red = (p) => p[0] > 2 * p[1] + 30 && p[0] > 2 * p[2] + 30;
// Rows of the red run in column x, from the top.
function redRun(image, x, height) {
  let first = -1,
    last = -1;
  for (let y = 0; y < height; y++)
    if (red(image.at(x, y))) {
      if (first < 0) first = y;
      last = y;
    }
  return [first, last];
}

async function scene(report) {
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 1.2, 3.2], target: [0, 0.2, 0], fov: 60, near: 0.1, far: 100 },
  });
  const device = engineRuntime(engine).gpu,
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  engine.lighting.direction.set([0.3, 1, 0.4, 0]);
  engine.lighting.radiance.set([2, 2, 2, 1]);
  engine.lighting.ambient.set([0.3, 0.3, 0.3]);
  // The floor: a 10 x 10 quad in its local XY plane facing +Z, turned to face +Y; a red unit box stands on it.
  const quad = new Geometry([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]);
  const floor = engine
    .createMesh()
    .setGeometry(quad)
    .setMaterial(new PbrMaterial({ color: [0.3, 0.3, 0.3], roughness: 0.8 }))
    .setRotation([-Math.PI / 2, 0, 0]);
  const cube = engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({ color: [0.9, 0.05, 0.05], roughness: 0.5 }))
    .setPosition([0, 0.5, 0]);
  const plain = frame(engine, canvas);
  const [top, bottom] = redRun(plain, 64, 128);
  assert(top > 0 && bottom > top, `box seen in column 64: ${top}..${bottom}`);
  const reflector = MeshReflector.attach(engine, { parent: floor, width: 10, height: 10, exclude: [floor], mirror: 1 });
  surface = reflector;
  const mirrored = frame(engine, canvas);
  const [, reflectionEnd] = redRun(mirrored, 64, 128);
  assert(reflectionEnd > bottom + 8, `the box's reflection continues below it: ${bottom} to ${reflectionEnd}`);
  report.checks.push('mirror 1 shows the box reflected below it');
  // Coplanar with the floor it covers: at mirror 1 no floor pixel shows through (no depth fighting) below the horizon.
  const floorColour = plain.at(10, 120);
  let through = 0;
  for (let y = reflectionEnd + 4; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const p = mirrored.at(x, y),
        q = plain.at(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 2 && !red(q)) through++;
    }
  report.floorThrough = through;
  assert(floorColour[0] > 10 && through === 0, `floor pixels left unreflected under mirror 1: ${through}`);
  report.checks.push('drawn over the coplanar mesh without depth fighting');
  reflector.mixStrength = 0;
  const none = frame(engine, canvas);
  let changed = 0;
  for (let i = 0; i < none.data.length; i++) if (none.data[i] !== plain.data[i]) changed++;
  assert(changed === 0, `mixStrength 0 leaves the mesh's pixels as they were: ${changed} differ`);
  report.checks.push('mixStrength 0 leaves the frame unchanged');
  // Blur: across the reflection's side edge (row in the reflection), the steepest step between neighbours shrinks.
  reflector.mixStrength = 1;
  const row = Math.round((bottom + reflectionEnd) / 2);
  const step = (image) => {
    let most = 0;
    for (let x = 1; x < 128; x++) most = Math.max(most, Math.abs(image.at(x, row)[0] - image.at(x - 1, row)[0]));
    return most;
  };
  const sharpStep = step(frame(engine, canvas));
  reflector.blurSize = [24, 24];
  const blurredStep = step(frame(engine, canvas));
  report.sharpStep = sharpStep;
  report.blurredStep = blurredStep;
  assert(sharpStep > 60 && blurredStep < sharpStep / 2, `blur softens the reflection's edge: ${sharpStep} to ${blurredStep}`);
  reflector.mixBlur = 0;
  assert(step(frame(engine, canvas)) === sharpStep, 'mixBlur 0 keeps the sharp image');
  reflector.mixBlur = 1;
  reflector.blurSize = [0, 0];
  report.checks.push('blur softens, mixBlur 0 keeps it sharp');
  // Depth: fade between 0.2 and 0.6 world units from the plane: the contact stays red, the box's top half fades.
  reflector.depthScale = 1;
  reflector.minDepthThreshold = 0.2;
  reflector.maxDepthThreshold = 0.6;
  const faded = frame(engine, canvas);
  const [, fadedEnd] = redRun(faded, 64, 128);
  report.fadedEnd = fadedEnd;
  assert(red(faded.at(64, bottom + 2)), 'the contact keeps its reflection');
  assert(fadedEnd < reflectionEnd - 4, `the far part of the reflection fades: ${fadedEnd} vs ${reflectionEnd}`);
  reflector.depthScale = 0;
  report.checks.push('depthScale fades the reflection away from the contact');
  // reflectorOffset lowers the mirror plane: the virtual camera drops with it, its rays through the floor climb more
  // steeply and reach the box's top from floor points nearer the box, so the reflection ends higher on the screen.
  reflector.reflectorOffset = -0.3;
  const lowered = frame(engine, canvas);
  const [, loweredEnd] = redRun(lowered, 64, 128);
  report.loweredEnd = loweredEnd;
  assert(loweredEnd < reflectionEnd - 3, `the reflection shortens: ${reflectionEnd} to ${loweredEnd}`);
  reflector.reflectorOffset = 0;
  assert(redRun(frame(engine, canvas), 64, 128)[1] === reflectionEnd, 'offset 0 restores the reflection');
  report.checks.push('reflectorOffset moves the mirror plane');
  assert(!errors.length, errors.join('; '));
  reflector.dispose();
  engine.dispose();
}

// A floor built from many triangles (a subdivided PlaneGeometry), seen at a grazing angle out to a far depth: its
// rasterised depth is interpolated over other triangles than the reflection's one quad, so the two coplanar depths
// differ by rounding. With mirror 1 every floor pixel must show the reflection, none the floor beneath it.
async function grazing(report) {
  const canvas = document.querySelector('#grazing');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0.4, 0], target: [0, 0, -40], fov: 60, near: 0.05, far: 2000 },
  });
  const device = engineRuntime(engine).gpu,
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  engine.scene.background = '#2050e0';
  engine.lighting.ambient.set([1, 1, 1]);
  const n = 48,
    half = 400,
    positions = [],
    normals = [],
    indices = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      positions.push(-half + (2 * half * i) / n, -half + (2 * half * j) / n, 0);
      normals.push(0, 0, 1);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  const floor = engine
    .createMesh()
    .setGeometry(new Geometry(positions, normals, indices))
    .setMaterial(new PbrMaterial({ color: [0.9, 0.9, 0.1], roughness: 1 }))
    .setRotation([-Math.PI / 2, 0, 0]);
  const plain = frame(engine, canvas);
  const reflector = MeshReflector.attach(engine, { parent: floor, width: 2 * half, height: 2 * half, exclude: [floor], mirror: 1 });
  surface = reflector;
  const mirrored = frame(engine, canvas);
  let floorPixels = 0,
    through = 0;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++) {
      const q = plain.at(x, y);
      if (!(q[0] > 2 * q[2] + 40)) continue; // a yellow floor pixel in the plain frame
      floorPixels++;
      const p = mirrored.at(x, y);
      if (p[0] > 2 * p[2] + 40) through++;
    }
  report.grazingFloorPixels = floorPixels;
  report.grazingThrough = through;
  assert(floorPixels > canvas.width * 20, `the floor covers the lower view: ${floorPixels} pixels`);
  assert(through === 0, `subdivided floor pixels left unreflected at a grazing angle: ${through} of ${floorPixels}`);
  report.checks.push('drawn over a subdivided coplanar mesh at a grazing angle without depth fighting');
  assert(!errors.length, errors.join('; '));
  reflector.dispose();
  engine.dispose();
}

// The distortion normal map is a borrowed GPU object (docs/conventions.md, "Borrowed GPU objects"): after a device
// restore a plain texture of the old device is dropped and reported once while frames keep drawing without a
// validation error; a `(device) => GPUTexture` is made again on the new device and nothing is reported.
async function borrowedNormal(report) {
  const engine = await Engine.create(document.querySelector('#borrowed'), {
    backend: 'webgpu',
    camera: { position: [0, 2, 4], target: [0, 0, 0] },
  });
  const runtime = engineRuntime(engine),
    reported = [];
  engine.onError = (error) => reported.push(error);
  const flat = (device) => {
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, new Uint8Array([128, 128, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    return texture;
  };
  const reflector = new Reflector({ width: 2, height: 2, normalMap: flat(runtime.gpu) });
  engine.use(reflector);
  const frames = async (label) => {
    const device = runtime.gpu;
    device.pushErrorScope('validation');
    // fixed-wait: the three frames under the error scope are the work; readiness is onSubmittedWorkDone below
    for (let i = 0; i < 3; i++) {
      reflector.update();
      engine.render();
    }
    await device.queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope();
    assert(!validation, `${label}: ${validation?.message}`);
  };
  await frames('plain texture, first device');
  await engine.rebootDevice();
  await frames('plain texture after a restore');
  assert(reported.length === 1 && reported[0].code === 'state', `reported once: ${reported.map((e) => e.message)}`);
  report.checks.push('a plain normal map is dropped and reported once after a device restore; frames keep drawing');
  const made = [];
  reflector.normalMap = (device) => (made.push(device), flat(device));
  await frames('function, before a restore');
  await engine.rebootDevice();
  await frames('function after a restore');
  assert(made.length === 2 && made[1] === runtime.gpu, `made once per device: ${made.length}`);
  assert(reported.length === 1, `nothing more reported: ${reported.length}`);
  report.checks.push('a normal-map function is made again on the restored device');
  reflector.dispose();
  engine.dispose();
}

window.runTests = async () => {
  const report = { checks: [] };
  await numbers(report);
  await scene(report);
  await grazing(report);
  await borrowedNormal(report);
  return report;
};

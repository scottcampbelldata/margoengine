// Real-GPU checks for Lightformer (@margoengine/environment/lightformer): on an HDR target each form writes exactly
// color x intensity where it covers and nothing elsewhere (circle corners and the ring's hole left open), a hidden or
// zero-intensity form draws nothing, and a CubeCamera capture of a Lightformer becomes an Environment lit from its side.
import { Engine, engineRuntime } from '@margoengine/core/extension';
import { Lightformer } from '../dist/lightformer.js';
import { CubeCamera } from '../dist/cube-camera.js';
import { Environment } from '../dist/index.js';
import { assert, readTexture } from './gpu-read.js';

const SIZE = 64;
// Draws the Lightformer's pass alone into a SIZE x SIZE rgba16float target cleared to 0.
async function drawPass(engine, device, former) {
  const target = device.createTexture({
    size: [SIZE, SIZE],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({
    size: [SIZE, SIZE],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const encoder = device.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    })
    .end();
  const passes = [];
  former.registerPasses({ add: (p) => passes.push(p) });
  engineRuntime(engine).store.tick(false);
  engine.camera.update(1, true);
  passes[0].execute({
    backend: 'webgpu',
    device,
    encoder,
    color: target.createView(),
    depth: depth.createView(),
    width: SIZE,
    height: SIZE,
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

async function forms(report) {
  // An orthographic-like view: the camera 10 units back with a narrow field, the form 1 unit across in the middle.
  const engine = await Engine.create(document.querySelector('#forms'), {
    backend: 'webgpu',
    camera: { position: [0, 0, 10], target: [0, 0, 0], fov: 8, near: 0.1, far: 100 },
  });
  const device = engineRuntime(engine).gpu,
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const former = Lightformer.attach(engine, { form: 'rect', color: [1, 0.5, 0.25], intensity: 3 });
  // Half the view height at the form: 10 x tan(4 degrees) = 0.699, so the 1 x 1 card spans 0.5 / 0.699 of each half.
  const half = SIZE / 2,
    edge = (0.5 / (10 * Math.tan((4 * Math.PI) / 180))) * half;
  report.cardHalfWidthPx = edge;
  const at = (image, x, y) => image.at(0, Math.round(half + x), Math.round(half - y));
  let image = await drawPass(engine, device, former);
  assert(
    JSON.stringify(at(image, 0, 0).slice(0, 3)) === JSON.stringify([3, 1.5, 0.75]),
    `rect centre ${at(image, 0, 0)}`,
  );
  assert(at(image, edge - 2, edge - 2)[0] === 3, 'rect corner covered');
  assert(at(image, edge + 2, 0)[0] === 0, 'outside the card nothing');
  report.checks.push('rect: exactly color x intensity, linear on an HDR target');
  former.form = 'circle';
  image = await drawPass(engine, device, former);
  assert(at(image, 0, 0)[0] === 3 && at(image, edge - 2, edge - 2)[0] === 0, 'circle: centre lit, corner open');
  former.form = 'ring';
  image = await drawPass(engine, device, former);
  assert(at(image, 0, 0)[0] === 0, 'ring: hole open');
  assert(at(image, edge * 0.75, 0)[0] === 3, 'ring: band lit');
  former.form = 'box';
  former.node.setRotation([0.6, 0.7, 0]);
  image = await drawPass(engine, device, former);
  assert(at(image, 0, 0)[0] === 3, 'box: lit through its turned faces');
  former.node.setRotation([0, 0, 0]);
  report.checks.push('circle, ring and box cover what they should');
  former.form = 'rect';
  former.node.visible = false;
  image = await drawPass(engine, device, former);
  assert(at(image, 0, 0)[0] === 0, 'hidden draws nothing');
  former.node.visible = true;
  former.intensity = 0;
  image = await drawPass(engine, device, former);
  assert(at(image, 0, 0)[0] === 0, 'intensity 0 draws nothing');
  report.checks.push('hidden or intensity 0 draws nothing');
  assert(!errors.length, errors.join('; '));
  former.dispose();
  engine.dispose();
}

async function capture(report) {
  const engine = await Engine.create(document.querySelector('#capture'), {
    backend: 'webgpu',
    camera: { position: [0, 0, 4], target: [0, 0, 0] },
  });
  const device = engineRuntime(engine).gpu,
    errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  // A 4 x 4 softbox 3 units along +X, facing the origin.
  const former = Lightformer.attach(engine, { intensity: 5 });
  former.node
    .setPosition([3, 0, 0])
    .setRotation([0, -Math.PI / 2, 0])
    .setScale([4, 4, 1]);
  const cube = new CubeCamera({ size: 64, near: 0.1, far: 100 });
  engine.use(cube);
  engine.render();
  assert(cube.update(6), 'captured');
  const environment = await Environment.create(engine, cube, { name: 'captured' });
  const lit = environment.irradianceAt([1, 0, 0]),
    away = environment.irradianceAt([-1, 0, 0]);
  report.irradiance = { toward: lit, away };
  assert(lit[0] > 0.5 && lit[0] > 20 * Math.max(away[0], 1e-4), `lit from the softbox's side: ${lit} vs ${away}`);
  report.checks.push('a captured Lightformer lights the environment from its side');
  // Brighter softbox, refresh in place.
  former.intensity = 10;
  assert(cube.update(6), 'captured again');
  await environment.refresh();
  const brighter = environment.irradianceAt([1, 0, 0]);
  assert(Math.abs(brighter[0] / lit[0] - 2) < 0.02, `refresh follows the intensity: ${brighter[0]} vs 2 x ${lit[0]}`);
  report.checks.push('refresh follows the Lightformer');
  assert(!errors.length, errors.join('; '));
  environment.dispose();
  cube.dispose();
  former.dispose();
  engine.dispose();
}

window.runTests = async () => {
  const report = { checks: [] };
  await forms(report);
  await capture(report);
  return report;
};

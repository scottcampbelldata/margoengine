// Real-GPU check for KB5663a (`@margoengine/environment/volumetric`): the fog's two integration routes store the same
// integrated volume. The column kernel (native WebGPU) and the per-froxel kernel (the WebGL2 layer, where the column
// kernel ran as JavaScript) each run on this page's device over the same scattering volume, by presenting the device
// to a fresh fog under the other adapter vendor. On a layer device it also counts the layer's compute dispatches per
// tier: the fog's own route runs none on the CPU. Run: npm run test:fog-route:browser (add --compat for the layer).
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VolumetricFog } from '../dist/volumetric.js';
import { COMPAT_VENDOR } from '../../shared/compat.js';
import { assert, hardware, readTexture } from './gpu-read.js';

const grid = [16, 12, 32];

window.runTests = async () => {
  const report = { checks: [] };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 1, 6], target: [0, 1, 0], fov: 60, near: 0.1, far: 100 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    layer = device.adapterInfo?.vendor === COMPAT_VENDOR,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  runtime.lighting.direction.set([0.3, 0.8, 0.5, 1]);
  runtime.lighting.radiance.set([2, 1.8, 1.6, 0.2]);
  const depth = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // Height falloff and noise vary the scattering in every direction; temporal 0 makes each frame depend on itself only.
  const options = {
    density: 0.08,
    heightFalloff: 0.3,
    noise: 0.8,
    noiseScale: 2,
    color: [1, 0.8, 0.6],
    ambient: [0.4, 0.45, 0.5],
    anisotropy: 0.4,
    multipleScattering: 3,
    temporal: 0,
    grid,
    range: 40,
    depth: () => depth,
  };
  const integrated = async (vendor) => {
    if (vendor !== undefined) Object.defineProperty(device, 'adapterInfo', { value: { vendor }, configurable: true });
    try {
      const fog = VolumetricFog.attach(engine, options),
        before = layer ? { ...device.dispatches } : undefined;
      engine.render();
      await device.queue.onSubmittedWorkDone();
      const after = layer ? { ...device.dispatches } : undefined,
        read = await readTexture(device, fog.texture);
      fog.dispose();
      const tiers = before && Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
      return { data: read.data, tiers };
    } finally {
      if (vendor !== undefined) delete device.adapterInfo;
    }
  };
  const own = await integrated(),
    other = await integrated(layer ? 'native-route' : COMPAT_VENDOR);
  // Distance in rgba16float steps: a step is 2^(e - 10) for a value in [2^e, 2^(e + 1)), 2^-24 below 2^-14.
  const step = (x) => 2 ** Math.max(Math.floor(Math.log2(Math.max(x, 2 ** -14))) - 10, -24);
  let differ = 0,
    worst = 0,
    steps = 0,
    peak = 0;
  for (let i = 0; i < own.data.length; i++) {
    const a = own.data[i],
      b = other.data[i];
    peak = Math.max(peak, Math.abs(a));
    if (a === b) continue;
    differ++;
    worst = Math.max(worst, Math.abs(a - b));
    steps = Math.max(steps, Math.abs(a - b) / step(Math.min(Math.abs(a), Math.abs(b))));
  }
  report.backend = layer ? 'webgl2-compat' : 'webgpu';
  report.texels = own.data.length / 4;
  report.differ = differ;
  report.worst = worst;
  report.steps = steps;
  report.peak = peak;
  assert(peak > 0.05, `the fog integrates light (peak ${peak})`);
  if (layer) {
    report.tiers = { route: own.tiers, column: other.tiers };
    assert(own.tiers.cpu === 0 && own.tiers.fragment > 0, `the layer route ran ${JSON.stringify(own.tiers)}`);
    assert(other.tiers.cpu === 1, `the column kernel ran ${JSON.stringify(other.tiers)} on the layer`);
    report.checks.push(
      `layer: the fog's compute ran ${JSON.stringify(own.tiers)} dispatches (column kernel: ${JSON.stringify(other.tiers)})`,
    );
    // The column kernel runs on the layer's CPU tier, whose filtering and exp round apart from the GPU's: values agree
    // to one rgba16float step. That the two kernels compute the same arithmetic is the native leg's value-for-value check.
    assert(
      steps <= 1,
      `the layer routes differ in ${differ} of ${own.data.length} values, by up to ${steps} half-float steps`,
    );
    report.checks.push(
      `layer: GPU route and CPU-tier column kernel agree within one half-float step (${differ} of ${own.data.length} values differ, by up to ${worst})`,
    );
  } else {
    assert(differ === 0, `the routes differ in ${differ} of ${own.data.length} values, by up to ${worst}`);
    report.checks.push(`both integration routes store the same ${grid.join(' x ')} volume, value for value`);
  }
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware(runtime.adapter ?? (await navigator.gpu.requestAdapter()));
  depth.destroy();
  engine.dispose();
  return report;
};

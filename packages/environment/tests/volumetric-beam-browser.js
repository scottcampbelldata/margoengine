// Real-GPU check (`@margoengine/environment/volumetric`): clustered lights in the froxel fog. Each froxel column's
// integrated light is compared with the fog the light really scatters over the column's footprint (8 x 8 rays of 4,000
// steps, volumetric-beam-reference.js), for (a) a narrow spot beam crossing the view obliquely, the lighthouse case, and
// (b) a bulb inside the volume. Until 2026-11-15 the beam was compared along each column's centre ray, as the froxels
// sampled it then; they now take the light over their footprint (volumetric-beam-continuity-browser.js). Before the
// 2026-11-13 fix the froxel pass lit each slice from one point: the beam broke into one block per slice, and the froxel
// holding the bulb took 1/d^2 at one point, up to 4096 times what its cell scatters. Run: npm run test:fog-beam:browser.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Clustered } from '@margoengine/clustered';
import { VolumetricFog } from '../dist/volumetric.js';
import { assert, hardware, readTexture } from './gpu-read.js';
import { reference } from './volumetric-beam-reference.js';

const grid = [24, 24, 48],
  range = 20,
  density = 0.05,
  camera = { position: [0, 1, 6], fov: 60, near: 0.1 };

// A point on froxel column (i, j)'s centre ray at slice depth k (slices spaced quadratically over the range beyond the
// near plane): k + 0.5 is where one sample per slice sat, k + 0.625 one of the four stratified samples.
function sample(i, j, k) {
  const t = Math.tan((camera.fov * Math.PI) / 360),
    x = ((i + 0.5) / grid[0]) * 2 - 1,
    y = 1 - ((j + 0.5) / grid[1]) * 2,
    along = camera.near + range * (k / grid[2]) ** 2;
  return [camera.position[0] + x * t * along, camera.position[1] + y * t * along, camera.position[2] - along];
}
window.runTests = async () => {
  const report = { checks: [], cases: {} };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: camera.position, target: [0, 1, 0], fov: camera.fov, near: camera.near, far: 100 },
  });
  engine.stop();
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  runtime.lighting.radiance.set([0, 0, 0, 0]);
  const depth = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const lights = Clustered.attach(engine);
  const fog = VolumetricFog.attach(engine, {
    density,
    ambient: [0, 0, 0],
    anisotropy: 0,
    temporal: 0,
    grid,
    range,
    lights,
    depth: () => depth,
  });
  const cases = {
    // A narrow beam from outside the view, crossing it obliquely toward the camera.
    beam: {
      position: [-6, 1.3, -9],
      direction: [0.62, -0.02, 0.78],
      outerAngle: 0.052,
      innerAngle: 0.03,
      range: 40,
      intensity: 400,
    },
    // A bulb in the fog 1 cm beside one of the four stratified sample points of froxel (12, 11, 30), whose cell is about
    // 0.4 m wide and 0.5 m deep: 1/d^2 there is about 100 times its mean over the cell.
    bulb: { position: sample(12, 11, 30.625).map((v, i) => v + (i === 0 ? 0.01 : 0)), range: 10, intensity: 4 },
  };
  for (const [name, light] of Object.entries(cases)) {
    lights.setLights([{ color: [1, 1, 1], ...light }]);
    engine.render();
    await device.queue.onSubmittedWorkDone();
    const read = await readTexture(device, fog.texture),
      want = reference({ grid, range, density, camera }, light, 8);
    let error = 0,
      total = 0,
      peak = 0,
      wantPeak = 0;
    for (let j = 0; j < grid[1]; j++)
      for (let i = 0; i < grid[0]; i++) {
        const got = read.at(grid[2] - 1, i, j)[0],
          ref = want[j * grid[0] + i];
        error += Math.abs(got - ref);
        total += ref;
        peak = Math.max(peak, got);
        wantPeak = Math.max(wantPeak, ref);
      }
    report.cases[name] = { error: error / total, peak, wantPeak, total };
  }
  const { beam } = report.cases;
  assert(beam.total > 0.05, `the beam scatters light (${beam.total})`);
  assert(
    beam.error < 0.05,
    `the beam's columns match the fog it lights within L1 ${beam.error.toFixed(3)} (limit 0.05)`,
  );
  report.checks.push(`a narrow spot beam crossing the view: per-column L1 error ${beam.error.toFixed(3)}`);
  for (const name of ['bulb']) {
    const bulb = report.cases[name];
    assert(
      bulb.error < 0.1,
      `${name}: the columns match the fog it lights within L1 ${bulb.error.toFixed(3)} (limit 0.1)`,
    );
    assert(
      bulb.peak < 2 * bulb.wantPeak,
      `${name}: the brightest column ${bulb.peak} stays within twice ${bulb.wantPeak}`,
    );
    report.checks.push(
      `a bulb on a froxel sample (${name}): per-column L1 error ${bulb.error.toFixed(3)}, brightest column ${bulb.peak.toFixed(3)} against ${bulb.wantPeak.toFixed(3)}`,
    );
  }
  // KB-FOG-HOOK-BINDINGS1: a Clustered hook the fog does not read (here a bounce hook, as LightBounce sets, whose
  // storage buffer only the lit shader reads). The fog's froxel pass takes the lights' declarations and bind group
  // entries with every hook's, and its `auto` layout dropped the bindings it never used, so the bind group failed
  // validation ("binding index 164 not present in the bind group layout") and the fog stopped. The beam's fog must be
  // the same with the hook as without it, and no GPU error.
  const hookBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
  lights.setLights([{ color: [1, 1, 1], ...cases.beam }]);
  engine.render();
  await device.queue.onSubmittedWorkDone();
  const without = await readTexture(device, fog.texture);
  lights.bounce = {
    declarations: (group) =>
      `@group(${group}) @binding(164) var<storage,read> clusterBounce:array<vec4f>;
fn clusterBounceLighting(position:vec3f,n:vec3f,base:vec3f,metal:f32)->vec3f {return vec3f(0.0)*clusterBounce[0].x;}
`,
    bindings: () => [{ binding: 164, resource: { buffer: hookBuffer } }],
  };
  engine.render();
  await device.queue.onSubmittedWorkDone();
  const withHook = await readTexture(device, fog.texture);
  let hookDiff = 0;
  for (let j = 0; j < grid[1]; j++)
    for (let i = 0; i < grid[0]; i++) hookDiff = Math.max(hookDiff, Math.abs(withHook.at(grid[2] - 1, i, j)[0] - without.at(grid[2] - 1, i, j)[0]));
  assert(errors.length === 0, `a Clustered hook the fog does not read: GPU errors ${errors.join('; ')}`);
  assert(hookDiff < 1e-6, `the beam's fog is the same with a hook the fog does not read (max difference ${hookDiff})`);
  report.checks.push(`a Clustered hook the fog does not read: no GPU error, the fog unchanged (max difference ${hookDiff})`);
  lights.bounce = undefined;
  hookBuffer.destroy();
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware(runtime.adapter ?? (await navigator.gpu.requestAdapter()));
  fog.dispose();
  lights.dispose();
  depth.destroy();
  engine.dispose();
  return report;
};

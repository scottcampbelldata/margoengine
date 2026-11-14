// Real-GPU check (`@margoengine/environment/volumetric`): clustered lights in the froxel fog. Each froxel column's
// integrated light is compared with the fog the light really scatters along the column (4,000 steps), for (a) a narrow
// spot beam crossing the view obliquely, the lighthouse case, along each column's centre ray, as the froxels sample it,
// and (b) a bulb inside the volume, averaged over each column's footprint (8 x 8 rays). Before the fix the froxel pass lit each slice from one point: the beam broke
// into one block per slice, and the froxel holding the bulb took 1/d^2 at one point, up to 4096 times what its cell
// scatters. Run: npm run test:fog-beam:browser.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Clustered } from '@margoengine/clustered';
import { VolumetricFog } from '../dist/volumetric.js';
import { assert, hardware, readTexture } from './gpu-read.js';

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
// The light one froxel sample takes from `light` at p: clustered's legacy terms (packages/shared/light-terms.js),
// with the isotropic phase 1 / 4 pi (anisotropy 0), dimmed by the fog it crosses on its way from the light to p
// (2026-11-13: the froxel pass left that out, so a beam lit thick fog as brightly far out as at the lens).
function lightAt(light, p) {
  const dx = light.position[0] - p[0],
    dy = light.position[1] - p[1],
    dz = light.position[2] - p[2],
    d = Math.hypot(dx, dy, dz);
  if (d >= light.range) return 0;
  const reach = d / light.range,
    fade = Math.min(Math.max(1 - reach ** 4, 0), 1);
  let cone = 1;
  if (light.direction) {
    const along = -(dx * light.direction[0] + dy * light.direction[1] + dz * light.direction[2]) / d,
      lo = Math.cos(light.outerAngle),
      hi = Math.cos(light.innerAngle),
      ramp = Math.min(Math.max((along - lo) / Math.max(hi - lo, 1e-6), 0), 1);
    cone = ramp * ramp * (3 - 2 * ramp);
  }
  return (
    (light.intensity * ((fade * fade) / Math.max(d * d, 2 ** -12)) * cone * Math.exp(-density * d)) / (4 * Math.PI)
  );
}
// The light reaching the camera along the ray through ndc (x, y), out to `range` metres beyond the near plane.
function column(light, direction, x, y) {
  const t = Math.tan((camera.fov * Math.PI) / 360),
    dir = [x * t, y * t, -1],
    stretch = Math.hypot(...dir),
    steps = 4000,
    dt = range / steps;
  let sum = 0;
  for (let k = 0; k < steps; k++) {
    const s = (k + 0.5) * dt,
      along = camera.near + s,
      p = [
        camera.position[0] + dir[0] * along,
        camera.position[1] + dir[1] * along,
        camera.position[2] + dir[2] * along,
      ];
    sum += density * lightAt({ ...light, direction }, p) * Math.exp(-density * stretch * s) * stretch * dt;
  }
  return sum;
}
// Each column's average over sub x sub rays of its footprint (one ray: its centre), then the 3 x 3 tent the integration applies across columns (clamped at the edges).
function reference(light, sub) {
  const [w, h] = grid,
    raw = new Float64Array(w * h),
    direction = light.direction && light.direction.map((v) => v / Math.hypot(...light.direction));
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let b = 0; b < sub; b++)
        for (let a = 0; a < sub; a++) {
          const u = (i + (a + 0.5) / sub) / w,
            v = (j + (b + 0.5) / sub) / h;
          sum += column(light, direction, u * 2 - 1, 1 - v * 2);
        }
      raw[j * w + i] = sum / (sub * sub);
    }
  const at = (i, j) => raw[Math.min(Math.max(j, 0), h - 1) * w + Math.min(Math.max(i, 0), w - 1)],
    out = new Float64Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++) sum += (2 - Math.abs(a)) * (2 - Math.abs(b)) * at(i + a, j + b);
      out[j * w + i] = sum / 16;
    }
  return out;
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
      want = reference(light, name === 'beam' ? 1 : 8);
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
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware(runtime.adapter ?? (await navigator.gpu.requestAdapter()));
  fog.dispose();
  lights.dispose();
  depth.destroy();
  engine.dispose();
  return report;
};

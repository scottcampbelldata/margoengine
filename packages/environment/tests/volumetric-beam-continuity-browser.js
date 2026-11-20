// Real-GPU check (`@margoengine/environment/volumetric`): a spot beam much narrower than a froxel stays one continuous
// shaft. The Storm Light short (2026-11-15) showed its lighthouse beam as a row of separate blocks: the froxel pass took
// each light at points on each froxel's centre ray (four per slice), so a beam narrower than their spacing in depth, or
// than a froxel across, lit only the froxels whose points fell inside it. Here a 0.7 degree cone crosses a portrait
// view whose froxels are 3 times taller than wide, about 0.2 m across against froxels 0.4 m wide, 1.3 m tall and 0.14 m
// between depth points. Each froxel column's light, summed down the column (the beam's light along the screen), is
// compared with the fog the beam really scatters over each froxel's footprint (2 x 64 rays, fine down the column): before
// the fix the columns held 0 to 0.51 of it (four points per slice on each centre ray). The ripple left (each column 0.76 to 1.18
// of its light on one frame; temporal jitter averages it) is in docs/limits.md. Run: npm run
// test:fog-beam-continuity:browser (WebGPU, then the WebGL2 layer).
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Clustered } from '@margoengine/clustered';
import { VolumetricFog } from '../dist/volumetric.js';
import { assert, hardware, readTexture } from './gpu-read.js';
import { reference } from './volumetric-beam-reference.js';

const scene = {
  grid: [16, 9, 48],
  range: 20,
  density: 0.05,
  aspect: 54 / 96,
  camera: { position: [0, 1, 6], fov: 60, near: 0.1 },
};
// From outside the view on the left, rising across it about 9 m from the camera.
const beam = {
  position: [-6, -1.5, -3],
  direction: [1, 0.35, -0.1],
  outerAngle: 0.012,
  innerAngle: 0.005,
  range: 40,
  intensity: 4000,
};

window.runTests = async () => {
  const report = { checks: [] };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: scene.camera.position, target: [0, 1, 0], fov: scene.camera.fov, near: scene.camera.near, far: 100 },
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
    density: scene.density,
    ambient: [0, 0, 0],
    anisotropy: 0,
    temporal: 0,
    grid: scene.grid,
    range: scene.range,
    lights,
    depth: () => depth,
  });
  lights.setLights([{ color: [1, 1, 1], ...beam }]);
  engine.render();
  await device.queue.onSubmittedWorkDone();
  const read = await readTexture(device, fog.texture),
    want = reference(scene, beam, [2, 64]),
    [w, h, d] = scene.grid,
    got = [],
    ref = [];
  for (let i = 0; i < w; i++) {
    let a = 0,
      b = 0;
    for (let j = 0; j < h; j++) {
      a += read.at(d - 1, i, j)[0];
      b += want[j * w + i];
    }
    got.push(a);
    ref.push(b);
  }
  const top = Math.max(...ref),
    lit = ref.map((r, i) => i).filter((i) => ref[i] >= 0.2 * top),
    ratios = lit.map((i) => got[i] / ref[i]),
    error = lit.reduce((s, i) => s + Math.abs(got[i] - ref[i]), 0) / lit.reduce((s, i) => s + ref[i], 0);
  report.columns = { got, ref, lit, ratios, error };
  assert(lit.length >= 10, `the beam crosses at least 10 columns (${lit.length})`);
  const low = Math.min(...ratios),
    high = Math.max(...ratios);
  assert(
    low > 0.7 && high < 1.3,
    `every column the beam crosses holds 0.7 to 1.3 of its light (${low.toFixed(3)} to ${high.toFixed(3)})`,
  );
  assert(error < 0.2, `the beam's light along the screen matches within L1 ${error.toFixed(3)} (limit 0.2)`);
  report.checks.push(
    `a beam 0.2 m across in froxels 0.4 m wide and 1.3 m tall: ${lit.length} columns, each ${low.toFixed(3)} to ${high.toFixed(3)} of its light, L1 ${error.toFixed(3)}`,
  );
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware(runtime.adapter ?? (await navigator.gpu.requestAdapter()));
  fog.dispose();
  lights.dispose();
  depth.destroy();
  engine.dispose();
  return report;
};

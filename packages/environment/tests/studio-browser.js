// Real-GPU checks for @margoengine/environment/studio: an Environment made from the procedural studio image keeps it
// (source cube texels toward each softbox and the floor equal the image there), its GPU SH equals the CPU projection of
// the image, the key light makes the front left over 1.5x the fill side in the irradiance, and it lights a real engine.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import {
  Environment,
  EnvironmentLighting,
  evaluateSH,
  projectEquirectSH,
  radianceToIrradianceSH,
} from '../dist/index.js';
import { studio, STUDIO_LIGHTS } from '../dist/studio.js';
import { assert, cubeTexel, faceDirection, hardware, openDevice, readTexture } from './gpu-read.js';

const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
// The image's texel nearest direction d (the equirect convention of tests/gpu-read.js: centre -Z, row 0 +Y).
function texelAt(image, d) {
  const phi = Math.atan2(d[0], -d[2]),
    theta = Math.acos(Math.max(-1, Math.min(1, d[1]))),
    x = Math.min(image.width - 1, Math.floor((phi / (2 * Math.PI) + 0.5) * image.width)),
    y = Math.min(image.height - 1, Math.floor((theta / Math.PI) * image.height)),
    o = (y * image.width + x) * 4;
  return [...image.data.subarray(o, o + 3)];
}

window.runTests = async () => {
  const report = { checks: [] };
  const { adapter, device, finish } = await openDevice();
  const image = studio({ width: 512 });
  const environment = await Environment.create(device, image, {
    size: 128,
    samples: 64,
    brdfSize: 16,
    brdfSamples: 64,
    shSize: 64,
  });

  // 1. The source cube keeps the studio: at the centre of each softbox and straight down (the floor) the cube texel
  //    equals the image there (a softbox centre and the floor are flat over a texel; float16 and the resampling).
  const cube = await readTexture(device, environment.cubeTexture);
  let worst = 0;
  for (const d of [
    ...STUDIO_LIGHTS.map((l) => unit(l.direction)),
    [0, -1, 0],
    [0, 0.2, -1].map((x, _, a) => x / Math.hypot(...a)),
  ]) {
    const [face, x, y] = cubeTexel(d, cube.width),
      centre = faceDirection(face, ((x + 0.5) / cube.width) * 2 - 1, ((y + 0.5) / cube.width) * 2 - 1),
      got = cube.at(face, x, y),
      want = texelAt(image, centre);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k] - want[k]) / Math.max(want[k], 0.1));
  }
  assert(worst < 0.03, `the cube differs from the studio image by ${worst}`);
  report.cubeError = worst;
  report.checks.push('the source cube equals the studio image toward every softbox, the floor and a wall');

  // 2. The GPU SH equals the CPU projection of the image.
  const cpu = projectEquirectSH(image),
    gpu = environment.sh.radiance;
  let shError = 0;
  for (let i = 0; i < 27; i++) shError = Math.max(shError, Math.abs(gpu[i] - cpu[i]) / cpu[i % 3]);
  assert(shError < 0.02, `GPU SH differs from the CPU projection by ${shError} of the DC term`);
  report.shError = shError;
  report.checks.push('the GPU SH equals the CPU projection of the studio image');

  // 3. Product lighting: irradiance toward the key light (front left) is over 1.5x the fill side's and above the back's
  //    (the overhead softbox keeps straight up the brightest); the floor side is the darkest.
  const irradiance = radianceToIrradianceSH(gpu),
    at = (n) => evaluateSH(irradiance, unit(n))[0];
  const sides = {
    key: at([-1, 0.6, 1]),
    fill: at([1.2, 0.3, 0.8]),
    back: at([0, 0, -1]),
    up: at([0, 1, 0]),
    down: at([0, -1, 0]),
  };
  report.irradiance = sides;
  assert(
    sides.key > sides.fill * 1.5 &&
      sides.key > sides.back &&
      sides.down < Math.min(sides.key, sides.fill, sides.back, sides.up),
    `studio lighting sides: ${JSON.stringify(sides)}`,
  );
  report.checks.push('the key side is over 1.5x the fill side and above the back; the floor side is the darkest');
  environment.dispose();
  await finish();

  // 4. It lights a real engine: a white box under EnvironmentLighting from the studio, no GPU error.
  const engine = await Engine.create(document.querySelector('#scene'), {
    backend: 'webgpu',
    camera: { position: [0, 0, 3], target: [0, 0, 0] },
  });
  const live = engineRuntime(engine).gpu,
    errors = [];
  live.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const lit = await Environment.attach(engine, studio({ width: 256 }), { size: 64, samples: 64 });
  EnvironmentLighting.attach(engine, lit);
  engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({ color: [1, 1, 1], roughness: 0.5, metalness: 0 }));
  engine.render();
  await live.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.checks.push('a studio Environment lights a real engine with no GPU error');
  report.hardware = hardware(adapter);
  engine.dispose();
  return report;
};

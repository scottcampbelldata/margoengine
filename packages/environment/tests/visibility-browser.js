// Real-GPU checks for the irradiance volume's `visibility` option (@margoengine/environment/probes): a thin wall between
// two probe columns, sunlit on one side, a dark room on the other. Without visibility the dark room's floor by the wall
// takes light from the sunlit probes through the wall; with it, that leak is gone and the sunlit side keeps its light.
// Checked on the CPU mirror (irradianceAt, read back from the GPU) and on the shaded pixels.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { LightProbes } from '../dist/probes.js';
import { assert, hardware } from './gpu-read.js';

window.runTests = async () => {
  const report = { checks: [] };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [2.5, 1.5, 0], target: [0.3, 0, 0], fov: 50 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  // A level sun from -x (xyz toward it, w intensity) and no ambient term: of all the room's surfaces only the wall's
  // -x face is lit directly, and every other light is the probes'.
  runtime.lighting.direction.set([-1, 0, 0, 1]);
  runtime.lighting.radiance.set([4, 4, 4, 0]);
  const white = new PbrMaterial({ roughness: 1, metalness: 0, color: [0.8, 0.8, 0.8] });
  const add = (size, position) =>
    engine
      .createMesh()
      .setGeometry(box(...size))
      .setPosition(position)
      .setMaterial(white);
  add([8, 0.1, 4], [0, -0.05, 0]); // floor
  add([0.05, 3, 4], [0, 1.5, 0]); // the thin wall at x = 0
  add([4, 0.1, 4], [2, 3.05, 0]); // the dark room's roof and side walls (open at x = 4)
  add([4, 3, 0.1], [2, 1.5, 2.05]);
  add([4, 3, 0.1], [2, 1.5, -2.05]);
  const volume = { min: [-4, 0, -2], max: [4, 3, 2], counts: [4, 2, 2], resolution: 16 };
  const frames = (n) => {
    for (let i = 0; i < n; i++) engine.render({ culling: false });
  };
  // Read in the same task as the render: a WebGPU canvas keeps its frame for drawImage only until the task ends.
  const pixel = () => {
    frames(1);
    const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
    copy.drawImage(canvas, 0, 0);
    return [...copy.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
  };
  const bake = async (visibility) => {
    const probes = LightProbes.attach(engine, { volume: { ...volume, visibility }, reflections: [] });
    const done = probes.bake();
    frames(80);
    await done;
    const dark = probes.irradianceAt([0.3, 0.02, 0], [0, 1, 0]),
      lit = probes.irradianceAt([-0.3, 0.02, 0], [0, 1, 0]),
      shaded = pixel();
    return { probes, dark, lit, shaded };
  };
  const off = await bake(false);
  off.probes.dispose();
  const on = await bake(true);

  // 1. The leak: without visibility the dark floor by the wall takes the sunlit probes' light.
  report.off = { dark: off.dark, lit: off.lit, pixel: off.shaded };
  report.on = { dark: on.dark, lit: on.lit, pixel: on.shaded };
  assert(off.dark[0] > 0.1 * off.lit[0], `no leak to remove without visibility: ${off.dark} vs ${off.lit}`);
  assert(on.dark[0] < 0.25 * off.dark[0], `visibility left the leak: ${on.dark[0]} against ${off.dark[0]} without`);
  assert(on.lit[0] > 0.9 * off.lit[0], `visibility darkened the sunlit side: ${on.lit[0]} against ${off.lit[0]}`);
  report.checks.push(
    'CPU mirror: the leak through the thin wall falls below a quarter; the sunlit side keeps its light',
  );

  // 2. The shaded pixel of the dark floor by the wall (the camera in the dark room) follows the mirror.
  assert(off.shaded[0] > 20, `the leak does not show on screen: ${off.shaded}`);
  assert(on.shaded[0] < 0.5 * off.shaded[0], `visibility left the leak on screen: ${on.shaded} against ${off.shaded}`);
  report.checks.push('shaded: the dark floor by the wall loses the leaked light on screen');

  // 3. The stored distances: the probe 1 m from the wall's lit face sees it at about 1 m along +x.
  await on.probes.readback();
  const floats = new Float32Array(on.probes.texels.buffer, on.probes.texels.byteOffset, on.probes.texels.length),
    offset = (on.probes.byteLength - 1088) / 8 - 16 * 24, // the bins follow every SH texel (16 probes x 24 bins)
    probe = 1, // corner (1, 0, 0): x = -1, y = 0.75, z = -1
    plusX = (probe * 24 + 0 * 4) * 2; // face +x, the quadrant y < 0, z < 0
  const mean = floats[(offset * 2 + plusX) | 0];
  report.meanDistancePlusX = mean;
  assert(mean > 0.9 && mean < 1.8, `the probe 1 m from the wall stores ${mean} m along +x`);
  report.checks.push('the probe 1 m from the wall stores about 1 m toward it');

  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware({ info: device.adapterInfo });
  on.probes.dispose();
  engine.dispose();
  return report;
};

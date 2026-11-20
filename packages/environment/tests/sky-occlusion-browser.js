// Real-GPU check that the sky's light stays out of a closed-in space (KB-SCENES-SKYOCC1): a 4 m x 4 m shed, 2.5 m
// high, lit only through its door (1 m x 2 m) and two windows (1 m x 0.8 m), on open sand under Sky's overcast preset
// (no direct sun: nearly all light is sky light). The floor's linear luminance is read through the camera inside the
// shed and on the open sand. The sky alone lights both the same (it has no visibility term). LightProbes with `sky`
// light the inside through what the probes see of the sky (doors and windows) and leave the open sand exactly as the sky
// alone lights it. Closing the openings darkens the inside further: its light came through them.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Sky } from '@margoengine/sky';
import { dayPreset } from '@margoengine/sky/day-presets';
import { LightProbes } from '../dist/probes.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';
import { assert } from './gpu-read.js';

const linear = (b) => ((b /= 255) <= 0.04045 ? b / 12.92 : ((b + 0.055) / 1.055) ** 2.4);
const volume = { min: [-2, 0, -2], max: [2, 2.5, 2], counts: [4, 3, 4], visibility: true };
function shed(engine) {
  const wood = new PbrMaterial({ color: '#8a6a48', roughness: 0.9, doubleSided: false }),
    sand = new PbrMaterial({ color: '#b8a888', roughness: 1, doubleSided: false });
  const add = (size, at, material = wood) =>
    engine.createMesh().setGeometry(box(...size)).setMaterial(material).setPosition(at);
  add([80, 0.2, 80], [0, -0.1, 0], sand);
  add([4.2, 2.5, 0.1], [0, 1.25, -2.05]);
  add([1.5, 2.5, 0.1], [-1.35, 1.25, 2.05]);
  add([1.5, 2.5, 0.1], [1.35, 1.25, 2.05]);
  add([1, 0.5, 0.1], [0, 2.25, 2.05]);
  for (const x of [-2.05, 2.05]) {
    add([0.1, 1.2, 4.2], [x, 0.6, 0]);
    add([0.1, 0.5, 4.2], [x, 2.25, 0]);
    add([0.1, 0.8, 1.6], [x, 1.6, -1.3]);
    add([0.1, 0.8, 1.6], [x, 1.6, 1.3]);
  }
  add([4.4, 0.1, 4.4], [0, 2.55, 0]);
  // The door and the window shutters, shown only for the last check.
  return [add([1, 2, 0.1], [0, 1, 2.05]), add([0.1, 0.8, 1], [-2.05, 1.6, 0]), add([0.1, 0.8, 1], [2.05, 1.6, 0])];
}
// Mean linear luminance of the floor seen from 2.2 m up, looking down near `at`, each frame read in its render task.
// The sky's light reaches the scene from the frame after it is drawn, so frames are drawn until no pipeline is compiling
// (scripts/support/gpu-ready.js) and the reading holds still: the last frames agree to the bit.
async function floor(engine, canvas, at) {
  engine.camera.position = [at[0], 2.2, at[2]];
  engine.camera.target = [at[0] + 0.001, 0, at[2] - 0.6];
  let reading = Number.NaN,
    steady = false;
  await waitForPipelines(
    async () => {
      engine.render();
      const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
      copy.drawImage(canvas, 0, 0);
      const data = copy.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0,
        n = 0;
      for (let y = 24; y < 40; y++)
        for (let x = 24; x < 40; x++) {
          const i = (y * canvas.width + x) * 4;
          sum += 0.2126 * linear(data[i]) + 0.7152 * linear(data[i + 1]) + 0.0722 * linear(data[i + 2]);
          n++;
        }
      steady = sum / n === reading;
      reading = sum / n;
      await engine.gpu.queue.onSubmittedWorkDone();
    },
    { ready: () => steady, describe: () => `floor reading ${reading} still changing` },
  );
  return reading;
}

window.runTests = async () => {
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { fov: 40, near: 0.05, far: 300 } });
  const closers = shed(engine);
  for (const mesh of closers) mesh.visible = false;
  const sky = Sky.attach(engine, dayPreset('overcast'));
  const checks = [];
  const measure = async (name) => {
    const inside = await floor(engine, canvas, [0, 0, 0.5]),
      outside = await floor(engine, canvas, [12, 0, 0]),
      result = { name, inside, outside, ratio: inside / outside };
    checks.push(result);
    return result;
  };
  const open = await measure('sky alone');
  assert(open.outside > 0.02, `the open sand is lit by the sky: ${open.outside}`);

  const probes = LightProbes.attach(engine, { sky, volume });
  await probes.bake({ bounces: 2 });
  const lit = await measure('light probes with the sky');
  // A floor 2 m under a roof that sees the sky only through a door and two windows gets a few per cent of the open
  // ground's sky light (the daylight factor of such a room under the overcast sky of Moon and Spencer 1942).
  assert(lit.ratio < 0.25, `the shed floor is darker than the open sand: ${lit.inside} against ${lit.outside}`);
  assert(lit.inside > 0.01 * lit.outside, `light comes in through the door and windows: ${lit.inside}`);
  assert(
    Math.abs(lit.outside - open.outside) <= 0.01 * open.outside,
    `outside the probes the sky lights the sand as it does alone: ${lit.outside} against ${open.outside}`,
  );

  for (const mesh of closers) mesh.visible = true;
  await probes.bake({ bounces: 2 });
  const closed = await measure('door and windows closed');
  assert(
    closed.inside < 0.5 * lit.inside,
    `closing the openings darkens the inside: ${closed.inside} against ${lit.inside}`,
  );
  probes.dispose();
  for (const mesh of closers) mesh.visible = false;
  const after = await measure('sky alone after dispose');
  assert(
    Math.abs(after.outside - open.outside) <= 0.01 * open.outside && Math.abs(after.inside - open.inside) <= 0.01 * open.inside,
    `disposing the probes gives the sky its light back: ${after.inside}, ${after.outside}`,
  );
  engine.dispose();
  return { checks };
};

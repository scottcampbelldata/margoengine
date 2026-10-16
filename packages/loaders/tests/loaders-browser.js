import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { createMeshes, load, parse3MF, LoaderError } from '@margoengine/loaders';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function snapshot(engine) {
  engine.render();
  // Read the WebGPU canvas in the same task as the render, before it is presented.
  const canvas = document.createElement('canvas');
  canvas.width = engine.canvas.width;
  canvas.height = engine.canvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(engine.canvas, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

window.runLoaderTests = async () => {
  const checks = [];
  const canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, { backend: 'webgpu' });
  const device = engineRuntime(engine).gpu,
    errors = [];
  assert(device, 'WebGPU device unavailable');
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');

  const empty = snapshot(engine);
  const result = await load('/tests/fixtures/facecolors.3mf', parse3MF, { maxBytes: 1 << 20 });
  assert(result.groups.length === 5, `expected 5 color groups, got ${result.groups.length}`);
  checks.push('load() + parse3MF in the browser (DecompressionStream deflate-raw)');

  const loaded = createMeshes(engine, result);
  assert(loaded.meshes.length === 5 && loaded.materials.length === 5, 'one mesh and one material per face color');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < result.positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], result.positions[i + a]);
      max[a] = Math.max(max[a], result.positions[i + a]);
    }
  const center = min.map((v, a) => (v + max[a]) / 2),
    radius = Math.hypot(...max.map((v, a) => v - min[a])) / 2;
  engine.camera.near = radius / 50;
  engine.camera.far = radius * 50;
  engine.camera.target = center;
  engine.camera.position = [center[0] + radius * 1.6, center[1] + radius * 1.3, center[2] + radius * 2.0];
  const pixels = snapshot(engine);

  // Classify every pixel by the face color it is closest to in direction (lighting scales brightness only).
  const references = result.groups.map((g) => [g.color.slice(0, 3), g.color.slice(0, 3).map(toLinear)]);
  const counts = new Array(result.groups.length).fill(0);
  let changed = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      Math.abs(pixels[i] - empty[i]) + Math.abs(pixels[i + 1] - empty[i + 1]) + Math.abs(pixels[i + 2] - empty[i + 2]) >
      30
    )
      changed++;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]],
      length = Math.hypot(...rgb);
    if (length < 60) continue;
    let best = -1,
      bestScore = 0.985;
    references.forEach((pair, g) => {
      for (const ref of pair) {
        const score = (rgb[0] * ref[0] + rgb[1] * ref[1] + rgb[2] * ref[2]) / (length * Math.hypot(...ref));
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
    });
    if (best >= 0) counts[best]++;
  }
  const visible = counts.filter((n) => n > 40).length;
  assert(changed > 2000, `model covers too few pixels (${changed})`);
  assert(visible >= 3, `expected at least 3 face colors on screen, counts ${counts}`);
  checks.push(`Rendered ${changed} model pixels with ${visible} distinct face colors visible`);

  const picked = await engine.pick(canvas.clientWidth / 2, canvas.clientHeight / 2);
  assert(picked && loaded.meshes.includes(picked), 'GPU pick at the center did not return a created mesh');
  checks.push(`GPU pick returned mesh "${picked.name}"`);

  let rejected = false;
  try {
    await load('/tests/fixtures/facecolors.3mf', parse3MF, { maxBytes: 100 });
  } catch (error) {
    rejected = error instanceof LoaderError && error.code === 'limit';
  }
  assert(rejected, 'load() did not enforce maxBytes');
  checks.push('load() rejects responses over maxBytes');

  loaded.dispose();
  assert(engineRuntime(engine).meshes.size === 0, 'dispose left meshes behind');
  const cleared = snapshot(engine);
  let leftover = 0;
  for (let i = 0; i < cleared.length; i += 4)
    if (
      Math.abs(cleared[i] - empty[i]) +
        Math.abs(cleared[i + 1] - empty[i + 1]) +
        Math.abs(cleared[i + 2] - empty[i + 2]) >
      30
    )
      leftover++;
  assert(leftover === 0, `${leftover} pixels remain after dispose`);
  checks.push('dispose() removes every mesh');

  const scope = await device.popErrorScope();
  await device.queue.onSubmittedWorkDone();
  assert(!scope && errors.length === 0, `WebGPU validation errors: ${scope?.message ?? errors.join('; ')}`);
  checks.push('Zero WebGPU validation errors');
  engine.dispose();
  return { checks, counts, adapter: device.adapterInfo?.description || device.adapterInfo?.vendor || 'unknown' };
};

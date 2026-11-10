import { SDFScene2D } from '/packages/lighting2d/dist/sdf.js';
import { GILighting2D, RadianceCascade2D } from '/packages/lighting2d/dist/gi.js';
import { LayerCompositor } from '/packages/pixel/dist/index.js';
import { readHDR } from './emission-regressions.js';

async function readField(device, source) {
  const row = Math.ceil(source.width * 16 / 256) * 256;
  const copy = device.createBuffer({ size: row * source.height, usage: 1 | 8 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: source }, { buffer: copy, bytesPerRow: row }, [source.width, source.height]);
  device.queue.submit([encoder.finish()]);
  await copy.mapAsync(1);
  const data = new Float32Array(copy.getMappedRange()), result = [];
  for (let y = 0; y < source.height; y++)
    result.push(...data.slice(y * row / 4, y * row / 4 + source.width * 4));
  copy.destroy();
  return result;
}

// Independent brute-force oracle, used only on tiny test fixtures, never in the feature.
function exactDistance(bytes, width, height, threshold) {
  const solid = (i) => bytes[i * 4 + 3] > 0 && bytes[i * 4 + 3] / 255 >= threshold;
  return Array.from({ length: width * height }, (_, i) => {
    let best = 1e20;
    for (let j = 0; j < width * height; j++) if (solid(i) !== solid(j))
      best = Math.min(best, (i % width - j % width) ** 2 + (Math.floor(i / width) - Math.floor(j / width)) ** 2);
    return [Math.sqrt(best) * (solid(i) ? -1 : 1), solid(i) ? 1 : 0];
  });
}

export async function sdfRegressions({ instance, engine, texture, frame, checks, errors }) {
  engine.gpu.pushErrorScope('validation');
  for (const [w, h, density] of [[1, 1, 0], [1, 1, 1], [13, 9, .25], [2, 17, .5], [15, 3, .8], [7, 11, 0], [7, 11, 1]]) {
    const bytes = new Uint8Array(w * h * 4);
    let seed = 247;
    for (let i = 0; i < w * h; i++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      bytes.set([128, 64, 255, seed / 2 ** 32 < density ? 255 : 0], i * 4);
    }
    const source = texture('rgba8unorm', w, h);
    engine.gpu.queue.writeTexture({ texture: source }, bytes, { bytesPerRow: w * 4 }, [w, h]);
    const scene = new SDFScene2D({ source });
    const encoder = engine.gpu.createCommandEncoder();
    scene.encode(engine.gpu, encoder);
    engine.gpu.queue.submit([encoder.finish()]);
    const values = await readField(engine.gpu, scene.distanceTexture);
    const expected = exactDistance(bytes, w, h, .5);
    checks[`SDF exact EDT ${w}x${h} density ${density}`] = {
      wrong: expected.filter((p, i) => Math.abs(p[0] - values[i * 4]) > Math.max(1e-5, Math.abs(p[0]) * 1e-6) || p[1] !== values[i * 4 + 1]).length,
    };
    scene.dispose();
    source.destroy();
  }
  // Real layer getters, not CPU-created polygon substitutes, feed the GPU before GI in the same frame.
  const compositor = LayerCompositor.attach(instance, { camera: { width: 13, height: 9, zoom: 1 } });
  const picture = compositor.addLayer();
  const bytes = new Uint8Array(13 * 9 * 4);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 13; x++) {
    if (x === 7 || (x >= 10 && y > 1 && y < 7)) bytes.set([x === 7 ? 0 : 255, 0, 0, 255], (y * 13 + x) * 4);
  }
  picture.write({ width: 13, height: 9, data: bytes });
  const camera = { x: -2.25, y: 1.75, zoom: 2 };
  const scene = new SDFScene2D({ source: picture.target, camera, emissionIntensity: 2 });
  let target = texture('rgba16float', 6, 5);
  const options = { cascades: 2, baseDistance: 12, bounces: 0, baseRays: 8, angularRatio: 2 };
  const pass = GILighting2D.attach(instance, { target: () => target, painted: scene, camera, cascades: options });
  const compare = async (name) => {
    frame();
    const values = await readHDR(engine.gpu, target);
    let wrong = 0;
    const emitters = [];
    for (let y = 0; y < 9; y++) for (let x = 0; x < 13; x++) if (bytes[(y * 13 + x) * 4 + 3]) emitters.push({
      x: camera.x + (x + .5) / camera.zoom, y: camera.y + (y + .5) / camera.zoom,
      width: 1 / camera.zoom, height: 1 / camera.zoom, color: [bytes[(y * 13 + x) * 4] / 255 * scene.emissionIntensity, 0, 0],
    });
    const rc = new RadianceCascade2D(options);
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      const expected = rc.evaluateAt([pass.camera.x + (x + .5) / pass.camera.zoom, pass.camera.y + (y + .5) / pass.camera.zoom], undefined, { emitters });
      if (expected.some((v, c) => Math.abs(v - values[(y * target.width + x) * 4 + c]) > .001)) wrong++;
    }
    checks[name] = { wrong, values: [...values.slice(0, 4)] };
    return values;
  };
  const dark = await compare('SDF painted wall isolates source across cascade connectors');
  checks['SDF black wall has exact zero leakage'] = { wrong: dark.some((v, i) => i % 4 < 3 && v !== 0) ? 1 : 0 };
  for (let y = 0; y < 9; y++) bytes.fill(0, (y * 13 + 7) * 4, (y * 13 + 7) * 4 + 4);
  picture.write({ width: 13, height: 9, data: bytes });
  const open = await compare('SDF painting updates source and distance field in the current frame');
  checks['SDF removing wall reveals offscreen red source'] = { wrong: open.some((v, i) => i % 4 === 0 && v > 0) ? 0 : 1 };
  scene.emissionIntensity = 4;
  await compare('SDF HDR emission multiplier');
  pass.camera = { x: 2.25, y: 3.25, zoom: 2 };
  await compare('SDF inside emitter and independent camera');
  // Source resizing and replacement rebuild scratch, and restoring the device recreates every owned resource.
  scene.source = texture('rgba8unorm', 1, 1);
  engine.gpu.queue.writeTexture({ texture: scene.source }, new Uint8Array([0, 255, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
  pass.camera = { x: camera.x, y: camera.y, zoom: 2 };
  frame();
  checks['SDF resize replaces field and emits new color'] = { wrong: scene.distanceTexture.width === 1 && (await readHDR(engine.gpu, target))[1] === 4 ? 0 : 1 };
  const validation = await engine.gpu.popErrorScope();
  if (validation) errors.push(validation.message);
  const oldDevice = engine.gpu;
  oldDevice.destroy(); await oldDevice.lost; await engine.rebootDevice();
  engine.gpu.addEventListener('uncapturederror', e => errors.push(e.error.message));
  target.destroy(); target = texture('rgba16float', 1, 1);
  scene.source = texture('rgba8unorm', 1, 1);
  engine.gpu.queue.writeTexture({ texture: scene.source }, new Uint8Array([0, 255, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
  engine.gpu.pushErrorScope('validation');
  frame();
  checks['SDF device replacement rebuilds distance and lighting'] = { wrong: (await readHDR(engine.gpu, target))[1] === 4 ? 0 : 1 };
  pass.dispose(); scene.dispose(); scene.source.destroy(); target.destroy(); compositor.dispose();
  const restored = await engine.gpu.popErrorScope(); if (restored) errors.push(restored.message);
}

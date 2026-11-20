// What a sky sends the GPU, as one SHA-256 per configuration: every shader module and compute pipeline code it
// compiles and every buffer write it makes (offset and bytes, in order) over a run of frames through dusk. Two builds
// with the same fingerprint send the GPU the same programs and the same data, so they draw the same frames.
// `node packages/sky/test/defaults-fingerprint.js --write` records the current build's figures in
// test/fixtures/defaults-fingerprint.json; defaults-unchanged.test.js checks the build against them.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Sky } from '../dist/index.js';
import { dayPreset, dayPresetNames } from '../dist/day-presets.js';
import { SkyMoon } from '../dist/night-preset.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

// The harness's frame is 128 x 96, single-sampled; TEXTURE_BINDING is 4 there.
const depth = {
  format: 'depth32float',
  dimension: '2d',
  depthOrArrayLayers: 1,
  width: 128,
  height: 96,
  usage: 4,
  sampleCount: 1,
  createView: () => ({}),
};
/** Each configuration a scene can have today without any of the 2026-11-16 slider options. */
export const configurations = {
  default: () => ({}),
  noonHeld: () => ({ hours: 12, timeScale: 0 }),
  turbid: () => ({ turbidity: 6, exposure: 1 }),
  bruneton: () => ({ model: 'bruneton' }),
  brunetonAlbedo: () => ({ model: 'bruneton', groundAlbedo: [0.3, 0.25, 0.2], turbidity: 3 }),
  clouds: () => ({ clouds: { coverage: 0.6, speed: 12, height: 2000 } }),
  fog: () => ({ fog: { depth: () => depth, density: 0.02, start: 10, height: 0.5, falloff: 'exp' } }),
  fogColour: () => ({ fog: { depth: () => depth, color: [0.5, 0.6, 0.7] } }),
  lighting: () => ({
    lighting: { intensity: 5, ambient: { day: [0.1, 0.1, 0.1], night: [0.01, 0.01, 0.02] }, moon: {} },
  }),
  environment: () => ({ environment: true, clouds: {} }),
  night: () => ({ hours: 0, timeScale: 0, night: { moonPhase: 'full' } }),
  sunDirection: () => ({ sunDirection: [0.3, 0.2, -0.8], model: 'bruneton', clouds: { coverage: 0.3 } }),
  ...Object.fromEntries(dayPresetNames.map((name) => [`day-${name}`, () => dayPreset(name)])),
  skyMoon: () => new SkyMoon({ moonPhase: 'waningGibbous', starIntensity: 2 }),
};
/** The SHA-256 of what a Sky (or the Sky of these options) made by `make` compiles and writes over 12 frames from 17:00, 0.25 h apart. */
export function fingerprint(make) {
  const h = optionalGPU(),
    hash = createHash('sha256'),
    device = h.engine.gpu,
    module = device.createShaderModule,
    computePipeline = device.createComputePipeline,
    write = device.queue.writeBuffer;
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  device.createShaderModule = (d) => {
    hash.update('module\0' + d.code + '\0');
    return module.call(device, d);
  };
  device.createComputePipeline = (d) => {
    hash.update('compute\0' + (d.compute?.module?.code ?? '') + '\0' + (d.compute?.entryPoint ?? '') + '\0');
    return computePipeline.call(device, d);
  };
  device.queue.writeBuffer = (buffer, offset, value, dataOffset = 0, size) => {
    const unit = value.BYTES_PER_ELEMENT ?? 1,
      start = (value.byteOffset ?? 0) + dataOffset * unit,
      bytes = size === undefined ? (value.byteLength ?? value.length * unit) - dataOffset * unit : size * unit;
    hash.update(`write\0${offset}\0`);
    hash.update(new Uint8Array(value.buffer ?? value, start, bytes));
    return write.call(device.queue, buffer, offset, value, dataOffset, size);
  };
  const made = make(),
    sky = typeof made.setup === 'function' ? made : new Sky(made),
    options = sky.options;
  h.engine.use(sky);
  const held = options.sunDirection || options.timeScale === 0;
  for (let i = 0; i < 12; i++) {
    if (!held) sky.options.hours = 17 + i * 0.25;
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  }
  hash.update(`shader|${h.context.shader}|`);
  hash.update(`lights\0${[...sky.lights[0].direction, ...sky.lights[0].radiance, ...sky.lights[1].direction]}`);
  sky.dispose();
  h.cleanup();
  return hash.digest('hex');
}
export const fingerprints = () =>
  Object.fromEntries(Object.entries(configurations).map(([name, make]) => [name, fingerprint(make)]));
if (process.argv.includes('--write')) {
  const path = new URL('./fixtures/defaults-fingerprint.json', import.meta.url);
  await writeFile(path, JSON.stringify(fingerprints(), null, 2) + '\n');
  console.log(`wrote ${path.pathname}`);
}

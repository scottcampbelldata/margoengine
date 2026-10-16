// Recorded GPU work for the demo sky configurations. `node packages/sky/test/traces.js <dist>` rewrites
// fixtures/traces.json from a build; it was recorded from the build before the entry split (1970fda).
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';
import { wgsl } from '../../core/src/shaders.ts';
import { configs } from './configs.js';
export { configs };

/** Runs one configuration on the tracing mock: attach, frames (4x then 1x scene depth), restoration, disposal. */
export function trace(Sky, name, features) {
  const config = configs[name],
    h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  let depth = Object.assign(
    h.engine.gpu.createTexture({
      size: [128, 96],
      format: 'depth32float',
      sampleCount: 4,
      usage: globalThis.GPUTextureUsage.TEXTURE_BINDING,
    }),
    { depthOrArrayLayers: 1 },
  );
  const sky = features
    ? new Sky(
        config.options(() => depth),
        features,
      )
    : new Sky(config.options(() => depth));
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  h.engine.use(sky);
  if (config.reflection) void sky.reflectionTexture;
  for (const change of config.frames) {
    change(sky);
    frame();
  }
  depth = Object.assign(
    h.engine.gpu.createTexture({
      size: [128, 96],
      format: 'depth32float',
      usage: globalThis.GPUTextureUsage.TEXTURE_BINDING,
    }),
    { depthOrArrayLayers: 1 },
  );
  frame();
  sky.onDeviceRestored(h.engine);
  frame();
  sky.dispose();
  return h;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { Sky } = await import(pathToFileURL(resolve(process.argv[2] ?? 'packages/sky/dist', 'index.js')).href),
    result = {};
  for (const name of Object.keys(configs)) {
    const h = trace(Sky, name);
    result[name] = { digest: h.digest(), created: h.created.length, commands: h.commands().length };
  }
  await writeFile(new URL('./fixtures/traces.json', import.meta.url), JSON.stringify(result, null, 1) + '\n');
  console.log(result);
}

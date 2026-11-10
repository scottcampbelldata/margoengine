import { Camera } from '@margoengine/core/extension';
import { decodeEXR, loadEXR } from '../dist/exr-codecs.js';
import { Environment, EnvironmentBackground } from '../dist/index.js';
import { assert, openDevice, renderBackground } from './gpu-read.js';

window.runTests = async () => {
  const { device, finish } = await openDevice();
  const reference = await (await fetch('./fixtures/codecs/reference.json')).json();
  const camera = new Camera({ position: [0, 0, 0], target: [0, 0, -1], near: 0.1, far: 100 });
  camera.update(1, true);
  let components = 0;
  for (const fixture of reference.fixtures) {
    const image = await loadEXR('./fixtures/codecs/' + fixture.name + '.exr');
    const expected = new Uint32Array(await (await fetch('./fixtures/codecs/' + fixture.name + '.f32')).arrayBuffer());
    const got = new Uint32Array(image.data.buffer);
    assert(
      got.length === expected.length && got.every((v, i) => v === expected[i]),
      `${fixture.name}: native OpenEXR bit equality`,
    );
    components += got.length;
    const env = await Environment.create(device, image, {
      size: 16,
      specularSize: 16,
      specularMips: 3,
      samples: 16,
      brdfSize: 16,
      brdfSamples: 32,
    });
    assert(env.sh.irradiance.every(Number.isFinite), 'codec output reaches GPU SH and GGX prefilter');
    const bg = new EnvironmentBackground(env);
    const pixels = await renderBackground(device, bg, { size: 16, camera });
    assert(
      pixels(8, 8).every(Number.isFinite) &&
        pixels(8, 8)
          .slice(0, 3)
          .some((v) => v > 0),
      'real photograph renders a finite lit background',
    );
    bg.dispose();
    env.dispose();
  }
  const input = await (await fetch('./fixtures/codecs/venice-half-dwaa.exr')).arrayBuffer();
  const abort = new AbortController(),
    pending = decodeEXR(input, { signal: abort.signal });
  abort.abort();
  let cancelled = false;
  try {
    await pending;
  } catch (e) {
    cancelled = e.name === 'AbortError';
  }
  assert(cancelled, 'in-flight worker cancellation');
  await finish();
  device.destroy();
  return {
    checks: [
      '20 HALF/FLOAT scanline/tiled codec fixtures match native OpenEXR bit for bit',
      'all codec images reach GPU GGX/SH and render the real CC0 photograph',
      'in-flight worker is cancelled',
    ],
    components,
  };
};

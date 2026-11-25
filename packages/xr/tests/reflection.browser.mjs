import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
// ARReflection on a real device (WebGPU, or the WebGL2 layer under MARGO_COMPAT=1): the cube painted from spherical
// harmonics is read back and compared with the analytic radiance, and the browser-cube path copies a real texture.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { ARReflection } = await import('/packages/xr/dist/reflection.js');
    const adapter = await navigator.gpu.requestAdapter(),
      device = await adapter.requestDevice(),
      probe = Object.assign(new EventTarget(), { probeSpace: {} }),
      frames = new Set(),
      eyes = new Set(),
      sh = new Float32Array(27);
    sh.set([2.5, 1.2, 0.6], 0);
    sh.set([1, 1, 1], 3);
    const xr = {
      session: { enabledFeatures: ['light-estimation'], requestLightProbe: async () => probe },
      referenceSpace: {},
      onFrame: (cb) => (frames.add(cb), () => frames.delete(cb)),
      onEye: (cb) => (eyes.add(cb), () => eyes.delete(cb)),
    };
    const frame = {
      getLightEstimate: () => ({
        sphericalHarmonicsCoefficients: sh,
        primaryLightDirection: { x: 0, y: 1, z: 0 },
        primaryLightIntensity: { x: 1, y: 1, z: 1 },
      }),
      getPose: () => null,
    };
    const reflection = await ARReflection.create(xr, { device, size: 8, interval: 0 });
    for (const cb of frames) cb({ time: 0, frame });
    const cube = await reflection.ready;
    const read = async (texture, layer) => {
      const encoder = device.createCommandEncoder();
      // bytesPerRow must be a multiple of 256, so each 64 byte row is padded to 256.
      const padded = device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture, origin: [0, 0, layer] }, { buffer: padded, bytesPerRow: 256 }, [8, 8, 1]);
      device.queue.submit([encoder.finish()]);
      await padded.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(padded.getMappedRange().slice(0));
      padded.unmap();
      return words;
    };
    const half = (h) => {
      const e = (h >> 10) & 31,
        m = h & 1023;
      return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
    };
    // Texel (0, 0) of the +Y face looks along (-1 + 1/8, 1, -1 + 1/8): its radiance is the harmonics' value there.
    const top = await read(cube, 2),
      d = [-7 / 8, 1, -7 / 8],
      n = Math.hypot(...d),
      [x, y, z] = d.map((v) => v / n),
      Y1 = 0.4886025119029199,
      expected = [0, 1, 2].map((c) => sh[c] * 0.28209479177387814 + sh[3 + c] * Y1 * y);
    return { got: [half(top[0]), half(top[1]), half(top[2])], expected, source: reflection.source, x, z };
  });
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(result.got[c] - result.expected[c]) < 0.01 * (1 + result.expected[c]), JSON.stringify(result));
  assert.equal(result.source, 'sh');
  await writeFile('test-results/xr-reflection-browser.json', JSON.stringify(result, null, 2));
  console.log('XR reflection PASS', JSON.stringify(result));
} finally {
  await browser.close();
}

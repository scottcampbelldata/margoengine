import test from 'node:test';
import assert from 'node:assert/strict';
import { ARReflection, paintCubeFromSH } from '../dist/reflection.js';

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2, COPY_SRC: 1 };

function halfToFloat(h) {
  const e = (h >> 10) & 31,
    m = h & 1023;
  return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
}
/** A stand-in XR with a light probe (an EventTarget) and a recording device. */
function rig(extra = {}) {
  const probe = Object.assign(new EventTarget(), { probeSpace: { name: 'probe' } }),
    frames = new Set(),
    eyes = new Set(),
    log = { textures: [], writes: [], copies: 0 },
    xr = {
      session: {
        enabledFeatures: ['light-estimation'],
        requestLightProbe: async (init) => ((probe.init = init), probe),
      },
      referenceSpace: { name: 'local' },
      onFrame: (cb) => (frames.add(cb), () => frames.delete(cb)),
      onEye: (cb) => (eyes.add(cb), () => eyes.delete(cb)),
    },
    device = {
      createTexture: (d) => {
        const t = {
          ...d,
          width: d.size[0],
          height: d.size[1],
          depthOrArrayLayers: d.size[2],
          format: d.format,
          destroy() {
            this.gone = true;
          },
        };
        log.textures.push(t);
        return t;
      },
      queue: { writeTexture: (t, data) => log.writes.push(data), submit() {} },
      createCommandEncoder: () => ({ copyTextureToTexture: () => log.copies++, finish: () => ({}) }),
    };
  const sh = new Float32Array(27);
  sh.set([2, 1, 0.5], 0);
  sh.set([0.4, 0.4, 0.4], 6);
  const frame = {
    getLightEstimate: () => ({
      sphericalHarmonicsCoefficients: sh,
      primaryLightDirection: { x: 0, y: 1, z: 0 },
      primaryLightIntensity: { x: 1, y: 1, z: 1 },
    }),
    getPose: () => null,
  };
  const step = (time) => {
    for (const cb of frames) cb({ time, frame });
  };
  return { xr, probe, device, log, step, eyes, frames };
}

test('paintCubeFromSH paints the harmonics: a constant band 0 gives a flat cube, band 1 y a top to bottom ramp', () => {
  const flat = new Float32Array(27);
  flat.set([Math.sqrt(4 * Math.PI), 0, 0], 0);
  const data = paintCubeFromSH(flat, 8);
  assert.equal(data.length, 6 * 8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(Math.abs(halfToFloat(data[i]) - 1) < 2e-3);
    assert.equal(data[i + 1], 0);
    assert.equal(halfToFloat(data[i + 3]), 1);
  }
  const up = new Float32Array(27);
  up.set([1, 1, 1], 3);
  const ramp = paintCubeFromSH(up, 8),
    at = (face, x, y) => halfToFloat(ramp[((face * 8 + y) * 8 + x) * 4]);
  assert.ok(at(2, 3, 3) > 0, '+Y face looks up');
  assert.equal(at(3, 3, 3), 0, '-Y face looks down (negative light is clamped)');
});

test('ARReflection paints the cube from the estimate, throttled, and refreshes the attached environment', async () => {
  const { xr, probe, device, log, step } = rig();
  const reflection = await ARReflection.create(xr, { device, size: 8, interval: 100 });
  assert.deepEqual(probe.init, { reflectionFormat: 'rgba16f' });
  assert.equal(reflection.texture, null);
  let refreshed = 0;
  reflection.attach({ refresh: async () => void refreshed++ });
  step(0);
  const texture = await reflection.ready;
  assert.equal(texture.width, 8);
  assert.equal(texture.depthOrArrayLayers, 6);
  assert.equal(reflection.source, 'sh');
  assert.equal(log.writes.length, 1);
  assert.equal(refreshed, 1);
  step(50);
  assert.equal(log.writes.length, 1, 'same light, inside the interval: nothing painted');
  step(500);
  assert.equal(log.writes.length, 1, 'same light after the interval: nothing painted');
  reflection.dispose();
  assert.ok(texture.gone);
});

test('ARReflection copies the browser cube map on reflectionchange and falls back where it is unusable', async () => {
  const { xr, probe, device, log, step, eyes } = rig();
  const reflection = await ARReflection.create(xr, { device, size: 8 });
  const native = { format: 'rgba16float', width: 16, height: 16, depthOrArrayLayers: 6 };
  let given = native;
  for (const eye of eyes) eye({ binding: { getReflectionCubeMap: (p) => (p === probe ? given : null) } });
  step(0);
  assert.equal(reflection.source, 'binding');
  assert.equal(reflection.texture.width, 16);
  assert.equal(log.copies, 1);
  step(10);
  assert.equal(log.copies, 1, 'no reflectionchange, no copy');
  probe.dispatchEvent(new Event('reflectionchange'));
  step(20);
  assert.equal(log.copies, 2);
  given = { ...native, format: 'rgba8unorm' };
  step(1000);
  assert.equal(reflection.source, 'sh', 'an unusable browser texture falls back to the harmonics');
  assert.equal(reflection.texture.width, 8);
  reflection.dispose();
});

test('ARReflection validates its options and stops with the session hooks', async () => {
  const { xr, device, frames, eyes } = rig();
  await assert.rejects(ARReflection.create(xr, {}), { code: 'state' });
  await assert.rejects(ARReflection.create(xr, { device, size: 12 }), RangeError);
  await assert.rejects(ARReflection.create(xr, { device, interval: -1 }), RangeError);
  const reflection = await ARReflection.create(xr, { device });
  assert.equal(eyes.size, 1);
  reflection[Symbol.dispose]();
  assert.equal(eyes.size, 0);
  assert.equal(frames.size, 0);
  reflection.dispose();
});

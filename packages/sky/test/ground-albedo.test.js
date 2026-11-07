// Ground albedo feedback on the Bruneton model: options, the passes it adds and when the tables are rebuilt. The
// light it adds to the sky is checked on a real GPU in features-check.mjs (albedo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { bruneton } from '@margoengine/sky/bruneton';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function setup(options) {
  const h = optionalGPU(),
    code = [],
    shader = h.engine.gpu.createShaderModule;
  h.engine.gpu.createShaderModule = (x) => {
    code.push(x.code);
    return shader.call(h.engine.gpu, x);
  };
  const sky = new Sky({ model: 'bruneton', hours: 12, timeScale: 0, ...options }, { preetham, bruneton });
  h.engine.use(sky);
  const frame = () => {
    const before = h.counts.compute;
    h.frame();
    return h.counts.compute - before;
  };
  return { h, sky, code, frame };
}
const albedoBuffer = (h) => h.resources.find((r) => r.data?.byteLength === 16);

test('groundAlbedo takes one number or linear RGB from 0 to 1 and needs the Bruneton entry', () => {
  for (const good of [0, 0.4, 1, [0.9, 0.85, 0.8]])
    assert.doesNotThrow(() => new Sky({ groundAlbedo: good }, { preetham, bruneton }), JSON.stringify(good));
  for (const bad of [-0.1, 1.5, Number.NaN, [0.5, 0.5], [0.5, 0.5, 2], ['0.5', 0, 0], '0.3', null])
    assert.throws(
      () => new Sky({ groundAlbedo: bad }, { preetham, bruneton }),
      /Invalid sky groundAlbedo; use a number from 0 to 1 or three of them/,
      JSON.stringify(bad),
    );
  assert.throws(
    () => new Sky({ groundAlbedo: 0.3 }, { preetham }),
    /Sky groundAlbedo needs bruneton from @margoengine\/sky\/bruneton/,
  );
});

test('at albedo 0 the tables are built by the same passes as without the option', () => {
  const plain = setup({}),
    zero = setup({ groundAlbedo: 0 });
  try {
    assert.equal(plain.frame(), 11);
    assert.equal(zero.frame(), 11);
    assert.deepEqual(zero.code, plain.code, 'no ground shader is compiled');
    assert.equal(zero.h.resources.length, plain.h.resources.length, 'nothing more is allocated');
    assert.ok(!zero.code.some((c) => c.includes('fn groundIrradiance(')));
  } finally {
    plain.sky.dispose();
    zero.sky.dispose();
  }
});

test('an albedo adds the ground irradiance pass per order and rebuilds only when it changes', () => {
  const { h, sky, code, frame } = setup({ groundAlbedo: 0.8 });
  try {
    // Transmission, single scattering, then per order: ground irradiance, density with the ground term, multiple, add.
    assert.equal(frame(), 14);
    assert.ok(code.some((c) => c.includes('fn groundIrradiance(')));
    assert.ok(code.some((c) => c.includes('fn direct(') && c.includes('fn indirect(')));
    assert.deepEqual([...new Float32Array(albedoBuffer(h).data)].slice(0, 3), [0.8, 0.8, 0.8].map(Math.fround));
    assert.equal(frame(), 0, 'unchanged tables are kept');
    sky.options.groundAlbedo = [0.9, 0.85, 0.8];
    assert.equal(frame(), 13, 'a new albedo rebuilds the scattering, not the transmission');
    assert.deepEqual([...new Float32Array(albedoBuffer(h).data)].slice(0, 3), [0.9, 0.85, 0.8].map(Math.fround));
    const shaders = code.length;
    sky.options.groundAlbedo = [0.9, 0.85, 0.8];
    assert.equal(frame(), 0, 'the same values in a new array are no change');
    sky.options.groundAlbedo = 0;
    assert.equal(frame(), 10, 'back to 0: the plain passes again');
    sky.options.groundAlbedo = 0.5;
    assert.equal(frame(), 13);
    assert.equal(code.length, shaders, 'the ground passes are built once');
    // On the Preetham model a changed albedo waits until Bruneton is chosen again.
    sky.options.model = 'preetham';
    sky.options.groundAlbedo = 0.2;
    assert.equal(frame(), 0);
    sky.options.model = 'bruneton';
    assert.equal(frame(), 13);
  } finally {
    sky.dispose();
  }
  assert.ok(h.resources.every((r) => r.destroyed), 'the ground buffer and table are released with the sky');
});

test('device restoration rebuilds the ground passes', () => {
  const { h, sky, frame } = setup({ groundAlbedo: 0.4 });
  try {
    assert.equal(frame(), 14);
    const old = albedoBuffer(h);
    sky.onDeviceRestored(h.engine);
    assert.ok(old.destroyed);
    assert.equal(frame(), 14);
    const fresh = h.resources.filter((r) => r.data?.byteLength === 16 && !r.destroyed);
    assert.equal(fresh.length, 1);
    assert.equal(new Float32Array(fresh[0].data)[0], Math.fround(0.4));
  } finally {
    sky.dispose();
  }
});

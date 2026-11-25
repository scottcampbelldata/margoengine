// Wind force of the particle simulation: what the CPU packs into the frame uniform (control.w, two half floats, 0 = no
// wind), for a [x, z] wind, a sampled field and setWind. The GPU half (the lean atan(U / w), on WebGPU and the WebGL2
// layer) is features-check.mjs checkWind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const half = (bits) => {
  const sign = bits & 0x8000 ? -1 : 1,
    e = (bits >> 10) & 31,
    m = bits & 1023;
  return e === 0 ? sign * 2 ** -14 * (m / 1024) : sign * 2 ** (e - 15) * (1 + m / 1024);
};
const setup = (options) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX({ capacity: 32, rate: 0, ...options });
  h.engine.use(effect);
  const wind = () => {
    const bits = new Uint32Array(h.resources.findLast((r) => r.size === 224 && !r.destroyed).data)[55];
    return [bits, [half(bits & 0xffff), half(bits >>> 16)]];
  };
  return { h, effect, wind };
};

test('wind: [x, z] in m/s reaches the simulation as two half floats; no wind and [0, 0] write 0', () => {
  const { h, effect, wind } = setup({ wind: [7.25, -3.5] });
  h.frame();
  assert.deepEqual(wind()[1], [7.25, -3.5]);
  effect.setWind(undefined);
  h.frame();
  assert.equal(wind()[0], 0, 'removed');
  effect.setWind([0, 0]);
  h.frame();
  assert.equal(wind()[0], 0, 'calm is no force');
  effect.setWind([-12.3, 0.001]);
  h.frame();
  const [, [x, z]] = wind();
  assert.ok(Math.abs(x + 12.3) < 0.01 && Math.abs(z - 0.001) < 1e-5, `${x} ${z}`);
  effect.dispose();
});

test('wind: a field is sampled at the emitter and the frame time; its [x, y, z] gives x and z', () => {
  const seen = [];
  const field = { sample: (x, y, z, t) => (seen.push([x, y, z, t]), [4, 99, -2]) };
  const { h, effect, wind } = setup({ position: [1, 2, 3], wind: field });
  h.frame();
  assert.deepEqual(wind()[1], [4, -2], 'x and z, never y');
  assert.deepEqual(seen.at(-1).slice(0, 3), [1, 2, 3]);
  const first = seen.at(-1)[3];
  h.frame();
  assert.ok(seen.at(-1)[3] > first, 'the time moves on');
  effect.dispose();
});

test('wind: bad winds name the fix and a rejected setWind keeps the old wind', () => {
  assert.throws(() => new VFX({ wind: [1] }), /\[x, z\]|1,000/);
  assert.throws(() => new VFX({ wind: [Number.NaN, 0] }), RangeError);
  assert.throws(() => new VFX({ wind: [1001, 0] }), RangeError);
  assert.throws(() => new VFX({ wind: 5 }), TypeError);
  assert.throws(() => new VFX({ wind: {} }), TypeError);
  const { h, effect, wind } = setup({ wind: [2, 1] });
  assert.throws(() => effect.setWind([Number.POSITIVE_INFINITY, 0]), RangeError);
  assert.deepEqual(effect.options.wind, [2, 1]);
  h.frame();
  assert.deepEqual(wind()[1], [2, 1]);
  effect.dispose();
});

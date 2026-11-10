import test from 'node:test';
import assert from 'node:assert/strict';
import { Stylize } from '@margoengine/post/stylize';
import { harness, written, modules } from './support.js';
test('Stylize exposes independent controls, exact seed bits, an explicit wave clock and restoration', async () => {
  const h = harness(),
    effect = Stylize.attach(h.engine, { time: 0.2, scanlines: 0, noise: 0, colorDepth: [5, 6, 5], seed: 0xffffffff });
  effect.explode(0);
  const log = h.gpu.record(() => h.frame()),
    v = written(log, 64),
    bits = new Uint32Array(v.buffer, v.byteOffset, v.length);
  assert.ok(Math.abs(v[6] - 0.4) < 1e-6);
  assert.deepEqual([...bits.slice(12)], [31, 63, 31, 0xffffffff]);
  assert.ok(modules(log).some((s) => s.includes('fn bilinear(') && s.includes('rgb=round(rgb*levels)/levels')));
  effect.options.enabled = false;
  assert.equal(
    written(
      h.gpu.record(() => h.frame()),
      64,
    )[10],
    -1,
  );
  h.engine.restore();
  h.frame();
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
  assert.throws(() => effect.explode(), /disposed/);
});
test('Stylize validates mutable clocks, colour bits and wave controls', () => {
  for (const o of [
    { noise: NaN },
    { scanlines: -1 },
    { seed: 0x100000000 },
    { density: 0 },
    { scrollSpeed: 101 },
    { colorDepth: [5, 0, 5] },
    { time: -1 },
    { shockWave: { waveSize: 0 } },
    { shockWave: { amplitude: 2 } },
    { shockWave: { position: [0, Infinity, 0] } },
  ])
    assert.throws(() => new Stylize(o), RangeError);
  assert.throws(() => new Stylize({ enabled: 1 }), TypeError);
  const e = new Stylize();
  assert.throws(() => e.explode(-1), RangeError);
  e.dispose();
});

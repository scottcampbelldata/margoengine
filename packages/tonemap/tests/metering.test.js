import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const meter = (h) => h.pipelines.find((p) => p.compute)?.compute.module.code;

test('metering modes share one compute pipeline and bind a mask texture at 3', () => {
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { autoExposure: true });
  h.frame();
  const code = meter(h);
  assert.match(code, /@binding\(3\) var mask:texture_2d<f32>/);
  assert.match(code, /var<workgroup> bins:array<atomic<u32>,64>/);
  const computes = h.pipelines.filter((p) => p.compute).length;
  for (const a of [
    { method: 'histogram', percentiles: [0.2, 0.8] },
    { metering: 'center' },
    { metering: 'spot', spot: { x: 0.25, y: 0.75, radius: 0.1 } },
  ]) {
    effect.options.autoExposure = a;
    h.frame();
  }
  assert.equal(h.pipelines.filter((p) => p.compute).length, computes, 'no new pipeline per mode');
  effect.dispose();
});

test('metering options are checked now and every frame', () => {
  for (const autoExposure of [
    { method: 'median' },
    { metering: 'matrix' },
    { percentiles: [0.9, 0.1] },
    { percentiles: [0, 1.5] },
    { spot: { radius: 0 } },
    { spot: { x: 2 } },
    { metering: 'mask' },
  ])
    assert.throws(() => new Tonemap({ autoExposure }), RangeError, JSON.stringify(autoExposure));
  const t = new Tonemap({ autoExposure: { metering: 'spot' } });
  t.options.autoExposure.metering = 'mask';
  assert.throws(() => new Tonemap(t.options), RangeError);
});

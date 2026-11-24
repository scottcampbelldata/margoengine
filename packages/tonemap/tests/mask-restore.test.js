// KB-RESTORE-BORROWED1 for the auto exposure mask (docs/conventions.md, "Borrowed GPU objects"): a plain mask belongs to
// the device it was made on. After a device restore the meter weighs nothing (the exposure holds), the loss is reported
// once through engine.onError and the frame keeps running; setAutoExposureMask brings a new one in; a function is read
// every frame and never reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const maskOn = (h) => h.engine.gpu.createTexture({ size: [4, 4], format: 'r8unorm', usage: 4 });
const bound = (h, owner = h) => owner.groups.at(-1)?.entries.find((entry) => entry.binding === 3)?.resource.texture;
function restore(h, next, effect) {
  h.engine.gpu = h.context.device = next.engine.gpu;
  effect.onDeviceRestored(h.engine);
}

test('a plain mask lost at a device restore is reported once, weighs nothing, and setAutoExposureMask brings it back', () => {
  const first = gpuHarness(),
    second = gpuHarness(),
    errors = [];
  first.engine.onError = (error) => errors.push(error);
  const mask = maskOn(first),
    effect = Tonemap.attach(first.engine, { autoExposure: { metering: 'mask', mask } });
  first.frame();
  assert.equal(bound(first), mask, 'the mask is bound on its own device');
  restore(first, second, effect);
  first.frame();
  first.frame();
  assert.notEqual(bound(first, second), mask, 'nothing of the old device is bound');
  const lost = errors.filter((error) => /borrowed-lost/.test(error.message));
  assert.equal(lost.length, 1, 'one report');
  assert.match(
    lost[0].message,
    /^Tonemap autoExposure mask lost with the device; pass a function or call setAutoExposureMask/,
  );
  assert.equal(lost[0].code, 'state');
  const again = maskOn(second);
  effect.setAutoExposureMask(again);
  first.frame();
  assert.equal(bound(first, second), again, 'the new mask is bound');
  assert.equal(errors.filter((error) => /borrowed-lost/.test(error.message)).length, 1, 'no further report');
  effect.dispose();
});

test('a mask function is read each frame across a restore, with no report', () => {
  const first = gpuHarness(),
    second = gpuHarness(),
    errors = [];
  first.engine.onError = (error) => errors.push(error);
  let current = maskOn(first);
  const effect = Tonemap.attach(first.engine, { autoExposure: { metering: 'mask', mask: () => current } });
  first.frame();
  assert.equal(bound(first), current);
  restore(first, second, effect);
  current = maskOn(second);
  first.frame();
  assert.equal(bound(first, second), current);
  assert.deepEqual(errors, []);
  effect.dispose();
});

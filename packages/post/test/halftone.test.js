import test from 'node:test';
import assert from 'node:assert/strict';
import { Halftone, DotScreen } from '@margoengine/post/halftone';
import { harness, written, modules } from './support.js';
for (const Class of [Halftone, DotScreen])
  test(`${Class.name} restores, validates and releases its screen resources`, async () => {
    const h = harness(),
      effect = Class.attach(h.engine, { cellSize: 12, shape: 'ellipse', scatter: 0.5 });
    const log = h.gpu.record(() => h.frame());
    const values = written(log, 64);
    assert.equal(values[0], 12);
    assert.equal(values[2], 0.5);
    assert.equal(values[3], +(Class === DotScreen));
    assert.equal(values[6], 1);
    assert.ok(modules(log).some((s) => s.includes('fn screen(')));
    h.engine.restore();
    h.frame();
    effect.options.enabled = false;
    assert.equal(
      written(
        h.gpu.record(() => h.frame()),
        64,
      )[1],
      0,
    );
    effect.dispose();
    await null;
    assert.deepEqual(h.live(), []);
  });
test('Halftone rejects invalid live options', () => {
  for (const o of [
    { cellSize: 1 },
    { scale: 0 },
    { scatter: 2 },
    { angles: [0, NaN, 0] },
    { center: [0] },
    { blend: 'invalid' },
    { shape: 'bad' },
  ])
    assert.throws(() => new Halftone(o), RangeError);
  assert.throws(() => new Halftone({ grayscale: 1 }), TypeError);
});

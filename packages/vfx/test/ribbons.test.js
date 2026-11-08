import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { ribbons, MAX_RIBBON_POINTS } from '../dist/ribbons.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};
const ribbonUniform = (h) => h.resources.findLast((r) => r.size === 48 && !r.destroyed);

test('ribbons record each interval, draw one strip per slot after the billboards and release everything', () => {
  const { h, effect } = attach({ capacity: 10, initialCount: 10, ribbons: { points: 5, interval: 0.15 } });
  const history = h.resources.find((r) => r.size === 10 * 4 * 16);
  assert.ok(history, 'a ring of points - 1 records per slot');
  const records = [];
  for (let i = 0; i < 4; i++) {
    h.frame();
    records.push(new Uint32Array(ribbonUniform(h).data)[0]);
  }
  // Frames of 0.1 s: the first records, then each 0.15 s (0.1 + 0.1 >= 0.15, remainder 0.05, then 0.05 + 0.1).
  assert.deepEqual(records, [1, 1, 2, 3]);
  const u = new Uint32Array(ribbonUniform(h).data);
  assert.deepEqual([u[1], u[2], u[3]], [3, 4, 5], 'readable records, ring length, points');
  assert.equal(h.counts.draws, 4, 'one ribbon draw a frame, and the billboards draw indirect');
  const code = h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  assert.ok(code.includes('fn ribbonRecord') && code.includes('ribbonHistory'));
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('an interval longer than a frame records every few frames without catching up after a long one', () => {
  const { h, effect } = attach({ capacity: 4, ribbons: { interval: 0.25 } });
  const made = [];
  for (const delta of [0.1, 0.1, 0.1, 0.1, 0.1, 2, 0.1]) {
    h.context.delta = delta;
    h.frame();
    made.push(new Uint32Array(ribbonUniform(h).data)[0]);
  }
  // First frame records; then 0.3 >= 0.25 at frame 4 (0.1 x 3); 2 s records once and resets.
  assert.deepEqual(made, [1, 1, 1, 2, 2, 3, 3]);
  effect.dispose();
});

test('effects without ribbons compile no ribbon code; heads: false leaves the billboards out', () => {
  const plain = attach({ capacity: 8 });
  plain.h.frame();
  assert.ok(!plain.h.pipelines.some((p) => (p.compute ?? p.vertex).module.code.includes('ribbon')));
  plain.effect.dispose();
  const { h, effect } = attach({ capacity: 8, initialCount: 8, ribbons: { heads: false } }, { ribbons });
  h.frame();
  assert.equal(h.counts.indirect ?? 0, 0, 'no billboard draw');
  assert.equal(h.counts.draws, 1, 'the ribbon draw');
  effect.options.ribbons.heads = true;
  h.frame();
  assert.equal(h.counts.indirect, 1, 'heads can come back between frames');
  effect.dispose();
});

test('ribbons are validated, need the feature and keep their points from attach', () => {
  assert.throws(() => new Base({ ribbons: {} }), /VFX ribbons needs ribbons from @margoengine\/vfx\/ribbons/);
  for (const bad of [{ points: 1 }, { points: 65 }, { points: 2.5 }, { interval: -1 }, { interval: 2 }, { width: 0 }])
    assert.throws(() => new VFX({ capacity: 4, ribbons: bad }), RangeError, JSON.stringify(bad));
  assert.throws(() => new VFX({ ribbons: { heads: 1 } }), TypeError);
  assert.throws(() => new VFX({ ribbons: 3 }), TypeError);
  assert.throws(
    () => new VFX({ capacity: MAX_RIBBON_POINTS / 16 + 1, ribbons: { points: 17 } }),
    /capacity x \(points - 1\)/,
  );
  assert.doesNotThrow(() => new VFX({ capacity: MAX_RIBBON_POINTS / 16, ribbons: { points: 17 } }));
  const { h, effect } = attach({ capacity: 4, ribbons: { points: 4 } });
  h.frame();
  effect.options.ribbons = { points: 6 };
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.options.ribbons = { points: 4, width: 0.3 };
  h.frame();
  assert.equal(new Float32Array(ribbonUniform(h).data)[4], Math.fround(0.3), 'width is read every frame');
  effect.dispose();
});

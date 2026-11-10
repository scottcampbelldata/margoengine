import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { schedule, MAX_BURST_EVENTS } from '../dist/schedule.js';
test('timed bursts include zero once, repeated cycles, simultaneous events and skipped probabilities', () => {
  const v = {
    bursts: [
      { time: 0, count: 2, cycles: 4, interval: 0.125 },
      { time: 0.25, count: 7, probability: 0 },
      { time: 0.375, count: 5, cycles: 2 },
    ],
  };
  schedule.validate(v, { capacity: 32 });
  const r = schedule.create({}, v, []),
    advance = () => [r.emission(0), r.emission(0), r.emission(0.125), r.emission(0.25), r.emission(0.125)];
  assert.deepEqual(advance(), [2, 0, 2, 14, 0]);
  r.reset();
  assert.deepEqual(advance(), [2, 0, 2, 14, 0]);
});
test('probabilities are seeded by event identity and repeat exactly after reset', () => {
  const value = { seed: 17, bursts: [{ time: 0, count: 1, cycles: 4096, probability: 0.5 }] };
  schedule.validate(value, { capacity: 4096 });
  const r = schedule.create({}, value, []),
    n = r.emission(1);
  assert.ok(n > 1900 && n < 2200);
  r.reset();
  assert.equal(r.emission(1), n);
  const other = schedule.create({}, { ...value, seed: 18 }, []);
  assert.notEqual(other.emission(1), n);
});
test('prewarm steps are bounded, include a final partial step and repeat only on reset', () => {
  const r = schedule.create({}, { prewarm: 0.3, step: 0.125 }, []),
    steps = [];
  r.warmup((dt) => steps.push(dt));
  r.warmup(() => assert.fail('prewarm repeated'));
  assert.equal(steps.length, 3);
  assert.equal(
    steps.reduce((a, b) => a + b, 0),
    0.3,
  );
  r.reset();
  r.warmup((dt) => steps.push(dt));
  assert.equal(steps.length, 6);
  assert.equal(MAX_BURST_EVENTS, 16384);
  for (const value of [
    { prewarm: -1 },
    { step: 0 },
    { prewarm: 3600 },
    { seed: -1 },
    { bursts: [{ time: 0, count: 9 }] },
    { bursts: [{ time: -1, count: 1 }] },
    { bursts: [{ time: 0, count: 1, cycles: 1.5 }] },
    { bursts: [{ time: 0, count: 1, probability: 2 }] },
  ])
    assert.throws(() => new VFX({ capacity: 8, schedule: value }, { schedule }), /VFX/);
  assert.throws(() => new VFX({ schedule: { prewarm: 1 } }), /schedule/);
});

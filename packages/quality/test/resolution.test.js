import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionScaler, watchResolution } from '../dist/index.js';

const feed = (s, ms, n) => {
  const changes = [];
  for (let i = 0; i < n; i++) {
    const r = s.push(ms);
    if (r !== undefined) changes.push(r);
  }
  return changes;
};

test('scaler drops when over budget in one sized step and never goes below min', () => {
  const s = new ResolutionScaler({ budget: 10, min: 0.5, window: 10 });
  assert.equal(s.scale, 1);
  assert.deepEqual(feed(s, 9, 20), [], 'inside the budget changes nothing');
  const first = feed(s, 20, 10);
  assert.equal(first.length, 1);
  assert.ok(first[0] < 1 && first[0] >= 0.7, `sqrt(0.5) drop is limited to 30% per decision, got ${first[0]}`);
  for (let i = 0; i < 40; i++) feed(s, 100, 20);
  assert.equal(s.scale, 0.5);
  assert.deepEqual(feed(s, 100, 40), [], 'stays at the floor');
});

test('scaler rises slowly after calm windows, stops at max, and backs off after a failed rise', () => {
  const s = new ResolutionScaler({ budget: 10, window: 10 });
  feed(s, 30, 10);
  assert.ok(s.scale < 1);
  const low = s.scale;
  assert.deepEqual(
    feed(s, 2, 18),
    [],
    'the first samples after a change are ignored and one calm window is not enough',
  );
  const rose = feed(s, 2, 100);
  assert.ok(rose.length > 0 && rose[0] > low && rose[0] - low <= 0.1, `rises about 5% at a time, got ${rose}`);
  assert.ok(s.scale <= 1);
  for (let i = 0; i < 30; i++) feed(s, 2, 20);
  assert.equal(s.scale, 1, 'reaches max and stops');
  // A rise that is undone makes the next rise wait longer.
  const t = new ResolutionScaler({ budget: 10, window: 10 });
  feed(t, 30, 10);
  let rises = 0,
    quietAfterFirstFail = 0;
  for (let round = 0; round < 6; round++) {
    let rose = false;
    for (let w = 0; w < 80 && !rose; w++) {
      const r = feed(t, 2, 10);
      if (r.length) {
        rose = true;
        rises++;
        if (round >= 1) quietAfterFirstFail += w;
      }
    }
    feed(t, 30, 10); // the rise did not hold
  }
  assert.ok(rises >= 2 && quietAfterFirstFail > 0);
  assert.throws(() => new ResolutionScaler({ min: 0 }), RangeError);
  assert.throws(() => new ResolutionScaler({ min: 0.8, max: 0.5 }), RangeError);
  assert.throws(() => new ResolutionScaler({ budget: -1 }), RangeError);
  assert.throws(() => new ResolutionScaler({ window: 0 }), RangeError);
  assert.equal(new ResolutionScaler().push(Number.NaN), undefined);
});

test('watchResolution times GPU submissions, moves core pixel-ratio cap and restores it on dispose', async () => {
  const saved = [globalThis.margoLow, globalThis.devicePixelRatio];
  globalThis.margoLow = 2;
  globalThis.devicePixelRatio = 2;
  let clock = 0;
  const submitted = [];
  const queue = {
    submit(buffers) {
      submitted.push(buffers);
      return 'ok';
    },
    onSubmittedWorkDone: () => Promise.resolve(),
  };
  const original = queue.submit;
  try {
    const watch = watchResolution({ queue, now: () => clock, budget: 10, window: 5 });
    assert.notEqual(queue.submit, original, 'submit is wrapped');
    for (let i = 0; i < 5; i++) {
      const before = clock;
      assert.equal(queue.submit(i), 'ok');
      clock = before + 25;
      await null;
      await null;
    }
    assert.ok(watch.scale < 1);
    assert.equal(globalThis.margoLow, Math.max(0.25, 2 * watch.scale));
    assert.deepEqual(submitted, [0, 1, 2, 3, 4]);
    watch.dispose();
    watch.dispose();
    assert.equal(queue.submit, original, 'submit is restored');
    assert.equal(globalThis.margoLow, 2, 'full resolution again');
  } finally {
    [globalThis.margoLow, globalThis.devicePixelRatio] = saved;
  }
});

test('watchResolution does nothing on the full tier, and an injected apply works anywhere', () => {
  const saved = globalThis.margoLow;
  delete globalThis.margoLow;
  try {
    const queue = { submit() {}, onSubmittedWorkDone: () => Promise.resolve() },
      original = queue.submit,
      watch = watchResolution({ queue });
    assert.equal(watch.scale, 1);
    assert.equal(queue.submit, original, 'nothing wrapped');
    watch.dispose();
    const seen = [],
      frames = [];
    let tick;
    const own = watchResolution({
      request: (cb) => (tick = cb),
      apply: (s) => seen.push(s),
      budget: 10,
      window: 3,
    });
    for (let i = 0, t = 1000; i < 6; i++, t += 40) {
      frames.push(t);
      tick(t);
    }
    assert.ok(seen.length >= 1 && seen[0] < 1, 'frame intervals of 40 ms scale down');
    own.dispose();
    assert.equal(seen.at(-1), 1);
    tick(99999);
    assert.equal(seen.at(-1), 1, 'stopped watchers record nothing');
  } finally {
    if (saved !== undefined) globalThis.margoLow = saved;
  }
});

test('watchResolution dispose puts back the cap it found, not the cap clipped to this display (batch 132)', async () => {
  const saved = [globalThis.margoLow, globalThis.devicePixelRatio];
  globalThis.margoLow = 2;
  globalThis.devicePixelRatio = 1;
  let clock = 0;
  const queue = { submit: () => 'ok', onSubmittedWorkDone: () => Promise.resolve() };
  try {
    const watch = watchResolution({ queue, now: () => clock, budget: 10, window: 5 });
    for (let i = 0; i < 5; i++) {
      const before = clock;
      queue.submit(i);
      clock = before + 25;
      await null;
      await null;
    }
    assert.ok(watch.scale < 1);
    assert.ok(globalThis.margoLow < 1, 'scaled against the 1x display');
    watch.dispose();
    assert.equal(globalThis.margoLow, 2, 'a later move to a 2x display can still use the full cap');
  } finally {
    [globalThis.margoLow, globalThis.devicePixelRatio] = saved;
  }
});

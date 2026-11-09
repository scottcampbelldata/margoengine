import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { flowSeeds, traceStreakline, tracePathline } from '@margoengine/sciviz/flow';

const grid = {
  dims: [2, 2, 1], bounds: [-10, 10, -10, 10, 0, 0],
  frames: [0, 2].map((time) => ({ time, u: new Float32Array(4).fill(time), v: new Float32Array(4).fill(1) })),
};
test('all four seed layouts are deterministic, in bounds and independent of the caller', () => {
  for (const seeding of [{ kind: 'uniform' }, { kind: 'random', seed: 171 },
    { kind: 'rake', start: [-1, -2, 0], end: [1, 2, 0] },
    { kind: 'region', bounds: [-2, 3, -4, 5, 0, 0] }]) {
    const seeds = flowSeeds(grid, 101, seeding);
    assert.deepEqual(seeds, flowSeeds(grid, 101, seeding));
    assert.equal(seeds.length, 303);
    seeds.forEach((v, i) => assert.ok(v >= grid.bounds[2 * (i % 3)] && v <= grid.bounds[2 * (i % 3) + 1]));
    seeds[0] = 999;
    assert.notEqual(flowSeeds(grid, 101, seeding)[0], 999);
  }
  assert.deepEqual([...flowSeeds(grid, 3, { kind: 'rake', start: [-1, -2, 0], end: [1, 2, 0] })], [-1, -2, 0, 0, 0, 0, 1, 2, 0]);
  assert.notDeepEqual(flowSeeds(grid, 10, { kind: 'random', seed: 0 }), flowSeeds(grid, 10, { kind: 'random', seed: 1 }));
  const volume = { ...grid, dims: [2, 2, 2], bounds: [-1, 1, -1, 1, -1, 1], frames: [{ time: 0, u: new Float32Array(8), v: new Float32Array(8) }] };
  const seeds = flowSeeds(volume, 8);
  assert.deepEqual([...new Set(seeds.filter((_, i) => i % 3 === 2))], [-0.5, 0.5]);
});
test('seed layouts reject malformed counts, regions, seeds, kinds and rakes', () => {
  for (const count of [0, 1.5, NaN, 1000001]) assert.throws(() => flowSeeds(grid, count), RangeError);
  for (const seeding of [{ kind: 'none' }, { kind: 'random', seed: -1 }, { kind: 'random', seed: 2 ** 32 },
    { kind: 'rake', start: [0, 0, 1], end: [0, 0, 0] }, { kind: 'rake' },
    { kind: 'region', bounds: [-2, 2, -2, 2, 1, 1] }, { kind: 'region', bounds: [2, -2, -2, 2, 0, 0] }])
    assert.throws(() => flowSeeds(grid, 10, seeding), RangeError);
});
test('streaklines use release time, not one pathline, with a single loaded field and Wasm instance', async () => {
  const spy = mock.method(WebAssembly, 'instantiate');
  const releases = [0, 0.25, 1, 2];
  try {
    const streak = await traceStreakline(grid, [0, 0, 0], releases, { to: 2, step: 0.1 });
    assert.equal(spy.mock.callCount(), 1);
    assert.equal(streak.time, 2);
    assert.deepEqual(streak.stops, ['end', 'end', 'end', 'end']);
    for (let i = 0; i < releases.length; i++) {
      const r = releases[i];
      assert.ok(Math.abs(streak.samples[4 * i] - (4 - r * r) / 2) < 1e-12);
      assert.ok(Math.abs(streak.samples[4 * i + 1] - (2 - r)) < 1e-12);
      assert.equal(streak.samples[4 * i + 3], r);
    }
  } finally { spy.mock.restore(); }
  for (const release of releases) {
    const path = await tracePathline(grid, [0, 0, 0], { from: release, to: 2, step: 0.1 });
    assert.equal(path.stop, 'end');
  }
});
test('unfinished streakline releases are explicit gaps and malformed/cancelled calls reject', async () => {
  const short = await traceStreakline(grid, [0, 0, 0], [0, 2], { to: 2, step: 0.1, maxSteps: 1 });
  assert.deepEqual(short.stops, ['steps', 'end']);
  assert.ok(short.samples.slice(0, 3).every(Number.isNaN));
  assert.deepEqual([...short.samples.slice(-4)], [0, 0, 0, 2]);
  for (const times of [[], [0, 0], [1, 0], [NaN], [3], new Array(4097).fill(0)])
    await assert.rejects(traceStreakline(grid, [0, 0, 0], times, { to: 2, step: 0.1 }), RangeError);
  const abort = new AbortController(), reason = { stop: true }; abort.abort(reason);
  await assert.rejects(traceStreakline(grid, [0, 0, 0], [0], { to: 2, step: 0.1, signal: abort.signal }), (e) => e === reason);
});

// vfx-gpu.mjs passes timing() to page.evaluate; it once called the Node percentile helper there ("median is not
// defined" in the page). The page now returns raw frames and Node summarizes them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { summarizeTiming } from '../examples/package-benchmarks/parts/vfx-timing.mjs';

test('summarizeTiming takes nearest-rank medians per round and pairs the arms', () => {
  const frames = (c, d) => c.map((x, i) => ({ compute: x, draw: d[i] }));
  const blocks = [
    [frames([1, 2, 3], [1, 1, 1]), frames([2, 2, 4], [1, 2, 3])],
    [frames([1, 1, 1], [1, 1, 1]), frames([1, 3, 3], [1, 1, 1])],
  ];
  const { summary, blocks: perRound } = summarizeTiming(blocks, 2);
  assert.deepEqual(perRound[0], [{ compute: 2, draw: 1, total: 3 }, { compute: 2, draw: 2, total: 4 }]);
  assert.deepEqual(perRound[1], [{ compute: 1, draw: 1, total: 2 }, { compute: 3, draw: 1, total: 4 }]);
  assert.deepEqual(summary.compute.A, { median: 2, min: 2, max: 2 });
  assert.equal(summary.compute.pairedSavingMs, -1);
  assert.equal(summary.total.bFasterRounds, 1);
  assert.throws(() => summarizeTiming([[[]], [[]]], 1), /empty|sample/i);
});

test('the in-page timing function uses no Node-side helper', () => {
  const source = readFileSync(new URL('../examples/package-benchmarks/vfx-gpu.mjs', import.meta.url), 'utf8');
  const page = source.slice(source.indexOf('async function timing('));
  assert.ok(page.length > 100);
  assert.doesNotMatch(page, /\b(nearestMedian|median|summarizeTiming|percentile|distribution)\(/);
});

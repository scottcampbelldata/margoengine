// Proof for @margoengine/points: nearest-point picking rejects far points on squared distance before Math.hypot,
// and the point budget split computes its clamped weights and sort keys once instead of inside the comparator.
// Run: node examples/package-benchmarks/proofs/points.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/points.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('points', ref, undefined, pin);
const {random, buildBlocks, multiply} = baseline;
const cloud = (n, seed, scale) => {const next = random(seed), p = new Float32Array(n * 3); for (let i = 0; i < p.length; i++) p[i] = (next() - 0.5) * scale; return p;};
// Reversed-Z perspective (clip z in 0..w) times a camera `distance` back on +Z, as Margo Engine's camera.matrix.
function viewProjection(distance, aspect, near = 0.1, far = 1000) {
  const f = 1 / Math.tan(Math.PI / 6), projection = new Float64Array(16), view = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -distance, 1]);
  projection[0] = f / aspect; projection[5] = f; projection[10] = near / (far - near); projection[11] = -1; projection[14] = near * far / (far - near);
  return multiply(projection, view);
}
const pick = (module, positions, order, ranges, mvp, x, y, radius) => module.pickPoint(positions, order, ranges, mvp, 1920, 1080, x, y, radius);

// --- pickPoint: same hit for every pixel and radius, including the edge cases of packages/points/tests ---------
{
  const n = 20_000, positions = cloud(n, 3, 8), blocks = buildBlocks(positions, n, 1000), mvp = viewProjection(10, 16 / 9), next = random(2);
  // Coincident points (depth tie-break), non-finite points and points behind the camera.
  for (let i = 0; i < 300; i++) {const from = Math.floor(next() * n) * 3, to = Math.floor(next() * n) * 3; positions[to] = positions[from]; positions[to + 1] = positions[from + 1]; if (i % 2) positions[to + 2] = positions[from + 2];}
  positions[30] = NaN; positions[61] = Infinity; positions[92] = -Infinity; positions[122] = 50;
  const ranges = Array.from(blocks.starts, (start, b) => ({start, count: blocks.counts[b]})), direct = [{start: 0, count: n}, {start: 100, count: 500}];
  const screen = new Float64Array(3);
  for (let trial = 0; trial < 120; trial++) {
    // Aim half of the picks exactly at a projected point so zero and sub-pixel distances are covered.
    let x = next() * 1920, y = next() * 1080;
    if (trial % 2 && baseline.projectPoint(mvp, positions[trial * 3], positions[trial * 3 + 1], positions[trial * 3 + 2], 1920, 1080, screen)) {x = screen[0] + (trial % 4 === 1 ? 0 : 0.3); y = screen[1];}
    for (const radius of [0, 0.4, 2, 6, 50, 1e-200, 1e200, Infinity, -1, NaN]) {
      assert.deepStrictEqual(pick(candidate, positions, blocks.order, ranges, mvp, x, y, radius), pick(baseline, positions, blocks.order, ranges, mvp, x, y, radius));
      assert.deepStrictEqual(pick(candidate, positions, null, direct, mvp, x, y, radius), pick(baseline, positions, null, direct, mvp, x, y, radius));
    }
  }
  const pair = new Float32Array([0, 0, 0, 0, 0, 5]);
  assert.deepStrictEqual(pick(candidate, pair, null, [{start: 0, count: 2}], mvp, 960, 540, 2), pick(baseline, pair, null, [{start: 0, count: 2}], mvp, 960, 540, 2));
  assert.equal(pick(candidate, pair, null, [], mvp, 960, 540, 2), null);
}

// --- allocateBudget: same allotments on the tests' cases and on randomized blocks ------------------------------
const allot = (module, counts, weights, length, budget) => {
  const out = new Uint32Array(length);
  try {return [module.allocateBudget(counts, weights, length, budget, out), ...out];} catch (error) {return `${error.constructor.name}: ${error.message}`;}
};
for (const [counts, weights, budget] of [
  [[10, 20, 30, 40], [1, 1, 1, 1], 1000], [[1000, 1000, 1000, 1000], [1, 1, 1, 1], 1000], [[50, 1000, 1000, 1000], [1, 1, 1, 2], 1000],
  [[1], [1], -1], [[1], [1], NaN], [[5, 5], [0, NaN], 3], [[5, 5, 5], [1], 7], [[0, 0, 9], [1, 1, 1], 4], [[], [], 10], [[7, 7, 7], [1e12, 1e-12, 1], 10.9],
]) assert.deepStrictEqual(allot(candidate, counts, weights, counts.length, budget), allot(baseline, counts, weights, counts.length, budget));
{
  const next = random(5);
  for (let trial = 0; trial < 2000; trial++) {
    const n = 1 + Math.floor(next() * 80), counts = [], weights = [];
    // Equal counts and weights are common (full blocks at similar distance), so ties in the sort are exercised.
    for (let i = 0; i < n; i++) {counts.push(next() < 0.3 ? 16384 : Math.floor(next() * 20000)); weights.push(next() < 0.1 ? 0 : next() < 0.3 ? 2500 : next() * 1e5);}
    const budget = Math.floor(next() * 300000);
    assert.deepStrictEqual(allot(candidate, counts, weights, n, budget), allot(baseline, counts, weights, n, budget));
    assert.deepStrictEqual(allot(candidate, Uint32Array.from(counts), Float64Array.from(weights), n, budget), allot(baseline, Uint32Array.from(counts), Float64Array.from(weights), n, budget));
  }
}

const cases = [];
{
  // A 500,000-point scan in 16,384-point blocks, filling a 1080p view. Hovering runs one pick per pointer move
  // over the blocks under the cursor; here the cursor is over the dense middle, so every block is a candidate.
  const n = 500_000, positions = cloud(n, 9, 12), blocks = buildBlocks(positions, n), mvp = viewProjection(14, 16 / 9), next = random(4);
  const ranges = Array.from(blocks.starts, (start, b) => ({start, count: blocks.counts[b]}));
  const at = Array.from({length: 4}, () => [760 + next() * 400, 340 + next() * 400]);
  for (const radius of [6, 24]) cases.push({case: `pickPoint, 500k points, radius ${radius}px`, picks: at.length, ...time(
    () => {for (const [x, y] of at) pick(baseline, positions, blocks.order, ranges, mvp, x, y, radius);},
    () => {for (const [x, y] of at) pick(candidate, positions, blocks.order, ranges, mvp, x, y, radius);})});
}
{
  // 10,000,000 points are 611 blocks; with a 2,000,000 point budget the split runs every frame the camera moves.
  const length = 611, next = random(8), counts = Array.from({length}, (_, i) => i === length - 1 ? 5824 : 16384), weights = Array.from({length}, () => next() < 0.15 ? 2073600 : 200 + next() ** 3 * 4e5);
  const out = new Uint32Array(length), frames = 300, budgets = Array.from({length: frames}, (_, i) => 2_000_000 + i * 997);
  // The plugin passes plain arrays; weights change every frame as the camera moves.
  const frame = (module, i) => {weights[i % length] += 1; module.allocateBudget(counts, weights, length, budgets[i], out);};
  cases.push({case: 'allocateBudget, 611 blocks over budget', frames, ...time(() => {for (let i = 0; i < frames; i++) frame(baseline, i);}, () => {for (let i = 0; i < frames; i++) frame(candidate, i);})});
}
await record('points', ref, cases, 'pickPoint pre-rejects on squared distance with a 1e-9 relative slack before the exact Math.hypot comparisons; allocateBudget precomputes clamped weights and sort keys.', pin);

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {OverlappingModel} from '../dist/overlapping.js';

// A 12 x 12 sample: rooms of walls (1) around floors (0) with doors (2).
const rows = [
  '111111111111',
  '100001000001',
  '100002000001',
  '100001000001',
  '111211111211',
  '100001000001',
  '100001000001',
  '100002000001',
  '111111111111',
  '100000000001',
  '100000000001',
  '111111111111',
];
const sample = {data: rows.join('').split('').map(Number), width: 12, height: 12};
// Every N x N window of the output (wrapping when periodic) must be a pattern of the sample under the 8 symmetries.
function windows(data, width, height, N, periodic) {
  const out = new Set();
  for (let y = 0; y < (periodic ? height : height - N + 1); y++) for (let x = 0; x < (periodic ? width : width - N + 1); x++) {
    let p = Array.from({length: N * N}, (_, i) => data[(x + i % N) % width + (y + Math.floor(i / N)) % height * width]);
    for (let k = 0; k < 4; k++) {out.add(p.join()); out.add(p.map((_, i) => p[N - 1 - i % N + Math.floor(i / N) * N]).join()); p = p.map((_, i) => p[N - 1 - Math.floor(i / N) + (i % N) * N]);}
  }
  return out;
}

test('output windows all come from the sample, seeded and repeatable', () => {
  const model = new OverlappingModel(sample, {N: 3}), allowed = windows(sample.data, 12, 12, 3, true);
  assert.ok(model.patterns > 10);
  for (const periodic of [false, true]) for (const seed of [1, 2, 3, 4]) {
    const image = model.solve(24, 20, {seed, periodic});
    assert.equal(image.length, 24 * 20);
    for (const w of windows(image, 24, 20, 3, periodic)) assert.ok(allowed.has(w), `window ${w} is not in the sample`);
    assert.deepEqual(model.solve(24, 20, {seed, periodic}), image);
  }
  assert.notDeepEqual(model.solve(24, 20, {seed: 1}), model.solve(24, 20, {seed: 2}));
  // Values are the sample's own values, not palette indices.
  const tinted = new OverlappingModel({...sample, data: sample.data.map(v => [0xff202020, 0xffa0a0a0, 0xff3060c0][v])}).solve(16, 16, {seed: 5});
  assert.ok([...tinted].every(v => [0xff202020, 0xffa0a0a0, 0xff3060c0].includes(v)));
});

test('backtracking recovers from contradictions where restarts alone fail', () => {
  // A small maze without symmetries is contradiction-prone: with no backtracking every one of these seeds fails.
  const maze = ['1111111', '1000001', '1011101', '1010001', '1010111', '1000001', '1111111'], mazeSample = {data: maze.join('').split('').map(Number), width: 7, height: 7};
  const model = new OverlappingModel(mazeSample, {N: 3, symmetry: 1}), allowed = new Set();
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) allowed.add(Array.from({length: 9}, (_, i) => mazeSample.data[(x + i % 3) % 7 + (y + Math.floor(i / 3)) % 7 * 7]).join());
  let failedWithout = 0, backtracked = 0;
  for (let seed = 1; seed <= 6; seed++) {
    try {model.solve(24, 24, {seed, periodic: true, backtracks: 0, attempts: 1});} catch {failedWithout++;}
    const image = model.solve(24, 24, {seed, periodic: true, backtracks: 3000, attempts: 1});
    backtracked += model.stats.backtracks; assert.equal(model.stats.attempts, 1);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) assert.ok(allowed.has(Array.from({length: 9}, (_, i) => image[(x + i % 3) % 24 + (y + Math.floor(i / 3)) % 24 * 24]).join()));
  }
  assert.equal(failedWithout, 6); assert.ok(backtracked > 0);
});

test('unsatisfiable outputs fail within the budget instead of hanging', () => {
  // Stripes with period 3 cannot wrap around a periodic width of 4: every start contradicts, every branch is exhausted.
  const stripes = {data: Array.from({length: 36}, (_, i) => i % 3), width: 6, height: 6};
  const model = new OverlappingModel(stripes, {N: 2, symmetry: 1});
  assert.throws(() => model.solve(4, 4, {periodic: true, attempts: 3}), /contradicted/);
  assert.equal(model.stats.attempts, 3);
  // A large budget on a large unsatisfiable grid still terminates (in a child process with a hard timeout).
  const code = `import {OverlappingModel} from ${JSON.stringify(new URL('../dist/overlapping.js', import.meta.url).href)};
    const m = new OverlappingModel({data: Array.from({length: 49}, (_, i) => (i % 7) % 3 + 3 * (Math.floor(i / 7) % 2)), width: 7, height: 7}, {N: 2});
    try {m.solve(31, 31, {periodic: true, backtracks: 100000, attempts: 2}); console.log('solved');} catch (e) {console.log(e.message.includes('contradicted') ? 'failed' : e.message);}`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 60000});
  assert.equal(run.error, undefined, 'solve did not return'); assert.match(run.stdout.trim(), /^(solved|failed)$/, run.stderr);
  assert.throws(() => new OverlappingModel(sample, {N: 6}), /pattern options/); assert.throws(() => new OverlappingModel(sample).solve(2, 2), /output size/);
});

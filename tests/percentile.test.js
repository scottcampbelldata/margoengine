import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSamples, distribution, median, nearestRank, percentile } from '../scripts/lib/percentile.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const oneTo = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('nearest rank: known sample sets give the textbook values', () => {
  const thousand = oneTo(1000).reverse();
  assert.equal(nearestRank(thousand, 99), 990);
  assert.equal(nearestRank(thousand, 95), 950);
  assert.equal(nearestRank(thousand, 50), 500);
  assert.equal(nearestRank(thousand, 99.9), 999);
  assert.equal(nearestRank(thousand, 100), 1000);
  assert.equal(nearestRank(thousand, 0.1), 1);
  // The usual worked example: 15, 20, 35, 40, 50.
  const five = [40, 15, 50, 20, 35];
  assert.deepEqual(
    [5, 30, 40, 50, 100].map((p) => nearestRank(five, p)),
    [15, 20, 20, 35, 50],
  );
  // Always a measured sample: the median of an even count is the lower middle one.
  assert.equal(median([4, 1, 3, 2]), 2);
  assert.equal(median([7]), 7);
  // With fewer than 100 samples the 99th percentile is the maximum (why the quiet phase takes 1000).
  assert.equal(percentile(oneTo(99), 99), 99);
  assert.equal(percentile(oneTo(100), 99), 99);
  assert.deepEqual(distribution([3, 1, 2, 4]), { count: 4, mean: 2.5, min: 1, median: 2, p95: 4, p99: 4, max: 4 });
  assert.equal(percentile(new Float64Array([3, 1, 2]), 50), 2);
});

test('nearest rank: the input is not reordered', () => {
  const values = [3, 1, 2];
  nearestRank(values, 50);
  assert.deepEqual(values, [3, 1, 2]);
});

test('broken sample sets fail loudly instead of becoming a number', () => {
  assert.throws(() => nearestRank([1, Number.NaN, 3], 50), /Sample 1 is NaN/);
  assert.throws(() => percentile([1, Number.POSITIVE_INFINITY], 95), RangeError);
  assert.throws(() => median([1, undefined, 3]), RangeError);
  assert.throws(() => median([1, null, 3]), RangeError);
  assert.throws(() => median(['1', 2]), RangeError);
  assert.throws(() => median([]), /0 samples/);
  assert.throws(() => nearestRank([], 50), /No samples/);
  assert.throws(() => distribution([]), RangeError);
  assert.throws(() => percentile([1, 2], 0), /outside/);
  assert.throws(() => percentile([1, 2], 101), /outside/);
  assert.throws(() => percentile([1, 2], Number.NaN), /outside/);
  // A run that declared 1000 samples and delivered fewer (or more) never reports a percentile.
  assert.throws(() => percentile(oneTo(999), 99, { count: 1000, label: 'frame times' }), /frame times: 999 samples/);
  assert.throws(() => median(oneTo(11), { count: 10 }), /declared 10/);
  assert.throws(() => median(oneTo(3), { min: 4 }), /at least 4/);
  assert.throws(() => checkSamples(null), /expected an array/);
  assert.equal(percentile(oneTo(1000), 99, { count: 1000 }), 990);
});

test('collect-performance.js carries an exact copy of nearestRank (a pasted console script cannot import)', () => {
  const source = readFileSync(join(root, 'scripts/collect-performance.js'), 'utf8').replace(/\r\n/g, '\n');
  const lines = (text) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const shared = lines(nearestRank.toString()),
    start = lines(source).indexOf(shared[0]);
  assert.ok(start >= 0, 'collect-performance.js has no nearestRank');
  assert.deepEqual(lines(source).slice(start, start + shared.length), shared);
});

// Every benchmark and performance script takes its percentiles from scripts/lib/percentile.mjs. A hand-written
// percentile index (sorted[Math.floor(n * 0.95)], sorted[n >> 1], ...) is how the two old rules got in; this scan fails
// on a new one. Files left out, each with its reason:
const LEFT_OUT = {
  // Pixel and value error statistics of correctness checks, not timings: their thresholds were set with these rules.
  'scripts/env-mirror-gpu-check.js': 'pixel difference p99 of an image check',
  'examples/package-benchmarks/oit-gpu.mjs': 'pixel error p95 against the reference',
  'examples/package-benchmarks/physical-gpu.mjs': 'relative error p95 against the CPU model',
  'examples/package-benchmarks/probes-gpu.mjs': 'radiance error median and p95 against bake-time truth',
  'examples/package-benchmarks/volumetric-gpu.mjs': 'per-step image change, not a timing',
  // Fixed budget gates whose rule picks the same or a higher sample than nearest rank: moving them would loosen the
  // budget by one rank, which is never done.
  'scripts/frame-alloc-browser.mjs': 'allocation budget on the averaged median',
  'scripts/support/visual-compat-pages.js': 'frame-time budget on the upper median',
  // Medians computed inside a browser page (page.evaluate or a page module that is not served the helper yet).
  'examples/package-benchmarks/gates/dof.mjs': 'in-page median, to port',
  'examples/package-benchmarks/gates/post-stack.mjs': 'in-page median, to port',
  'examples/package-benchmarks/large-coordinates.mjs': 'in-page median, to port',
  'examples/package-benchmarks/pipeline-toggles/toggle.js': 'in-page median, to port',
  'examples/package-benchmarks/proofs/animation-vat.proof.js': 'in-page median, to port',
  'examples/package-benchmarks/scatter-cull-gpu.mjs': 'in-page median, to port',
  'examples/package-benchmarks/ssr-gpu.mjs': 'in-page median, to port',
  'examples/package-benchmarks/ssr-models-gpu.mjs': 'in-page median, to port',
  'bench/web/app.js': 'results viewer that redraws stored medians, to port',
};
const AD_HOC = new RegExp(
  [
    // sorted[Math.floor(n * 0.95)], sorted[Math.ceil((n - 1) * f)], ...: a length times a fraction, not a random pick
    String.raw`\[\s*Math\.(?:floor|ceil|min)\((?![^\]\n]*(?:random|next)\(\))(?=[^\]\n]*length)[^\]\n]*\*`,
    // sorted[n >> 1] and sorted[Math.floor(n / 2)]
    String.raw`\[\s*[\w.]*length\s*>>\s*1\s*\]`,
    String.raw`\[\s*Math\.floor\(\s*[\w.]*length\s*\/\s*2\s*\)\s*\]`,
    // the averaged median: n % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    String.raw`%\s*2\s*\?\s*[\w.]+\[[^\]\n]+\]\s*:\s*\(`,
    String.raw`\(\s*sorted\[[^\]\n]+\]\s*\+\s*sorted\[`,
    // any fraction of a sorted set: sorted[Math.floor((n - 1) * 0.95)]
    String.raw`sorted\[\s*Math\.(?:floor|ceil|min)\([^\]\n]*\*`,
    // fixed indexes into a sorted set: durations[45]
    String.raw`durations\[\d+\]`,
  ].join('|'),
);

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'vendor') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(?:js|mjs)$/.test(entry.name)) yield path;
  }
}

test('no benchmark or performance script computes a percentile by hand', () => {
  const found = [],
    stale = new Set(Object.keys(LEFT_OUT));
  for (const folder of ['scripts', 'bench', 'examples/package-benchmarks', 'tools'])
    for (const path of sources(join(root, folder))) {
      const name = relative(root, path).replaceAll('\\', '/');
      if (name === 'scripts/lib/percentile.mjs') continue;
      const hits = readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => AD_HOC.test(line) && !/^\s*\/\//.test(line));
      if (!hits.length) continue;
      stale.delete(name);
      if (!(name in LEFT_OUT)) found.push(...hits.map(([line, text]) => `${name}:${line}: ${text.trim()}`));
    }
  assert.deepEqual(found, [], 'use scripts/lib/percentile.mjs (nearest rank, throws on NaN or a short set)');
  assert.deepEqual([...stale], [], 'these files no longer compute a percentile by hand: drop them from LEFT_OUT');
});

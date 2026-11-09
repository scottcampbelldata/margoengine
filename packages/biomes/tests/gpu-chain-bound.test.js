// docs/known-bugs.md, "biomes test:gpu on the Intel Arc laptop: every check OK, then killed at 600 s". The kill could not
// be reproduced on the dev PC, so this bounds it where it can be checked without a GPU: no browser check may be able to
// sit past its step limit unnoticed. Every biomes GPU step (a) has a measured time on the RTX A6000 that fits its limit
// with a margin for a machine several times slower, (b) runs only check files that end through `runSuite` (a failed
// check exits at once, teardown bounded) and `watchExit` (a finished suite that does not end in 30 s exits 1 naming the
// open handle), and (c) chains at most two check files, so one stuck page cannot hold a long chain. Measured times
// (RTX A6000, one run in a shared slot, 2026-10-30): the whole chain was 431.5 s, of it view 2.8 s, objects 14.9 s,
// flythrough 413.7 s. A new step or a longer check must add its own measured row here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageMinutes, testLimitMs } from '../../../scripts/support/run-limited.mjs';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Seconds measured on the RTX A6000 for each GPU script. Scripts not listed here have no recorded time yet. */
const MEASURED = {
  'test:gpu': 2.8 + 14.9,
  'test:gpu:objects': 14.9,
  'test:gpu:flythrough': 413.7,
  // Full unchanged prefetch proof, including its queue wait (prefetch-final-gpu-proof.json, 2026-11-09).
  'test:gpu:prefetch': 118.9,
};
/** The laptop is up to this many times slower on CPU-bound steps (the Arc ran a 13.1 s case in 61.3 s). */
const SLOWEST_MACHINE = 1.4;

const gpuScripts = Object.entries(manifest.scripts).filter(([name]) => name.startsWith('test:gpu'));
const filesOf = (command) => [...command.matchAll(/packages\/biomes\/tests\/([\w-]+\.mjs)/g)].map((m) => m[1]);

test('every biomes GPU step has a limit of its own that covers its measured time with a margin', () => {
  for (const [name, seconds] of Object.entries(MEASURED)) {
    assert.ok(manifest.scripts[name], `${name} exists`);
    const limit = testLimitMs(packageMinutes(manifest.margo.gpuTestTimeoutMinutes, name), {}) / 1000;
    assert.ok(
      limit >= seconds * SLOWEST_MACHINE,
      `${name}: limit ${limit} s, measured ${seconds} s x ${SLOWEST_MACHINE}`,
    );
  }
  // The flythrough ran 72 percent of the old shared 600 s; it must not fall back under the default.
  const fly = testLimitMs(packageMinutes(manifest.margo.gpuTestTimeoutMinutes, 'test:gpu:flythrough'), {});
  assert.ok(fly > 600_000, 'the flythrough keeps its longer limit');
});

test('the 431 s chain stays split: no GPU script runs more than two check files', () => {
  assert.ok(gpuScripts.length >= 5);
  for (const [name, command] of gpuScripts) {
    const files = filesOf(command);
    assert.ok(files.length >= 1, `${name} runs a check file`);
    assert.ok(files.length <= 2, `${name} chains ${files.length} checks: ${files.join(', ')}`);
  }
  assert.deepEqual(
    filesOf(manifest.scripts['test:gpu:flythrough']),
    ['flythrough-check.mjs'],
    'the timing test runs alone',
  );
});

test('every check file a biomes GPU script runs ends through runSuite and watchExit', () => {
  const seen = new Set();
  for (const [name, command] of gpuScripts)
    for (const file of filesOf(command)) {
      seen.add(file);
      const text = readFileSync(join(root, 'tests', file), 'utf8');
      assert.match(text, /\brunSuite\(/, `${file} (${name}) ends through runSuite`);
      assert.match(text, /\bwatchExit\(/, `${file} (${name}) calls watchExit`);
    }
  assert.ok(seen.size >= 5, 'the scripts name their check files');
});

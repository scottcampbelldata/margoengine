// runMinutes (scripts/gpu-package-tests.mjs) and its use in scripts/record-wgsl-corpus.mjs. A full WGSL corpus record
// on the Radeon 680M (2026-11-08) stopped check:gpu-packages at its 30-minute suite cap with nothing hung: tests 1 to
// 111 of 193 had run and reported, and the one running (shadows test:gpu:vsm) takes 9 s alone. Every test of that
// script is ended at its own limit, so the whole run's limit is the sum of those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { holdMinutes, runMinutes } from '../scripts/gpu-package-tests.mjs';

const tests = [
    { label: 'shadows test:gpu', dir: 'shadows', script: 'test:gpu', minutes: 10 },
    { label: 'shadows test:gpu:vsm', dir: 'shadows', script: 'test:gpu:vsm', minutes: 10 },
    { label: 'sky test:gpu', dir: 'sky', script: 'test:gpu', minutes: 20 },
  ],
  profile = { name: 'test', split: false };
const holds = (...picked) => picked.reduce((sum, t) => sum + holdMinutes(t), 0);

test('a whole run may take the sum of its tests hold limits', () => {
  assert.equal(runMinutes('check:gpu-packages -- --no-build', tests, profile), holds(...tests));
  // 193 tests at even the shortest hold are far past 30 minutes.
  assert.ok(holds(tests[0]) * 193 > 30);
});

test('--select and --only narrow the sum to the tests that run', () => {
  assert.equal(runMinutes('check:gpu-packages -- --select=shadows/test:gpu:vsm', tests, profile), holds(tests[1]));
  assert.equal(runMinutes('check:gpu-packages -- --only=shadows', tests, profile), holds(tests[0], tests[1]));
  assert.equal(runMinutes('check:gpu-packages -- --select=nothing/here', tests, profile), 0);
});

test('a test the machine profile excludes adds nothing', () => {
  const excluding = { ...profile, exclude: { sky: 'no sky here' } };
  assert.equal(runMinutes('check:gpu-packages', tests, excluding), holds(tests[0], tests[1]));
});

test('the corpus recorder gives check:gpu-packages that sum, never less than its suite cap', () => {
  const source = readFileSync(new URL('../scripts/record-wgsl-corpus.mjs', import.meta.url), 'utf8');
  assert.match(source, /\/\^check:gpu-packages\(\\s\|\$\)\/\.test\(suite\) \? Math\.max\(limitMs, runMinutes\(suite\)/);
});

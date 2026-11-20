// AGENTS.md "Build phase": no benchmark or timing assertion runs in a correctness gate while scripts/speed-phase.json
// says `deferred`. A GPU test whose file carries the header `// timing test: deferred in the build phase` is a timing
// test: check:gpu-packages leaves it out and names it as deferred, and runs it after every shared step, alone, once the
// phase is `active`. No lock is involved (KB-TIMING-INGATE1: the lock removal of 80ca93fe2c took the marker away).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMING_TEST, plan, splitTiming } from '../scripts/gpu-package-tests.mjs';

const root = join(import.meta.dirname, '..');
const SPEED_FILES = ['packages/biomes/tests/flythrough-speed.mjs', 'packages/biomes/tests/objects-frame-speed.mjs'];

test('the header marks a timing test', () => {
  assert.ok(TIMING_TEST.test('// x\n// timing test: deferred in the build phase\n// y'));
  assert.ok(!TIMING_TEST.test('// A timing test: run it on a quiet machine.'));
  assert.ok(!TIMING_TEST.test('const s = "// timing test: deferred in the build phase";'));
});

test('every speed suite of the gate carries the header and defers itself', () => {
  for (const file of SPEED_FILES) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.match(text, TIMING_TEST, `${file} has no timing-test header`);
    assert.match(text, /deferSpeed\(/, `${file} does not defer itself in the build phase`);
  }
});

test('the plan flags exactly the timing tests', () => {
  const flagged = plan()
    .filter((t) => t.timing)
    .map((t) => t.label)
    .sort();
  assert.deepEqual(flagged, ['biomes test:gpu:flythrough:speed', 'biomes test:gpu:objects-frame:speed']);
});

test('splitTiming leaves timing steps out and names them while the speed phase is deferred', () => {
  const steps = [{ label: 'a' }, { label: 'b', timing: true }, { label: 'c' }, { label: 'd', timing: true }];
  const named = [];
  const off = splitTiming(steps, { active: false, defer: (label) => named.push(label) });
  assert.deepEqual(
    off.shared.map((s) => s.label),
    ['a', 'c'],
  );
  assert.deepEqual(off.timing, []);
  assert.deepEqual(named, ['b', 'd']);
  const on = splitTiming(steps, { active: true, defer: () => assert.fail('nothing is deferred when active') });
  assert.deepEqual(
    on.shared.map((s) => s.label),
    ['a', 'c'],
  );
  assert.deepEqual(
    on.timing.map((s) => s.label),
    ['b', 'd'],
  );
});

test('check:gpu-packages lists no timing test in the build phase and announces each as deferred', () => {
  const run = spawnSync(process.execPath, ['scripts/gpu-package-tests.mjs', '--list'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MARGO_SPEED_PHASE: 'deferred' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(
    run.stdout,
    /^biomes test:gpu:(flythrough|objects-frame):speed: [(]/m,
    'a timing test is in the correctness plan',
  );
  assert.match(run.stdout, /SPEED DEFERRED: biomes test:gpu:flythrough:speed/);
  assert.match(run.stdout, /SPEED DEFERRED: biomes test:gpu:objects-frame:speed/);
});

test('with the speed phase active the plan lists the timing tests', () => {
  const run = spawnSync(process.execPath, ['scripts/gpu-package-tests.mjs', '--list'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MARGO_SPEED_PHASE: 'active' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^biomes test:gpu:flythrough:speed: [(]/m);
  assert.match(run.stdout, /^biomes test:gpu:objects-frame:speed: [(]/m);
  assert.doesNotMatch(run.stdout, /SPEED DEFERRED/);
});

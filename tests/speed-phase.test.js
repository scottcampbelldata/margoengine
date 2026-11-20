import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { speedBudget, speedBudgetNames } from '../scripts/speed/budgets.mjs';
import { pathToFileURL } from 'node:url';
import { deferSpeedEntry, speedPhase } from '../scripts/support/speed-phase.mjs';
import { time } from '../examples/package-benchmarks/proofs/compare.js';

test('one checked-in phase defaults to deferred; invalid phases fail closed', () => {
  assert.equal(JSON.parse(readFileSync('scripts/speed-phase.json', 'utf8')).phase, 'deferred');
  assert.equal(speedPhase({}), 'deferred');
  assert.equal(speedPhase({ MARGO_SPEED_PHASE: 'active' }), 'active');
  assert.throws(() => speedPhase({ MARGO_SPEED_PHASE: 'activ' }), { code: 'ERR_SPEED_PHASE' });
});

test('deferSpeedEntry defers only the deferred entry, never an import or a listing run', () => {
  const previous = process.env.MARGO_SPEED_PHASE;
  const entry = pathToFileURL(process.argv[1]).href;
  try {
    process.env.MARGO_SPEED_PHASE = 'deferred';
    assert.equal(deferSpeedEntry(entry, 'speed-phase test entry', ['node', process.argv[1]]), true);
    assert.equal(deferSpeedEntry('file:///elsewhere.mjs', 'speed-phase test import', ['node', process.argv[1]]), false);
    for (const flag of ['--help', '-h', '--list'])
      assert.equal(deferSpeedEntry(entry, 'speed-phase test listing', ['node', process.argv[1], flag]), false, flag);
    process.env.MARGO_SPEED_PHASE = 'active';
    assert.equal(deferSpeedEntry(entry, 'speed-phase test active', ['node', process.argv[1]]), false);
  } finally {
    if (previous === undefined) delete process.env.MARGO_SPEED_PHASE;
    else process.env.MARGO_SPEED_PHASE = previous;
  }
});

test('the release inventory names every retained timing assertion and executable source', () => {
  const cases = JSON.parse(readFileSync('scripts/speed/cases.json', 'utf8'));
  const suites = JSON.parse(readFileSync('scripts/speed/suites.json', 'utf8'));
  for (const name of speedBudgetNames)
    assert.ok(
      cases.some((item) => item.id === name),
      name,
    );
  for (const item of cases) {
    assert.ok(item.budget.length > 0, item.id);
    assert.ok(existsSync(item.file), item.file);
  }
  for (const suite of suites) assert.ok(Number.isFinite(suite.limitMinutes) && suite.limitMinutes > 0, suite.id);
  const sources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    timeout: 10000,
  }).split('\n');
  for (const file of sources.filter((file) => /^(bench|scripts|examples|packages)\/.*\.[cm]?js$/.test(file))) {
    if (!/\b(?:is|defer)SpeedEntry\(import\.meta\.url\b/.test(readFileSync(file, 'utf8'))) continue;
    // This file is a child-only worker, with arguments supplied by the sandbox benchmark.
    const entry =
      file === 'examples/voxel-sandbox/test/shard-bench-process.mjs' ? 'examples/voxel-sandbox/bench.mjs' : file;
    assert.ok(
      suites.some((suite) => suite.command.includes(entry)),
      `${file}: deferred entry missing from the release manifest`,
    );
  }
});

test('deferred budgets never read their values; active speed suite retains exact limits', () => {
  const previous = process.env.MARGO_SPEED_PHASE;
  try {
    process.env.MARGO_SPEED_PHASE = 'deferred';
    assert.deepEqual(
      time(
        () => assert.fail('baseline ran'),
        () => assert.fail('candidate ran'),
      ),
      { deferred: true },
    );
    speedBudget('points-las', { cpu: () => assert.fail('deferred speed assertion ran') });
    process.env.MARGO_SPEED_PHASE = 'active';
    speedBudget('points-las', { cpu: () => 149.999 });
    assert.throws(() => speedBudget('points-las', { cpu: () => 150 }), assert.AssertionError);
    speedBudget('geometry-circle', { ms: 299.999, reference: 100, count: 100000 });
    assert.throws(
      () => speedBudget('geometry-circle', { ms: 300, reference: 100, count: 100000 }),
      assert.AssertionError,
    );
  } finally {
    if (previous === undefined) delete process.env.MARGO_SPEED_PHASE;
    else process.env.MARGO_SPEED_PHASE = previous;
  }
});

test('a release speed run cannot succeed by listing or narrowing the manifest', { timeout: 30_000 }, () => {
  for (const option of ['--list', '--only=geometry']) {
    const run = spawnSync(process.execPath, ['scripts/speed-suite.mjs', '--release', option], {
      env: { ...process.env, MARGO_SPEED_PHASE: 'deferred' },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.notEqual(run.status, 0, `${option} bypassed the release speed gate`);
    assert.match(run.stderr, /release.*whole manifest|whole manifest.*release/i);
  }
});

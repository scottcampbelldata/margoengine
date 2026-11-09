import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { speedBudget, speedBudgetNames } from '../scripts/speed/budgets.mjs';
import { speedPhase } from '../scripts/support/speed-phase.mjs';
import { time } from '../examples/package-benchmarks/proofs/compare.js';
import { exclusiveApproval } from '../scripts/gpu-lock.mjs';

test('one checked-in phase defaults to deferred; invalid phases fail closed', () => {
  assert.equal(JSON.parse(readFileSync('scripts/speed-phase.json', 'utf8')).phase, 'deferred');
  assert.equal(speedPhase({}), 'deferred');
  assert.equal(speedPhase({ MARGO_SPEED_PHASE: 'active' }), 'active');
  assert.throws(() => speedPhase({ MARGO_SPEED_PHASE: 'activ' }), { code: 'ERR_SPEED_PHASE' });
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
    if (!readFileSync(file, 'utf8').includes('isSpeedEntry(import.meta.url)')) continue;
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

test('default bench, timing run and enqueue start no child, holder or ticket', { timeout: 60_000 }, (t) => {
  mkdirSync('test-results', { recursive: true });
  const folder = mkdtempSync(resolve('test-results/speed-phase-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const lock = join(folder, 'gpu.lock');
  const env = { ...process.env, MARGO_SPEED_PHASE: 'deferred', MARGO_GPU_LOCK: lock, npm_lifecycle_event: '' };
  delete env.MARGO_GPU_EXCLUSIVE;
  delete env.MARGO_GPU_LOCK_NESTED;
  delete env.MARGO_GPU_LOCK_NESTED_MODE;
  for (const args of [
    ['bench/cli.mjs', 'math'],
    ['scripts/visual-compat-budget.mjs'],
    ['packages/biomes/tests/flythrough-speed.mjs'],
    ['scripts/speed-suite.mjs'],
    ...['run', 'enqueue'].map((verb) => [
      'scripts/gpu-lock.mjs',
      verb,
      '--owner=phase-test',
      '--timing=fake speed probe',
      '--',
      process.execPath,
      '-e',
      'throw new Error("child ran")',
    ]),
  ]) {
    const run = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (args[0] === 'scripts/gpu-lock.mjs') {
      assert.notEqual(run.status, 0, `${args.join(' ')} must refuse exclusive access`);
      assert.match(run.stderr, /ERR_SPEED_PHASE_DEFERRED/);
    } else {
      assert.equal(run.status, 0, `${args.join(' ')}\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /SPEED DEFERRED/);
    }
  }
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${lock}-waiting`), false);
  assert.equal(existsSync(`${lock}-jobs`), false);
  const refusals = readFileSync(join(folder, 'gpu-lock-refusals.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(refusals.length, 2);
  assert.ok(refusals.every((entry) => entry.code === 'ERR_SPEED_PHASE_DEFERRED'));
  const release = spawnSync(process.execPath, ['scripts/speed-suite.mjs', '--release'], {
    env,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /ERR_SPEED_PHASE_RELEASE_REQUIRED/);
});

test('only an exact, documented, approved and unexpired coordinator exception matches', () => {
  assert.ok(Array.isArray(JSON.parse(readFileSync('scripts/gpu-exclusive-allow.json', 'utf8'))));
  const now = Date.parse('2026-11-10T00:00:00Z');
  const entry = {
    command: 'node exceptional-gpu-check.mjs',
    reason: 'fixture reason',
    approvedBy: 'Scott via coordinator (fixture)',
    expiry: '2026-11-10T01:00:00Z',
  };
  assert.equal(exclusiveApproval(entry.command, [entry], now), entry);
  for (const invalid of [
    null,
    { ...entry, expiry: '2026-11-09T23:59:59Z' },
    { ...entry, expiry: 'never' },
    { ...entry, approvedBy: '' },
    { ...entry, reason: '' },
    { ...entry, command: 'node *' },
  ])
    assert.equal(exclusiveApproval(entry.command, [invalid], now), undefined);
  assert.equal(exclusiveApproval(`${entry.command} --other-scene`, [entry], now), undefined);
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

test('direct exclusive API cannot enter the GPU during deferral', { timeout: 30_000 }, (t) => {
  mkdirSync('test-results', { recursive: true });
  const folder = mkdtempSync(resolve('test-results/speed-api-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const lock = join(folder, 'gpu.lock');
  const url = new URL('../scripts/gpu-lock.mjs', import.meta.url).href;
  for (const mode of ['exclusive', 'shared', undefined]) {
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {acquire} from ${JSON.stringify(url)}; await acquire({owner:'probe',mode:${JSON.stringify(mode)},timing:'fake regression'});`,
      ],
      {
        env: { ...process.env, MARGO_SPEED_PHASE: 'deferred', MARGO_GPU_LOCK: lock },
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /ERR_SPEED_PHASE_DEFERRED/);
    assert.equal(existsSync(lock), false);
  }
});

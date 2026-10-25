// Generated records and rebases (scripts/merge-driver.mjs, scripts/land-records.mjs): the quality baselines merge item by
// item and only ever shrink, the pure-output files keep main's copy for the landing script to regenerate, and a real
// `git rebase` over two landings that both rewrote them stops on no conflict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DERIVED, RATCHET, mergeRatchet } from '../scripts/support/derived-records.mjs';
import { DRIVERS, setupMergeDrivers } from '../scripts/setup-merge-drivers.mjs';
import { STEPS, pairedRecords } from '../scripts/land-records.mjs';

const root = resolve(import.meta.dirname, '..');
const baseline = (items, history = [], extra = {}) => ({
  gate: 'sizes',
  about: 'budgets',
  total: Object.values(items).reduce((a, b) => a + b, 0),
  history,
  items,
  ...extra,
});
const entry = (reason) => ({ date: '2026-10-25', commit: 'abc1234', reason, grew: 1 });

test('mergeRatchet: a change on one side is kept, on both sides the smaller limit wins', () => {
  const base = baseline({ a: 100, b: 200, c: 300, d: 400 });
  const ours = baseline({ a: 90, b: 200, c: 250, d: 400 });
  const theirs = baseline({ a: 100, b: 150, c: 280, d: 400 });
  const merged = mergeRatchet(base, ours, theirs);
  assert.deepEqual(merged.items, { a: 90, b: 150, c: 250, d: 400 });
  assert.equal(merged.total, 890);
});

test('mergeRatchet never widens a limit: growth on one side against a shrink on the other keeps the shrink', () => {
  const base = baseline({ a: 100 });
  const merged = mergeRatchet(base, baseline({ a: 80 }), baseline({ a: 300 }));
  assert.equal(merged.items.a, 80);
});

test('mergeRatchet keeps added items, drops items one side fixed, and sorts the keys', () => {
  const base = baseline({ fixed: 5, stays: 1 });
  const ours = baseline({ stays: 1, 'z-new': 2 });
  const theirs = baseline({ fixed: 5, stays: 1, 'a-new': 3 });
  const merged = mergeRatchet(base, ours, theirs);
  assert.deepEqual(Object.keys(merged.items), ['a-new', 'stays', 'z-new']);
  assert.equal(merged.items.fixed, undefined);
});

test('mergeRatchet keeps every reasoned history entry once, base first', () => {
  const first = entry('first'),
    mine = entry('mine'),
    yours = entry('yours');
  const merged = mergeRatchet(
    baseline({ a: 1 }, [first]),
    baseline({ a: 1 }, [first, mine]),
    baseline({ a: 1 }, [first, yours, mine]),
  );
  assert.deepEqual(merged.history, [first, mine, yours]);
});

test('mergeRatchet takes about and unknown fields from the side that changed them', () => {
  const base = baseline({ a: 1 }, [], { note: 'old' });
  const merged = mergeRatchet(base, baseline({ a: 1 }, [], { note: 'old' }), {
    ...baseline({ a: 1 }, [], { note: 'new' }),
    about: 'budgets, reworded',
  });
  assert.equal(merged.about, 'budgets, reworded');
  assert.equal(merged.note, 'new');
});

test('.gitattributes routes every derived and ratcheting path to a registered driver', () => {
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8');
  for (const path of DERIVED)
    assert.match(
      attributes,
      new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} merge=margo-derived\\s*$`, 'm'),
    );
  for (const path of RATCHET)
    assert.match(
      attributes,
      new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} merge=margo-ratchet\\s*$`, 'm'),
    );
  assert.deepEqual(Object.keys(DRIVERS).sort(), ['margo-derived', 'margo-ratchet']);
});

test('land-records regenerates API reports and baselines before the size records, GPU step last', () => {
  assert.deepEqual(
    STEPS.map((step) => step.name),
    ['build', 'api reports', 'quality baselines', 'entry sizes', 'basic-scene network'],
  );
  assert.deepEqual(
    STEPS.filter((step) => step.gpu).map((step) => step.name),
    ['basic-scene network'],
  );
});

test('pairedRecords refuses size records that name different commits or a dirty tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-paired-'));
  try {
    const results = join(dir, 'examples/package-benchmarks/results');
    mkdirSync(results, { recursive: true });
    const write = (sizes, network) => {
      writeFileSync(join(results, 'entry-sizes.json'), JSON.stringify(sizes));
      writeFileSync(join(results, 'basic-scene-network.json'), JSON.stringify(network));
    };
    write({ commit: 'aaaaaaaa', dirty: false }, { commit: 'aaaaaaaa', dirty: false });
    assert.equal(pairedRecords(dir), 'aaaaaaaa');
    write({ commit: 'aaaaaaaa', dirty: false }, { commit: 'bbbbbbbb', dirty: false });
    assert.throws(() => pairedRecords(dir), /measured bbbbbbbb, entry-sizes\.json aaaaaaaa/);
    write({ commit: 'aaaaaaaa', dirty: true }, { commit: 'aaaaaaaa', dirty: true });
    assert.throws(() => pairedRecords(dir), /dirty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch repository holding the driver scripts, the attributes and one generated file of each kind. */
function scratch({ register }) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-rebase-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, 'scripts/support'), { recursive: true });
  for (const file of ['scripts/merge-driver.mjs', 'scripts/support/derived-records.mjs'])
    cpSync(join(root, file), join(dir, file));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    join(dir, '.gitattributes'),
    'api/*.api.md merge=margo-derived\nrecords/entry-sizes.json merge=margo-derived\nscripts/quality/baselines/*.json merge=margo-ratchet\n',
  );
  if (register) setupMergeDrivers(dir);
  return { dir, git };
}

function landing(dir, git, { api, size, items, reason }) {
  mkdirSync(join(dir, 'api'), { recursive: true });
  mkdirSync(join(dir, 'records'), { recursive: true });
  mkdirSync(join(dir, 'scripts/quality/baselines'), { recursive: true });
  writeFileSync(join(dir, 'api/core.api.md'), api);
  writeFileSync(join(dir, 'records/entry-sizes.json'), JSON.stringify({ size }, null, 2) + '\n');
  writeFileSync(
    join(dir, 'scripts/quality/baselines/sizes.json'),
    JSON.stringify(baseline(items, reason ? [entry(reason)] : []), null, 2) + '\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', reason ?? 'landing');
}

function divergingLandings(register) {
  const { dir, git } = scratch({ register });
  landing(dir, git, { api: 'one\ntwo\nthree\n', size: 1, items: { a: 100, b: 100 } });
  git('checkout', '-q', '-b', 'work');
  landing(dir, git, { api: 'one\ntwo\nthree\nwork\n', size: 3, items: { a: 100, b: 90 }, reason: 'work shrank b' });
  git('checkout', '-q', 'main');
  landing(dir, git, { api: 'one\ntwo\nthree\nmain\n', size: 2, items: { a: 80, b: 100 }, reason: 'main shrank a' });
  git('checkout', '-q', 'work');
  return { dir, git };
}

test('a rebase over a landing that rewrote the same generated files has no conflict', () => {
  const { dir, git } = divergingLandings(true);
  try {
    git('rebase', 'main');
    assert.equal(git('status', '--porcelain'), '');
    // Derived files keep main's copy (the landing script regenerates them from the rebased tree).
    assert.equal(readFileSync(join(dir, 'api/core.api.md'), 'utf8'), 'one\ntwo\nthree\nmain\n');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'records/entry-sizes.json'), 'utf8')), { size: 2 });
    // The baseline keeps both landings' shrinks and both reasons.
    const merged = JSON.parse(readFileSync(join(dir, 'scripts/quality/baselines/sizes.json'), 'utf8'));
    assert.deepEqual(merged.items, { a: 80, b: 90 });
    assert.deepEqual(
      merged.history.map((h) => h.reason),
      ['main shrank a', 'work shrank b'],
    );
    assert.equal(merged.total, 170);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without the registered drivers the same rebase stops on conflicts (what the drivers remove)', () => {
  const { dir, git } = divergingLandings(false);
  try {
    assert.throws(() => git('rebase', 'main'), /conflict|CONFLICT/i);
  } finally {
    try {
      git('rebase', '--abort');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

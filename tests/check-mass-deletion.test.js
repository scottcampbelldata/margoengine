// check:mass-deletion over a temporary git repo with scripted commits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { scan } from '../scripts/check-mass-deletion.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mass-deletion-'));
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
const put = (name, text) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
};
const commit = (subject, body = '') => {
  git('add', '-A');
  git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  return git('rev-parse', 'HEAD').trim();
};
/** Offending codes of the one commit `sha`. */
const codes = (sha) => scan(dir, { range: `${sha}~1..${sha}` }).bad.map((b) => b.code);
const many = (prefix, n, lines = 1) => {
  for (let i = 0; i < n; i++) put(`${prefix}/f${i}.js`, 'x\n'.repeat(lines));
};

test.before(() => git('init', '-q'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a 60-file deletion fails, and passes with the approval line and a reason', () => {
  many('a', 60);
  commit('add a');
  git('rm', '-rq', 'a');
  assert.deepEqual(codes(commit('remove a')), ['MASS-DELETION']);
  many('b', 60);
  commit('add b');
  git('rm', '-rq', 'b');
  const approved = commit('remove b', 'Mass-deletion-approved-by: Scott Campbell\nThe package moved to its own repo.');
  assert.deepEqual(codes(approved), []);
  many('c', 60);
  commit('add c');
  git('rm', '-rq', 'c');
  assert.deepEqual(codes(commit('remove c', 'Mass-deletion-approved-by: Scott Campbell')), ['MASS-DELETION']);
});

test('a 30,000-line removal fails; generated files do not count', () => {
  put('big.js', 'x\n'.repeat(30_000));
  put('api/core.api.md', 'x\n'.repeat(30_000));
  commit('add big');
  put('big.js', '');
  assert.deepEqual(codes(commit('empty big')), ['MASS-DELETION']);
  put('api/core.api.md', '');
  assert.deepEqual(codes(commit('empty generated')), []);
});

test('a sync: commit reverting 12 files fails; the same in a normal commit passes', () => {
  many('s', 12, 5);
  commit('add s');
  many('s', 12, 2);
  assert.deepEqual(codes(commit('sync: private main abc')), ['SYNC-REVERT']);
  many('s', 12, 1);
  assert.deepEqual(codes(commit('refactor s')), []);
});

test('a commit made from a stale tree fails STALE-REVERT; naming the undone commit lets it through', () => {
  // The 3bcef614ed shape: a reset onto a newer main with the working tree still on the older one.
  for (const f of ['x1', 'x2', 'x3', 'x4']) put(`st/${f}.js`, `${f} old\n`);
  commit('add st');
  for (const f of ['x1', 'x2', 'x3']) put(`st/${f}.js`, `${f} new\n`);
  put('st/added.js', 'added by the other lane\n');
  const other = commit('feat: another lane changes st');
  for (const f of ['x1', 'x2', 'x3']) put(`st/${f}.js`, `${f} old\n`);
  rmSync(join(dir, 'st/added.js'));
  put('st/x4.js', 'x4 mine\n');
  const stale = commit('feat: my change from a stale tree');
  const [bad] = scan(dir, { range: `${stale}~1..${stale}` }).bad;
  assert.equal(bad.code, 'STALE-REVERT');
  assert.match(bad.message, /puts 3 files back/);
  assert.ok(bad.message.includes(other.slice(0, 10)));
  git('reset', '-q', '--hard', other);
  for (const f of ['x1', 'x2', 'x3']) put(`st/${f}.js`, `${f} old\n`);
  rmSync(join(dir, 'st/added.js'));
  assert.deepEqual(codes(commit('fix: undo the other lane', `Reverts: ${other.slice(0, 10)} it broke st`)), []);
  for (const f of ['x1', 'x2', 'x3']) put(`st/${f}.js`, `${f} new\n`);
  put('st/added.js', 'added by the other lane\n');
  const back = commit('Revert "fix: undo the other lane"', 'This reverts commit 0123abc.');
  assert.deepEqual(codes(back), ['STALE-REVERT'], 'a revert line naming another commit does not cover this one');
});

test('putting two files back, or editing a file to new bytes, passes', () => {
  for (const f of ['y1', 'y2', 'y3']) put(`tw/${f}.js`, `${f} old\n`);
  commit('add tw');
  for (const f of ['y1', 'y2', 'y3']) put(`tw/${f}.js`, `${f} new\n`);
  commit('change tw');
  put('tw/y1.js', 'y1 old\n');
  put('tw/y2.js', 'y2 old\n');
  put('tw/y3.js', 'y3 newer\n');
  assert.deepEqual(codes(commit('put two back')), []);
});

test('a normal commit passes', () => {
  put('n.js', 'one\n');
  assert.deepEqual(codes(commit('add n')), []);
});

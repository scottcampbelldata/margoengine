// Regression: a rebase conflict resolved by hand left its markers in docs/known-bugs.md on main (commit 9f8c8a24d), and
// no check read for them. No tracked text file may keep a line that opens or closes a conflict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('no tracked file holds a conflict marker', () => {
  const found = spawnSync('git', ['grep', '-nIE', '^(<<<<<<<|>>>>>>>) '], { encoding: 'utf8' });
  assert.ok(found.status === 0 || found.status === 1, `git grep failed: ${found.stderr}`);
  assert.equal(found.stdout, '', 'finish the merge and take the markers out');
});

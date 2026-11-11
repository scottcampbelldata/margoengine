// scripts/worktree-report.mjs tells the coordinator which folders and branches still hold work that is not on main.
// A wrong verdict would let finished folders pile up on the drive or send unlanded work to the bin.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { collect, verdict } from '../scripts/worktree-report.mjs';

test('unlanded commits or changed files are never marked for deletion', () => {
  assert.match(verdict({ kind: 'worktree', ahead: 3, dirty: 0 }), /^unlanded work/);
  assert.match(verdict({ kind: 'worktree', ahead: 0, dirty: 2 }), /^unlanded work/);
  assert.match(verdict({ kind: 'branch', ahead: 1, dirty: 0 }), /^unlanded work/);
});

test('a worktree or branch with nothing unlanded is marked for deletion', () => {
  assert.match(verdict({ kind: 'worktree', ahead: 0, dirty: 0 }), /^nothing unlanded: delete/);
  assert.match(verdict({ kind: 'branch', ahead: 0, dirty: 0 }), /^nothing unlanded: delete/);
});

test('the main checkout, remote branches and stray folders get their own verdicts', () => {
  assert.equal(verdict({ kind: 'main', ahead: 5, dirty: 5 }), 'main checkout');
  assert.match(verdict({ kind: 'remote' }), /^remote branch/);
  assert.match(verdict({ kind: 'folder' }), /^not a worktree/);
});

test('this checkout reports itself once, as the main checkout or a worktree', () => {
  const root = resolve(import.meta.dirname, '..');
  const { rows } = collect(root);
  const self = rows.filter((row) => row.path && row.path.toLowerCase() === root.toLowerCase());
  assert.equal(self.length, 1);
  assert.ok(self[0].kind === 'main' || self[0].kind === 'worktree');
  for (const row of rows) assert.equal(typeof row.verdict, 'string');
});

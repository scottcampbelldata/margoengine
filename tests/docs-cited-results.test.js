// Regression: commit 5225908a6 cited two docs/whitepaper/results files (size pair, compose timeout) it never committed,
// and only the full verify's docs:links noticed. hygiene now fails when a doc cites an untracked results file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingCitedResults } from '../scripts/support/cited-results.mjs';

const root = join(import.meta.dirname, '..');

test('every cited whitepaper results file is tracked', () => {
  assert.deepEqual(missingCitedResults(root), []);
});

test('an untracked cited results file is reported, a tracked one is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cited-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, timeout: 30_000 });
    git('init', '-q');
    mkdirSync(join(dir, 'docs/whitepaper/results'), { recursive: true });
    writeFileSync(join(dir, 'docs/whitepaper/results/have.json'), '{}');
    writeFileSync(join(dir, 'docs/a.md'), '[x](whitepaper/results/have.json) [y](whitepaper/results/gone.json)\n');
    git('add', '-A');
    assert.deepEqual(missingCitedResults(dir).sort(), ['docs/a.md cites docs/whitepaper/results/gone.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

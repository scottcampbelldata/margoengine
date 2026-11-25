// No GPU lock is used, ever (Scott, 2026-11-16: "I want it gone. I never wanna see it again."). GPU work runs directly
// with a hard timeout (scripts/run-with-timeout.mjs). This fails when a tracked file brings the lock back: the lock
// script or its helpers by name, or an import of them. Dated result records are history and stay as they were.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
// The names are built here, so this file does not name them itself.
const gone = ['gpu', 'lock'].join('-'),
  pattern = [
    `${gone}\\.mjs`,
    `${gone}-env`,
    'gpu-queue\\.mjs',
    'gpu-lease\\.mjs',
    'check-gpu-policy',
    'MARGO_GPU_(LOCK|EXCLUSIVE|SLOTS)',
  ].join('|');
const HISTORY = [
  ':!docs/whitepaper/results',
  ':!benchmarks/records',
  ':!examples/package-benchmarks/results',
  ':!tests/no-gpu-lock.test.js',
];

test('no tracked file names or imports the GPU lock', () => {
  let found = '';
  try {
    found = execFileSync('git', ['grep', '-n', '-E', pattern, '--', '.', ...HISTORY], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status !== 1) throw error;
  }
  assert.equal(found, '', `the GPU lock is gone; run GPU work with scripts/run-with-timeout.mjs instead:\n${found}`);
});

test('the lock script and its helpers are deleted', () => {
  for (const file of [
    `scripts/${gone}.mjs`,
    'scripts/gpu-queue.mjs',
    'scripts/support/gpu-lease.mjs',
    'scripts/check-gpu-policy.mjs',
  ])
    assert.equal(existsSync(resolve(root, file)), false, file);
  assert.equal(existsSync(resolve(root, 'scripts/run-with-timeout.mjs')), true);
});

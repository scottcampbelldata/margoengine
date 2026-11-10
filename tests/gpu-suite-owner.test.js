import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import * as suites from '../scripts/gpu-package-tests.mjs';
import * as gpu from '../scripts/gpu-lock.mjs';
import { firstEligible, sameLane } from '../scripts/support/gpu-admission.mjs';

test('package GPU owners separate unrelated worktrees and retain one slot per worktree across suites', {
  timeout: 5000,
}, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-suite-owner-'));
  try {
    const roots = ['first tree', 'second tree'].map((name) => join(folder, name));
    for (const root of roots) mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(roots[0], 'packages'));
    const holder = { owner: suites.suiteOwner(roots[0], 'sky test:gpu'), worktree: roots[0] };
    const other = { owner: suites.suiteOwner(roots[1], 'sky test:gpu'), worktree: roots[1] };
    const same = { owner: suites.suiteOwner(join(roots[0], 'packages'), 'post test:gpu'), worktree: roots[0] };
    assert.equal(sameLane(holder, other), false, 'unrelated worktrees may occupy different free slots');
    assert.equal(sameLane(holder, same), true, 'one worktree still holds at most one slot');
    assert.equal(firstEligible([same, other], [holder]), other);
    assert.equal(
      sameLane({ owner: holder.owner }, { owner: same.owner }),
      true,
      'labels do not change the lane identity',
    );
    assert.equal(
      sameLane({ owner: holder.owner }, { owner: other.owner }),
      false,
      'owner-only entries remain distinct',
    );
    assert.equal(suites.suiteOwner(roots[0]), suites.suiteOwner(join(roots[0], 'packages')));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the actual suite runner publishes the worktree owner at admission', { timeout: 30000 }, async (t) => {
  const folder = mkdtempSync(resolve('test-results/gpu-suite-admission-'));
  mkdirSync(join(folder, '.git'));
  const admitted = [];
  t.mock.module('../scripts/gpu-lock.mjs', {
    namedExports: {
      ...gpu,
      slots: () => 1,
      acquire: async (options) => {
        admitted.push(options);
        return () => {};
      },
    },
  });
  try {
    const runner = await import('../scripts/gpu-package-tests.mjs?suite-owner-regression');
    const step = {
      id: 'fixture/test:gpu',
      name: 'fixture',
      label: 'fixture test:gpu',
      cwd: '.',
      command: `"${process.execPath}" -e "process.exit(0)"`,
      minutes: 1,
    };
    const results = await runner.runSideBySide([step], {
      env: process.env,
      phase: 'shared',
      logs: join(folder, 'logs'),
    });
    assert.equal(results[0].ok, true);
    assert.equal(admitted.length, 1);
    assert.equal(
      sameLane({ owner: admitted[0].owner, worktree: resolve('.') }, { owner: 'check:gpu-packages', worktree: folder }),
      false,
      'another worktree using the historical generic owner does not block this runner',
    );
    assert.equal(admitted[0].owner, suites.suiteOwner(resolve('.'), step.label));
    assert.equal(admitted[0].mode, 'shared');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

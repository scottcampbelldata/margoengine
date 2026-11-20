// KB-API-FOREIGN1: a worktree whose node_modules was one junction to the main checkout's folder resolved every
// `@margoengine/*` import to the main checkout's packages. The checker read that checkout's declarations, no file
// matched a package of the worktree, and api:check failed on 15 reports nobody changed: every cross-package re-export
// printed `from "undefined"` and its import lines vanished. The report now stops before reading anything when a
// workspace link leaves the checkout.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { foreignWorkspaceLinks } from '../scripts/api-report-scope.mjs';

const root = resolve(import.meta.dirname, '..');
const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

function checkout(base, name) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'stage'), { recursive: true });
  return dir;
}

const packages = [
  { name: '@margoengine/core', dir: 'core' },
  { name: '@margoengine/stage', dir: 'stage' },
];

test('workspace links into this checkout pass; links into another checkout are listed', () => {
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), 'margo-api-links-'));
  try {
    const main = checkout(base, 'main');
    const worktree = checkout(base, 'worktree');
    mkdirSync(join(main, 'node_modules', '@margoengine'), { recursive: true });
    for (const { name, dir } of packages) link(join(main, 'packages', dir), join(main, 'node_modules', name));
    assert.deepEqual(foreignWorkspaceLinks(main, packages), []);

    // The worktree borrows the main checkout's whole node_modules folder.
    link(join(main, 'node_modules'), join(worktree, 'node_modules'));
    const foreign = foreignWorkspaceLinks(worktree, packages);
    assert.deepEqual(
      foreign.map(({ name }) => name),
      ['@margoengine/core', '@margoengine/stage'],
    );
    assert.equal(
      realpathSync.native(foreign[0].target).toLowerCase(),
      realpathSync.native(join(main, 'packages', 'core')).toLowerCase(),
    );

    // A package with no link at all (not installed) is not a foreign link.
    assert.deepEqual(foreignWorkspaceLinks(worktree, [{ name: '@margoengine/absent', dir: 'absent' }]), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('api-report.js stops on foreign workspace links and never prints an unowned re-export', () => {
  const source = readFileSync(join(root, 'scripts', 'api-report.js'), 'utf8');
  const guard = source.indexOf('foreignWorkspaceLinks(root, packages)');
  assert.ok(guard > 0, 'api-report.js checks the workspace links');
  assert.ok(guard < source.indexOf('new API('), 'the check runs before the checker loads any declaration');
  assert.doesNotMatch(source, /from "\$\{ownerOf\(/, 'a re-export never interpolates a possibly undefined owner');
});

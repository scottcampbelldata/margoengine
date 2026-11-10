import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cleanRoomGate } from '../scripts/quality/clean-room.js';
import { repoFiles } from '../scripts/quality/packages.js';

test('quality inventory excludes disposable React bundles while retaining new source', { timeout: 30_000 }, () => {
  const workspace = new URL('../.lane/', import.meta.url);
  mkdirSync(workspace, { recursive: true });
  const root = mkdtempSync(new URL('quality-inventory-', workspace));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root, timeout: 10_000 });
    writeFileSync(join(root, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
    writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), '');
    const tests = join(root, 'packages/react/tests');
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, 'new-source.test.js'), 'export const source = true;');
    const temporary = mkdtempSync(join(tests, '.subpaths-'));
    writeFileSync(join(temporary, 'hooks.mjs'), 'export const disposableBundle = true;');
    const files = repoFiles(root);
    rmSync(temporary, { recursive: true });
    // Reproduce cleanup between the inventory and the detector's reads.
    assert.deepEqual(cleanRoomGate({ root, files, packages: [] }).items, {});
    assert.deepEqual(files.filter((file) => file.startsWith('packages/')), ['packages/react/tests/new-source.test.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

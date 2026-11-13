import assert from 'node:assert/strict';
import test from 'node:test';
import { scanRepo } from '../scripts/check-banned-terms.mjs';
import { hasMachinePath, machinePathAllowed, machinePathLines } from '../scripts/machine-paths.mjs';

const drive = 'C:';

test('absolute machine paths are found in every separator style', () => {
  for (const line of [
    `see ${drive}\\Development\\Projects\\x\\notes.md`,
    `"report": "${drive}\\\\Development\\\\Projects\\\\engine-bench\\\\a.json"`,
    `${drive}/Users/name/x`,
    `d:\\users\\name\\AppData`,
    'cd /c/Development/Projects/x',
    'ls /mnt/c/Users/name',
    // A home folder's 8.3 short name with no drive, as a scripts/bundler-matrix.mjs comment once held one.
    '// The real path, not a Windows 8.3 short one (JSMITH~1): Turbopack loads React twice.',
    'cd ALEXSM~2\\AppData',
  ])
    assert.ok(hasMachinePath(line), line);
});

test('checkout-relative paths, URLs and ordinary words pass', () => {
  for (const line of [
    'see ../engine-bench/batch-160/proof.json',
    '%LOCALAPPDATA%\\ms-playwright\\firefox',
    'https://example.com/c/Users/guide',
    'Users and Development teams',
    'packages/c/Users.ts',
    '~/.cargo/registry',
    'C:\\PROGRA~1\\nodejs',
    'reached through RUNNER~1 or DEVELO~1',
    'git diff HEAD~1',
  ])
    assert.ok(!hasMachinePath(line), line);
});

test('line numbers are reported and binary buffers are skipped', () => {
  assert.deepEqual(machinePathLines(Buffer.from(`a\n${drive}\\Users\\x\nb\n`)), [2]);
  assert.deepEqual(machinePathLines(Buffer.from([0, 67, 58, 92, 85])), []);
  assert.ok(machinePathAllowed('packages/fbx/test/fixtures/real/a.fbx'));
  assert.ok(!machinePathAllowed('docs/limits.md'));
});

test('no tracked file names an absolute machine path, except the allowed ones', () => {
  const found = scanRepo().filter((line) => line.includes('absolute machine path'));
  assert.deepEqual(found, []);
});

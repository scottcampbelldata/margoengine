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

// The README install route works as written in the shells students use (school pilot, 2026-11-11): Windows PowerShell 5.1
// rejects `&&` and passes `*.tgz` to npm unexpanded, so the tarball route needs a PowerShell block of its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { blocks } from '../scripts/support/doc-snippets.mjs';

const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');

test('every PowerShell block in the README runs in Windows PowerShell 5.1 and never relies on glob expansion', () => {
  const shells = blocks(readme).filter((b) => b.lang === 'powershell');
  assert.ok(shells.length > 0, 'the README has a PowerShell install block');
  for (const { code } of shells) {
    assert.doesNotMatch(code, /&&|\|\|/, 'PowerShell 5.1 has no && or || between commands');
    for (const line of code.split('\n').filter((l) => /\*\.tgz/.test(l)))
      assert.match(line, /\(Get-ChildItem [^)]*\*\.tgz\)\.FullName/, `npm gets the tarball names, not the pattern: ${line}`);
  }
});

test('each shell block that installs the packed tarballs has a PowerShell twin running the same commands', () => {
  const all = blocks(readme),
    // The program and subcommand of every command, with && and ; both read as separators.
    commands = (code) =>
      code
        .split(/\n|&&|;/)
        .map((c) => c.trim().split(/\s+/).slice(0, 2).join(' '))
        .filter(Boolean);
  let checked = 0;
  for (const [i, b] of all.entries()) {
    if (b.lang !== 'sh' || !/test-results\/\*\.tgz/.test(b.code)) continue;
    const twin = all[i + 1];
    assert.equal(twin?.lang, 'powershell', 'the next block is the PowerShell form');
    assert.deepEqual(commands(twin.code), commands(b.code));
    checked++;
  }
  assert.ok(checked > 0, 'the README still installs the packed tarballs');
});

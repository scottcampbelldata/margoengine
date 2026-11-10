import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('browser package commands serve the repository while resolving the package test entry', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const filename = `.cwd-probe-${process.pid}.mjs`,
    fixture = new URL(filename, import.meta.url);
  writeFileSync(fixture, 'console.log(JSON.stringify({cwd:process.cwd(),url:import.meta.url}));\n');
  try {
    const result = spawnSync(process.execPath, ['scripts/browser-root.mjs', `tests/${filename}`], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.cwd.replace(/[\\/]$/, ''), root.replace(/[\\/]$/, ''));
    assert.equal(report.url, fixture.href);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    for (const [name, command] of Object.entries(manifest.scripts))
      if (/browser/.test(name)) {
        for (const part of command.split(' && ').filter((p) => p.startsWith('node ')))
          assert.ok(
            part.startsWith('node scripts/browser-root.mjs tests/'),
            `${name} needs browser-root before serving fixtures`,
          );
      }
  } finally {
    unlinkSync(fixture);
  }
});

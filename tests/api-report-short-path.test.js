// `npm run api:check` from a checkout reached through a Windows 8.3 short name (C:\Users\\..., the form
// os.tmpdir() returns): the checker reports declaration files by their real long path, api-report.js compared them
// with its unresolved root, so no file matched a package and every cross-package import line vanished from the
// reports. The fresh-clone check (a clone under os.tmpdir()) found it. Needs `npm run build:packages` (verify builds
// first). 8.3 names exist only on Windows; elsewhere the path is already canonical and there is nothing to run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('api:check passes when the checkout is reached through its 8.3 short path', { timeout: 300_000 }, () => {
  if (process.platform !== 'win32') return;
  const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${root}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).stdout.trim();
  assert.ok(short, 'cmd.exe gave no short path');
  assert.notEqual(
    short.toLowerCase(),
    root.toLowerCase(),
    `this checkout has no 8.3 name (${root}); enable 8.3 names or move it`,
  );
  const run = spawnSync(process.execPath, [`${short}\\scripts\\api-report.js`], {
    cwd: short,
    encoding: 'utf8',
    timeout: 280_000,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-3000));
});

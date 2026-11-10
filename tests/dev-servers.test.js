// `vite` started at the repository root (`npm run modern:dev:extensions`, `npm run dev:examples`) printed "Failed to run
// dependency scan. Skipping dependency pre-bundling" because the scan read every HTML file in the checkout, the rival
// comparison pages included: they import engines that are deliberately not installed here and are served by their own
// scripts, never by Vite. The root vite.config.mjs keeps them out of the scan. This starts the root dev server with a
// fresh dependency cache and fails on any warning or error line (scripts/check-dev-servers.mjs, which verify runs for
// every dev server in the repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('the root dev server starts without a dependency scan failure', { timeout: 150_000 }, () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/check-dev-servers.mjs'), '--only=package.json modern:dev:extensions'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 140_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ok\s+package\.json modern:dev:extensions/);
});

test('the root Vite config leaves the rival comparison pages out of the dependency scan', () => {
  const config = readFileSync(join(root, 'vite.config.mjs'), 'utf8');
  for (const page of ['scripts/rival-*.html', 'scripts/sciviz-compare/**', 'packages/*/scripts/rival-page.html']) {
    assert.ok(config.includes(`'!${page}'`), `${page} is excluded`);
  }
});

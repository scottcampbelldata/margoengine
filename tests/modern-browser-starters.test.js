// `npm run test:browser` and `modern:test:browser` failed with an ENOENT stack on examples/vite/dist/.vite/manifest.json
// when the starters were not built. They now stop at once, before a browser opens, naming the command to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STARTER_BUILDS, missingStarterBuilds, starterBuildMessage } from '../scripts/support/starter-builds.mjs';
import { PREPARE } from '../scripts/gpu-package-tests.mjs';

test('missing starter builds are listed and the message names the command to run', () => {
  const root = mkdtempSync(join(tmpdir(), 'starters-'));
  try {
    assert.equal(missingStarterBuilds(root).length, STARTER_BUILDS.length);
    assert.match(starterBuildMessage(missingStarterBuilds(root)), /npm run modern:build:starters/);
    for (const { file } of STARTER_BUILDS) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(missingStarterBuilds(root), []);
    assert.equal(starterBuildMessage([]), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the browser suite stops before opening a browser when a starter build is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'starters-run-'));
  try {
    const run = spawnSync(process.execPath, [resolve('scripts/modern-browser-tests.js')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /starter build missing .*npm run modern:build:starters/);
    assert.doesNotMatch(run.stderr, /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check:gpu-packages builds every starter the suite needs before it, once', () => {
  for (const name of ['modern:test:browser', 'modern:test:browser:slow-compile'])
    for (const { command } of STARTER_BUILDS)
      assert.ok(PREPARE[name].includes(command), `${name} PREPARE lacks ${command}`);
});

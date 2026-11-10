import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('relocated React tooling tests inspect the contributor repository while packed component tests keep their package paths', () => {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const parent = resolve(repository, 'test-results');
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(join(parent, 'packed-react-tooling-'));
  try {
    const tests = ['browser-scripts.test.js', 'browser-working-directory.test.js'];
    for (const file of tests) copyFileSync(join(repository, 'packages/react/tests', file), join(fixture, file));
    const env = { ...process.env, MARGOENGINE_TEST_REPOSITORY: repository };
    delete env.NODE_TEST_CONTEXT; // An independent runner must report its own test results.
    const result = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--test', '--test-timeout=30000', ...tests],
      {
        cwd: fixture,
        env,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /fail 0/);
  } finally {
    assert.ok(resolve(fixture).startsWith(parent + sep));
    rmSync(fixture, { recursive: true, force: true });
  }
});

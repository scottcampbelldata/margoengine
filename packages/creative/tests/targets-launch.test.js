import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

test('targets browser harness serves the repository when invoked from the package directory', () => {
  const script = new URL('../scripts/test-targets.js', import.meta.url).href;
  const browser = new URL('../../../scripts/browser.js', import.meta.url).href;
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const source = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    mock.module(${JSON.stringify(browser)}, { namedExports: {
      openBrowser: async () => {
        assert.equal(process.cwd(), ${JSON.stringify(root)});
        return { page: { evaluate: async () => ({ subresources: 78 }) }, close: async () => {} };
      }
    }});
    await import(${JSON.stringify(script)});
  `;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

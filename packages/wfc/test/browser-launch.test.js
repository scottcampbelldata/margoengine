import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

test('WFC browser harness serves the repository from a workspace launch', () => {
  const script = new URL('./browser-check.mjs', import.meta.url).href;
  const launcher = new URL('../../../scripts/lib/browser.mjs', import.meta.url).href;
  const shutdown = new URL('../../../scripts/support/shutdown.mjs', import.meta.url).href;
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const source = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    mock.module('vite', { namedExports: { createServer: async options => {
      assert.equal(resolvePath(options.root), ${JSON.stringify(root)});
      return { listen: async () => {}, resolvedUrls: { local: ['http://localhost/'] } };
    } } });
    function resolvePath(value) { return value && value.replace(/[\\\\/]+$/, ''); }
    mock.module(${JSON.stringify(launcher)}, { namedExports: { launchBrowser: async () => ({
      newPage: async () => ({ on() {}, goto: async () => {}, evaluate: async () =>
        [{route:'webgpu',image:Array(64).fill(0)},{route:'webgl2',image:Array(64).fill(0)}] })
    }) } });
    mock.module(${JSON.stringify(shutdown)}, { namedExports: { closeAll: async () => {} } });
    await import(${JSON.stringify(script)});
  `;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

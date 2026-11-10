import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = new URL('../scripts/', import.meta.url);
for (const name of readdirSync(scripts).filter((name) => /^test-.*-browser\.(mjs|js)$/.test(name))) {
  test(`${name} serves the repository when npm invokes it from the package`, () => {
    const repository = fileURLToPath(new URL('../../..', import.meta.url));
    const browser = new URL('../../../scripts/browser.js', import.meta.url).href;
    const lock = new URL('../../../scripts/gpu-lock.mjs', import.meta.url).href;
    const script = new URL(name, scripts).href;
    const probe = `
      import { mock } from 'node:test';
      mock.module(${JSON.stringify(lock)}, { namedExports: { acquire: async () => () => {} } });
      mock.module(${JSON.stringify(browser)}, { namedExports: { openBrowser: async () => {
        console.log(JSON.stringify({ cwd: process.cwd() }));
        throw new Error('working-directory-probe');
      } } });
      try { await import(${JSON.stringify(script)}); }
      catch (error) { if (error.message !== 'working-directory-probe') throw error; }
    `;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', probe], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(realpathSync(result.cwd).toLowerCase(), realpathSync(repository).toLowerCase());
  });
}

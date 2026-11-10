import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = new URL('./', import.meta.url);
for (const name of readdirSync(directory).filter((name) => name.endsWith('-browser.mjs'))) {
  test(`${name} opens repository URLs from the package working directory`, () => {
    const browser = new URL('../../../scripts/browser.js', import.meta.url).href;
    const driver = new URL(name, directory).href;
    const probe = `
      import { mock } from 'node:test';
      mock.module(${JSON.stringify(browser)}, { namedExports: { openBrowser: async () => {
        console.log(JSON.stringify(process.cwd()));
        throw new Error('ui-browser-root-probe');
      } } });
      try { await import(${JSON.stringify(driver)}); }
      catch (error) { if (error.message !== 'ui-browser-root-probe') throw error; }
    `;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', probe], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    const repository = fileURLToPath(new URL('../../..', import.meta.url));
    assert.equal(realpathSync(JSON.parse(child.stdout.trim())).toLowerCase(), realpathSync(repository).toLowerCase());
  });
}

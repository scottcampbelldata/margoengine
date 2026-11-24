import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('every Blender browser driver serves repository URLs when launched by its package script', () => {
  const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
  const drivers = ['objects', 'lightmap', 'meshopt', 'nodes'].map(name => new URL(`${name}-browser.mjs`, import.meta.url).href);
  const browserModule = new URL('../../../scripts/browser.js', import.meta.url).href;
  const program = `
    import { mock } from 'node:test';
    const roots = [];
    const stop = new Error('browser launch intercepted');
    mock.module(${JSON.stringify(browserModule)}, {namedExports: {openBrowser: () => {
      roots.push(process.cwd()); throw stop;
    }}});
    for (const url of ${JSON.stringify(drivers)}) {
      process.chdir(${JSON.stringify(packageDirectory)});
      try { await import(url); } catch (error) { if (error !== stop) throw error; }
    }
    process.stdout.write(JSON.stringify(roots));
  `;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', program], {
    cwd: packageDirectory, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const expected = realpathSync(fileURLToPath(new URL('../../..', import.meta.url))).toLowerCase();
  const roots = JSON.parse(result.stdout);
  assert.equal(roots.length, drivers.length);
  assert.deepEqual(roots.map(root => realpathSync(root).toLowerCase()), drivers.map(() => expected));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

test('GPU package scripts serve repository fixtures from the repository root', () => {
  for (const directory of ['scene', 'worker']) {
    const packageRoot = fileURLToPath(new URL(`../packages/${directory}/`, import.meta.url));
    const root = resolve(packageRoot, '../..');
    const { scripts } = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    for (const name of Object.keys(scripts).filter((name) => /^test:(gpu|browser)(:|$)/.test(name))) {
      const script = scripts[name];
      if (directory === 'scene')
        assert.match(script, /--compat\b/, `${name} must also cover the compatibility backend`);
      const entry = /\bnode (\S+)/.exec(script)?.[1];
      assert.ok(entry, `${name} must launch its browser fixture`);
      // Execute the actual command's directory setup, replacing only the browser process with a cwd probe.
      const probe = script.replace(/\bnode .*$/, `"${process.execPath}" -p "process.cwd()"`);
      const result = spawnSync(probe, {
        cwd: packageRoot,
        shell: true,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      const servedRoot = result.stdout.trim();
      assert.equal(resolve(servedRoot), root, name);
      assert.ok(existsSync(resolve(servedRoot, entry)), `${name} must resolve its fixture entry`);
      assert.ok(
        existsSync(resolve(servedRoot, 'tests/modern-extension.html')),
        `${name} must serve the requested page`,
      );
    }
  }
});

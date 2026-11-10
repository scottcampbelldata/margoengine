import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

test('React browser scripts serve their declared fixtures from the effective package-script directory', () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  let checked = 0;
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (!name.includes('browser')) continue;
    let cwd = packageRoot;
    for (const part of command.split('&&').map(s => s.trim())) {
      const cd = /^cd\s+(.+)$/.exec(part);
      if (cd) { cwd = resolve(cwd, cd[1]); continue; }
      const node = /^node\s+([^\s]+)/.exec(part);
      if (!node) continue;
      const file = resolve(cwd, node[1]);
      assert.ok(existsSync(file), `${name}: executable source ${file}`);
      const source = readFileSync(file, 'utf8');
      const chdir = /process\.chdir\(fileURLToPath\(new URL\(['"]([^'"]+)['"]/.exec(source);
      const serverRoot = chdir ? resolve(dirname(file), chdir[1]) : cwd;
      for (const [, fixture] of source.matchAll(/startPath:\s*['"]\/([^'"]+)['"]/g)) {
        assert.ok(existsSync(resolve(serverRoot, fixture)), `${name}: fixture /${fixture} must exist beneath its server root ${serverRoot}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 2, 'both optional binding fixtures are covered');
});

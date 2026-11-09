import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('every optional PostStack member avoids active-scene plugin removal', () => {
  const packages = fileURLToPath(new URL('../packages/', import.meta.url));
  let checked = 0;
  for (const pkg of readdirSync(packages, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = join(packages, pkg.name, 'src');
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory, { recursive: true })) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(directory, file), 'utf8');
      if (!/\bjoinStack\(/.test(source)) continue;
      checked++;
      assert.equal(/\b(?:engine|runtime)\??\.removePlugin\(/.test(source), false, `${pkg.name}/${file}`);
    }
  }
  assert.ok(checked > 20, 'the guard must cover stack members across optional packages');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';

// Published type files may only import relative paths inside their own package; anything else breaks after npm install.
const packages = resolve(import.meta.dirname, '../packages');
const files = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.d.ts') ? [join(dir, e.name)] : []);

test('every dist .d.ts stays inside its package', () => {
  const escapes = [];
  for (const name of readdirSync(packages)) {
    const root = join(packages, name), dist = join(root, 'dist');
    if (!existsSync(dist)) continue;
    for (const file of files(dist)) for (const [, spec] of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g))
      if (relative(root, resolve(dirname(file), spec)).startsWith('..')) escapes.push(`${relative(packages, file)}: ${spec}`);
  }
  assert.deepEqual(escapes, []);
});

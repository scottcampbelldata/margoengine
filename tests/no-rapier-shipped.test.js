// Rapier is a test-only comparison: it is a root devDependency that test files load, and nothing a package ships names it.
// No package source, no built file and no package manifest dependency may reference `@dimforge/rapier`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const NAME = /@dimforge\/rapier/;

test('no package source names Rapier', () => {
  const files = execFileSync('git', ['ls-files', 'packages'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((file) => /^packages\/[^/]+\/src\//.test(file) && SOURCE.test(file));
  const found = files.filter((file) => NAME.test(readFileSync(join(root, file), 'utf8')));
  assert.deepEqual(found, []);
});

test('no built package file names Rapier', () => {
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE.test(name) || name.endsWith('.d.ts') || name.endsWith('.wasm')) {
        if (name.endsWith('.wasm') ? /rapier/i.test(name) : NAME.test(readFileSync(path, 'utf8')))
          found.push(path.slice(root.length));
      }
    }
  };
  for (const name of readdirSync(join(root, 'packages'))) {
    const dist = join(root, 'packages', name, 'dist');
    if (existsSync(dist)) walk(dist);
  }
  assert.deepEqual(found, []);
});

test('no package manifest depends on Rapier', () => {
  const found = [];
  for (const name of readdirSync(join(root, 'packages'))) {
    const file = join(root, 'packages', name, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta'])
      for (const dependency of Object.keys(manifest[field] ?? {}))
        if (/rapier/i.test(dependency)) found.push(`${name}: ${field}.${dependency}`);
  }
  assert.deepEqual(found, []);
});

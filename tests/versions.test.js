import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Every published package ships in lockstep (scripts/set-version.mjs), so an app can never mix versions.
const root = resolve(import.meta.dirname, '..'),
  read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const published = ['packages', 'tools']
  .flatMap((dir) => readdirSync(join(root, dir)).map((name) => join(dir, name, 'package.json')))
  .filter((path) => existsSync(join(root, path)));
const consumers = [
  'tools/create-margo/template/package.json',
  ...read('package.json')
    .workspaces.filter((w) => !w.startsWith('packages/'))
    .map((w) => join(w, 'package.json')),
];

test('all published packages share one version and every internal range is ^that version', () => {
  const versions = new Set(published.map((path) => read(path).version));
  assert.equal(
    versions.size,
    1,
    `versions differ: ${[...versions].join(', ')} (run node scripts/set-version.mjs <version>)`,
  );
  const expected = `^${[...versions][0]}`;
  for (const path of [...published, ...consumers]) {
    const manifest = read(path);
    for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, range] of Object.entries(manifest[field] ?? {}))
        if (name === 'margoengine' || name.startsWith('@margoengine/'))
          assert.equal(range, expected, `${path} ${field} ${name}`);
  }
});

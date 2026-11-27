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
  ...readdirSync(join(root, 'tools/create-margo/templates'))
    .map((name) => join('tools/create-margo/templates', name, 'package.json'))
    .filter((path) => existsSync(join(root, path))),
  ...read('package.json')
    .workspaces.filter((w) => !w.startsWith('packages/'))
    .map((w) => join(w, 'package.json')),
];

test('all published packages share one version and every internal range is ^that version', () => {
  // create-margo is published on its own 0.1 line. The repo packages stay at one version.
  // Its templates install ^0.1.0, which is the engine release on npm.
  const cli = 'tools/create-margo/package.json';
  const engine = published.filter((path) => path !== cli);
  const versions = new Set(engine.map((path) => read(path).version));
  assert.equal(
    versions.size,
    1,
    `versions differ: ${[...versions].join(', ')} (run node scripts/set-version.mjs <version>)`,
  );
  assert.equal(read(cli).version, '0.1.1');
  const expected = `^${[...versions][0]}`;
  for (const path of [...engine, ...consumers]) {
    const manifest = read(path);
    const wanted = path.includes('tools/create-margo/templates/') ? '^0.1.0' : expected;
    for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, range] of Object.entries(manifest[field] ?? {}))
        if (name === 'margoengine' || name.startsWith('@margoengine/'))
          assert.equal(range, wanted, `${path} ${field} ${name}`);
  }
});

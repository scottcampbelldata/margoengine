// Packaging class check: a manifest names packages, never subpaths, and every bare import in a package's built dist
// is a node built-in or a package its manifest declares. publish:rehearsal found three of these late (a subpath
// dependency and two error messages that read as imports); this runs on the CPU without a registry.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { importsOf, packageOf } from '../scripts/publish-rehearsal.mjs';

const root = resolve(import.meta.dirname, '..');
const NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Imports a package looks up in a try and documents as the user's choice (as in scripts/publish-rehearsal.mjs). */
const OPTIONAL_LOOKUPS = { 'margo-convert': ['sharp'] };

const dirs = [
  ...readdirSync(join(root, 'packages')).map((d) => join('packages', d)),
  ...readdirSync(join(root, 'tools')).map((d) => join('tools', d)),
].filter((d) => existsSync(join(root, d, 'package.json')));
const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

test('importsOf reads real imports and ignores a call written inside a string', () => {
  assert.deepEqual(importsOf("import a from '@x/a';\nconst b = await import('@x/b');"), ['@x/a', '@x/b']);
  assert.deepEqual(importsOf(`throw Error("pass { compat: await import('@x/c') }");`), []);
});

for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  test(`${dir}: dependencies are package names, not subpaths`, () => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'])
      for (const name of Object.keys(manifest[field] ?? {}))
        assert.match(name, NAME, `${field}: "${name}" is not a package name (a subpath cannot be installed)`);
  });

  test(`${dir}: built code imports only what the manifest declares`, (t) => {
    const dist = join(root, dir, 'dist');
    if (!existsSync(dist)) return t.skip('not built');
    const declared = new Set([
      manifest.name,
      ...['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((f) => Object.keys(manifest[f] ?? {})),
      ...(OPTIONAL_LOOKUPS[manifest.name] ?? []),
    ]);
    for (const file of files(dist).filter((f) => /\.m?js$/.test(f)))
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        const name = packageOf(spec);
        if (name && !declared.has(name))
          assert.fail(`${file} imports ${spec}, which ${manifest.name} does not declare`);
      }
  });
}

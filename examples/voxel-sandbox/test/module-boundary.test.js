import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// The sandbox is an example of the public API: it imports package entries only, never package sources or internals.
test('the sandbox imports public package entries only', async () => {
  const source = new URL('../src/', import.meta.url),
    exported = new Set();
  for (const name of ['clustered', 'core', 'lines', 'post', 'quality', 'shadows', 'sky', 'voxel', 'voxel-pathtracer']) {
    const manifest = JSON.parse(await readFile(new URL(`../../../packages/${name}/package.json`, import.meta.url)));
    for (const entry of Object.keys(manifest.exports)) exported.add(manifest.name + entry.slice(1));
  }
  for (const path of await readdir(source)) {
    if (!path.endsWith('.ts')) continue;
    const text = await readFile(new URL(path, source), 'utf8');
    for (const [, specifier] of text.matchAll(/from\s+'([^']+)'/g)) {
      if (specifier.startsWith('./')) {
        assert.doesNotMatch(specifier, /\.\./, `${path}: ${specifier}`);
        continue;
      }
      assert.ok(exported.has(specifier), `${path} imports ${specifier}, which is not a package export`);
    }
  }
});

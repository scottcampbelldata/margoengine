import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// The sandbox is an example of the public API: it imports package entries only, never package sources or internals.
test('the sandbox imports public package entries only', async () => {
  const source = new URL('../src/', import.meta.url),
    exported = new Set();
  for (const name of [
    'clustered',
    'core',
    'culling',
    'labels',
    'lines',
    'post',
    'procedural',
    'quality',
    'shadows',
    'sky',
    'voxel',
    'voxel-net',
    'voxel-pathtracer',
  ]) {
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

// The finds and wider tunnels are for plaza=1 worlds: the page's generator worker, which every deterministic view runs,
// and the page itself reach neither.
test('the deterministic views and the page never reach the finds', async () => {
  const source = new URL('../src/', import.meta.url);
  for (const file of ['generator.worker.ts', 'plants.ts', 'main.ts']) {
    const text = await readFile(new URL(file, source), 'utf8');
    assert.doesNotMatch(text, /finds[.]ts|plazaTerrainOptions|[.][/]plaza[.]ts/, file);
  }
});

// The tracer stays out of the first download, and the figures out of a page playing alone: nothing the page loads eagerly
// may import photo.ts, figures.ts or voxel-pathtracer, and the only way in is the dynamic import in main.ts (the plaza
// case in bench/suites/size.mjs measures the bytes).
test('the path tracer is reached only through the dynamic import', async () => {
  const source = new URL('../src/', import.meta.url),
    staticImports = async (file) => {
      const text = await readFile(new URL(file, source), 'utf8');
      return [...text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/gms)].map(
        (match) => match[1] ?? match[2],
      );
    },
    seen = new Set(),
    walk = async (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of await staticImports(file)) {
        assert.notEqual(specifier, './photo.ts', `${file} imports photo.ts statically`);
        assert.notEqual(specifier, './figures.ts', `${file} imports figures.ts statically`);
        assert.notEqual(specifier, './timing.ts', `${file} imports timing.ts statically`);
        assert.ok(!specifier.startsWith('@margoengine/voxel-pathtracer'), `${file} imports the tracer statically`);
        if (specifier.startsWith('./') && specifier.endsWith('.ts')) await walk(specifier.slice(2));
      }
    };
  await walk('main.ts');
  assert.ok(seen.size > 5, 'the walk followed the imports');
  const main = await readFile(new URL('main.ts', source), 'utf8');
  assert.match(main, /import\('\.\/photo\.ts'\)/);
  assert.match(main, /import\('\.\/figures\.ts'\)/);
});

// The page asks the shard's own protection rule before it predicts an edit (so a refused edit never flashes), but takes it
// from plaza-area.ts: plaza.ts holds the terrain and the generator, which a page must not download.
test('the page shares the protection rule without the generator', async () => {
  const main = await readFile(new URL('main.ts', new URL('../src/', import.meta.url)), 'utf8');
  assert.match(main, /from '\.\/plaza-area\.ts'/);
  assert.doesNotMatch(main, /from '\.\/plaza\.ts'/);
  const area = await readFile(new URL('../src/plaza-area.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(area, /^import\s/m, 'plaza-area.ts imports nothing');
});

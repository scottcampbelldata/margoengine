// A demo's source/ rebuilds it (node scripts/web-demos/build.mjs <name>), so every data file its code imports must be
// there. height-streaming's survey tiles arrived without their source copies (3eb5f2dd23): tiles.js imports
// ./launch.tile?url and globs ./tiles/*.tile, and the build failed on the missing launch file. The source copies must be
// the very bytes the built page ships (Vite copies a ?url asset as is, under a content hash).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const demo = resolve(import.meta.dirname, '..', 'demos', 'height-streaming');

test('height-streaming source holds the launch file and every survey tile its build imports, as shipped', () => {
  const source = readFileSync(join(demo, 'source', 'tiles.js'), 'utf8');
  assert.match(source, /from '\.\/launch\.tile\?url'/);
  const assets = readdirSync(join(demo, 'assets')).filter((name) => name.endsWith('.tile')),
    shipped = (stem) => {
      const name = assets.find((a) => a.startsWith(`${stem}-`) && /^[\w-]+-[\w-]{8}\.tile$/.test(a));
      assert.ok(name, `assets ships ${stem}`);
      return readFileSync(join(demo, 'assets', name));
    };
  assert.deepEqual(readFileSync(join(demo, 'source', 'launch.tile')), shipped('launch'));
  const tiles = readdirSync(join(demo, 'source', 'tiles'));
  // 14 x 14 tiles, less the 6 x 6 launch window the launch file carries.
  assert.equal(tiles.length, 14 * 14 - 6 * 6);
  for (const name of tiles)
    assert.deepEqual(readFileSync(join(demo, 'source', 'tiles', name)), shipped(name.slice(0, -5)));
});

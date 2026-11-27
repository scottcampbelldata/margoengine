import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { heavyFiles } from './heavy-files.js';
import { films } from './films.js';
import { ASSET_BASE, ASSET_FALLBACK } from './asset-base.js';

const root = new URL('../..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const manifest = JSON.parse(read('examples/live/assets-manifest.json'));
const catalog = JSON.parse(read('site/examples/catalog.json'));

test('the catalog lists every film that has source, and leaves the held-back titles out', () => {
  assert.equal(catalog.films.length, 22);
  assert.deepEqual(
    catalog.films.map((film) => film.id),
    films.map((film) => film.id),
  );
  const text = JSON.stringify(catalog).toLowerCase();
  for (const banned of ['tokyo', 'littlest', 'night citadel', 'night-citadel']) {
    assert.equal(text.includes(banned), false, banned);
  }
  assert.ok(catalog.films.some((film) => film.id === 'last-tram'));
  assert.ok(catalog.films.some((film) => film.id === 'the-voxel-night-shop'));
  assert.equal(catalog.films.some((film) => film.id === 'train'), false);
});

test('the asset manifest matches the heavy file list and the bucket constant', () => {
  assert.equal(manifest.assetBase, ASSET_BASE);
  assert.equal(manifest.assetBase, 'https://assets.margoengine.com/examples/');
  assert.equal(manifest.fallback, ASSET_FALLBACK);
  assert.equal(manifest.fileCount, heavyFiles.length);
  assert.deepEqual(manifest.files, heavyFiles);
  const keys = heavyFiles.map((file) => file.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    heavyFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
    12258800,
  );
  assert.ok(heavyFiles.every((file) => file.gitLfs === false));
  assert.equal(statSync(new URL('examples/showcase-films/assets/north-yard/industrial-buildings.glb', root), { throwIfNoEntry: false }), undefined);
});

test('every exampleAsset literal is a manifest key, and the dynamic prefixes are covered', () => {
  const keys = new Set(heavyFiles.map((file) => file.key));
  const dirs = ['examples/showcase-films', 'examples/first-wake', 'examples/underwater-cable', 'examples/glass-bench', 'examples/event-horizon'];
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'assets') walk(path);
      } else if (/\.(js|mjs|html|ts)$/.test(name)) files.push(path);
    }
  }
  for (const dir of dirs) walk(new URL(dir, root).pathname);
  const literals = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/exampleAsset\(\s*'([^']+)'\s*\)/g)) literals.push(match[1]);
    for (const match of text.matchAll(/exampleAsset\(\s*`([^`$]+)`\s*\)/g)) literals.push(match[1]);
  }
  for (const key of literals) {
    const covered = keys.has(key) || (key.endsWith('/') && heavyFiles.some((file) => file.key.startsWith(key)));
    assert.ok(covered, key);
  }
  const count = (prefix) => heavyFiles.filter((file) => file.key.startsWith(prefix)).length;
  assert.equal(count('city-to-street/tiles/'), 6);
  assert.equal(count('opening-night/'), 16);
  assert.equal(count('first-wake/'), 12);
  assert.equal(count('below-the-swell/'), 15);
  assert.equal(count('inside-a-meteorite/'), 3);
  assert.equal(count('the-scanned-workshop/'), 3);
  assert.equal(count('the-solar-field/'), 2);
  assert.equal(count('horse-at-the-ridge/'), 2);
  assert.equal(count('last-tram/'), 1);
  assert.equal(count('the-projectionist/'), 1);
});

test('tracked showcase assets stay under 5 MB', () => {
  const dir = new URL('examples/showcase-films/assets/', root);
  function walk(path) {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const info = statSync(child);
      if (info.isDirectory()) walk(child);
      else assert.ok(info.size <= 5 * 1024 * 1024, child);
    }
  }
  walk(dir.pathname);
});

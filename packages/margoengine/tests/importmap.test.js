import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localImportMap, rebaseImportMap } from '../dist/importmap.js';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const cdn = JSON.parse(readFileSync(join(dist, 'importmap.json'), 'utf8'));
const modules = join(fileURLToPath(new URL('../../../', import.meta.url)), 'node_modules');

test('localImportMap points every entry at the local base and keeps every entry', async () => {
  const local = await localImportMap('/node_modules/');
  assert.deepEqual(Object.keys(local.imports), Object.keys(cdn.imports));
  assert.equal(local.imports.margoengine, '/node_modules/margoengine/dist/index.js');
  assert.equal(local.imports['@margoengine/core/extension'], '/node_modules/@margoengine/core/dist/extension.js');
  for (const url of Object.values(local.imports)) assert.match(url, /^\/node_modules\/(@margoengine\/)?[\w-]+\/dist\//);
  assert.equal(JSON.stringify(local).includes('jsdelivr'), false);
});

test('every local URL is a file of the installed package, so a page served from the project folder loads it', async () => {
  const local = await localImportMap('/node_modules/');
  for (const [specifier, url] of Object.entries(local.imports))
    assert.ok(existsSync(join(modules, url.slice('/node_modules/'.length))), `${specifier} -> ${url} is not installed`);
});

test('the base may be an absolute URL, with or without its closing slash', async () => {
  const a = await localImportMap('http://localhost:8080/assets/'),
    b = await localImportMap('http://localhost:8080/assets');
  assert.deepEqual(a, b);
  assert.equal(a.imports['@margoengine/stage'], 'http://localhost:8080/assets/@margoengine/stage/dist/index.js');
});

test('only keeps the listed specifiers and the subpaths under a prefix', async () => {
  const one = await localImportMap('/m/', { only: ['margoengine', 'margoengine/shadows'] });
  assert.deepEqual(Object.keys(one.imports), ['margoengine', 'margoengine/shadows']);
  const core = await localImportMap('/m/', { only: ['@margoengine/core/'] });
  assert.ok('@margoengine/core' in core.imports && Object.keys(core.imports).length > 1);
  assert.ok(
    Object.keys(core.imports).every((key) => key === '@margoengine/core' || key.startsWith('@margoengine/core/')),
  );
});

test('rebaseImportMap leaves a URL that is not a CDN file alone and rejects bad input with a help link', () => {
  const map = { imports: { a: 'https://cdn.jsdelivr.net/npm/@x/y@1.2.3/dist/a.js', b: '/already/local.js' } };
  assert.deepEqual(rebaseImportMap(map, '/n').imports, { a: '/n/@x/y/dist/a.js', b: '/already/local.js' });
  assert.throws(() => rebaseImportMap(map, ''), { name: 'TypeError', message: /errors#import-map/ });
  assert.throws(() => rebaseImportMap({}, '/n'), { name: 'TypeError', message: /errors#import-map/ });
  assert.throws(() => rebaseImportMap(map, '/n', { only: ['nope'] }), {
    name: 'RangeError',
    message: /nope.*errors#import-map/,
  });
});

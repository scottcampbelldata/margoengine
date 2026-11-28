import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ASSET_ROOT, asset, assetRoot } from '../assets.js';
import { libraryFile, libraryRoot } from '../library.mjs';

const page = 'http://127.0.0.1:5173/examples/showcase-films/last-tram.html?capture=1';

test('films load assets from the asset library by default', () => {
  assert.equal(DEFAULT_ASSET_ROOT, '/asset-library/showcase-films/');
  assert.equal(assetRoot(page).href, 'http://127.0.0.1:5173/asset-library/showcase-films/');
  assert.equal(
    asset('north-yard/industrial-buildings.glb', page),
    'http://127.0.0.1:5173/asset-library/showcase-films/north-yard/industrial-buildings.glb',
  );
});

test('?assets= names another root, absolute or relative to the page, with or without a trailing slash', () => {
  assert.equal(
    asset('technical-films/turbofan.glb', page + '&assets=https://cdn.example.com/films'),
    'https://cdn.example.com/films/technical-films/turbofan.glb',
  );
  assert.equal(
    asset('continental-divide-dem.u16', page + '&assets=../../local-assets/'),
    'http://127.0.0.1:5173/local-assets/continental-divide-dem.u16',
  );
  assert.equal(assetRoot(page + '&assets=').href, 'http://127.0.0.1:5173/asset-library/showcase-films/');
});

test('an asset path stays inside its root', () => {
  for (const bad of ['', '/etc/passwd', '../secret.glb', 'a/../../b', 7])
    assert.throws(() => asset(bad, page), RangeError);
  assert.throws(() => assetRoot(undefined), TypeError);
});

test('the authoring scripts write to the same library folder', () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  assert.equal(libraryRoot({}), join(resolve(repository, '../../Assets/blender-library'), 'showcase-films'));
  assert.equal(libraryRoot({ MARGO_ASSET_LIBRARY: 'D:/lib' }), join(resolve('D:/lib'), 'showcase-films'));
  assert.equal(libraryRoot({ MARGO_ASSET_LIBRARY: 'D:/lib', MARGO_SHOWCASE_ASSETS: 'E:/films' }), resolve('E:/films'));
  assert.equal(
    fileURLToPath(libraryFile('technical-films/cedar-hall.ifc', { MARGO_SHOWCASE_ASSETS: 'E:/films' })),
    resolve('E:/films/technical-films/cedar-hall.ifc'),
  );
});

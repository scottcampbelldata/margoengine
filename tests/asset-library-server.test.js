// Film assets never go into git (Scott, 2026-11-16): the root Vite config serves the library folder beside the
// checkouts at /asset-library/, so the shot tool's dev server (scripts/browser.js startDevServer, which loads the root
// config) and `npm run dev:examples` hand pages the files where they live. Without the plugin Vite answers an unknown
// path with its HTML fallback, so a loader got a page instead of the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { startDevServer } from '../scripts/browser.js';
import { assetLibraryRoot } from '../vite.config.mjs';

test('the asset library root is MARGO_ASSET_LIBRARY, else Assets/blender-library two folders above the checkout', () => {
  assert.equal(assetLibraryRoot({ MARGO_ASSET_LIBRARY: join(tmpdir(), 'lib') }), join(tmpdir(), 'lib'));
  assert.match(assetLibraryRoot({}).replaceAll(sep, '/'), /\/Assets\/blender-library$/);
});

test('a dev server serves library files at /asset-library/ and refuses paths outside it', {
  timeout: 120_000,
}, async () => {
  const lib = mkdtempSync(join(tmpdir(), 'margo-asset-library-'));
  mkdirSync(join(lib, 'film', 'prop'), { recursive: true });
  const bytes = Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);
  writeFileSync(join(lib, 'film', 'prop', 'prop one.glb'), bytes);
  const before = process.env.MARGO_ASSET_LIBRARY;
  process.env.MARGO_ASSET_LIBRARY = lib;
  let dev;
  try {
    dev = await startDevServer({ startPath: '/LICENSE', port: 'free' });
    const origin = `http://127.0.0.1:${dev.server.config.server.port}`;
    const ok = await fetch(`${origin}/asset-library/film/prop/prop%20one.glb`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'model/gltf-binary');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), bytes);
    const missing = await fetch(`${origin}/asset-library/film/prop/none.glb`);
    assert.equal(missing.status, 404);
    await missing.text();
    const escape = await fetch(`${origin}/asset-library/film/..%2F..%2F..%2Fpackage.json`);
    assert.equal(escape.status, 403);
    await escape.text();
    const post = await fetch(`${origin}/asset-library/film/prop/prop%20one.glb`, { method: 'POST' });
    assert.equal(post.status, 405);
    await post.text();
  } finally {
    if (before === undefined) delete process.env.MARGO_ASSET_LIBRARY;
    else process.env.MARGO_ASSET_LIBRARY = before;
    await dev?.close();
    rmSync(lib, { recursive: true, force: true });
  }
});

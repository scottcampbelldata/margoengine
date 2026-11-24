// Regression (2026-11-07): test:gallery:browser read site/dist, which only `npm run build:site` makes, so the GPU runner
// alone failed it ("site/dist/gallery differs from examples/gallery") and a site built at an older commit passed it.
// The check now builds the gallery and the voxel sandbox itself with scripts/site-gallery.mjs, the code build-site.js
// builds them with, into a folder of its own.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildGallery, buildVoxel } from '../scripts/site-gallery.mjs';

const root = resolve(import.meta.dirname, '..');

test('the gallery check builds every gallery page and the voxel sandbox itself, as the site does', async () => {
  const out = mkdtempSync(join(tmpdir(), 'site-gallery-'));
  try {
    await buildGallery(out);
    await buildVoxel(out);
    const pages = readdirSync(join(root, 'examples/gallery')).filter((name) => name.endsWith('.html'));
    assert.deepEqual(readdirSync(join(out, 'gallery')).filter((name) => name.endsWith('.html')).sort(), pages.sort());
    assert.ok(existsSync(join(out, 'gallery/models/manifest.json')) && existsSync(join(out, 'voxel/index.html')));
    const check = readFileSync(join(root, 'scripts/test-gallery-browser.mjs'), 'utf8'),
      site = readFileSync(join(root, 'scripts/build-site.js'), 'utf8');
    assert.ok(/await buildGallery\(dist\)/.test(check) && /await buildVoxel\(dist\)/.test(check), 'the check builds');
    assert.doesNotMatch(check, /site\/dist/, 'the check reads no site build');
    assert.ok(/await buildGallery\(out\)/.test(site) && /await buildVoxel\(out\)/.test(site), 'the site builds the same');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { allCases, captureArgs } from '../scripts/support/visual-compat-pages.js';

const root = resolve(import.meta.dirname, '..');

/** The source page the site build (scripts/build-site.js) turns into the served path, or the dev server path itself. */
function sourceOf(path, dev) {
  const url = path.split(/[?#]/)[0];
  if (dev) return url;
  const folders = {
    'gameplay-sandbox/': 'examples/gameplay-sandbox/index.html',
    'voxel/': 'examples/voxel-sandbox/index.html',
    'demos/earth/': 'packages/creative/examples/earth/index.html',
    'demos/boulder/': 'examples/boulder.html',
  };
  if (folders[url]) return folders[url];
  const package_ = url.match(/^demos\/(dof|tonemap|animator)\/$/);
  if (package_) return `packages/${package_[1]}/examples/index.html`;
  // The example folders build-site.js builds under /demos/<name>/.
  const folder = url.match(/^demos\/(orrery|molten-words|cathedral-light|biomes)\/$/);
  if (folder) return `examples/${folder[1]}/index.html`;
  const page = url.match(/^demos\/([\w-]+)\.html$/);
  if (page) return `examples/${page[1]}.html`;
  const gallery = url.match(/^gallery\/([\w-]+)\.html$/);
  if (gallery) return `examples/gallery/${gallery[1]}.html`;
  return undefined;
}

test('the compatibility check opens only demos that exist', () => {
  assert.ok(allCases.length > 20);
  const problems = [];
  for (const { id, demo } of allCases) {
    const source = sourceOf(demo.path, demo.dev);
    if (!source) problems.push(`${id}: ${demo.path} is not a page scripts/build-site.js builds`);
    else if (!existsSync(resolve(root, source))) problems.push(`${id}: ${source} does not exist (a deleted demo?)`);
  }
  assert.deepEqual(problems, [], 'remove the entry from scripts/support/visual-compat-pages.js or restore the demo');
});

test('case ids are unique', () => {
  const ids = allCases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the sciviz points status line states its plot time, so the compatibility check paints it over', () => {
  // The line changes run to run ("plotted in 12 ms"), which swung the layer difference between 0.20% and 0.02%.
  const page = readFileSync(resolve(root, 'examples/sciviz-points.ts'), 'utf8');
  assert.match(
    page,
    /plotted in \$\{[^}]*performance\.now\(\)[^}]*\} ms/,
    'the page no longer states a time; drop this mask',
  );
  assert.match(readFileSync(resolve(root, 'examples/sciviz-points.html'), 'utf8'), /id="status"/);
  const points = allCases.find((c) => c.id === 'sciviz-points');
  assert.ok(points, 'sciviz-points is one of the compatibility cases');
  assert.ok((points.demo.mask ?? []).includes('#status'), 'sciviz-points must mask #status');
});

// The orrery opened on Date.now(), so its planets sat at a new longitude in every capture: its two native captures
// differed (d > 2 on 0.32%) and the layer's, taken later, differed by 3.27%. A page that takes ?date= opens on the
// clock without it, so every case of such a page names a date.
test('every case whose page takes ?date= names one, so its still frame does not follow the clock', () => {
  const dated = [];
  for (const c of allCases) {
    const source = sourceOf(c.demo.path, c.demo.dev);
    if (!source || !existsSync(resolve(root, source))) continue;
    const folder = resolve(root, source, '..');
    const scripts = ['main.ts', 'main.js'].map((name) => resolve(folder, name)).filter(existsSync);
    if (!scripts.some((file) => /\.get\(['"]date['"]\)/.test(readFileSync(file, 'utf8')))) continue;
    dated.push(c.id);
    assert.match(c.demo.path, /[?&]date=\d{4}-\d{2}-\d{2}/, `${c.id} opens on today's date`);
  }
  assert.ok(dated.includes('orrery'), 'the orrery takes ?date=');
});

test('the pixel comparison captures with partial raster off, so the page itself paints the same every load', () => {
  assert.ok(captureArgs.includes('--disable-partial-raster'));
  assert.ok(captureArgs.includes('--enable-unsafe-webgpu'));
  const run = readFileSync(resolve(root, 'scripts/visual-compat.mjs'), 'utf8');
  assert.match(run, /launchBrowser\(\{ headless: true, args: captureArgs \}\)/);
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { allCases } from '../scripts/support/visual-compat-pages.js';

const root = resolve(import.meta.dirname, '..');

/** The source page the site build (scripts/build-site.js) turns into the served path, or the dev server path itself. */
function sourceOf(path, dev) {
  const url = path.split(/[?#]/)[0];
  if (dev) return url;
  const folders = {
    'night-citadel/': 'apps/showcase-night-citadel/index.html',
    'gameplay-sandbox/': 'examples/gameplay-sandbox/index.html',
    'voxel/': 'examples/voxel-sandbox/index.html',
    'demos/earth/': 'packages/creative/examples/earth/index.html',
    'demos/boulder/': 'examples/boulder.html',
  };
  if (folders[url]) return folders[url];
  const package_ = url.match(/^demos\/(dof|tonemap|animator)\/$/);
  if (package_) return `packages/${package_[1]}/examples/index.html`;
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

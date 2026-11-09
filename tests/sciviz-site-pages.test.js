import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { scientificPages } from '../scripts/support/sciviz-site-pages.mjs';

test('all sciviz README examples and their scientific navigation destinations ship in the site build', () => {
  const root = new URL('../', import.meta.url);
  const readme = readFileSync(new URL('packages/sciviz/README.md', root), 'utf8');
  const linked = [...readme.matchAll(/examples\/(sciviz-[\w-]+)\.html/g)].map((m) => m[1]);
  assert.ok(linked.length >= 5, 'the real scientific examples are linked from the README');
  for (const page of new Set(linked)) {
    assert.ok(scientificPages.includes(page), `README example ${page} is absent from production build targets`);
    const html = readFileSync(new URL(`examples/${page}.html`, root), 'utf8');
    for (const [, target] of html.matchAll(/href="\.\/(sciviz-[\w-]+)\.html"/g))
      assert.ok(scientificPages.includes(target), `${page} navigates to unbuilt ${target}`);
  }
  assert.equal(new Set(scientificPages).size, scientificPages.length, 'build targets are unique');
  for (const page of scientificPages) assert.ok(existsSync(new URL(`examples/${page}.html`, root)), page);
  const builder = readFileSync(new URL('scripts/build-site.js', root), 'utf8');
  assert.match(builder, /import\s*\{\s*scientificPages\s*\}\s*from\s*'.\/support\/sciviz-site-pages\.mjs'/);
  assert.match(builder, /\.\.\.scientificPages/, 'the production build consumes the audited target list');
});

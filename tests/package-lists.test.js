// README.md and docs/README.md list every package by the catalog's layers, generated from docs/catalog.json
// (scripts/package-lists.js, run by build-catalog.js). Any hand edit or catalog change without a rebuild fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PACKAGE_LISTS, packageList, withPackageList } from '../scripts/package-lists.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const catalog = JSON.parse(read('docs/catalog.json'));

for (const [file, packagesPath] of Object.entries(PACKAGE_LISTS))
  test(`${file} lists every package by catalog layer`, () => {
    const text = read(file);
    assert.ok(text.includes(packageList(catalog, packagesPath)), `${file} is out of date: run npm run catalog:build`);
    const headings = [...text.matchAll(/^### (.+) \((\d+)\)$/gm)];
    assert.deepEqual(
      headings.map((match) => match[1]),
      [...new Set(catalog.map((entry) => entry.category))],
      'the ten layers, in catalog order',
    );
    const listed = [...text.matchAll(/^\| \[`([^`]+)`\]\(([^)]+)\)/gm)];
    assert.deepEqual(
      listed.map((match) => match[1]),
      catalog.map((entry) => entry.package),
      'every package once, in catalog order',
    );
    for (const [, name, link] of listed)
      assert.ok(readFileSync(new URL(link, new URL(`../${file}`, import.meta.url))), `${name}: ${link}`);
  });

test('a catalog change shows up as drift, and the rewrite keeps line endings', () => {
  const text = read('README.md'),
    moved = catalog.map((entry) => (entry.id === 'bvh' ? { ...entry, category: 'Loading and formats' } : entry));
  assert.ok(!text.includes(packageList(moved, 'packages/')));
  const crlf = withPackageList(text.replaceAll('\n', '\r\n'), moved, 'packages/');
  assert.ok(crlf.replaceAll('\r\n', '\n').includes(packageList(moved, 'packages/')));
  assert.equal(crlf.split('\n').length, crlf.split('\r\n').length);
  assert.throws(() => withPackageList('# no markers', catalog, 'packages/'), /markers/);
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classify, KNOWN, pageNames } from '../scripts/test-pages-browser.mjs';
import { planContext } from '../scripts/check-merge.mjs';

const dir = 'examples/test-pages';

test('the test-page runner takes every page but the integration ones', () => {
  assert.deepEqual(pageNames(['a.html', 'integration-game.html', 'b.ts', 'c.html']), ['a', 'c']);
  const names = pageNames();
  assert.ok(names.length >= 16, `found ${names.length} test pages`);
  assert.ok(!names.some((n) => n.startsWith('integration-')));
});

test('every test page loads the harness, so the runner can read what went wrong', () => {
  for (const name of pageNames()) {
    const html = readFileSync(`${dir}/${name}.html`, 'utf8');
    const src = html.match(/<script type="module" src="\.\/([^"]+)"/)?.[1];
    assert.ok(src, `${name}.html loads a module script from its own folder`);
    assert.match(readFileSync(`${dir}/${src}`, 'utf8'), /from '\.\/page-harness'|import '\.\/page-harness'/, src);
  }
});

test('a known bug is reported as known, an unknown finding fails, and a known bug that went away fails', () => {
  const known = [{ page: 'p', match: /road seam/, row: 'KB-TP0' }];
  const one = classify(
    'p',
    [
      { kind: 'bug', text: 'road seam open' },
      { kind: 'error', text: 'boom' },
    ],
    known,
  );
  assert.deepEqual(one.expected, [{ kind: 'bug', text: 'road seam open', row: 'KB-TP0' }]);
  assert.deepEqual(one.unexpected, [{ kind: 'error', text: 'boom' }]);
  assert.deepEqual(one.gone, []);
  assert.deepEqual(classify('p', [], known).gone, ['KB-TP0']);
  assert.deepEqual(classify('q', [], known), { expected: [], unexpected: [], gone: [] });
});

test('every known test-page bug names a page that exists and a KB row', () => {
  const names = new Set(pageNames());
  for (const k of KNOWN) {
    assert.ok(names.has(k.page), k.page);
    assert.match(k.row, /^KB-/);
  }
});

test('the test pages and their imports enter the GPU footprint', { timeout: 120000 }, async () => {
  const ctx = await planContext(process.cwd());
  const footprint = ctx.footprints['gpu/root/test:pages:browser'];
  assert.ok(footprint, 'test-page suite must be registered');
  for (const file of readdirSync(dir).filter((f) => /\.html$/.test(f) && !f.startsWith('integration-')))
    assert.ok(footprint.files.has(`${dir}/${file}`), file);
  assert.ok(footprint.packages.has('@margoengine/road'));
});

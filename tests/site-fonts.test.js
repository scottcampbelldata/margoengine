// Site typeface: Source Sans 3 is self-hosted (SIL OFL 1.1) and the pages never ask another host for a font.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const site = new URL('../site/', import.meta.url);
const read = (path) => readFileSync(new URL(path, site), 'utf8');
const pages = ['index.html', 'webgpu.html', '404.html'];
const FONT = 'fonts/SourceSans3-latin.woff2';

test('the font file is the unmodified Google Fonts Latin subset and the licence sits beside it', () => {
  const bytes = readFileSync(new URL(FONT, site));
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '19143dca075972bc84e3fd9eab7416dd40cc565dccb2435a044bdfabe060c7d5',
  );
  assert.match(read('fonts/OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(readFileSync(new URL('../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8'), /Source Sans 3/);
});

test('site.css loads the local face with font-display swap and a metric-matched fallback', () => {
  const css = read('site.css');
  assert.match(
    css,
    /font-family: "Source Sans 3";[^}]*font-weight: 200 900; font-display: swap;[^}]*fonts\/SourceSans3-latin\.woff2/,
  );
  assert.match(css, /unicode-range: U\+0000-00FF/);
  assert.match(css, /font-family: "Source Sans 3", "Source Sans 3 Fallback", system-ui/);
  assert.match(css, /"Source Sans 3 Fallback";[^}]*size-adjust: [\d.]+%/);
});

test('the launch pages preload the font and make no request to a font host', () => {
  const generated = readFileSync(new URL('../scripts/build-sizes.js', import.meta.url), 'utf8');
  for (const [name, html] of [...pages.map((p) => [p, read(p)]), ['sizes.html (build-sizes.js)', generated]]) {
    assert.match(
      html,
      /<link rel="preload" href="[./]*\/?fonts\/SourceSans3-latin\.woff2" as="font" type="font\/woff2" crossorigin>/,
      name,
    );
  }
  const files = ['site.css', ...pages, ...readdirSync(new URL('.', site)).filter((n) => n.endsWith('.html'))];
  for (const file of new Set(files)) {
    assert.doesNotMatch(read(file), /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|fonts\.bunny/, file);
  }
  assert.ok(existsSync(new URL(FONT, site)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSiteLinksLive, siteLinkFindings } from '../scripts/check-site-links.mjs';
import { demoPages, resolveRoute, siteFiles } from '../scripts/support/site-routes.mjs';

// Every margoengine.com link in the tracked sources names a page the site build produces and an anchor that page has
// (scripts/check-site-links.mjs, also run by `npm run hygiene`). The dead links it was written for stay below as
// fixtures: coded errors, READMEs and the site pointed at pages and anchors that did not exist.
const root = resolve(import.meta.dirname, '..');

test('every margoengine.com link in the tracked sources names a page and anchor the site produces', () => {
  assert.deepEqual(siteLinkFindings(root), []);
  assertSiteLinksLive(root);
});

test('the error anchors the packages link to exist on the errors page', () => {
  const links = (anchors) => anchors.map((id) => `https://margoengine.com/errors#${id}`).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'site-links-'));
  try {
    mkdirSync(join(dir, 'site'), { recursive: true });
    cpSync(join(root, 'site/errors.html'), join(dir, 'site/errors.html'));
    writeFileSync(join(dir, 'a.md'), links(['wgsl', 'wgsl-syntax', 'vfx-json', 'points', 'attached', 'failed']));
    assert.deepEqual(siteLinkFindings(dir, { files: ['a.md'], pages: new Map() }), []);
    writeFileSync(join(dir, 'b.md'), links(['no-such-entry']));
    const [finding] = siteLinkFindings(dir, { files: ['b.md'], pages: new Map() });
    assert.match(finding.why, /no #no-such-entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the links that were dead are found, and the replacements pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-links-'));
  try {
    mkdirSync(join(dir, 'site'), { recursive: true });
    cpSync(join(root, 'site/errors.html'), join(dir, 'site/errors.html'));
    writeFileSync(join(dir, 'site/index.html'), '<!doctype html>');
    mkdirSync(join(dir, 'examples/gallery'), { recursive: true });
    writeFileSync(join(dir, 'examples/gallery/khronos.html'), '<!doctype html>');
    const dead = [
      'https://margoengine.com/docs/wfc',
      'https://margoengine.com/docs/text',
      'https://margoengine.com/docs/navmesh',
      'https://margoengine.com/docs/exporters#textures',
      'https://margoengine.com/docs/limits#cinematic-orthographic',
      'https://margoengine.com/docs/errors#failed',
      'https://margoengine.com/errors/failed',
      'https://margoengine.com/llms/guides/kits.md',
      'https://margoengine.com/demos/no-such-demo/',
    ];
    writeFileSync(join(dir, 'dead.md'), dead.join('\n'));
    const found = siteLinkFindings(dir, { files: ['dead.md'], pages: new Map() });
    assert.deepEqual(
      found.map((f) => f.url),
      dead,
    );
    const pages = new Map([
      ['llms/packages/wfc.md', '# wfc\n\n## Limits\n'],
      ['llms/docs/guides/kits.md', '# Kits\n'],
    ]);
    writeFileSync(
      join(dir, 'live.md'),
      [
        'https://margoengine.com/llms/packages/wfc.md',
        'https://margoengine.com/llms/packages/wfc.md#limits.',
        'https://margoengine.com/llms/docs/guides/kits.md',
        'https://margoengine.com/errors#failed',
        'https://margoengine.com/',
        'https://margoengine.com/demos/split-screen.html',
        'https://margoengine.com/demos/tonemap/',
        'https://margoengine.com/gallery/khronos.html',
        '`https://margoengine.com/errors#${id}` and https://margoengine.com/errors#<id> are templates',
      ].join('\n'),
    );
    assert.deepEqual(siteLinkFindings(dir, { files: ['live.md'], pages }), []);
    writeFileSync(join(dir, 'bad-anchor.md'), 'https://margoengine.com/llms/packages/wfc.md#nope');
    assert.match(siteLinkFindings(dir, { files: ['bad-anchor.md'], pages })[0].why, /no #nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a redirect whose destination page or anchor is missing is found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-links-'));
  try {
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'site/errors.html'), '<!doctype html><h2 id="live">Live</h2>');
    writeFileSync(
      join(dir, 'site/_redirects'),
      [
        '# old addresses',
        '/docs/a /errors#live 301',
        '/docs/b /errors#gone 301',
        '/docs/c /docs/nowhere 301',
        '/docs/d https://example.com/x 301',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'a.md'), 'https://margoengine.com/docs/b and https://margoengine.com/docs/c');
    const found = siteLinkFindings(dir, { files: ['a.md'], pages: new Map() });
    assert.deepEqual(
      found.map((f) => [f.file, f.line, f.url]),
      [
        ['site/_redirects', 3, '/errors#gone'],
        ['site/_redirects', 4, '/docs/nowhere'],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the route list names every demo page the build makes, and resolves like Cloudflare Pages', () => {
  const { served } = siteFiles(root);
  for (const name of demoPages) assert.ok(served.has(`demos/${name}.html`), name);
  assert.equal(resolveRoute(served, '/errors'), 'errors.html');
  assert.equal(resolveRoute(served, '/demos/tonemap/'), 'demos/tonemap/index.html');
  assert.equal(resolveRoute(served, '/demos/tonemap'), 'demos/tonemap/index.html');
  assert.equal(resolveRoute(served, '/errors/failed'), null);
  assert.equal(resolveRoute(served, '/docs/wfc'), null);
});

test('relative links of a page under site/ are resolved against its own route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-links-'));
  try {
    mkdirSync(join(dir, 'site/docs'), { recursive: true });
    writeFileSync(join(dir, 'site/index.html'), '<!doctype html><h2 id="start">Start</h2>');
    writeFileSync(join(dir, 'site/other.html'), '<!doctype html>');
    writeFileSync(join(dir, 'site/site.css'), 'a{}');
    writeFileSync(join(dir, 'site/docs/guide.html'), '<!doctype html>');
    const page = (body) => `<!doctype html>\n${body}\n`;
    writeFileSync(
      join(dir, 'site/docs/live.html'),
      page(
        [
          '<link href="../site.css" rel="stylesheet">',
          '<a href="guide">guide</a> <a href="guide.html">again</a> <a href="../other">other</a> <a href="../">home</a>',
          '<a href="../#start">anchor</a> <a href="/other.html">root</a> <a href="#here">same page</a>',
          '<a href="https://example.com/x">out</a> <a href="mailto:a@b.c">mail</a> <a href="data:text/plain,hi">data</a>',
        ].join('\n'),
      ),
    );
    assert.deepEqual(siteLinkFindings(dir, { files: ['site/docs/live.html'], pages: new Map() }), []);
    // The same names, one level out, point at pages that are not there.
    writeFileSync(
      join(dir, 'site/dead.html'),
      page(
        [
          '<a href="missing.html">a</a>',
          '<a href="docs/gone">b</a>',
          '<img src="../x.png">',
          '<a href="other.html#nowhere">c</a>',
          '<a href="docs/guide.html">live</a>',
        ].join('\n'),
      ),
    );
    const found = siteLinkFindings(dir, { files: ['site/dead.html'], pages: new Map() });
    assert.deepEqual(
      found.map((f) => [f.line, f.url]),
      [
        [2, 'missing.html'],
        [3, 'docs/gone'],
        [4, '../x.png'],
        [5, 'other.html#nowhere'],
      ],
    );
    assert.match(found[3].why, /no #nowhere/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the route list holds the files scripts/build-site.js copies in beside the pages', () => {
  const { served } = siteFiles(root);
  for (const name of ['THIRD-PARTY-NOTICES.md', 'demos/assets/ATTRIBUTION.md']) assert.ok(served.has(name), name);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  README_CAP,
  generate,
  renderLlmsFull,
  renderLlmsTxt,
  sitePages,
  stale,
  writeSitePages,
} from '../scripts/build-llms.mjs';
import { GUIDES, collectCorpus, summaryOf } from '../scripts/support/llms-corpus.mjs';

// site/llms.txt and site/llms-full.txt are what AI coding tools read to learn Margo. They are generated from the
// package READMEs, the api/ reports and docs/, so any change to those makes them stale; this test is the check that
// fails then (fix: node scripts/build-llms.mjs). scripts/land-records.mjs regenerates them when a change lands.

const corpus = collectCorpus();

test('site/llms.txt and site/llms-full.txt are current (run: node scripts/build-llms.mjs)', () => {
  assert.deepEqual(stale(), []);
});

test('llms.txt follows the convention: title, summary, sections of links with one-line descriptions', () => {
  const text = renderLlmsTxt(corpus),
    lines = text.split('\n');
  assert.equal(lines[0], '# Margo Engine');
  assert.match(lines[2], /^> .{80,}/, 'a blockquote summary follows the title');
  assert.equal(lines.filter((line) => line.startsWith('# ')).length, 1, 'one H1');
  const sections = lines.filter((line) => line.startsWith('## '));
  assert.ok(sections.includes('## Start here') && sections.includes('## Guides') && sections.includes('## Optional'));
  assert.ok(sections.some((s) => s.startsWith('## Packages: ')));
  for (const line of lines.filter((l) => l.startsWith('- ')))
    assert.match(line, /^- \[[^\]]+\]\(https:\/\/margoengine\.com\/[^)\s]+\)(: .+)?$/, line);
  for (const pkg of corpus.packages) {
    if (pkg.readme.trim()) assert.ok(text.includes(`(https://margoengine.com/llms/packages/${pkg.id}.md)`), pkg.id);
    if (pkg.entries.length) assert.ok(text.includes(`(https://margoengine.com/llms/api/${pkg.id}.md)`), pkg.id);
  }
  assert.ok(text.includes('(https://margoengine.com/llms-full.txt)'));
});

test('every /llms/ link in llms.txt is a page the site build writes', () => {
  const pages = sitePages(corpus);
  const links = [...renderLlmsTxt(corpus).matchAll(/\(https:\/\/margoengine\.com\/(llms\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 100);
  for (const link of links) assert.ok(pages.has(link), `${link} is not written by writeSitePages`);
  for (const [path] of GUIDES)
    assert.ok(
      corpus.docs.some((doc) => doc.path === path),
      `${path} is listed in GUIDES but missing`,
    );
});

test('llms-full.txt carries the guides in full and every package README up to the cap', () => {
  const text = renderLlmsFull(corpus);
  for (const [path] of GUIDES) {
    const doc = corpus.docs.find((candidate) => candidate.path === path);
    assert.ok(text.includes(doc.text.trim()), `${path} in full`);
  }
  for (const pkg of corpus.packages.filter((p) => p.readme.trim()))
    assert.ok(text.includes(`${pkg.name} (packages/${pkg.id}/README.md)`), pkg.name);
  assert.ok(text.endsWith('\n') && !text.includes('\r'));
  // A README over the cap is cut at a paragraph and points at the whole page; no code fence is left open.
  const cut = text.split('\n\n=== ').filter((part) => part.includes('[README continues: '));
  assert.ok(cut.length > 0, 'some README is longer than the cap');
  for (const part of cut) {
    assert.equal((part.match(/^```/gm) ?? []).length % 2, 0, 'fences balanced');
    assert.ok(part.length < README_CAP + 400);
  }
});

test('the site pages hold each README, API report and doc verbatim, and the example list', () => {
  const pages = sitePages(corpus);
  const first = corpus.packages.find((pkg) => pkg.readme.trim() && pkg.entries.length);
  assert.equal(pages.get(`llms/packages/${first.id}.md`), first.readme);
  assert.ok(pages.get(`llms/api/${first.id}.md`).includes(first.entries[0].report.trim()));
  assert.equal(pages.get('llms/docs/conventions.md'), corpus.docs.find((d) => d.path === 'docs/conventions.md').text);
  assert.ok(pages.get('llms/examples.md').includes('examples/flight-helmet.html'));
  const dir = mkdtempSync(join(tmpdir(), 'margo-llms-'));
  try {
    assert.equal(writeSitePages(dir, corpus), pages.size);
    assert.equal(readFileSync(join(dir, 'llms/examples.md'), 'utf8'), pages.get('llms/examples.md'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the AI-tools guide, the HANDOFF notes and the whitepaper are handled as intended', () => {
  const paths = corpus.docs.map((doc) => doc.path);
  assert.ok(paths.includes('docs/ai-tools.md'));
  assert.ok(!paths.includes('docs/HANDOFF.md'), 'working notes are not published');
  assert.ok(!paths.some((path) => path.startsWith('docs/whitepaper/')));
  assert.ok(!paths.some((path) => /-20\d\d-\d\d-\d\d\.md$/.test(path)));
});

test('the check notices a README or API change, and a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-llms-stale-'));
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    write('README.md', '# Margo\n');
    write('docs/conventions.md', '# Conventions\n\nRules.\n');
    write('examples/README.md', '## Example pages\n\n| [a.html](a.html) | An example |\n');
    write('api/alpha.api.md', '```ts\nexport function a(): void;\n```\n');
    write(
      'packages/alpha/package.json',
      JSON.stringify({ name: '@margoengine/alpha', description: 'Alpha.', exports: { '.': {} } }),
    );
    write('packages/alpha/README.md', '# alpha\n\nHello.\n');
    assert.deepEqual(stale(dir), ['site/llms.txt', 'site/llms-full.txt'], 'nothing generated yet');
    for (const [path, text] of Object.entries(generate(dir))) write(path, text);
    assert.deepEqual(stale(dir), []);
    write('packages/alpha/README.md', '# alpha\n\nHello, changed.\n');
    assert.deepEqual(stale(dir), ['site/llms-full.txt'], 'a README change makes llms-full.txt stale');
    write('api/alpha.api.md', '```ts\nexport function b(): void;\n```\n');
    write('packages/alpha/README.md', '# alpha\n\nHello.\n');
    assert.deepEqual(stale(dir), [], 'API reports go to the linked pages, not into the two files');
    write(
      'packages/alpha/package.json',
      JSON.stringify({ name: '@margoengine/alpha', description: 'Alpha, renamed.', exports: { '.': {} } }),
    );
    assert.deepEqual(stale(dir), ['site/llms.txt'], 'a description change makes llms.txt stale');
    // CRLF checkouts compare equal.
    write('site/llms.txt', generate(dir)['site/llms.txt'].replaceAll('\n', '\r\n'));
    assert.deepEqual(stale(dir), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('summaryOf takes the first prose paragraph after the title', () => {
  assert.equal(summaryOf('# T\n\n```sh\nnpm i\n```\n\nFirst line\nsecond line.\n\nNext.'), 'First line second line.');
  assert.equal(summaryOf('# T\n\n| a | b |\n\n- list\n\nProse.'), 'Prose.');
});

// A check once fetched whatever pinned file was missing from its cache: running the texture check on a folder that held
// only the KTX2 files downloaded 166 more files nobody had asked for, and six other checks did the same. A check now
// fetches only when started with --download; without it, it fails and names what is missing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { cachedProductionAssets } from '../scripts/support/gltf-production-assets.js';
import { cachedLobeAssets } from '../scripts/support/materials-lobe-assets.js';
import { ensurePBRBoxAssets } from '../scripts/support/pbr-box-assets.js';
import { downloadAllowed, pinnedFiles } from '../scripts/support/pinned-files.mjs';

const root = resolve(import.meta.dirname, '..');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), 'margo-pinned-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A stand-in network: records every address asked for and answers from a table. */
function network(answers = {}) {
  const asked = [];
  return {
    asked,
    fetch: async (url) => {
      asked.push(url);
      return url in answers ? new Response(answers[url]) : new Response('', { status: 404 });
    },
  };
}

test('--download is the only argument that allows a check to fetch', () => {
  assert.equal(downloadAllowed([]), false);
  assert.equal(downloadAllowed(['--downloads', 'download', '--download=no']), false);
  assert.equal(downloadAllowed(['--download']), true);
});

test('without the flag nothing is fetched, and every missing or changed file is named with the command', async (t) => {
  const cache = await folder(t),
    net = network();
  const rows = ['held', 'changed', 'absent'].map((name) => ({
    path: join(cache, name),
    url: `https://files.invalid/${name}`,
    sha256: sha256(name),
  }));
  await writeFile(rows[0].path, 'held');
  await writeFile(rows[1].path, 'something else');
  await assert.rejects(pinnedFiles(rows, { command: 'node check.mjs', fetch: net.fetch }), (error) => {
    assert.match(error.message, /^2 of 3 pinned files/);
    assert.ok(error.message.includes(`changed: ${rows[1].path} (${rows[1].url})`), error.message);
    assert.ok(error.message.includes(`missing: ${rows[2].path} (${rows[2].url})`), error.message);
    assert.ok(!error.message.includes(rows[0].url), error.message);
    assert.match(error.message, /Nothing was fetched\. To fetch them, run: node check\.mjs --download$/);
    return true;
  });
  assert.deepEqual(net.asked, []);
  assert.equal(await readFile(rows[1].path, 'utf8'), 'something else', 'a changed file is left as it was');
});

test('with the flag only the wanted files are fetched, and a wrong answer is refused', async (t) => {
  const cache = await folder(t);
  const row = (name) => ({ path: join(cache, name), url: `https://files.invalid/${name}`, sha256: sha256(name) });
  const rows = [row('held'), row('absent')];
  await writeFile(rows[0].path, 'held');
  const net = network({ [rows[1].url]: 'absent' });
  const read = await pinnedFiles(rows, { command: 'check', download: true, fetch: net.fetch });
  assert.deepEqual(read.map(String), ['held', 'absent']);
  assert.deepEqual(net.asked, [rows[1].url]);
  const wrong = row('wrong');
  await assert.rejects(
    pinnedFiles([wrong], { command: 'check', download: true, fetch: network({ [wrong.url]: 'other' }).fetch }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(readFile(wrong.path), { code: 'ENOENT' });
});

test('the glTF and PBR box checks fail on an empty cache without touching the network', async (t) => {
  const cache = await folder(t),
    net = network(),
    real = globalThis.fetch;
  globalThis.fetch = net.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  for (const [run, named] of [
    [() => cachedProductionAssets({ root: cache }), /\.ktx2[\s\S]*gltf-production-assets-tests\.js --download/],
    [
      () => cachedLobeAssets({ root: cache, productionRoot: cache }),
      /SheenChair\.glb[\s\S]*material-extension-tests\.js --download/,
    ],
    [() => ensurePBRBoxAssets({ directory: cache }), /Avocado\.bin[\s\S]*pbr-box-tests\.js --download/],
  ])
    await assert.rejects(run(), named);
  assert.deepEqual(net.asked, []);
});

// The class: a file that calls the global fetch on something other than the local server and also writes files can fill
// a cache from outside. Only the scripts below may; a check reads its outside files through pinnedFiles instead.
const MAY_FETCH_AND_WRITE = {
  'scripts/build-catalog.js': 'a build step that asks the npm registry which versions are published',
  'scripts/check-live-island-build.js': 'compares the live site named on its command line with the local build',
  'scripts/fetch-readme-assets.mjs': 'a download script (tests/download-script-arguments.test.js)',
  'scripts/reference-rendering/fetch-assets.mjs': 'a download script (tests/download-script-arguments.test.js)',
  'scripts/publish-rehearsal.mjs': 'a stand-in npm registry that forwards dependency requests to npm',
  'scripts/support/record-reads.mjs': 'wraps fetch to record what a check reads',
  'scripts/modern-browser-tests.js': 'asks the Next server it started on this machine',
  'scripts/quickstart-timing.mjs': 'asks the dev server it started on this machine',
  'scripts/reference-rendering/blend-repeat-scene.mjs': 'fetches only with download (reference-blend-repeat.test.js)',
  'scripts/umbrella.mjs': 'writes the source of a function that reads the import map beside its own page',
  'packages/loaders/scripts/test-real-files.mjs':
    'refuses absent files without --download (packages/loaders/tests/real-files-download.test.js)',
  'packages/sciviz/tests/notebook-browser.mjs': 'a page that reads the local server',
  'packages/terrain/test/imagery.browser.mjs': 'a page that reads fixtures from the local server',
  'packages/terrain/test/overlays.browser.mjs': 'a page that reads fixtures from the local server',
  'packages/terrain/test/rvt.browser.mjs': 'a page that reads fixtures from the local server',
  'packages/sciviz/scripts/fetch-graph-gpu-data.mjs': 'a download script (tests/download-script-arguments.test.js)',
  'packages/sciviz/scripts/prepare-stats.mjs': 'a download script (tests/download-script-arguments.test.js)',
  'packages/sky/test/fixtures/horizons/fetch-horizons.mjs':
    'a download script (tests/download-script-arguments.test.js)',
};

/** Whether this source can save something it fetched from outside the local server. */
export function savesOutsideFetches(source) {
  const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  // A method (route.fetch), a declaration and a path on the local server are not outside fetches.
  const outside = /(?<![.\w$]|function )fetch\((?!\s*(['"`])(\/|\.\/|\.\.\/))(?!\s*`\$\{(host|base|origin)\b)/;
  return outside.test(code) && /\b(writeFile|writeFileSync|createWriteStream)\s*\(/.test(code);
}

test('the class guard sees the shapes the old checks had', () => {
  for (const old of [
    'const r = await fetch(tile.url);\nawait writeFile(path, bytes);',
    'const response = await fetch(sampleAssetBase + path);\nawait writeFile(cache, data);',
    'const bytes = await readResponse(await fetch(url), {});\nwriteFileSync(path, bytes);',
  ])
    assert.equal(savesOutsideFetches(old), true, old);
  for (const local of [
    "await fetch('/fixture.bin');\nawait writeFile(report, text);",
    'await route.fetch();\nawait writeFile(report, text);',
    'const r = await fetch(url);',
  ])
    assert.equal(savesOutsideFetches(local), false, local);
});

test('no check fills a cache from outside by itself', () => {
  const found = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'scripts',
      'tools',
      ':(glob)packages/*/scripts/**',
      ':(glob)packages/*/test/**',
      ':(glob)packages/*/tests/**',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 },
  )
    .split('\0')
    .filter((file) => /\.(c?js|mjs|ts)$/.test(file))
    .filter((file) => savesOutsideFetches(readFileSync(resolve(root, file), 'utf8')));
  assert.deepEqual(
    found.filter((file) => !(file in MAY_FETCH_AND_WRITE)),
    [],
    'a check reads outside files with pinnedFiles (scripts/support/pinned-files.mjs), which fetches only with --download',
  );
});

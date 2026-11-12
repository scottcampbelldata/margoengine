// Bug (2026-11-12): docs/guides/imports.md, docs/ai-tools.md and docs/deploying.md told readers to run
// `npm i margoengine`, `npm i -D @margoengine/mcp` or `npm create margo` while no Margo package is on npm (the name
// `margoengine` holds a 0.0.1 placeholder), with no word that the command does not work yet. While docs/catalog.json
// marks any package unpublished, a reader page that shows such a command also says it waits for publication.
// docs/guides/imports.md also gave the CDN import map 568 entries when the build writes 2,623.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { documents } from '../scripts/docs-links.mjs';
import { importMap } from '../scripts/umbrella.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Internal records and the package READMEs (their own check) are not reader pages for this rule.
const SKIP =
  /^(?:docs\/(?:whitepaper|architecture|upstream-reports|research)\/|packages\/|CHANGELOG\.md$|docs\/known-bugs\.md$)/;
const SHELL = /```(?:sh|bash|shell|console|powershell|ps1)?\r?\n([\s\S]*?)```/g;
const INSTALL = /\bnpm (?:i|install|add)\b[^\n]*?(?:\bmargoengine\b|@margoengine\/)/;
const CREATE = /\bnpm create margo\b/;
const NOTE =
  /not on npm|not (?:yet )?published|publication is pending|(?:once|after|until|when|before)\b[^\n]{0,40}?\bpublished|before 1\.0\.0/i;

/** True when the page shows a Margo install command a reader would run: in a shell block, or `npm create margo`. */
function showsInstall(text) {
  if (CREATE.test(text)) return true;
  for (const [, block] of text.matchAll(SHELL)) if (INSTALL.test(block)) return true;
  return false;
}

test('the rule reads shell blocks and npm create, not prose about installs', () => {
  assert.ok(showsInstall('```sh\nnpm i margoengine\n```'));
  assert.ok(showsInstall('```\nnpm install @margoengine/core @margoengine/gltf\n```'));
  assert.ok(showsInstall('For an app, `npm create margo@latest my-app`.'));
  assert.ok(!showsInstall('`npm i margoengine` does not install React.'));
  assert.ok(!showsInstall('```sh\nnpm install vite\n```'));
  assert.ok(NOTE.test('The packages are not on npm yet.'));
  assert.ok(NOTE.test('It works once 1.0.0 is published to npm.'));
  assert.ok(!NOTE.test('npm i margoengine installs every package.'));
});

test('a page with a Margo install command says the packages are not published yet', () => {
  const catalog = JSON.parse(read('docs/catalog.json'));
  if (catalog.every((entry) => entry.published)) return; // after 1.0.0 the note is no longer owed
  const missing = documents().filter((file) => !SKIP.test(file) && showsInstall(read(file)) && !NOTE.test(read(file)));
  assert.deepEqual(
    missing,
    [],
    'add a line saying the command works once 1.0.0 is published, and what to do until then',
  );
});

test('docs/guides/imports.md gives the import map its real entry count', () => {
  const count = Object.keys(importMap().imports).length;
  const stated = /\(([\d,]+) of them\)/.exec(read('docs/guides/imports.md'));
  assert.ok(stated, 'docs/guides/imports.md states how many entries the import map has');
  assert.equal(Number(stated[1].replaceAll(',', '')), count, 'scripts/umbrella.mjs importMap() entry count');
});

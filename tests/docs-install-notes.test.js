// Bug (2026-11-12): docs/guides/imports.md, docs/ai-tools.md and docs/deploying.md told readers to run
// `npm i margoengine`, `npm i -D @margoengine/mcp` or `npm create margo` while no Margo package was on npm.
// As of 0.1.0 the packages are on npm, so those commands are the install path. docs/catalog.json still marks
// entries unpublished: scripts/build-catalog.js compares each package.json version (1.0.0 in this tree) with the
// registry, and 1.0.0 is not the published release. That file is left unchanged. The pages below must not still
// say the packages are unpublished.
// docs/guides/imports.md also gave the CDN import map 568 entries when the build writes 2,623.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMPORT_MAP_COUNT, importMap, umbrellaFiles } from '../scripts/umbrella.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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

test('the public install pages do not say the packages are unpublished', () => {
  const stale =
    /not on npm|none published|publication is pending|name placeholder|0\.0\.1[^\n]{0,40}placeholder|until 1\.0\.0 is published|once 1\.0\.0 is published|stays private/i;
  const files = [
    'README.md',
    'docs/start-here.md',
    'docs/guides/kits.md',
    'docs/from-babylon.md',
    'docs/from-playcanvas.md',
    'docs/guides/imports.md',
    'docs/guides/react-first-scene.md',
    'docs/guides/blender-game.md',
    'docs/react-nextjs-options.md',
    'docs/whitepaper/reproduce.md',
    'packages/margoengine/README.md',
    'packages/core/README.md',
    'site/index.html',
    'site/whitepaper/engine.html',
  ];
  assert.deepEqual(
    files.filter((file) => stale.test(read(file))),
    [],
  );
});

test('docs/guides/imports.md gives the import map its real entry count', () => {
  const count = Object.keys(importMap().imports).length;
  const stated = IMPORT_MAP_COUNT.exec(read('docs/guides/imports.md'));
  assert.ok(stated, 'docs/guides/imports.md states how many entries the import map has');
  assert.equal(
    Number(stated[1].replaceAll(',', '')),
    count,
    'scripts/umbrella.mjs importMap() entry count; node scripts/umbrella.mjs writes it',
  );
});

test('the import map entry count in docs/guides/imports.md is a generated figure (KB-DOCS-MAPCOUNT1)', () => {
  // Lanes added entries and the hand-kept figure drifted (2,772 stated against 2,778, then 2,784). umbrellaFiles
  // writes the guide with the rest of the generated files, from the same manifests importMap() reads.
  const written = umbrellaFiles()['docs/guides/imports.md'];
  assert.ok(written, 'scripts/umbrella.mjs writes docs/guides/imports.md');
  assert.equal(Number(IMPORT_MAP_COUNT.exec(written)[1].replaceAll(',', '')), Object.keys(importMap().imports).length);
});

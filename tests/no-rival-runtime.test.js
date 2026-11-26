// Margo connects to no rival engine at run time (Scott, 2026-11-26): no shipped source (packages/*/src) and no site
// script imports three.js or Babylon.js or names them, and no entry writes their formats. The one allowed connection is
// the .babylon scene loader (`@margoengine/loaders/babylon` and the kits that re-export it), so people can bring their
// scenes into Margo. Porting guides and comparisons live in docs/ and are not scanned here.
// Regression: the .babylon exporter (`@margoengine/exporters/babylon`) and the site's live code editor page were
// removed for this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = /\.(ts|tsx|js|mjs|cjs|jsx)$/;
/** A module specifier of either engine: `three`, `three/...`, `@babylonjs/...`, `babylonjs`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`](?:three(?:\/[^'"`]*)?|babylonjs[^'"`]*|@babylonjs\/[^'"`]*)['"`]/;
/** Either engine's name in text: three.js, threejs, Babylon in any case, and the THREE namespace in capitals only. */
const named = (text) => /three\.?js|babylon/i.test(text) || /\bTHREE\b/.test(text);
/** A function that would write their format. */
const WRITER = /\b(?:export|write|serialize|save|encode|to)[A-Z]?\w*Babylon\b/;

/** The .babylon import path: the loader and the entries that re-export it. Each may name the format; none may write it. */
export const LOADER = [
  /^packages\/loaders\/src\/(?:babylon|index)\.ts$/,
  /^packages\/[^/]+\/src\/loaders\/babylon\.ts$/,
];
const allowed = (file) => LOADER.some((pattern) => pattern.test(file));

const tracked = (...paths) =>
  execFileSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: root,
    maxBuffer: 1 << 28,
  })
    .toString()
    .split('\0')
    .filter(Boolean);

/** Problems in one file's text: an engine import anywhere, an engine name outside the loader path, a format writer. */
export function problems(file, text) {
  const out = [];
  if (SPECIFIER.test(text)) out.push(`${file}: imports three.js or Babylon.js`);
  if (!allowed(file) && named(text)) out.push(`${file}: names three.js or Babylon.js`);
  if (WRITER.test(text)) out.push(`${file}: writes the .babylon format`);
  return out;
}

test('the check catches an import, a name and a writer, and lets the loader name its format', () => {
  assert.deepEqual(problems('packages/x/src/a.ts', "import * as T from 'three';"), [
    'packages/x/src/a.ts: imports three.js or Babylon.js',
  ]);
  assert.equal(problems('packages/x/src/a.ts', "await import('@babylonjs/core')").length, 2);
  assert.deepEqual(problems('packages/x/src/a.ts', '// as three.js does'), [
    'packages/x/src/a.ts: names three.js or Babylon.js',
  ]);
  assert.deepEqual(problems('packages/loaders/src/babylon.ts', 'export function parseBabylon() {}'), []);
  assert.deepEqual(
    problems('packages/kit-web/src/loaders/babylon.ts', "export * from '@margoengine/loaders/babylon';"),
    [],
  );
  assert.equal(problems('packages/loaders/src/babylon.ts', 'export function exportBabylon() {}').length, 1);
  assert.deepEqual(problems('packages/x/src/a.ts', 'three numbers per point'), []);
});

test('no shipped source or site script imports or names three.js or Babylon.js, or writes their format', () => {
  const files = [
    ...tracked('packages').filter((file) => /^packages\/[^/]+\/src\//.test(file) && SCRIPT.test(file)),
    ...tracked('site').filter((file) => SCRIPT.test(file)),
  ];
  assert.ok(files.length > 1000, `scanned ${files.length} files`);
  const found = files.flatMap((file) => problems(file, readFileSync(join(root, file), 'utf8')));
  assert.deepEqual(found, []);
});

test('site pages import neither engine', () => {
  const found = tracked('site')
    .filter((file) => file.endsWith('.html'))
    .filter((file) => SPECIFIER.test(readFileSync(join(root, file), 'utf8')));
  assert.deepEqual(found, []);
});

test('no package exports an entry for their formats except the .babylon loader, and none depends on them', () => {
  const found = [];
  for (const name of readdirSync(join(root, 'packages'))) {
    const file = join(root, 'packages', name, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const key of Object.keys(manifest.exports ?? {}))
      if (named(key) && !(name === 'loaders' ? key === './babylon' : key === './loaders/babylon'))
        found.push(`${name}: exports ${key}`);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      for (const dependency of Object.keys(manifest[field] ?? {}))
        if (/^(?:three|@types\/three|babylonjs.*|@babylonjs\/.*)$/.test(dependency))
          found.push(`${name}: ${field}.${dependency}`);
  }
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
    for (const dependency of Object.keys(rootManifest[field] ?? {}))
      if (/^(?:three|@types\/three|babylonjs.*|@babylonjs\/.*)$/.test(dependency))
        found.push(`root: ${field}.${dependency}`);
  assert.deepEqual(found, []);
});

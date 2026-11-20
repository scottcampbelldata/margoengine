// Every GPU or browser check honours MARGO_COMPAT=1 (KB-SKY-COMPATCHECK1, 2026-11-16). A forced-compatibility run
// (scripts/support/compat-shim.js) must draw on the WebGL2 layer, yet a script that opens its own page with a browser of
// its own (`browser.newPage()`) and never installs the shim runs native WebGPU, and its MARGO_COMPAT=1 leg passes as a
// layer result while testing nothing of the layer. openBrowser (scripts/browser.js) and postBrowser
// (packages/post/test/post-browser.mjs) install the shim on every page they open; any other file that opens a page must
// name compatShim, compatRun() or installCompat, or say in a line `MARGO_COMPAT not applicable: <reason>` why the layer
// has nothing to do there (a page without GPU work, or a page that runs the layer itself).
//
// The files that open pages without either are listed in scripts/support/compat-owed.json, each to be given the shim or
// its reason; a new file that does neither fails here, and so does a listed file that now does one (take it off).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import test from 'node:test';
import { plan, ROOT } from '../scripts/gpu-package-tests.mjs';
import { nodeFiles } from './support/gpu-script-files.js';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

/** True when the text opens a page or context of a browser itself. */
export const opensPage = (text) => /\.newPage\s*\(|\.newContext\s*\(/.test(text);
/** True when the text routes its pages through the WebGL2 layer in a forced-compatibility run, or says why not. */
export const honoursCompat = (text) =>
  /\bcompatShim\b|\bcompatRun\s*\(|\binstallCompat\b|MARGO_COMPAT not applicable: \S/.test(text);

/** The repository files a script file imports by a relative path (static and literal dynamic imports). */
export function localImports(text, file) {
  const out = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm))
    if (/\.(?:mjs|js|cjs)$/.test(m[2])) out.push(normalize(join(dirname(file), m[2])));
  return out;
}

/** Every file a GPU or browser test runs, with the local files those import, transitively. */
export function checkFiles(load = read, has = (f) => existsSync(join(root, f))) {
  const scripts = JSON.parse(load('package.json')).scripts,
    tests = [...plan().map((t) => [t.command, t.cwd]), ...Object.keys(ROOT).map((n) => [scripts[n] ?? '', '.'])],
    files = new Map();
  const visit = (file) => {
    if (files.has(file) || !has(file)) return;
    const text = load(file);
    files.set(file, text);
    for (const f of localImports(text, file)) visit(f);
  };
  for (const [command, cwd] of tests) for (const [file] of nodeFiles(command, cwd)) visit(file);
  return files;
}

/** The files that open a page and do not honour MARGO_COMPAT=1. */
export function ignoringCompat(files) {
  return [...files]
    .filter(([, text]) => opensPage(text) && !honoursCompat(text))
    .map(([file]) => file.replaceAll('\\', '/'))
    .sort();
}

test('a script that opens its own page without the shim is caught, one with it or a reason is not', () => {
  const own = "const browser = await launchBrowser();\nconst page = await browser.newPage();\nawait page.goto(url);";
  assert.ok(opensPage(own) && !honoursCompat(own), 'its MARGO_COMPAT=1 run would be native WebGPU');
  assert.ok(honoursCompat(own + '\nif (compatRun()) await page.addInitScript(compatShim);'));
  assert.ok(honoursCompat('// MARGO_COMPAT not applicable: the page makes no GPU calls\n' + own));
  assert.ok(!honoursCompat('// MARGO_COMPAT not applicable:\n' + own), 'a reason is required');
  // A tag that only names the run in a log does not switch the backend.
  assert.ok(!honoursCompat("const tag = process.env.MARGO_COMPAT === '1' ? 'compat' : 'native';\n" + own));
  // openBrowser and postBrowser carry the shim for the scripts that call them.
  assert.ok(!opensPage("const { page } = await openBrowser({ startPath: '/x.html' });"));
  assert.ok(honoursCompat(read('scripts/browser.js')) && opensPage(read('scripts/browser.js')));
  assert.ok(honoursCompat(read('packages/post/test/post-browser.mjs')));
  assert.deepEqual(localImports("import { a } from '../b.mjs';\nconst c = await import('./d.js');", 'p/t/x.mjs'), [
    normalize('p/b.mjs'),
    normalize('p/t/d.js'),
  ]);
});

test('every GPU or browser check honours MARGO_COMPAT=1, or is on the owed list', () => {
  const files = checkFiles(),
    owed = JSON.parse(read('scripts/support/compat-owed.json')).files,
    ignoring = ignoringCompat(files);
  assert.ok(files.size > 100, `the scan reaches the check scripts: ${files.size}`);
  assert.ok(files.has(normalize('packages/sky/test/features-check.mjs')), 'sky features-check is scanned');
  assert.deepEqual(
    ignoring.filter((f) => !owed.includes(f)),
    [],
    'these open their own page without compatShim; install it (scripts/support/compat-shim.js) or give the reason',
  );
  assert.deepEqual(
    owed.filter((f) => !ignoring.includes(f)),
    [],
    'these now honour MARGO_COMPAT=1 or are gone; take them off scripts/support/compat-owed.json',
  );
});

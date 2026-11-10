// Every package GPU or browser test that opens a page by a literal `startPath` must find that page under the folder
// its script runs in. scripts/browser.js serves the current folder, so a package script that runs
// `node test/x-browser.mjs` from packages/<name> and opens '/tests/modern-game.html' (a repository-root page) gets a
// 404 on every machine (animator test:avoidance:browser, found by the list 5 AMD hunt on 2026-11-10). The fix is the
// usual `cd ../.. && node packages/<name>/test/x-browser.mjs`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import test from 'node:test';
import { plan } from '../scripts/gpu-package-tests.mjs';

const root = resolve(import.meta.dirname, '..');

/** The pages a script file opens by a literal startPath (query and hash dropped; /@fs/ and absolute URLs skipped). */
export function literalStartPaths(text) {
  const paths = [];
  for (const m of text.matchAll(/\bstartPath\s*:\s*(['"`])([^'"`$]+)\1/g)) {
    const path = m[2].split(/[?#]/)[0];
    if (path.startsWith('/') && !path.startsWith('/@')) paths.push(path);
  }
  return paths;
}

/** [file run, folder it runs in] for each `node <file>` part of a script, following its `cd` parts. */
export function nodeFiles(command, cwd) {
  const out = [];
  let dir = cwd;
  for (const part of command.split(/\s*&&\s*/)) {
    const cd = /^cd\s+(\S+)$/.exec(part);
    if (cd) dir = normalize(join(dir, cd[1]));
    const node = /^node\s+(?:--\S+\s+)*([^\s-]\S*\.(?:mjs|js|cjs))\b/.exec(part);
    if (node) out.push([normalize(join(dir, node[1])), dir]);
  }
  return out;
}

/** The folder a script serves: where it runs, or what its `process.chdir(... new URL(rel, import.meta.url))` names. */
export function servedFolder(text, file, dir) {
  const chdir = /process\.chdir\([^;]*?new URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url/.exec(text);
  return chdir ? normalize(join(dirname(file), chdir[2])) : dir;
}

/** Each opened page that does not exist under the folder its script serves. */
export function missingStartPages(tests = plan(), read = (f) => readFileSync(join(root, f), 'utf8')) {
  const missing = [];
  for (const t of tests) {
    if (t.cwd === '.') continue;
    for (const [file, dir] of nodeFiles(t.command, t.cwd)) {
      if (!existsSync(join(root, file))) continue;
      const text = read(file),
        served = servedFolder(text, file, dir);
      for (const page of literalStartPaths(text))
        if (!existsSync(join(root, served, page)))
          missing.push(`${t.label}: ${file} opens ${page}, not under ${served}`);
    }
  }
  return missing;
}

test('a package script that serves its own folder and opens a repository page is caught', () => {
  const read = () => "await openBrowser({startPath:'/tests/modern-game.html',port:'free'});";
  const at = (command) => [{ label: 'animator test:avoidance:browser', cwd: 'packages/animator', command }];
  // The broken script: served from packages/animator, where tests/modern-game.html does not exist.
  assert.equal(missingStartPages(at('node test/avoidance-browser.mjs'), read).length, 1);
  // The fixed script serves the repository root.
  assert.deepEqual(missingStartPages(at('cd ../.. && node packages/animator/test/avoidance-browser.mjs'), read), []);
  // A file that chdirs to the root itself is served from there.
  const chdir = () => "process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));" + read();
  assert.deepEqual(missingStartPages(at('node test/avoidance-browser.mjs'), chdir), []);
});

test('the parsers follow cd parts and drop queries', () => {
  assert.deepEqual(nodeFiles('cd ../.. && node --test-x packages/a/t.mjs && node b.js', 'packages/a'), [
    [normalize('packages/a/t.mjs'), '.'],
    [normalize('b.js'), '.'],
  ]);
  assert.deepEqual(literalStartPaths("startPath: '/tests/x.html?y=1', startPath:`/@fs/z`, startPath:'/p.html#a'"), [
    '/tests/x.html',
    '/p.html',
  ]);
});

test('every package GPU and browser test opens a page that its served folder has', () => {
  assert.deepEqual(missingStartPages(), []);
});

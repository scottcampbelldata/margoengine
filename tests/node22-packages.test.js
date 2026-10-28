// Which packages' unit tests run on Node 22 (bug 39 level 2): scripts/node22-packages.json sorts every published
// package into node (its tests run on Node 22.12 and the latest 22.x), contributorNode (tests that need Node 24.18)
// or browserOnly (covered on Node 22 by the end-user proof). A package that runs code in Node by its own declaration,
// a bin, a `node` export condition or a node:* import in src, must not sit in browserOnly or be missing.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { config, packageDirs, testFiles } from '../scripts/node22-tests.mjs';

const root = resolve(import.meta.dirname, '..');

/** Why `manifest` (in `dir`) runs in Node by its own declaration: bin, node condition, node:* imports in src. */
function nodeSignals(dir, manifest) {
  const signals = [];
  if (manifest.bin) signals.push('a bin');
  if (/"node"\s*:/.test(JSON.stringify(manifest.exports ?? {}))) signals.push('a node export condition');
  const walk = (folder) => {
    for (const name of existsSync(folder) ? readdirSync(folder) : []) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:tsx?|m?js)$/.test(name) && /(?:from\s+|import\(\s*)['"]node:/.test(readFileSync(path, 'utf8')))
        signals.push(`node: imports (${name})`);
    }
  };
  walk(join(dir, 'src'));
  return signals;
}

test('every published package is in exactly one list, with a reason', () => {
  const { node, contributorNode, browserOnly } = config();
  const lists = { node, contributorNode, browserOnly };
  for (const name of packageDirs(root).keys()) {
    const holders = Object.entries(lists)
      .filter(([, list]) => name in list)
      .map(([key]) => key);
    assert.equal(
      holders.length,
      1,
      `${name} is in ${holders.length ? holders.join(' and ') : 'no list'} of scripts/node22-packages.json`,
    );
  }
  for (const [key, list] of Object.entries(lists))
    for (const [name, entry] of Object.entries(list)) {
      assert.ok(packageDirs(root).has(name), `${key} lists ${name}, which is not a published package`);
      const reason = typeof entry === 'string' ? entry : entry.reason;
      assert.ok(reason?.length > 10, `${name} needs a reason in scripts/node22-packages.json`);
    }
});

test('a package that runs in Node by its own declaration is not browser-only', () => {
  const { browserOnly } = config();
  const wrong = [...packageDirs(root)]
    .map(([name, { dir, manifest }]) => [name, nodeSignals(dir, manifest)])
    .filter(([name, signals]) => signals.length && name in browserOnly)
    .map(([name, signals]) => `${name} (${signals.join(', ')})`);
  assert.deepEqual(wrong, []);
});

test('every Node-run package has test files on disk', () => {
  for (const { name, files } of testFiles(root)) assert.ok(files.length > 0, name);
});

test("CI runs them on Node 22.12.0 and the latest 22.x in the job 'node22 unit tests (Node-run packages)'", () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
  const job = /^ {2}node22-tests:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(ci)?.[1] ?? '';
  assert.match(job, /name: node22 unit tests \(Node-run packages\) on/);
  assert.match(job, /node: \['22\.12\.0', '22'\]/);
  assert.match(job, /npm run build:packages/);
  assert.match(job, /node scripts\/node22-tests\.mjs/);
});

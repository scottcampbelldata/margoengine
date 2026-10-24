// Gate 3, tests floor: every package has tests that `npm run verify` runs (tests/*.test.js, packages/*/tests/*.test.js,
// packages/*/test/*.test.js), and every public entry is imported by at least one of them (or by a helper module next to
// them). An import counts by bare specifier ('@margoengine/x/sub'), by path to the entry's dist or src file
// ('packages/x/dist/sub.js', '../src/sub.ts', resolved from the test file), in static imports, import() and plain
// strings handed to import(pathToFileURL(...)).
// Items: `untested <package>` -> 1, `unimported <specifier>` -> 1.
// Coverage is not measured: node's --experimental-test-coverage over the whole suite costs more than the suite itself,
// and a third-party tool (c8) is not allowed; the entry floor stands in for it.
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { slash } from './packages.js';

const RUN = /^(tests\/[^/]+\.test\.js|packages\/[^/]+\/tests?\/[^/]+\.test\.js)$/;
const HELPER = /^(tests\/[^/]+|packages\/[^/]+\/tests?\/[^/]+)\.(js|mjs)$/;

export function testsGate({ root, files, packages }) {
  const tests = files.filter((f) => RUN.test(f));
  const helpers = files.filter((f) => HELPER.test(f) && !RUN.test(f));
  const bySpecifier = new Map();
  const byFile = new Map();
  for (const pkg of packages)
    for (const entry of pkg.entries) {
      bySpecifier.set(entry.specifier, entry);
      byFile.set(entry.dist, entry);
      if (entry.src) byFile.set(entry.src, entry);
    }
  const imported = new Set(); // specifiers
  const testedPackages = new Set();
  const scan = (file, isTest) => {
    const text = readFileSync(join(root, file), 'utf8');
    const own = /^packages\/([^/]+)\//.exec(file)?.[1];
    if (own && isTest) testedPackages.add(own);
    for (const [, s] of text.matchAll(/['"`]((?:@margoengine\/|margoengine|\.{1,2}\/|packages\/)[^'"`\s]*)['"`]/g)) {
      let entry = bySpecifier.get(s);
      if (!entry) {
        const path = slash(normalize(s.startsWith('packages/') ? s : join(dirname(file), s)));
        entry = byFile.get(path) ?? byFile.get(path.replace(/\.js$/, '.ts'));
      }
      if (!entry) continue;
      imported.add(entry.specifier);
      if (isTest) testedPackages.add(entry.specifier.replace(/^(@margoengine\/[^/]+|margoengine).*$/, '$1'));
    }
  };
  for (const file of tests) scan(file, true);
  for (const file of helpers) scan(file, false);
  const dirOf = new Map(packages.map((p) => [p.name, p.dir]));
  const tested = new Set([...testedPackages].map((n) => dirOf.get(n) ?? n));
  const items = {};
  for (const pkg of packages) {
    if (!pkg.entries.length) continue;
    if (!tested.has(pkg.dir)) items[`untested ${pkg.name}`] = 1;
    for (const entry of pkg.entries) if (!imported.has(entry.specifier)) items[`unimported ${entry.specifier}`] = 1;
  }
  return {
    items,
    summary: () =>
      Object.keys(items)
        .slice(0, 20)
        .map((k) => `  ${k}`),
  };
}

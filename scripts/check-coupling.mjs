// The merge gate's guard for the physics framework (docs/physics-framework.md, section 10): every solver of the framework
// (a class that implements `Solver`, or a value typed or checked as one, in a package's `src`) is named by a test in a
// `tests/coupling/` folder that runs the coupling-test harness (`packages/physics/tests/coupling/harness.js`), so no solver
// joins a world without its coupling, conservation, frame-rate, snapshot, order and added-mass checks.
//
// Run: node scripts/check-coupling.mjs (exit 1 and the missing solvers when one has no harness test).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');

const DECLARATION =
  /\bclass\s+(\w+)[^{]*\bimplements\b[^{]*\bSolver\b|\b(?:const|let)\s+(\w+)\s*(?::\s*Solver\b|=[^;]*\bsatisfies\s+Solver\b)/g;
const HARNESS = /from\s+['"][^'"]*coupling\/harness\.js['"]|from\s+['"]\.\/harness\.js['"]/;

/** The framework solvers a source file declares: the names of classes implementing `Solver` and values typed as one. */
export function solversIn(text) {
  const names = [];
  for (const match of text.matchAll(DECLARATION)) names.push(match[1] ?? match[2]);
  return names;
}

/**
 * The solvers no harness test names. `sources` and `tests` are [path, text] pairs: package sources and the test files in
 * `tests/coupling/` folders; a test counts when it imports the harness and names the solver as a whole word.
 */
export function unguarded(sources, tests) {
  const harnessed = tests.filter(([, text]) => HARNESS.test(text)).map(([, text]) => text);
  const missing = [];
  for (const [path, text] of sources)
    for (const name of solversIn(text))
      if (!harnessed.some((t) => new RegExp(`\\b${name}\\b`).test(t))) missing.push(`${path}: ${name}`);
  return missing;
}

function tracked(...patterns) {
  return execFileSync('git', ['ls-files', '-z', '--', ...patterns], { maxBuffer: 2 ** 28, cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (path) => [path, readFileSync(resolve(root, path), 'utf8')];
  const sources = tracked('packages/*/src/**/*.ts')
      .filter((p) => !p.endsWith('.d.ts'))
      .map(read),
    tests = tracked('packages/*/tests/coupling/*.js', 'packages/*/tests/coupling/*.ts').map(read),
    missing = unguarded(sources, tests),
    count = sources.reduce((n, [, text]) => n + solversIn(text).length, 0);
  if (missing.length) {
    console.error(
      `check:coupling: ${missing.length} framework solver(s) with no coupling-harness test. Fix: add a test in the package's tests/coupling/ that imports packages/physics/tests/coupling/harness.js and runs the solver through it (docs/physics-framework.md, section 10):\n  ${missing.join('\n  ')}`,
    );
    // It ends by its event loop with code 1, as every check does (KB-OWN-EXIT2).
    process.exitCode = 1;
  } else console.log(`check:coupling: ok, ${count} framework solver(s), each with a coupling-harness test.`);
}

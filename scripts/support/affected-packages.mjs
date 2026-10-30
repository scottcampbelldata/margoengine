// Which package-level checks a change needs (`npm run check:merge`, scripts/check-merge.mjs). Pure: files, the package
// graph and an affected-gpu decision in, a scope out.
//
//   modern:test:packages   packs every package and installs the tarballs into a clean project. The packing, the install,
//                          the licence checks and the umbrella smoke test always run; the README examples of a package
//                          are type-checked only when the package is affected (a change to it, a package that depends on
//                          it, or its README), and the React lifecycle tests, the React docs and the packed browser run
//                          only when `react` is in that list (or a React doc changed). The full decision keeps it whole.
//   modern:test:bundlers   builds a tiny app with five bundlers from the packed packages. It runs when a changed package
//                          is one the matrix builds or imports (react, shadows, controls, stage, core, the umbrella, the
//                          Vite and Next starters) or one they depend on, or a file it runs changed (the `bundlers`
//                          footprint), and in the full decision. A changed file modern:test:packages runs (the
//                          `packages` footprint) runs it whole.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan, workspaceOf } from './affected-gpu.mjs';

const posix = (path) => path.replaceAll('\\', '/');

/** Workspaces the bundler matrix builds or imports: names of packages, and directories of the starters. */
export const MATRIX_ROOTS = [
  'margoengine',
  '@margoengine/react',
  '@margoengine/shadows',
  '@margoengine/controls',
  '@margoengine/stage',
  '@margoengine/core',
];
export const MATRIX_DIRS = ['examples/vite', 'examples/next'];

/** The documents modern-package-tests.js type-checks or copies next to the packed React package. */
export const REACT_DOCS = [
  'docs/react-cookbook.md',
  'docs/react-from-r3f.md',
  'docs/react-integration.md',
  'docs/react-r3f.md',
];

/** The first string target of an exports entry ({ import, browser, default } objects nest). */
const exportTarget = (entry) =>
  typeof entry === 'string' ? entry : entry && exportTarget(entry.import ?? entry.browser ?? entry.default);

/** The source files behind a package's exports (`./dist/x.js` is `src/x.ts`); only the root entry with `rootOnly`. */
function sourceEntries(root, w, rootOnly) {
  const manifest = JSON.parse(readFileSync(join(root, w.dir, 'package.json'), 'utf8')),
    out = [];
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (rootOnly && subpath !== '.') continue;
    const base = /^\.\/dist\/([\w-]+)\.js$/.exec(exportTarget(entry) ?? '')?.[1];
    const found =
      base && ['ts', 'tsx', 'js'].map((x) => `${w.dir}/src/${base}.${x}`).find((f) => existsSync(join(root, f)));
    if (found) out.push(found);
  }
  return out;
}

/**
 * Every workspace the matrix builds or imports: the packages in MATRIX_ROOTS and the starters, plus the packages their
 * entry sources reach (by import or mention; the React package only through its root entry, because the matrix imports
 * no other). The umbrella lists every package and is not followed: its imports are the ones named above.
 */
export function matrixClosure(root, workspaces) {
  const byName = new Map(workspaces.map((w) => [w.name, w])),
    starters = workspaces.filter((w) => MATRIX_DIRS.includes(w.dir)).map((w) => w.name),
    out = new Set([...MATRIX_ROOTS, ...starters].filter((name) => byName.has(name))),
    queue = MATRIX_ROOTS.filter((name) => byName.has(name) && name !== 'margoengine'),
    done = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (done.has(name)) continue;
    done.add(name);
    const w = byName.get(name),
      { packages } = scan(root, sourceEntries(root, w, name === '@margoengine/react'), workspaces);
    for (const reached of packages) {
      out.add(reached);
      if (reached !== 'margoengine') queue.push(reached);
    }
  }
  return out;
}

/**
 * Scope of the two package-level steps for a decision. `files` are the changed files; `browserFiles` the files the
 * packed browser test serves (tests/modern.html and what it imports) when one of them changes the packed test must
 * run whole. `closure` is matrixClosure().
 * Returns { packages: { full, dirs, reason }, bundlers: { run, reason } }; dirs are directory names under packages/.
 */
export function packageScopes({ decision, files, workspaces, browserFiles = new Set(), closure = new Set() }) {
  if (decision.mode === 'full')
    return {
      packages: { full: true, dirs: [], reason: decision.reason },
      bundlers: { run: true, reason: decision.reason },
    };
  const dirs = new Set(),
    names = new Set(decision.affected);
  for (const w of workspaces) if (names.has(w.name) && w.dir.startsWith('packages/')) dirs.add(w.dir.slice(9));
  for (const raw of files) {
    const file = posix(raw),
      owner = workspaceOf(workspaces, file);
    if (browserFiles.has(file))
      return {
        packages: { full: true, dirs: [], reason: `${file} is served by the packed browser test` },
        bundlers: bundlerScope(decision, closure),
      };
    // A README or other document of a package: its own examples change, nobody else's.
    if (owner && owner.dir.startsWith('packages/') && file.endsWith('.md')) dirs.add(owner.dir.slice(9));
    if (REACT_DOCS.includes(file)) dirs.add('react');
  }
  // A changed file that the tarball test runs (the stepClosure footprint `packages`) runs it whole.
  if ((decision.hits ?? []).includes('packages'))
    return {
      packages: { full: true, dirs: [], reason: 'a file modern:test:packages runs changed' },
      bundlers: bundlerScope(decision, closure),
    };
  const sorted = [...dirs].sort();
  return {
    packages: {
      full: false,
      dirs: sorted,
      reason: sorted.length ? `affected: ${sorted.join(', ')}` : 'no package affected (umbrella smoke test only)',
    },
    bundlers: bundlerScope(decision, closure),
  };
}

function bundlerScope(decision, closure) {
  if ((decision.hits ?? []).includes('bundlers'))
    return { run: true, reason: 'a file the bundler matrix runs changed' };
  const hit = decision.changed.filter((name) => closure.has(name));
  // A package that depends on a changed one is not enough: every package is a dependent of the umbrella.
  if (hit.length) return { run: true, reason: `the matrix builds ${hit.join(', ')}` };
  return { run: false, reason: 'no changed package is one the bundler matrix builds' };
}

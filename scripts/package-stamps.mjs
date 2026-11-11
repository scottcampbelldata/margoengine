// What each package's dist was built from. scripts/build-modern.js writes one stamp per package it builds, to
// test-results/package-stamps/<dir>.json: a hash of the package's sources (package.json, tsconfig.json and every
// tsconfig.json it extends, src/, its scripts/), the shared code its bundles take (packages/shared), the build tools
// (scripts/build-modern.js and every module it imports, followed transitively), the scripts its own build command runs
// with the modules they import, the lock file, the workspace list and the stamps of the packages it builds after. A dist
// whose stamp no longer matches was built from other sources.
//
// Why (bug, 2026-11-10): after `git rebase origin/main` brought in new entries of packages a lane never touched, the API
// report read those packages' old dist, found no .d.ts for the new entries (or old declarations for changed ones) and
// failed until someone ran build:packages again. scripts/api-report.js now rebuilds only the packages whose stamp is
// stale before it reads any declaration, so unchanged packages keep their build.
//
// Second bug, same day: the stamp hashed a hand-kept list of build tools (it missed compact-internals.js, core-budget.js,
// errors/entries.js, static-embind.js and support/llms-corpus.mjs) and only each package's own tsconfig.json, while 92
// packages extend packages/gltf/tsconfig.json. A change to any of those left an old dist looking current. The tools and
// the tsconfig chain are now found by following the imports and `extends` links, so a new helper is covered by itself.
//
// The stamp covers what decides a package's code and declarations. It does not cover data a build step reads from the
// rest of the repository with readFile (the mcp corpus reads docs/), which the API report never looks at.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { packageDependencies, packageOrder } from './package-order.js';

/** Stamp folder, relative to the repository root (test-results/ is ignored by git). */
export const STAMP_DIR = 'test-results/package-stamps';

/** Where every package build starts: build:packages runs build-modern, which imports the rest of the shared pipeline. */
const BUILD_ENTRY = 'scripts/build-modern.js';
/** Folders under a package that its build reads; `native` and `kernel` hold the Rust crates compiled to Wasm. */
const PACKAGE_INPUTS = ['package.json', 'tsconfig.json', 'src', 'scripts', 'native', 'kernel'];
const SKIP = new Set(['node_modules', 'dist', 'test-results', 'target']);
// Relative module specifiers after `from`, `import` or `import(` (static, side-effect and dynamic imports, re-exports).
// A specifier built in a template literal names no fixed file, so one holding `$` is left out.
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"\n$]+)['"]/g;

/** Map of package directory name -> parsed package.json, in workspace order (what build-modern reads). */
export function workspaceManifests(root) {
  const manifests = new Map();
  for (const dir of JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces)
    if (dir.startsWith('packages/'))
      manifests.set(dir.slice('packages/'.length), JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')));
  return manifests;
}

// Every file under the folder `path`, as sorted repository-relative paths with forward slashes.
function files(root, path, out = []) {
  const full = join(root, path);
  if (!existsSync(full)) return out;
  const entries = readdirSync(full, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (SKIP.has(entry.name)) continue;
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) files(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function hashFiles(root, paths) {
  const hash = createHash('sha256');
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full)) {
      hash.update(`${path}\0missing\0`);
      continue;
    }
    hash.update(`${path}\0`);
    hash.update(readFileSync(full));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const isFile = (root, path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();
// The repository-relative path, or undefined when it leaves the repository or lands in build output or node_modules.
const inRepository = (path) =>
  path.startsWith('../') || path.split('/').some((part) => SKIP.has(part)) ? undefined : path;

/**
 * Repository files the scripts `starts` load: themselves and every relative module they import, followed transitively,
 * sorted. A start that is missing is kept (hashed as missing); an import of a file that does not exist is left out (it
 * is a comment's example: a real one fails the build).
 */
export function moduleClosure(root, starts) {
  const seen = new Set(),
    queue = [...starts];
  while (queue.length) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!/\.[cm]?[jt]s$/.test(path) || !isFile(root, path)) continue;
    for (const [, specifier] of readFileSync(join(root, path), 'utf8').matchAll(RELATIVE_IMPORT)) {
      const next = inRepository(posix.normalize(posix.join(posix.dirname(path), specifier)));
      if (next && isFile(root, next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

// packages/<dir>/tsconfig.json and the tsconfig.json files it extends, nearest first (relative `extends` only: a
// published base config lives in node_modules, which the lock file covers).
function tsconfigChain(root, dir) {
  const chain = [];
  for (let path = `packages/${dir}/tsconfig.json`; isFile(root, path) && !chain.includes(path); ) {
    chain.push(path);
    const extended = readFileSync(join(root, path), 'utf8').match(/"extends"\s*:\s*"(\.{1,2}\/[^"]+)"/)?.[1];
    const next = extended && inRepository(posix.normalize(posix.join(posix.dirname(path), extended)));
    if (!next) break;
    path = next.endsWith('.json') ? next : `${next}.json`;
  }
  return chain;
}

// The scripts a package's own `build` command runs with node (`node ../../scripts/build-optional.js x`), from the root.
function buildCommandScripts(dir, manifest) {
  const scripts = [];
  for (const [, script] of (manifest?.scripts?.build ?? '').matchAll(/\bnode\s+([^\s&|;]+)/g)) {
    const path = inRepository(posix.normalize(posix.join('packages', dir, script.split('\\').join('/'))));
    if (path) scripts.push(path);
  }
  return scripts;
}

/** Every file a package's build reads besides the build tools and packages/shared, sorted within each group. */
export function packageInputs(root, dir, manifest) {
  const paths = [];
  for (const input of PACKAGE_INPUTS) {
    const path = `packages/${dir}/${input}`,
      full = join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) files(root, path, paths);
    else paths.push(path);
  }
  const own = new Set(paths),
    outside = new Set([...tsconfigChain(root, dir), ...moduleClosure(root, buildCommandScripts(dir, manifest))]);
  return [...paths, ...[...outside].filter((path) => !own.has(path)).sort()];
}

/** Repository files every package build reads: the lock file, build-modern and every module it imports. */
export function buildTools(root) {
  return ['package-lock.json', ...moduleClosure(root, [BUILD_ENTRY])];
}

/** Map of package directory name -> the stamp its dist must carry to match the checked-out sources. */
export function packageStamps(root, manifests = workspaceManifests(root)) {
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;
  const tools = buildTools(root);
  const common = createHash('sha256')
    .update(JSON.stringify(workspaces))
    .update(hashFiles(root, tools))
    .update(hashFiles(root, files(root, 'packages/shared')))
    .digest('hex');
  const dependencies = packageDependencies(manifests),
    stamps = new Map();
  for (const dir of packageOrder(manifests)) {
    const hash = createHash('sha256')
      .update(common)
      .update(hashFiles(root, packageInputs(root, dir, manifests.get(dir))));
    for (const dep of [...dependencies.get(dir)].sort()) hash.update(`${dep}\0${stamps.get(dep)}\0`);
    stamps.set(dir, hash.digest('hex'));
  }
  return stamps;
}

const stampFile = (root, dir) => join(root, STAMP_DIR, `${dir}.json`);

/** The stamp recorded for a package's dist, or undefined when none was written. */
export function readStamp(root, dir) {
  try {
    return JSON.parse(readFileSync(stampFile(root, dir), 'utf8')).stamp;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Records that a package's dist was built from the sources `stamp` names. */
export function writeStamp(root, dir, stamp) {
  mkdirSync(join(root, STAMP_DIR), { recursive: true });
  writeFileSync(stampFile(root, dir), `${JSON.stringify({ stamp })}\n`);
}

/** Forgets a package's stamp, so a build that fails part way leaves its dist stale. */
export function clearStamp(root, dir) {
  rmSync(stampFile(root, dir), { force: true });
}

/** Package directories, in build order, whose dist does not match the checked-out sources (or has no stamp). */
export function stalePackages(root, manifests = workspaceManifests(root)) {
  const stamps = packageStamps(root, manifests);
  return [...stamps].filter(([dir, stamp]) => readStamp(root, dir) !== stamp).map(([dir]) => dir);
}

// What each package's dist was built from. scripts/build-modern.js writes one stamp per package it builds, to
// test-results/package-stamps/<dir>.json: a hash of the package's sources (package.json, tsconfig.json, src/, its
// scripts/), the shared code its bundles take (packages/shared), the build tools, the lock file, the workspace list and
// the stamps of the packages it builds after. A dist whose stamp no longer matches was built from other sources.
//
// Why (bug, 2026-11-10): after `git rebase origin/main` brought in new entries of packages a lane never touched, the API
// report read those packages' old dist, found no .d.ts for the new entries (or old declarations for changed ones) and
// failed until someone ran build:packages again. scripts/api-report.js now rebuilds only the packages whose stamp is
// stale before it reads any declaration, so unchanged packages keep their build.
//
// The stamp covers what decides a package's code and declarations. It does not cover data a build step reads from the
// rest of the repository (the mcp corpus reads docs/), which the API report never looks at.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDependencies, packageOrder } from './package-order.js';

/** Stamp folder, relative to the repository root (test-results/ is ignored by git). */
export const STAMP_DIR = 'test-results/package-stamps';

/** Repository files every package build reads: the build scripts and the helpers they import. */
export const BUILD_TOOLS = [
  'package-lock.json',
  'scripts/build-modern.js',
  'scripts/build-optional.js',
  'scripts/build-postfx.js',
  'scripts/build-workers.js',
  'scripts/compact-package.js',
  'scripts/core-requirements.mjs',
  'scripts/measure-size.js',
  'scripts/package-declarations.js',
  'scripts/package-legal.js',
  'scripts/package-order.js',
  'scripts/package-stamps.mjs',
  'scripts/react-server-entries.js',
  'scripts/umbrella.mjs',
];

/** Folders under a package that its build reads. */
const PACKAGE_INPUTS = ['package.json', 'tsconfig.json', 'src', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', 'test-results', 'target']);

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

function inputsOf(root, dir) {
  const paths = [];
  for (const input of PACKAGE_INPUTS) {
    const path = `packages/${dir}/${input}`,
      full = join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) files(root, path, paths);
    else paths.push(path);
  }
  return paths;
}

/** Map of package directory name -> the stamp its dist must carry to match the checked-out sources. */
export function packageStamps(root, manifests = workspaceManifests(root)) {
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;
  const common = createHash('sha256')
    .update(JSON.stringify(workspaces))
    .update(hashFiles(root, BUILD_TOOLS))
    .update(hashFiles(root, files(root, 'packages/shared')))
    .digest('hex');
  const dependencies = packageDependencies(manifests),
    stamps = new Map();
  for (const dir of packageOrder(manifests)) {
    const hash = createHash('sha256').update(common).update(hashFiles(root, inputsOf(root, dir)));
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

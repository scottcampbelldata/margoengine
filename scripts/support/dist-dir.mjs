// A package build never leaves a reader without its dist (KB-BUILD-ATOMIC1, 2026-11-16). build:packages used to remove
// packages/<name>/dist and write the new build in place, so a process reading the checkout meanwhile (the Film Studio
// app's tests import packages/core/dist) failed with ENOENT, or read a file the build had only half written.
//
// Every package build now writes into a sibling folder, packages/<name>/dist-next (the same depth as dist, so every
// relative path a build emits resolves the same), and swapDist moves the result into dist one file at a time with
// rename(), which replaces a file in a single step: POSIX rename() leaves no moment at which the new name is missing
// (IEEE Std 1003.1-2017, rename()), and on Windows MoveFileEx with MOVEFILE_REPLACE_EXISTING, the call Node's rename
// makes, is the documented way to replace a file whole (Microsoft Learn, "Alternatives to using Transactional NTFS";
// MoveFileExW). Writing a complete file elsewhere and renaming it over the old one is the update idiom crash-consistency
// studies recommend (Pillai et al., "All File Systems Are Not Created Equal", OSDI 2014). A folder cannot be swapped in
// one step on Windows (a rename onto an existing folder fails, and renaming a folder fails while any file in it is
// open), hence one rename per file.
//
// A reader therefore sees each file whole, old or new, and never misses one both builds have. Files the new build no
// longer has are removed last, after every new file is in place; package entries (the files package.json `exports`
// names) move after the modules they import. Files whose bytes did not change are left alone.
//
// Windows refuses to replace or delete a file another process has open at that instant (EPERM, EBUSY or EACCES; Node
// opens files with FILE_SHARE_DELETE, but MoveFileEx still cannot supersede an open file). That is a reader holding the
// complete old file, not a failure: the swap waits for the handle to close, up to SHARED_FILE_LIMIT_MS, then stops
// with a coded error naming the file. The build lock (scripts/support/build-lock.mjs) waits on its holder the same way.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** Environment variable naming the folder a package build script writes into: `dist` (default) or `dist-next`. */
export const DIST_DIR_ENV = 'MARGOENGINE_DIST_DIR';
/** The sibling of dist a build writes into before swapDist moves it into place. */
export const STAGING_DIR = 'dist-next';
/** Longest wait for a reader to close a file the swap must replace or remove. */
export const SHARED_FILE_LIMIT_MS = 30_000;

const SHARING = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * The folder a package build writes its output into: `<root>/dist`, or `<root>/dist-next` when build:packages runs the
 * package's build script (it sets MARGOENGINE_DIST_DIR). Build scripts and helpers resolve their output through this,
 * never through a literal `dist` (tests/build-dist-swap.test.js checks it).
 */
export function distDir(root, folder = process.env[DIST_DIR_ENV] || 'dist') {
  if (folder !== 'dist' && folder !== STAGING_DIR)
    throw new Error(`${DIST_DIR_ENV} must be "dist" or "${STAGING_DIR}", not "${folder}"`);
  return resolve(root, folder);
}

/** The staging folder of a package: where build:packages builds it. */
export const stagingDir = (root) => resolve(root, STAGING_DIR);

/**
 * The tsconfig `tsc -p` takes to emit a package into `dist`. For dist itself that is the package's own tsconfig.json.
 * For dist-next it is a generated config in test-results/package-tsc/ that extends the package's and sets outDir to
 * dist-next, plus `paths` sending each of the package's own entry names (`@margoengine/<name>/<entry>`, which a
 * package's sources may import) to its source file. TypeScript maps a self-name import whose package.json target lies
 * in outDir back to the source (TypeScript's tryLoadInputFileForPath); with outDir moved to dist-next that mapping no
 * longer applies, and the import would type-check against the previous build's declarations in dist instead.
 */
export function tsconfigFor(root, dist = distDir(root)) {
  root = resolve(root);
  const own = join(root, 'tsconfig.json');
  if (resolve(dist) === resolve(root, 'dist')) return own;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    paths = {};
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    const target = typeof entry === 'string' ? entry : entry?.import;
    if (typeof target !== 'string' || !/^\.\/dist\/.+\.js$/.test(target)) continue;
    const module = target.slice('./dist/'.length, -'.js'.length),
      source = ['.ts', '.tsx', '.mts'].map((ext) => join(root, 'src', module + ext)).find((file) => existsSync(file));
    if (source) paths[subpath === '.' ? manifest.name : manifest.name + subpath.slice(1)] = [source];
  }
  const file = resolve(root, '../../test-results/package-tsc', `${basename(root)}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ extends: own, compilerOptions: { outDir: resolve(dist), paths } }, null, 2)}\n`);
  return file;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs a rename or removal, waiting while another process has the file open (Windows), up to the hard limit. */
async function whenReleased(action, path, limitMs) {
  const deadline = Date.now() + limitMs;
  for (let pause = 5; ; pause = Math.min(pause * 2, 100)) {
    try {
      return await action();
    } catch (error) {
      if (!SHARING.has(error.code) || process.platform !== 'win32') throw error;
      if (Date.now() >= deadline) {
        const stuck = new Error(
          `${path} stayed open in another process for ${limitMs} ms, so the build could not replace it (${error.code}). ` +
            'The old file is still whole; close the reader and build again.',
          { cause: error },
        );
        stuck.code = 'MARGO_DIST_FILE_BUSY';
        throw stuck;
      }
      await sleep(pause);
    }
  }
}

/** Every file and folder under `dir`, as paths relative to it. */
async function tree(dir) {
  const files = [],
    folders = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name),
        name = relative(dir, path);
      if (entry.isDirectory()) {
        folders.push(name);
        await walk(path);
      } else files.push(name);
    }
  }
  if (existsSync(dir)) await walk(dir);
  return { files, folders };
}

/** Files package.json `exports` points at, relative to dist: they move last, after what they import. */
function entryFiles(root) {
  const manifest = join(root, 'package.json'),
    entries = new Set();
  if (!existsSync(manifest)) return entries;
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./dist/')) entries.add(value.slice('./dist/'.length).split('/').join(sep));
    } else if (value && typeof value === 'object') for (const inner of Object.values(value)) visit(inner);
  };
  visit(JSON.parse(readFileSync(manifest, 'utf8')).exports);
  return entries;
}

const sameBytes = async (a, b) => {
  const left = statSync(a),
    right = statSync(b, { throwIfNoEntry: false });
  if (!right?.isFile() || left.size !== right.size) return false;
  return (await readFile(a)).equals(await readFile(b));
};

/**
 * Moves `<root>/dist-next` into `<root>/dist` file by file (see the top of this file). Returns the counts of files
 * moved, left unchanged and removed. Throws MARGO_DIST_FILE_BUSY when a reader holds a file past `limitMs`.
 */
export async function swapDist(root, { limitMs = SHARED_FILE_LIMIT_MS } = {}) {
  const next = stagingDir(root),
    dist = resolve(root, 'dist');
  if (!existsSync(next)) throw new Error(`Nothing to swap in: ${next} does not exist`);
  const fresh = await tree(next),
    old = await tree(dist),
    entries = entryFiles(root),
    oldFiles = new Set(old.files),
    freshFiles = new Set(fresh.files),
    freshFolders = new Set(fresh.folders);
  // A path that changes kind (a file that became a folder or the other way) is removed first; nothing else is.
  for (const folder of fresh.folders)
    if (oldFiles.has(folder)) await whenReleased(() => unlink(join(dist, folder)), join(dist, folder), limitMs);
  for (const file of fresh.files)
    if (old.folders.includes(file))
      await whenReleased(() => rm(join(dist, file), { recursive: true, force: true }), join(dist, file), limitMs);
  await mkdir(dist, { recursive: true });
  for (const folder of fresh.folders) await mkdir(join(dist, folder), { recursive: true });
  const order = [...fresh.files.filter((file) => !entries.has(file)), ...fresh.files.filter((file) => entries.has(file))];
  let moved = 0,
    unchanged = 0,
    removed = 0;
  for (const file of order) {
    const from = join(next, file),
      to = join(dist, file);
    if (oldFiles.has(file) && (await sameBytes(from, to))) {
      unchanged++;
      continue;
    }
    await whenReleased(() => rename(from, to), to, limitMs);
    moved++;
  }
  for (const file of old.files)
    if (!freshFiles.has(file) && !freshFolders.has(file)) {
      await whenReleased(() => unlink(join(dist, file)), join(dist, file), limitMs);
      removed++;
    }
  // Folders the new build no longer has, deepest first, once their files are gone.
  for (const folder of old.folders.filter((folder) => !freshFolders.has(folder) && !freshFiles.has(folder)).sort(
    (a, b) => b.length - a.length,
  ))
    if (existsSync(join(dist, folder)) && readdirSync(join(dist, folder)).length === 0)
      await whenReleased(() => rmdir(join(dist, folder)), join(dist, folder), limitMs);
  await rm(next, { recursive: true, force: true });
  return { moved, unchanged, removed };
}

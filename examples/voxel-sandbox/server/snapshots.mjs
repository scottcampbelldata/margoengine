// Snapshots of a world's edited chunks on disk: VoxelServer.exportEdits output, v8.serialize, gzip. A write lands whole
// or not at all (temporary file, flush, renames), so a crash mid-write leaves the previous snapshot as the newest.
// The final snapshots stay on disk for the 4K capture, which reads them with readSnapshot.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { gunzip, gzip } from 'node:zlib';

const zip = promisify(gzip),
  unzip = promisify(gunzip),
  NAME = /^snap-(\d+)\.bin$/;

// Writes of one path in this process, chained so that each starts when the one before it has ended.
const writing = new Map();
let written = 0;

/**
 * Writes `bytes` to `path` so that it appears whole or not at all, even while another process has `path` open. Windows
 * refuses to rename a file over one that any handle has open (MoveFileEx fails with ERROR_ACCESS_DENIED, EPERM in Node),
 * and an on-access virus scanner, a backup or an editor opens a file just written. It does let a file whose handles all
 * share delete be renamed and deleted, which is how Node and scanners open files. So the file in place moves aside to
 * `path.old` first, the new one takes the name, and the old one is deleted; on POSIX each step is a plain rename or
 * unlink. A crash between the two renames leaves only `path.old`, the last whole file: {@link readWhole} reads it and
 * {@link hasWhole} counts it, and the next write of `path` puts a new file in place and deletes it. Writes of one path in
 * this process run one after another, in call order.
 */
export function writeWhole(path, bytes) {
  const run = (writing.get(path) ?? Promise.resolve()).then(() => replace(path, bytes)),
    settled = run.then(
      () => {},
      () => {},
    );
  writing.set(path, settled);
  settled.then(() => {
    if (writing.get(path) === settled) writing.delete(path);
  });
  return run;
}
async function replace(path, bytes) {
  const temporary = `${path}.${process.pid}-${++written}.tmp`,
    aside = `${path}.old`,
    file = await open(temporary, 'w');
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  if (await present(path)) {
    // An old file a crash left beside a newer one in place; deleting a name takes it away at once, open or not.
    await rm(aside, { force: true });
    await rename(path, aside);
  }
  await rename(temporary, path);
  await rm(aside, { force: true });
}
async function present(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * What {@link writeWhole} last wrote to `path`, as `readFile` reads it with `options`, or undefined when it wrote
 * nothing there. A reader while a write runs gets the file before it or the one after: it tries the name, then `.old`,
 * then the name again, which are where the file is through a writer's steps (in place, aside, in place again).
 */
export async function readWhole(path, options) {
  for (const name of [path, `${path}.old`, path]) {
    try {
      return await readFile(name, options);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}
/** {@link readWhole} for a caller that cannot wait. */
export function readWholeSync(path, options) {
  for (const name of [path, `${path}.old`, path]) {
    try {
      return readFileSync(name, options);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}
/** Deletes what {@link writeWhole} wrote to `path`: the file aside first, so that a crash between leaves the newer. */
export async function removeWhole(path) {
  await rm(`${path}.old`, { force: true });
  await rm(path, { force: true });
}
/** Whether {@link writeWhole} has a file at `path`, counting one a crash left aside. */
export const hasWhole = (path) => existsSync(path) || existsSync(`${path}.old`);

/** Writes `edits` (the Map from exportEdits) to `path`. */
export const writeSnapshot = async (path, edits) => writeWhole(path, await zip(serialize(edits)));

/** The Map that {@link writeSnapshot} wrote to `path`. Rejects for a missing or damaged file. */
export async function readSnapshot(path) {
  const edits = deserialize(await unzip(await readFile(path)));
  if (!(edits instanceof Map)) throw new TypeError(`Snapshot ${path} holds no Map; it is not a Plaza snapshot`);
  return edits;
}

/** Writes the rolling snapshot of time `at` into world folder `dir`. */
export async function writeRolling(dir, at, edits) {
  await mkdir(dir, { recursive: true });
  await writeSnapshot(join(dir, `snap-${at}.bin`), edits);
}

/** The rolling snapshots of `dir`, oldest first, as `{ at, path }`. */
export async function listRolling(dir) {
  const names = await readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names
    .map((name) => [name, name.match(NAME)])
    .filter(([, match]) => match)
    .map(([name, match]) => ({ at: Number(match[1]), path: join(dir, name) }))
    .sort((a, b) => a.at - b.at);
}

/**
 * The newest rolling snapshot taken at or before `at` that can be read, as `{ at, edits }`; `{ at: undefined, edits }`
 * with an empty Map when there is none, which means the generator's world. A damaged file goes to `onDamaged` and the
 * next older one is used.
 */
export async function rollingAtOrBefore(dir, at, onDamaged = () => {}) {
  const list = (await listRolling(dir)).filter((snap) => snap.at <= at).reverse();
  for (const snap of list) {
    try {
      return { at: snap.at, edits: await readSnapshot(snap.path) };
    } catch (error) {
      onDamaged(snap.path, error);
    }
  }
  return { at: undefined, edits: new Map() };
}

/** Deletes rolling snapshots older than `before`, always keeping the newest. */
export async function pruneRolling(dir, before) {
  const list = await listRolling(dir);
  await Promise.all(
    list
      .slice(0, -1)
      .filter((snap) => snap.at < before)
      .map((snap) => rm(snap.path, { force: true })),
  );
}

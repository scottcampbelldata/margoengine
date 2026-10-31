// Snapshots of a world's edited chunks on disk: VoxelServer.exportEdits output, v8.serialize, gzip. A write lands whole
// or not at all (temporary file, flush, rename), so a crash mid-write leaves the previous snapshot as the newest.
// The final snapshots stay on disk for the 4K capture, which reads them with readSnapshot.
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { gunzip, gzip } from 'node:zlib';

const zip = promisify(gzip),
  unzip = promisify(gunzip),
  NAME = /^snap-(\d+)\.bin$/;

/** Writes `bytes` to `path` so that it appears whole or not at all. */
export async function writeWhole(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`,
    file = await open(temporary, 'w');
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

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

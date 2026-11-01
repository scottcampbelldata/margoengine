// @margoengine/voxel-net/file-store: a ChunkStore on disk for Node servers (design: DESIGN.md "Edited chunks").
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkKey, VoxelChunk } from '@margoengine/voxel';
import { decodeChunk, encodeChunk } from '@margoengine/voxel/codec';
import type { ChunkStore } from '@margoengine/voxel/stream';

// Chunk coordinates are cell >> 5 of a 32-bit cell coordinate: 27-bit signed integers (as VoxelStreamer's stores).
const at = (cx: number, cy: number, cz: number): string => {
  if ([cx, cy, cz].every((c) => typeof c === 'number' && (c << 5) >> 5 === c)) return chunkKey(cx, cy, cz);
  throw new RangeError(`Chunk (${cx}, ${cy}, ${cz}) is not three integers in -2^26..2^26-1; pass cell >> 5`);
};

/**
 * A {@link ChunkStore} in a folder: one deflated `encodeChunk` file per chunk, named `cx,cy,cz.chunk`, written to a
 * temporary file and renamed, so a crash leaves the old chunk or the new one, never half of one. Pass it as the
 * `store` of a `VoxelServer` and edits survive a restart; `VoxelStreamer` takes it too (in Node). Calls on one chunk
 * run in order and `get` sees every put and delete made before it.
 *
 * ```ts
 * import { VoxelServer } from '@margoengine/voxel-net/server';
 * import { FileChunkStore } from '@margoengine/voxel-net/file-store';
 * const server = new VoxelServer({ blocks, store: new FileChunkStore('world/chunks') });
 * ```
 */
export class FileChunkStore implements ChunkStore {
  /** The folder the chunks live in, created on the first put. */
  readonly directory: string;
  readonly #tails = new Map<string, Promise<void>>();
  #failure: unknown;
  /** @throws TypeError for a directory that is not a non-empty string. */
  constructor(directory: string) {
    if (typeof directory !== 'string' || !directory)
      throw new TypeError('FileChunkStore directory must be a non-empty string such as "world/chunks"');
    this.directory = directory;
  }
  /**
   * @throws RangeError or TypeError (rejects) for invalid chunk coordinates or a damaged file.
   * @throws what `readFile` throws (rejects) except a missing file, which is undefined.
   */
  async get(cx: number, cy: number, cz: number): Promise<VoxelChunk | undefined> {
    const key = at(cx, cy, cz);
    await this.#tails.get(key);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(this.directory, `${key}.chunk`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return decodeChunk(bytes);
  }
  /**
   * @throws TypeError when `chunk` is not a VoxelChunk; RangeError for invalid chunk coordinates.
   * @throws what the disk throws (rejects, and the next {@link FileChunkStore.flush}).
   */
  put(cx: number, cy: number, cz: number, chunk: VoxelChunk): Promise<void> {
    const key = at(cx, cy, cz);
    if (!(chunk instanceof VoxelChunk)) throw new TypeError('FileChunkStore.put expects a VoxelChunk');
    const bytes = encodeChunk(chunk), // reads the chunk now, so later edits are not saved
      file = join(this.directory, `${key}.chunk`);
    bytes.catch(() => {}); // the write below reports it
    return this.#queue(key, async () => {
      const data = await bytes;
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${file}.tmp`, data);
      await rename(`${file}.tmp`, file);
    });
  }
  /**
   * @throws RangeError or TypeError for invalid chunk coordinates.
   * @throws what the disk throws (rejects, and the next {@link FileChunkStore.flush}).
   */
  delete(cx: number, cy: number, cz: number): Promise<void> {
    const key = at(cx, cy, cz);
    return this.#queue(key, () => rm(join(this.directory, `${key}.chunk`), { force: true }));
  }
  /** @throws what the first failed put or delete since the last flush threw (rejects; the failure is then cleared). */
  async flush(): Promise<void> {
    while (this.#tails.size) await Promise.all(this.#tails.values());
    const failure = this.#failure;
    this.#failure = undefined;
    if (failure) throw failure;
  }
  #queue(key: string, job: () => Promise<void>): Promise<void> {
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(job),
      tail: Promise<void> = run.then(
        () => this.#settled(key, tail),
        (error) => {
          this.#failure ??= error;
          this.#settled(key, tail);
        },
      );
    this.#tails.set(key, tail);
    return run;
  }
  #settled(key: string, tail: Promise<void>): void {
    if (this.#tails.get(key) === tail) this.#tails.delete(key);
  }
}

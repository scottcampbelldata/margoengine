// A storage wrapper that survives a bad write. Each key has two copies, `key~a` and `key~b`, and a write only ever goes
// over the copy that is not the newest good one, so a crash, a torn write or a failed disk leaves the last good save in
// place. Each copy is a frame with a generation and a CRC-32, which is how a torn or decayed copy is told from a good
// one. The shape follows what Pillai et al. (OSDI 2014) found applications must assume of a crash: a write may land as a
// prefix, in pieces, out of order or with garbage in it, so nothing here relies on a single write being atomic.
import { MargoError } from '@margoengine/math/errors';
import { crc32 } from '../../shared/crc32.js';
import { keyQueue } from './queue.js';
import type { SaveStorage, StorageCallOptions } from './storage.js';

/** What a read found beside the copy it gave back. */
export interface SafeRecovery {
  /** The key the read asked for. */
  key: string;
  /** Which copy was bad: `key~a` or `key~b`. */
  copy: string;
  /** Why: a short description, or the error the storage gave. */
  reason: string;
}

/** Options of {@link safeStorage}. */
export interface SafeStorageOptions {
  /** Read each write back and compare it. Default true. */
  verify?: boolean;
  /** Accept a save written before this wrapper, stored plainly under `key`, with no way to check it. Default false. */
  legacy?: boolean;
  /** Called when a read passes over a bad copy. The save is good; the next write replaces the bad copy. */
  onRecover?(recovery: SafeRecovery): void;
}

/** The result of {@link SafeStorage.check}. */
export interface SafeCheck {
  /** True when a read gives a checked save. */
  ok: boolean;
  /** Good copies: 0, 1 or 2. */
  good: number;
  /** Bad copies: 0, 1 or 2. */
  bad: number;
  /** The newest good copy's generation, 0 when there is none. */
  generation: number;
}

/** A {@link SaveStorage} with checked copies. */
export interface SafeStorage extends SaveStorage {
  /** Reads both copies of `key` and reports on them, changing nothing. */
  check(key: string, options?: StorageCallOptions): Promise<SafeCheck>;
}

// magic, version, three zero bytes, payload length, generation (64 bits), payload, then the CRC-32 of all of that.
// The CRC comes last and little-endian, as a CRC of this bit order is sent, so a burst of up to 32 bits is always found.
const MAGIC = 0x4d534146, // 'MSAF'
  VERSION = 1,
  HEADER = 20,
  TRAILER = 4,
  COPIES = ['~a', '~b'] as const;

type Copy = { name: string; generation: bigint; payload: Uint8Array } | { name: string; bad: string } | { name: string };

const isGood = (copy: Copy): copy is Extract<Copy, { payload: Uint8Array }> => 'payload' in copy;
const isBad = (copy: Copy): copy is Extract<Copy, { bad: string }> => 'bad' in copy;

/** Header and payload as one frame. */
function frame(payload: Uint8Array, generation: bigint): Uint8Array {
  const bytes = new Uint8Array(HEADER + payload.length + TRAILER),
    view = new DataView(bytes.buffer),
    end = bytes.length - TRAILER;
  view.setUint32(0, MAGIC);
  view.setUint8(4, VERSION);
  view.setUint32(8, payload.length);
  view.setBigUint64(12, generation);
  bytes.set(payload, HEADER);
  view.setUint32(end, crc32(bytes.subarray(0, end)), true);
  return bytes;
}

/** What is wrong with a frame, or its generation and payload. */
function unframe(bytes: Uint8Array): { generation: bigint; payload: Uint8Array } | string {
  if (bytes.length < HEADER + TRAILER) return 'it is shorter than a frame';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    end = bytes.length - TRAILER;
  if (view.getUint32(0) !== MAGIC) return 'it is not a checked copy';
  if (view.getUint32(8) !== end - HEADER) return 'its length is wrong';
  if (view.getUint32(end, true) !== crc32(bytes.subarray(0, end))) return 'its checksum does not match';
  if (view.getUint8(4) !== VERSION) return `it has format version ${view.getUint8(4)}; this build reads version ${VERSION}`;
  return { generation: view.getBigUint64(12), payload: bytes.subarray(HEADER, end) };
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Wraps a storage so a failed or torn write never loses the last good save, and damage is found on read.
 * Write costs two reads, one write and, with `verify`, one more read; a key takes twice the room.
 * @example
 * const storage = safeStorage(fileStorage('./saves'), { onRecover: ({ key }) => console.warn('recovered', key) });
 * await saveGame(storage, 'slot-1', document);
 */
export function safeStorage(storage: SaveStorage, options: SafeStorageOptions = {}): SafeStorage {
  if (typeof storage?.read !== 'function') throw new TypeError('safeStorage needs a storage, e.g. memoryStorage()');
  const { verify = true, legacy = false, onRecover } = options,
    // One call at a time on a key, in call order, so a read never meets a half-made write of this wrapper.
    turn = keyQueue();

  /** Both copies. A copy the storage cannot read is as bad as a damaged one, unless the call was stopped. */
  const scan = async (key: string, call?: StorageCallOptions): Promise<Copy[]> => {
    const copies: Copy[] = [];
    for (const suffix of COPIES) {
      const name = key + suffix;
      try {
        const bytes = await storage.read(name, call);
        if (bytes === null) copies.push({ name });
        else {
          const found = unframe(bytes);
          copies.push(typeof found === 'string' ? { name, bad: found } : { name, ...found });
        }
      } catch (error) {
        call?.signal?.throwIfAborted();
        copies.push({ name, bad: String((error as Error)?.message ?? error) });
      }
    }
    return copies;
  };

  /** The good copies, newest first. */
  const good = (copies: Copy[]): Extract<Copy, { payload: Uint8Array }>[] =>
    copies.filter(isGood).sort((a, b) => (a.generation < b.generation ? 1 : a.generation > b.generation ? -1 : 0));

  const checkKey = (key: string): void => {
    if (typeof key !== 'string' || !key) throw new TypeError('Save key must be a non-empty string, e.g. "slot-1"');
  };

  return {
    async read(key, call) {
      checkKey(key);
      return turn(key, async () => {
        const copies = await scan(key, call),
          [newest] = good(copies),
          bad = copies.filter(isBad);
        if (newest) {
          for (const copy of bad) onRecover?.({ key, copy: copy.name, reason: copy.bad });
          return newest.payload.slice();
        }
        if (bad.length)
          throw new MargoError(
            'failed',
            `Save '${key}' is damaged (${bad.map((copy) => `${copy.name}: ${copy.bad}`).join(', ')}); no good copy is left, so load another save or delete this one`,
          );
        const plain = await storage.read(key, call);
        if (plain === null || legacy) return plain;
        throw new MargoError(
          'failed',
          `Save '${key}' has no checksum, so it cannot be trusted; pass legacy: true to read saves from before safeStorage`,
        );
      });
    },

    async write(key, bytes, call) {
      checkKey(key);
      if (!(bytes instanceof Uint8Array))
        throw new TypeError('Save bytes must be a Uint8Array; encode the document with encodeSave');
      return turn(key, async () => {
        const copies = await scan(key, call),
          [newest] = good(copies),
          target = copies.find((copy) => copy !== newest)!.name,
          framed = frame(bytes, (newest?.generation ?? 0n) + 1n);
        await storage.write(target, framed, call);
        if (verify) {
          const stored = await storage.read(target, call);
          if (stored === null || !same(stored, framed))
            throw new MargoError(
              'failed',
              `The storage did not keep save '${key}', and the last good save stands; check its free space and save again`,
            );
        }
        if (legacy) await storage.delete(key, call);
      });
    },

    async delete(key, call) {
      checkKey(key);
      return turn(key, async () => {
        const copies = await scan(key, call),
          [newest] = good(copies);
        // The older copy goes first: a crash between the two leaves the newest save, never an old one back from the dead.
        let had = false;
        for (const copy of copies.filter((one) => one !== newest)) had = (await storage.delete(copy.name, call)) || had;
        if (newest) had = (await storage.delete(newest.name, call)) || had;
        return (await storage.delete(key, call)) || had;
      });
    },

    async keys(call) {
      const names = new Set<string>();
      for (const name of await storage.keys(call))
        names.add(COPIES.some((suffix) => name.endsWith(suffix)) ? name.slice(0, -2) : name);
      return [...names].sort();
    },

    async check(key, call) {
      checkKey(key);
      return turn(key, async () => {
        const copies = await scan(key, call),
          found = good(copies);
        return {
          ok: found.length > 0,
          good: found.length,
          bad: copies.filter(isBad).length,
          generation: Number(found[0]?.generation ?? 0n),
        };
      });
    },
  };
}

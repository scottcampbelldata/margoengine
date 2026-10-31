// The Plaza's app message: how far the world's goal has come and what this player has found. The shard encodes it and the
// page decodes it; both import this file, and it imports only plaza-area.ts, so the page takes no terrain with it.
import { COUNTED_BLOCKS } from './plaza-area.ts';

/** One message. `counts` is in the order of `COUNTED_BLOCKS`; a message about the world alone leaves it out. */
export interface PlazaCountsMessage {
  /** Opals dug out of the ground in this world. Never goes down. */
  readonly found: number;
  /** Opals in this world; `GEM_TOTAL`. */
  readonly total: number;
  /** This player's counts, or undefined when only `found` moved: keep the ones you hold. */
  readonly counts?: ArrayLike<number>;
  /** True on the last message of a world, just before the 1001 close. */
  readonly ended?: boolean;
}

const ENDED = 1,
  HAS_COUNTS = 2;

/**
 * The bytes of one message: a flags byte, then varints.
 * @throws RangeError when a number is not a whole number from 0 to 2^31 - 1, or `counts` has the wrong length.
 */
export function encodeCounts(message: PlazaCountsMessage): Uint8Array {
  const { counts } = message,
    bytes: number[] = [(message.ended ? ENDED : 0) | (counts ? HAS_COUNTS : 0)],
    put = (value: number): void => {
      if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
        throw new RangeError(`encodeCounts takes whole numbers from 0 to 2^31 - 1, not ${value}`);
      let rest = value;
      while (rest > 127) {
        bytes.push((rest & 127) | 128);
        rest >>>= 7;
      }
      bytes.push(rest);
    };
  put(message.found);
  put(message.total);
  if (counts) {
    if (counts.length !== COUNTED_BLOCKS.length)
      throw new RangeError(
        `encodeCounts needs ${COUNTED_BLOCKS.length} counts, one per COUNTED_BLOCKS, not ${counts.length}`,
      );
    for (let i = 0; i < counts.length; i++) put(counts[i]);
  }
  return Uint8Array.from(bytes);
}

/**
 * Reads what {@link encodeCounts} wrote.
 * @throws RangeError when the bytes are not such a message: the page and the shard are from different builds.
 */
export function decodeCounts(bytes: Uint8Array): Required<Omit<PlazaCountsMessage, 'counts'>> & { counts?: number[] } {
  let at = 1;
  const wrong = (why: string): RangeError =>
      new RangeError(`decodeCounts: ${why}; reload the page, it may be from another build than the shard`),
    flags = bytes[0],
    get = (): number => {
      let value = 0;
      for (let shift = 0; shift <= 28; shift += 7) {
        if (at >= bytes.length) throw wrong('the message ends inside a number');
        const byte = bytes[at++];
        value += (byte & 127) * 2 ** shift;
        if (byte < 128) return value;
      }
      throw wrong('a number is too long');
    };
  if (flags === undefined || flags > (ENDED | HAS_COUNTS)) throw wrong(`unknown flags ${flags}`);
  const found = get(),
    total = get(),
    counts = flags & HAS_COUNTS ? COUNTED_BLOCKS.map(get) : undefined;
  if (at !== bytes.length) throw wrong('there are bytes past the end of the message');
  return { found, total, ended: (flags & ENDED) !== 0, ...(counts ? { counts } : {}) };
}

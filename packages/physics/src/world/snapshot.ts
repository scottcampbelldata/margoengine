// Snapshot, restore and the state hash of a set of solvers (docs/physics-framework.md, section 8). The world knows nothing
// of what a solver holds: it copies, restores and hashes the regions the solver names as its state (`stateRegions`) and
// its history beyond state (`extraState`), and nothing else, so scratch never reaches a hash and the hash does not depend
// on where the regions lie in memory (their offsets are layout, not state). Solvers are taken in the order of their ids
// and each solver's regions in the order it lists them, so the result is the same whatever order the world holds them in
// and however many threads stepped them.
//
// The hash is a 64-bit fingerprint, two 32-bit lanes of MurmurHash3's 32-bit function (Appleby, "MurmurHash3", 2011,
// public domain; the algorithm from its published description) with different seeds, over a canonical byte stream: per
// solver its id, per region its name, whether it is state or extra, its element type, its layout version, its length and
// its bytes. It finds a changed bit; it is not a cryptographic hash.
import { MargoError } from '@margoengine/math/errors';
import type { ElementType, Region, Solver } from './solver.js';

/** What a snapshot, a restore or a hash needs of a solver: its id and the regions of its state. */
export type SnapshotSolver = Pick<Solver, 'describe' | 'stateRegions' | 'extraState'>;

/** A snapshot: the bytes of every solver's state and extra regions with a manifest, and the state hash they had. */
export interface Snapshot {
  /** The encoded snapshot, self-describing and portable (no memory offsets in it). */
  readonly bytes: Uint8Array;
  /** The state hash of the solvers when it was taken, as `stateHash` gives it. */
  readonly hash: string;
}

const MAGIC = 0x504e534d; // 'MSNP' read as a little-endian word
/** The version of the snapshot encoding; a snapshot of another version is refused. */
export const SNAPSHOT_VERSION = 1;
const TYPES: readonly ElementType[] = ['f32', 'f64', 'i32', 'u32', 'u8'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** MurmurHash3's 32-bit function, fed in pieces: the same result as one call over the joined bytes. */
class Murmur {
  private h: number;
  private length = 0;
  private tail = 0;
  private tailBytes = 0;
  constructor(seed: number) {
    this.h = seed >>> 0;
  }
  private mix(k: number): void {
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    let h = this.h ^ k;
    h = (h << 13) | (h >>> 19);
    this.h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  update(bytes: Uint8Array): void {
    this.length += bytes.length;
    let i = 0;
    // Finish a word begun by the last piece.
    while (this.tailBytes > 0 && this.tailBytes < 4 && i < bytes.length) {
      this.tail |= bytes[i++]! << (8 * this.tailBytes++);
      if (this.tailBytes === 4) {
        this.mix(this.tail);
        this.tail = 0;
        this.tailBytes = 0;
      }
    }
    for (; i + 4 <= bytes.length; i += 4)
      this.mix(bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24));
    for (; i < bytes.length; i++) this.tail |= bytes[i]! << (8 * this.tailBytes++);
  }
  digest(): number {
    let h = this.h;
    if (this.tailBytes > 0) {
      let k = Math.imul(this.tail, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
    }
    h ^= this.length;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
}

/** Two lanes of MurmurHash3 with different seeds: a 64-bit fingerprint, as 16 hex digits. */
class Fingerprint {
  private readonly lanes = [new Murmur(0), new Murmur(0x9747b28c)];
  update(bytes: Uint8Array): void {
    for (const lane of this.lanes) lane.update(bytes);
  }
  word(value: number): void {
    this.update(littleEndian(value));
  }
  text(value: string): void {
    const bytes = encoder.encode(value);
    this.word(bytes.length);
    this.update(bytes);
  }
  hex(): string {
    return this.lanes.map((lane) => lane.digest().toString(16).padStart(8, '0')).join('');
  }
}

/** A 32-bit word as its four bytes, least significant first. */
function littleEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

/** One region with what the hash and the snapshot record of it. */
interface Entry {
  readonly solver: string;
  readonly region: Region;
  /** 0 for state, 1 for extra state. */
  readonly extra: 0 | 1;
}

/** Every region of the solvers in canonical order: solvers by id, each solver's state regions then its extra ones as listed. */
function entries(solvers: readonly SnapshotSolver[]): Entry[] {
  const named = solvers.map((solver) => ({ id: solver.describe().id, solver }));
  const seen = new Set<string>();
  for (const { id } of named) {
    if (seen.has(id))
      throw new MargoError('state', `Two solvers share the id '${id}'; give each solver of a world its own id.`);
    seen.add(id);
  }
  named.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Entry[] = [];
  for (const { id, solver } of named) {
    const names = new Set<string>();
    for (const [extra, regions] of [
      [0, solver.stateRegions()],
      [1, solver.extraState()],
    ] as const)
      for (const region of regions) {
        if (names.has(region.name))
          throw new MargoError(
            'state',
            `Solver '${id}' names two regions '${region.name}'; region names are unique in a solver.`,
          );
        names.add(region.name);
        out.push({ solver: id, region, extra });
      }
  }
  return out;
}

/** A region's bytes: in its own memory when it names one (a solver not yet on the world's memory), else the world's. */
function view(memory: WebAssembly.Memory, region: Region): Uint8Array {
  const buffer = (region.memory ?? memory).buffer;
  if (region.byteOffset < 0 || region.byteOffset + region.byteLength > buffer.byteLength)
    throw new MargoError(
      'state',
      `Region '${region.name}' lies outside its memory; it was allocated in another memory.`,
    );
  return new Uint8Array(buffer, region.byteOffset, region.byteLength);
}

function describeEntry(fingerprint: Fingerprint, entry: Entry): void {
  fingerprint.text(entry.region.name);
  fingerprint.word(entry.extra);
  fingerprint.word(TYPES.indexOf(entry.region.type));
  fingerprint.word(entry.region.layout);
  fingerprint.word(entry.region.byteLength);
}

/**
 * The state hash of `solvers`: 16 hex digits over every byte of their state and extra regions, their ids, names, element
 * types, layout versions and lengths, in canonical order. Equal states give equal hashes wherever their regions lie and
 * whatever order `solvers` is in; scratch a solver does not name is not part of it.
 * @throws MargoError `state` for two solvers with one id, two regions with one name in a solver, or a region outside `memory`.
 */
export function stateHash(memory: WebAssembly.Memory, solvers: readonly SnapshotSolver[]): string {
  return hashOf(entries(solvers), (entry) => view(memory, entry.region));
}

/** The hash of `list` with each region's bytes from `bytesOf`: memory for a state, a snapshot's copy to check it. */
function hashOf(list: readonly Entry[], bytesOf: (entry: Entry, index: number) => Uint8Array): string {
  const fingerprint = new Fingerprint();
  let current: string | null = null;
  list.forEach((entry, index) => {
    if (entry.solver !== current) {
      fingerprint.text(entry.solver);
      current = entry.solver;
    }
    describeEntry(fingerprint, entry);
    fingerprint.update(bytesOf(entry, index));
  });
  return fingerprint.hex();
}

/**
 * Takes a snapshot of `solvers`: the bytes of their state and extra regions under a versioned manifest, with the state
 * hash, which `restoreSnapshot` puts back bit for bit.
 * @throws MargoError `state` as `stateHash` does.
 */
export function takeSnapshot(memory: WebAssembly.Memory, solvers: readonly SnapshotSolver[]): Snapshot {
  const list = entries(solvers);
  const parts: Uint8Array[] = [];
  const word = (value: number): void => {
    parts.push(littleEndian(value));
  };
  const text = (value: string): void => {
    const bytes = encoder.encode(value);
    word(bytes.length);
    parts.push(bytes);
  };
  word(MAGIC);
  word(SNAPSHOT_VERSION);
  word(list.length);
  const copies = list.map((entry) => view(memory, entry.region).slice());
  list.forEach((entry, index) => {
    text(entry.solver);
    text(entry.region.name);
    word(entry.extra);
    word(TYPES.indexOf(entry.region.type));
    word(entry.region.layout);
    word(entry.region.byteLength);
    parts.push(copies[index]!);
  });
  const hash = hashOf(list, (_, index) => copies[index]!);
  parts.push(encoder.encode(hash));
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, hash };
}

/**
 * Puts a snapshot back into `solvers`' regions, wherever they lie now. The solvers must name the same regions, with the same
 * element types, layout versions and lengths, as when it was taken, and the snapshot's bytes must hash to the hash it was taken
 * with; everything is checked before anything is written, so a refused snapshot leaves the state as it was, and after a restore
 * the solvers' state hash is the snapshot's.
 * @throws MargoError `version` for a snapshot of another encoding or a region of another layout version, `state` for a set
 * of solvers or regions that differs from the snapshot's, `failed` for bytes that are not a whole snapshot.
 */
export function restoreSnapshot(
  memory: WebAssembly.Memory,
  solvers: readonly SnapshotSolver[],
  bytes: Uint8Array,
): void {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (count: number): void => {
    if (at + count > bytes.length)
      throw new MargoError(
        'failed',
        'The snapshot ends early; pass the whole `bytes` of a snapshot `takeSnapshot` made.',
      );
  };
  const word = (): number => {
    need(4);
    const value = data.getUint32(at, true);
    at += 4;
    return value;
  };
  const text = (): string => {
    const length = word();
    need(length);
    const value = decoder.decode(bytes.subarray(at, at + length));
    at += length;
    return value;
  };
  if (word() !== MAGIC)
    throw new MargoError(
      'failed',
      'These bytes are not a physics snapshot; pass the `bytes` of a snapshot `takeSnapshot` made.',
    );
  const version = word();
  if (version !== SNAPSHOT_VERSION)
    throw new MargoError(
      'version',
      `The snapshot is of encoding ${version}; this build reads encoding ${SNAPSHOT_VERSION}.`,
    );
  const list = entries(solvers);
  const count = word();
  if (count !== list.length)
    throw new MargoError(
      'state',
      `The snapshot holds ${count} regions and the solvers name ${list.length}; restore it into the solvers it was taken of.`,
    );
  // Read and check everything before writing anything, so a refused snapshot leaves the state as it was. Every mismatch is
  // collected, so a world laid out otherwise is told all of it: a field's port and a kernel's columns grow with its capacity.
  const copies: [Entry, Uint8Array][] = [],
    problems: string[] = [];
  let versioned = false;
  for (const entry of list) {
    const solver = text();
    const name = text();
    const extra = word();
    const type = TYPES[word()];
    const layout = word();
    const length = word();
    if (solver !== entry.solver || name !== entry.region.name || extra !== entry.extra)
      problems.push(
        `the snapshot has region '${name}' of solver '${solver}' where the solvers have '${entry.region.name}' of '${entry.solver}'`,
      );
    else if (layout !== entry.region.layout) {
      versioned = true;
      problems.push(
        `region '${name}' of solver '${solver}' was saved at layout ${layout} and is now at layout ${entry.region.layout}`,
      );
    } else if (type !== entry.region.type || length !== entry.region.byteLength)
      problems.push(
        `region '${name}' of solver '${solver}' was ${length} bytes of ${type} and is now ${entry.region.byteLength} bytes of ${entry.region.type}`,
      );
    need(length);
    copies.push([entry, bytes.subarray(at, at + length)]);
    at += length;
  }
  if (problems.length) {
    const shown = problems.slice(0, 8).join('; '),
      more = problems.length > 8 ? `; and ${problems.length - 8} more` : '';
    throw new MargoError(
      versioned ? 'version' : 'state',
      `The snapshot does not fit these solvers (${problems.length} regions): ${shown}${more}. Restore it into solvers built as they were when it was taken.`,
    );
  }
  need(16);
  const hash = decoder.decode(bytes.subarray(at, at + 16));
  at += 16;
  if (at !== bytes.length)
    throw new MargoError('failed', 'The snapshot has bytes past its end; pass exactly the `bytes` of one snapshot.');
  const saved = hashOf(list, (_, index) => copies[index]![1]);
  if (saved !== hash)
    throw new MargoError(
      'failed',
      `The snapshot's regions hash to ${saved}, not the ${hash} it was taken with: its bytes were changed.`,
    );
  for (const [entry, source] of copies) view(memory, entry.region).set(source);
}

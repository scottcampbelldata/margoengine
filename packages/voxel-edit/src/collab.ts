// @margoengine/voxel-edit/collab: shared editing. Each user holds a replica of the grid; edits are operations stamped
// with a Lamport clock and the user's site name, and every cell keeps the write with the highest stamp (last writer
// wins, site name breaking ties). Applying operations in any order, any number of times, gives every replica the same
// cells, so concurrent edits merge with no conflict to resolve and no server to order them. Each operation also
// carries its site's own count (seq, 1, 2, 3 ...), so a replica can say which operations it holds even when they
// arrived out of order: a Lamport clock skips numbers, a count does not.
import { cellLimit, checkGrid, checkOptions, type GridLimits, type VoxelGrid } from './grid.js';

/** One edit: cells set to values, stamped by its site's clock. Plain data; {@link encodeVoxelOp} packs it. */
export interface VoxelOp {
  /** The site (user) that made it. */
  readonly site: string;
  /** Its place among its site's operations: 1, 2, 3 and so on with no gaps. */
  readonly seq: number;
  /** Its Lamport clock, from 1. */
  readonly clock: number;
  /** Cell indexes of the grid. */
  readonly cells: Uint32Array;
  /** The palette index written to each cell (0 erases). */
  readonly values: Uint8Array;
}

/** A replica's state for a newcomer: the cells, each cell's stamp, and every operation seen. */
export interface VoxelReplicaSnapshot {
  readonly grid: VoxelGrid;
  readonly ops: readonly VoxelOp[];
}

const checkSite = (site: unknown, subject: string): string => {
  if (typeof site !== 'string' || !site || site.length > 256)
    throw new TypeError(
      `${subject} site must be a non-empty string of at most 256 characters; pass a user or device id`,
    );
  return site;
};

/**
 * A replica of a shared grid. {@link VoxelReplica.edit} makes a local operation (send it to the others);
 * {@link VoxelReplica.apply} takes anyone's operation, in any order and any number of times. Replicas that have
 * applied the same operations hold the same cells. {@link VoxelReplica.version} and {@link VoxelReplica.since} let a
 * replica catch another up with only the operations it lacks.
 */
export class VoxelReplica {
  readonly site: string;
  readonly size: readonly [number, number, number];
  #voxels: Uint8Array;
  // Per cell: the clock and the site of the write it holds (site 0: the starting grid).
  #clocks: Uint32Array;
  #sites: Uint16Array;
  #siteNames: string[] = [''];
  #siteIndex = new Map<string, number>([['', 0]]);
  #clock = 0;
  #log: VoxelOp[] = [];
  // Per site: the seqs applied above its gap-free run, and the length of that run (its entry in version).
  #seen = new Map<string, Set<number>>();
  #run = new Map<string, number>();
  #top = 0;
  #listeners = new Set<(op: VoxelOp, changed: number) => void>();

  /**
   * A replica of `grid` (copied) for `site`. Every replica of one shared grid starts from the same grid. A replica
   * keeps 7 bytes a cell (the cell, its write's clock and site).
   * @throws TypeError for a bad grid or site; RangeError past `maxCells` (default 16,777,216).
   */
  constructor(grid: VoxelGrid, options: { site: string } & GridLimits) {
    checkOptions(options, 'VoxelReplica');
    this.site = checkSite(options.site, 'VoxelReplica');
    const cells = checkGrid(grid, cellLimit(options));
    this.size = [grid.size[0], grid.size[1], grid.size[2]];
    this.#voxels = grid.voxels.slice();
    this.#clocks = new Uint32Array(cells);
    this.#sites = new Uint16Array(cells);
  }

  /** The current cells (a copy). */
  get grid(): VoxelGrid {
    return { size: [...this.size], voxels: this.#voxels.slice() };
  }

  /** The palette index at cell `index`. */
  get(index: number): number {
    return this.#voxels[index] ?? 0;
  }

  /**
   * Per site, the count of its operations this replica holds with none missing before them (1 to n all applied).
   * Send it to a peer, which answers with {@link VoxelReplica.since}. Operations applied past a gap are held but not
   * counted until the gap fills, so a peer resends them; applying a repeat does nothing.
   */
  get version(): Record<string, number> {
    return Object.fromEntries(this.#run);
  }

  /** Calls `listener(op, changed)` after each operation this replica applies, local or remote. Returns an unsubscribe. */
  onChange(listener: (op: VoxelOp, changed: number) => void): () => void {
    if (typeof listener !== 'function')
      throw new TypeError('VoxelReplica.onChange needs a function; pass (op, changed) => {}');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Sets `cells` (indexes) to `value`, or to `values[i]` each, as one local operation, and returns it to send.
   * @throws RangeError for an index outside the grid or a value outside 0 to 255; TypeError for mismatched lengths.
   */
  edit(cells: ArrayLike<number>, value: number | ArrayLike<number>): VoxelOp {
    if (typeof cells?.length !== 'number')
      throw new TypeError('VoxelReplica.edit cells must be cell indexes; pass an array');
    const n = cells.length,
      list = new Uint32Array(n),
      values = new Uint8Array(n),
      count = this.#voxels.length;
    if (typeof value !== 'number' && (typeof value?.length !== 'number' || value.length !== n))
      throw new TypeError('VoxelReplica.edit values must be one number or one per cell; pass a value per cell');
    for (let i = 0; i < n; i++) {
      const c = cells[i],
        v = typeof value === 'number' ? value : value[i];
      if (!Number.isInteger(c) || c < 0 || c >= count)
        throw new RangeError(`VoxelReplica.edit cell ${c} is outside the grid; pass indexes 0 to ${count - 1}`);
      if (!Number.isInteger(v) || v < 0 || v > 255)
        throw new RangeError(`VoxelReplica.edit value ${v} is not a palette index; pass 0 to 255`);
      list[i] = c;
      values[i] = v;
    }
    const op: VoxelOp = { site: this.site, seq: this.#top + 1, clock: this.#clock + 1, cells: list, values };
    this.apply(op);
    return op;
  }

  /**
   * Applies anyone's operation. An operation already applied does nothing; otherwise each cell takes the value when the
   * operation's stamp (clock, then site name) is higher than the stamp of the cell's last write. Returns the cells
   * whose value changed.
   * @throws TypeError or RangeError for a malformed operation or one for a grid of another size.
   */
  apply(op: VoxelOp): number {
    checkOp(op, this.#voxels.length);
    const run = this.#run.get(op.site) ?? 0;
    let seen = this.#seen.get(op.site);
    if (op.seq <= run || seen?.has(op.seq)) return 0;
    // Register the site before recording the operation, so a refused site leaves the replica unchanged.
    let site = this.#siteIndex.get(op.site);
    if (site === undefined) {
      if (this.#siteNames.length > 65535)
        throw new RangeError('VoxelReplica holds 65,535 sites; start a new shared grid');
      site = this.#siteNames.length;
      this.#siteNames.push(op.site);
      this.#siteIndex.set(op.site, site);
    }
    if (op.seq === run + 1) {
      let next = op.seq;
      while (seen?.delete(next + 1)) next++;
      this.#run.set(op.site, next);
    } else {
      if (!seen) this.#seen.set(op.site, (seen = new Set()));
      seen.add(op.seq);
    }
    if (op.site === this.site) this.#top = Math.max(this.#top, op.seq);
    this.#log.push(op);
    this.#clock = Math.max(this.#clock, op.clock);
    const names = this.#siteNames;
    let changed = 0;
    for (let i = 0; i < op.cells.length; i++) {
      const c = op.cells[i],
        held = this.#clocks[c];
      // Equal stamps come only from one operation naming a cell twice: its later entry wins.
      if (op.clock < held || (op.clock === held && op.site < names[this.#sites[c]])) continue;
      this.#clocks[c] = op.clock;
      this.#sites[c] = site;
      if (this.#voxels[c] !== op.values[i]) {
        this.#voxels[c] = op.values[i];
        changed++;
      }
    }
    for (const listener of [...this.#listeners]) listener(op, changed);
    return changed;
  }

  /** The operations this replica has that a replica at `version` (from {@link VoxelReplica.version}) lacks. */
  since(version: Readonly<Record<string, number>> = {}): VoxelOp[] {
    checkOptions(version, 'VoxelReplica.since version');
    return this.#log.filter((op) => op.seq > (Object.hasOwn(version, op.site) ? version[op.site] : 0));
  }

  /** The starting grid and every operation, for a newcomer: `VoxelReplica.fromSnapshot(snapshot, {site})`. */
  snapshot(): VoxelReplicaSnapshot {
    return { grid: this.#start(), ops: [...this.#log] };
  }

  /** A replica for `site` built from another replica's {@link VoxelReplica.snapshot}. */
  static fromSnapshot(snapshot: VoxelReplicaSnapshot, options: { site: string } & GridLimits): VoxelReplica {
    checkOptions(snapshot, 'VoxelReplica.fromSnapshot');
    if (!Array.isArray(snapshot.ops))
      throw new TypeError('VoxelReplica snapshot ops must be an array; pass replica.snapshot()');
    const replica = new VoxelReplica(snapshot.grid, options);
    for (const op of snapshot.ops) replica.apply(op);
    return replica;
  }

  // The replica keeps no copy of its starting grid. Cells no operation wrote still hold their start; a cell some
  // operation wrote ends as the highest-stamped write whatever it started as, so any start value works for it (0 here).
  #start(): VoxelGrid {
    const voxels = this.#voxels.slice(),
      written = new Uint8Array(voxels.length);
    for (const op of this.#log) for (const c of op.cells) written[c] = 1;
    for (let c = 0; c < voxels.length; c++) if (written[c]) voxels[c] = 0;
    return { size: [...this.size], voxels };
  }
}

function checkOp(op: VoxelOp, count: number): void {
  checkOptions(op, 'VoxelReplica operation');
  checkSite(op.site, 'VoxelReplica operation');
  if (!Number.isInteger(op.seq) || op.seq < 1 || op.seq > 0xffffffff)
    throw new RangeError(`VoxelReplica operation seq ${op.seq} is not 1 to 4294967295; pass an operation from edit()`);
  if (!Number.isInteger(op.clock) || op.clock < 1 || op.clock > 0xffffffff)
    throw new RangeError(
      `VoxelReplica operation clock ${op.clock} is not 1 to 4294967295; pass an operation from edit()`,
    );
  if (!(op.cells instanceof Uint32Array) || !(op.values instanceof Uint8Array) || op.cells.length !== op.values.length)
    throw new TypeError(
      'VoxelReplica operation needs cells (Uint32Array) and values (Uint8Array) of one length; pass an operation from edit()',
    );
  for (let i = 0; i < op.cells.length; i++)
    if (op.cells[i] >= count)
      throw new RangeError(
        `VoxelReplica operation cell ${op.cells[i]} is outside this grid; it comes from a grid of another size`,
      );
}

const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Packs an operation into bytes for the network: `MVOP`, version 1, site length (u16) and UTF-8 site, seq, clock and
 * count (u32 each), then the cell indexes (u32) and values (u8), little-endian.
 */
export function encodeVoxelOp(op: VoxelOp): Uint8Array {
  checkOp(op, Infinity);
  const site = encoder.encode(op.site),
    n = op.cells.length,
    bytes = new Uint8Array(4 + 1 + 2 + site.length + 12 + n * 5),
    view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x56, 0x4f, 0x50, 1]);
  view.setUint16(5, site.length, true);
  bytes.set(site, 7);
  let o = 7 + site.length;
  view.setUint32(o, op.seq, true);
  view.setUint32(o + 4, op.clock, true);
  view.setUint32(o + 8, n, true);
  o += 12;
  for (let i = 0; i < n; i++) view.setUint32(o + i * 4, op.cells[i], true);
  bytes.set(op.values, o + n * 4);
  return bytes;
}

/** Unpacks {@link encodeVoxelOp}'s bytes. @throws RangeError for bytes that are not a whole version 1 operation. */
export function decodeVoxelOp(bytes: Uint8Array): VoxelOp {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeVoxelOp needs a Uint8Array; pass the bytes received');
  const bad = (why: string) => new RangeError(`decodeVoxelOp: ${why}; pass bytes from encodeVoxelOp`);
  if (bytes.length < 19 || bytes[0] !== 0x4d || bytes[1] !== 0x56 || bytes[2] !== 0x4f || bytes[3] !== 0x50)
    throw bad('not a voxel operation');
  if (bytes[4] !== 1) throw bad(`version ${bytes[4]} is not 1`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    length = view.getUint16(5, true);
  if (bytes.length < 19 + length) throw bad('cut short');
  let site: string;
  try {
    site = decoder.decode(bytes.subarray(7, 7 + length));
  } catch {
    throw bad('the site is not UTF-8');
  }
  let o = 7 + length;
  const seq = view.getUint32(o, true),
    clock = view.getUint32(o + 4, true),
    n = view.getUint32(o + 8, true);
  o += 12;
  if (bytes.length !== o + n * 5) throw bad('its length does not match its cell count');
  const cells = new Uint32Array(n);
  for (let i = 0; i < n; i++) cells[i] = view.getUint32(o + i * 4, true);
  const op = { site, seq, clock, cells, values: bytes.slice(o + n * 4) };
  checkOp(op, Infinity);
  return op;
}

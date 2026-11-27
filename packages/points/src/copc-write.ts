// Cloud Optimized Point Cloud writer, the mirror of the reader in copc.ts, from the public COPC 1.0 specification
// (Hobu, 2021, https://copc.io): a LAZ 1.4 file of point format 6, 7 or 8 whose chunks are the nodes of an octree, with
// an info record first and the hierarchy as an extended record. The octree is built out of core and top down: a node
// keeps the first point that falls in each cell of its sampling grid and hands the rest to its children through a store,
// so only the nodes being built are in memory (a top-down form of the octrees of M. Schütz, S. Ohrhallinger and M.
// Wimmer, "Fast out-of-core octree generation for massive point clouds", Computer Graphics Forum 39(7), 2020,
// https://doi.org/10.1111/cgf.14134). No source code of PDAL, Untwine, Entwine or any other writer was read.
import { concatBytes } from '../../shared/bytes.js';
import { LAS_RECORD_SIZES, type LASRecord, type LASWriteInput, readLASHeader, writeLAS } from './las.js';
import { chunk, chunkTable, itemsOf, lazRecord } from './laz-encode.js';

/** Points for the writer: what `writeLAS` takes, or the bytes of an uncompressed LAS file (versions 1.0 to 1.5). */
export type CopcBatch = LASWriteInput | Uint8Array;
/** One batch, or any number of them: an array, a generator, or an async stream such as tiles being read. */
export type CopcPoints = CopcBatch | Iterable<CopcBatch> | AsyncIterable<CopcBatch>;

/**
 * Where the writer keeps points that wait for their node. The default holds them in memory; a store over files or the
 * browser's file system keeps a cloud of any size out of it.
 */
export interface CopcStore {
  /** Adds bytes after those already under `key`. The writer does not touch `bytes` again. */
  append(key: string, bytes: Uint8Array): void | Promise<void>;
  /** The bytes under `key` in the order appended, in pieces of any length. */
  read(key: string): Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  /** Forgets `key`. */
  delete(key: string): void | Promise<void>;
}

/** Options of {@link writeCOPC} and {@link writeCOPCTo}. */
export interface CopcWriteOptions {
  /**
   * Cells along each side of a node's sampling grid, 2 to 1024; a node keeps one point a cell, and the file's `spacing`
   * is the cube's side over this. Default 128.
   */
  gridSize?: number;
  /** A node with at most this many points left keeps them all and has no children. Default 100,000. */
  leafPoints?: number;
  /** Coordinate resolution. Default: that of the first batch. */
  scale?: readonly [number, number, number];
  /** OGC WKT of the CRS, in place of the first batch's. Needed when that batch states its CRS as GeoTIFF keys. */
  wkt?: string;
  /** Where waiting points go. Default: memory. */
  store?: CopcStore;
  /** Entries in one hierarchy page, 9 or more. Default 4,096: a reader loads a page at a time. */
  pageEntries?: number;
  /** Called after each node is written, with the points written so far and the points in all. */
  onProgress?: (written: number, total: number) => void;
  /** Stops the work; the store is emptied and the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link writeCOPCTo} wrote. */
export interface CopcWritten {
  points: number;
  /** Octree nodes, one LAZ chunk each. */
  nodes: number;
  /** The deepest node's level; the root is 0. */
  depth: number;
  /** Length of the file. */
  bytes: number;
}

/** Writes `bytes` at `position` of the file. Positions rise, but for the header, written last at 0. */
export type CopcSink = (bytes: Uint8Array, position: number) => void | Promise<void>;

const HEADER = 375,
  INFO = 160,
  /** Records move to and from the store in blocks of about this many bytes. */
  BLOCK = 1 << 20,
  /** Levels a voxel key's 32-bit numbers can address. */
  DEEPEST = 30;

/** The layout every record of the file shares, from the first batch. */
interface Layout {
  format: number;
  length: number;
  scale: readonly number[];
  offset: readonly number[];
  /** The first batch's variable length records that the file keeps. */
  records: LASRecord[];
  wkt: Uint8Array | undefined;
  globalEncoding: number;
  /** Header bytes of the first batch that the file keeps: file source id, project id and creation date. */
  kept: Uint8Array;
}

/** The point format a record of `format` becomes: COPC holds 6, 7 and 8. */
function targetFormat(format: number): number {
  if (format >= 6 && format <= 8) return format;
  if (format <= 3) return format >= 2 ? 7 : 6;
  throw new RangeError(
    `COPC holds point formats 6, 7 and 8; format ${format} has waveform packets, which it cannot keep`,
  );
}

/** A format 0 to 3 record at `from` as format 6 or 7 at `to` (LAS 1.4 R15: the fields the new formats widen). */
function widen(source: DataView, from: number, format: number, out: DataView, to: number): void {
  const returns = source.getUint8(from + 14),
    classes = source.getUint8(from + 15),
    // Class 12, "overlap points", is a flag from format 6 on, and the value is reserved.
    overlap = (classes & 31) === 12,
    gps = format === 1 || format === 3;
  out.setUint16(to + 12, source.getUint16(from + 12, true), true);
  out.setUint8(to + 14, (returns & 7) | (((returns >> 3) & 7) << 4));
  // Synthetic, key point and withheld keep their order below the overlap bit; scan direction and edge stay on top.
  out.setUint8(to + 15, (classes >> 5) | (overlap ? 8 : 0) | (returns & 0xc0));
  out.setUint8(to + 16, overlap ? 1 : classes & 31);
  out.setUint8(to + 17, source.getUint8(from + 17));
  // The rank is whole degrees; the new angle counts 0.006 degrees.
  out.setInt16(to + 18, Math.round(source.getInt8(from + 16) / 0.006), true);
  out.setUint16(to + 20, source.getUint16(from + 18, true), true);
  if (gps) out.setFloat64(to + 22, source.getFloat64(from + 20, true), true);
  if (format >= 2) {
    const rgb = from + (format === 3 ? 28 : 20);
    for (let c = 0; c < 3; c++) out.setUint16(to + 30 + c * 2, source.getUint16(rgb + c * 2, true), true);
  }
}

const isRecord = (r: LASRecord, user: string, ...ids: number[]) => r.userId === user && ids.includes(r.recordId);

/** A batch's records in the file's layout; the first batch makes the layout. */
function convert(batch: CopcBatch, options: CopcWriteOptions, layout?: Layout): { layout: Layout; points: Uint8Array } {
  // A batch of arrays is written as LAS first, so both kinds take one route.
  const file =
      batch instanceof Uint8Array
        ? batch
        : writeLAS({ ...batch, scale: options.scale ?? (layout?.scale as LASWriteInput['scale']) ?? batch.scale }),
    { header, records } = readLASHeader(file),
    { pointFormat: format, pointRecordLength: length, pointCount: count, pointDataOffset: start } = header;
  if (file[104] & 0xc0)
    throw new TypeError('A batch is compressed; give uncompressed LAS bytes or decoded points to writeCOPC');
  if (start + count * length > file.length)
    throw new TypeError(`A LAS batch ends before its ${count} points of ${length} bytes; it is cut off`);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    target = targetFormat(format),
    extra = length - LAS_RECORD_SIZES[format],
    outLength = LAS_RECORD_SIZES[target] + extra;
  if (extra < 0) throw new TypeError(`A LAS batch's records are shorter than point format ${format} needs`);
  if (!layout) {
    const text = options.wkt === undefined ? undefined : new TextEncoder().encode(`${options.wkt}\0`),
      wkt = text ?? records.find((r) => isRecord(r, 'LASF_Projection', 2112))?.data.slice(),
      scale = options.scale ?? header.scale;
    if (!wkt && records.some((r) => isRecord(r, 'LASF_Projection', 34735)))
      throw new RangeError('The points state their CRS as GeoTIFF keys, which COPC cannot hold; pass options.wkt');
    if (!scale.every((s) => s > 0 && Number.isFinite(s)))
      throw new RangeError('COPC scale must be three numbers above 0');
    layout = {
      format: target,
      length: outLength,
      scale: [...scale],
      offset: [...header.offset],
      records: records
        .filter(
          (r) =>
            !isRecord(r, 'laszip encoded', 22204) &&
            !isRecord(r, 'copc', 1, 1000) &&
            !isRecord(r, 'LASF_Projection', 2111, 2112, 34735, 34736, 34737),
        )
        .map((r) => ({ ...r, data: r.data.slice() })),
      wkt,
      // GPS time type and synthetic returns carry over; waveform bits cannot, and bit 4 says the CRS is WKT.
      globalEncoding: (view.getUint16(6, true) & 0b1001) | (wkt ? 16 : 0),
      kept: file.slice(0, 94),
    };
  }
  if (target !== layout.format || outLength !== layout.length)
    throw new RangeError(
      `Every batch needs one record layout: this one makes point format ${target} of ${outLength} bytes, the first made format ${layout.format} of ${layout.length}`,
    );
  const points = new Uint8Array(count * outLength),
    out = new DataView(points.buffer),
    { scale, offset } = layout;
  for (let i = 0; i < count; i++) {
    const from = start + i * length,
      to = i * outLength;
    if (format === target) points.set(file.subarray(from, from + length), to);
    else {
      widen(view, from, format, out, to);
      points.set(file.subarray(from + LAS_RECORD_SIZES[format], from + length), to + LAS_RECORD_SIZES[target]);
    }
    for (let a = 0; a < 3; a++) {
      const raw = view.getInt32(from + a * 4, true),
        moved =
          header.scale[a] === scale[a] && header.offset[a] === offset[a]
            ? raw
            : Math.round((raw * header.scale[a] + header.offset[a] - offset[a]) / scale[a]);
      if (!(moved >= -0x80000000 && moved <= 0x7fffffff))
        throw new RangeError("A point lies too far from the first batch's offset for this scale; pass a coarser scale");
      out.setInt32(to + a * 4, moved, true);
    }
  }
  return { layout, points };
}

/** A node waiting to be built: its voxel key, its points in the store and their number. */
interface Waiting {
  level: number;
  x: number;
  y: number;
  z: number;
  count: number;
}
/** A written node and where its chunk lies. */
interface Node {
  level: number;
  x: number;
  y: number;
  z: number;
  count: number;
  offset: number;
  bytes: number;
  children: Node[];
}
const keyOf = ({ level, x, y, z }: Waiting) => `copc-${level}-${x}-${y}-${z}`;

/** Records gathered into blocks, each a fresh array that is handed on when full. */
class Blocks {
  private block: Uint8Array | undefined;
  private used = 0;
  count = 0;
  constructor(
    private readonly length: number,
    private readonly full: (block: Uint8Array) => void | Promise<void>,
  ) {}
  /** Adds the record at `from`; returns the handing on when this one filled a block. */
  add(records: Uint8Array, from: number): void | Promise<void> {
    const length = this.length;
    this.block ??= new Uint8Array(Math.max(1, Math.floor(BLOCK / length)) * length);
    this.block.set(records.subarray(from, from + length), this.used);
    this.used += length;
    this.count++;
    if (this.used === this.block.length) return this.flush();
  }
  flush(): void | Promise<void> {
    if (!this.used) return;
    const block = this.block!.subarray(0, this.used);
    this.block = undefined;
    this.used = 0;
    return this.full(block);
  }
}

function memoryStore(): CopcStore {
  const held = new Map<string, Uint8Array[]>();
  return {
    append(key, bytes) {
      const list = held.get(key);
      if (list) list.push(bytes);
      else held.set(key, [bytes]);
    },
    read: (key) => held.get(key) ?? [],
    delete(key) {
      held.delete(key);
    },
  };
}

/** The store's bytes under `key` as whole records, a run at a time. */
async function* recordsOf(store: CopcStore, key: string, length: number): AsyncGenerator<Uint8Array> {
  let rest = new Uint8Array(0);
  for await (const piece of store.read(key)) {
    let bytes = piece;
    if (rest.length) {
      bytes = new Uint8Array(rest.length + piece.length);
      bytes.set(rest);
      bytes.set(piece, rest.length);
    }
    const whole = bytes.length - (bytes.length % length);
    if (whole) yield bytes.subarray(0, whole);
    rest = new Uint8Array(bytes.subarray(whole));
  }
  if (rest.length)
    throw new RangeError('The COPC store gave back part of a record; read must return what was appended');
}

/** One variable length record, or with `extended` an extended one's header. */
function recordHeader(user: string, id: number, size: number, extended = false): Uint8Array {
  const out = new Uint8Array(extended ? 60 : 54),
    view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(user).subarray(0, 16), 2);
  view.setUint16(18, id, true);
  if (extended) view.setBigUint64(20, BigInt(size), true);
  else view.setUint16(20, size, true);
  return out;
}

/**
 * The hierarchy as pages, each of at most `limit` entries: a node's subtree stays in its page while it fits, and
 * otherwise becomes a page of its own. Returns the pages, children before the page that points to them, with the place
 * each starts when the first is written at `start`.
 */
function pages(root: Node, limit: number, start: number): { bytes: Uint8Array[]; root: [number, number] } {
  const sizes = new Map<Node, number>(),
    measure = (node: Node): number => {
      const size = node.children.reduce((sum, child) => sum + measure(child), 1);
      sizes.set(node, size);
      return size;
    },
    bytes: Uint8Array[] = [];
  measure(root);
  let at = start;
  const page = (top: Node): [number, number] => {
    const entries: [Node, number, number, number][] = [];
    let room = limit;
    const put = (node: Node, offset: number, size: number, count: number) => {
        entries.push([node, offset, size, count]);
        room--;
      },
      whole = (node: Node) => {
        put(node, node.offset, node.bytes, node.count);
        node.children.forEach(whole);
      };
    put(top, top.offset, top.bytes, top.count);
    top.children.forEach((child, i) => {
      // Every child still to come needs at least the entry that points to its page.
      if (sizes.get(child)! <= room - (top.children.length - i - 1)) whole(child);
      else {
        const [offset, size] = page(child);
        put(child, offset, size, -1);
      }
    });
    const out = new Uint8Array(entries.length * 32),
      view = new DataView(out.buffer);
    entries.forEach(([node, offset, size, count], i) => {
      const o = i * 32;
      view.setInt32(o, node.level, true);
      view.setInt32(o + 4, node.x, true);
      view.setInt32(o + 8, node.y, true);
      view.setInt32(o + 12, node.z, true);
      view.setBigUint64(o + 16, BigInt(offset), true);
      view.setInt32(o + 24, size, true);
      view.setInt32(o + 28, count, true);
    });
    bytes.push(out);
    const place: [number, number] = [at, out.length];
    at += out.length;
    return place;
  };
  const place = page(root);
  return { bytes, root: place };
}

async function build(sink: CopcSink, source: CopcPoints, options: CopcWriteOptions): Promise<CopcWritten> {
  const { gridSize = 128, leafPoints = 100_000, pageEntries = 4096, signal, onProgress } = options,
    store = options.store ?? memoryStore();
  if (!Number.isInteger(gridSize) || gridSize < 2 || gridSize > 1024)
    throw new RangeError('gridSize must be a whole number from 2 to 1024');
  if (!Number.isInteger(leafPoints) || leafPoints < 1 || leafPoints > 0x7fffffff)
    throw new RangeError('leafPoints must be a whole number from 1 to 2147483647');
  if (!Number.isInteger(pageEntries) || pageEntries < 9) throw new RangeError('pageEntries must be 9 or more');
  signal?.throwIfAborted();
  const used = new Set<string>(),
    append = (key: string) => (block: Uint8Array) => {
      used.add(key);
      return store.append(key, block);
    },
    drop = async (key: string) => {
      used.delete(key);
      await store.delete(key);
    };
  try {
    // Every point goes to the root's place in the store, in the file's layout, and the cube comes from their extent.
    const top: Waiting = { level: 0, x: 0, y: 0, z: 0, count: 0 },
      low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity],
      byReturn = new Float64Array(15);
    let layout: Layout | undefined,
      earliest = Infinity,
      latest = -Infinity;
    const batches =
      source instanceof Uint8Array || 'positions' in (source as object)
        ? [source as CopcBatch]
        : (source as Iterable<CopcBatch>);
    let waiting: Blocks | undefined;
    for await (const batch of batches) {
      signal?.throwIfAborted();
      const made = convert(batch, options, layout);
      layout = made.layout;
      const { points } = made,
        { length } = layout,
        view = new DataView(points.buffer);
      waiting ??= new Blocks(length, append(keyOf(top)));
      for (let from = 0; from < points.length; from += length) {
        for (let a = 0; a < 3; a++) {
          const v = view.getInt32(from + a * 4, true);
          if (v < low[a]) low[a] = v;
          if (v > high[a]) high[a] = v;
        }
        const r = view.getUint8(from + 14) & 15;
        if (r) byReturn[r - 1]++;
        const time = view.getFloat64(from + 22, true);
        if (time < earliest) earliest = time;
        if (time > latest) latest = time;
        top.count++;
        const held = waiting.add(points, from);
        if (held) await held;
      }
    }
    if (!layout || !top.count) throw new RangeError('writeCOPC needs at least one point');
    await waiting!.flush();
    const { length, scale, offset, format } = layout,
      total = top.count,
      min = low.map((v, a) => v * scale[a] + offset[a]),
      max = high.map((v, a) => v * scale[a] + offset[a]),
      center = min.map((v, a) => (v + max[a]) / 2),
      // A cube of no size cannot be divided: it spans at least one step of the coordinates.
      halfSize = Math.max(...max.map((v, a) => (v - min[a]) / 2), ...scale),
      side = halfSize * 2,
      corner = center.map((c) => c - halfSize),
      items = itemsOf(format, length),
      info = new Uint8Array(INFO),
      carried = [
        ...(layout.wkt ? [{ userId: 'LASF_Projection', recordId: 2112, data: layout.wkt }] : []),
        ...layout.records,
      ],
      short = carried.filter((r) => r.data.length <= 0xffff),
      // Too long for a variable length record: these follow the points as extended ones.
      long = carried.filter((r) => r.data.length > 0xffff),
      records = [
        recordHeader('copc', 1, INFO),
        info,
        lazRecord(items, 0xffffffff),
        ...short.flatMap((r) => [recordHeader(r.userId, r.recordId, r.data.length), r.data]),
      ],
      pointStart = HEADER + records.reduce((sum, part) => sum + part.length, 0),
      sizes: number[] = [],
      counts: number[] = [];
    let position = pointStart + 8,
      written = 0,
      nodes = 0,
      depth = 0;
    const write = async (bytes: Uint8Array) => {
      await sink(bytes, position);
      position += bytes.length;
    };

    const buildNode = async (node: Waiting): Promise<Node> => {
      signal?.throwIfAborted();
      const key = keyOf(node),
        leaf = node.count <= leafPoints || node.level >= DEEPEST,
        cell = side / 2 ** node.level / gridSize,
        from = [node.x, node.y, node.z].map((v, a) => corner[a] + v * (side / 2 ** node.level)),
        taken = leaf ? undefined : new Set<number>(),
        kept: Uint8Array[] = [],
        mine = new Blocks(length, (block) => {
          kept.push(block);
        }),
        below: ({ node: Waiting; blocks: Blocks } | undefined)[] = [];
      for await (const run of recordsOf(store, key, length)) {
        signal?.throwIfAborted();
        const view = new DataView(run.buffer, run.byteOffset, run.byteLength);
        for (let at = 0; at < run.length; at += length) {
          if (!taken) {
            mine.add(run, at);
            continue;
          }
          let index = 0,
            octant = 0;
          for (let a = 0; a < 3; a++) {
            const place = (view.getInt32(at + a * 4, true) * scale[a] + offset[a] - from[a]) / cell,
              c = Math.min(gridSize - 1, Math.max(0, Math.floor(place)));
            index = index * gridSize + c;
            if (place >= gridSize / 2) octant |= 1 << a;
          }
          if (!taken.has(index)) {
            taken.add(index);
            mine.add(run, at);
            continue;
          }
          let child = below[octant];
          if (!child) {
            const voxel = {
              level: node.level + 1,
              x: node.x * 2 + (octant & 1),
              y: node.y * 2 + ((octant >> 1) & 1),
              z: node.z * 2 + ((octant >> 2) & 1),
              count: 0,
            };
            child = below[octant] = { node: voxel, blocks: new Blocks(length, append(keyOf(voxel))) };
          }
          child.node.count++;
          const held = child.blocks.add(run, at);
          if (held) await held;
        }
      }
      mine.flush();
      await drop(key);
      for (const child of below) await child?.blocks.flush();

      // Points in time order compress best; the order within a node is free.
      const unsorted = concatBytes(kept),
        count = mine.count,
        times = new Float64Array(count),
        unsortedView = new DataView(unsorted.buffer);
      kept.length = 0;
      for (let i = 0; i < count; i++) times[i] = unsortedView.getFloat64(i * length + 22, true);
      const order = Uint32Array.from({ length: count }, (_, i) => i).sort((a, b) => times[a] - times[b] || a - b),
        sorted = new Uint8Array(count * length);
      for (let i = 0; i < count; i++)
        sorted.set(unsorted.subarray(order[i] * length, (order[i] + 1) * length), i * length);
      const offsetOfChunk = position;
      for (const part of chunk(sorted, new DataView(sorted.buffer), 0, count, length, items)) await write(part);
      const bytes = position - offsetOfChunk;
      sizes.push(bytes);
      counts.push(count);
      written += count;
      nodes++;
      depth = Math.max(depth, node.level);
      onProgress?.(written, total);
      const children: Node[] = [];
      for (const child of below) if (child) children.push(await buildNode(child.node));
      return { level: node.level, x: node.x, y: node.y, z: node.z, count, offset: offsetOfChunk, bytes, children };
    };
    const root = await buildNode(top);

    const tableOffset = position,
      pointer = new Uint8Array(8);
    new DataView(pointer.buffer).setBigUint64(0, BigInt(tableOffset), true);
    await sink(pointer, pointStart);
    for (const part of chunkTable(sizes, counts)) await write(part);
    const evlr = position,
      hierarchy = pages(root, pageEntries, evlr + 60),
      entries = concatBytes(hierarchy.bytes);
    await write(recordHeader('copc', 1000, entries.length, true));
    await write(entries);
    for (const r of long) {
      await write(recordHeader(r.userId, r.recordId, r.data.length, true));
      await write(r.data);
    }

    const view = new DataView(info.buffer);
    [...center, halfSize, side / gridSize].forEach((v, i) => view.setFloat64(i * 8, v, true));
    view.setBigUint64(40, BigInt(hierarchy.root[0]), true);
    view.setBigUint64(48, BigInt(hierarchy.root[1]), true);
    view.setFloat64(56, earliest, true);
    view.setFloat64(64, latest, true);

    const header = new Uint8Array(HEADER),
      h = new DataView(header.buffer);
    header.set([0x4c, 0x41, 0x53, 0x46]);
    header.set(layout.kept.subarray(4, 6), 4);
    h.setUint16(6, layout.globalEncoding, true);
    header.set(layout.kept.subarray(8, 24), 8);
    h.setUint8(24, 1);
    h.setUint8(25, 4);
    header.set(layout.kept.subarray(26, 58), 26);
    header.set(new TextEncoder().encode('Margo Engine'), 58);
    header.set(layout.kept.subarray(90, 94), 90);
    h.setUint16(94, HEADER, true);
    h.setUint32(96, pointStart, true);
    h.setUint32(100, 2 + short.length, true);
    h.setUint8(104, format | 0x80);
    h.setUint16(105, length, true);
    for (let a = 0; a < 3; a++) {
      h.setFloat64(131 + a * 8, scale[a], true);
      h.setFloat64(155 + a * 8, offset[a], true);
      h.setFloat64(179 + a * 16, max[a], true);
      h.setFloat64(187 + a * 16, min[a], true);
    }
    h.setBigUint64(235, BigInt(evlr), true);
    h.setUint32(243, 1 + long.length, true);
    h.setBigUint64(247, BigInt(total), true);
    for (let r = 0; r < 15; r++) h.setBigUint64(255 + r * 8, BigInt(byReturn[r]), true);
    await sink(concatBytes([header, ...records]), 0);
    return { points: total, nodes, depth, bytes: position };
  } finally {
    // After an abort or a failure the store holds nothing of this file.
    for (const key of used) await store.delete(key);
  }
}

/**
 * Writes a Cloud Optimized Point Cloud through `sink`, holding only the nodes it is building in memory when
 * `options.store` keeps waiting points elsewhere. Formats 0 to 3 become 6 or 7; every field and extra byte is kept.
 *
 * @param sink Writes bytes at a position: a file handle, a browser file stream.
 * @param source The points: one batch, or an iterable or async iterable of batches with one record layout.
 * @param options The octree's grid and leaf sizes, the coordinate scale and CRS, the store, progress and abort.
 * @returns The points, nodes, depth and length written.
 * @throws RangeError for no points, a bad option, batches of two layouts, waveform formats, a CRS held only as GeoTIFF
 * keys, or a point too far for the scale; TypeError for a batch that is not uncompressed LAS; the signal's reason on an
 * abort.
 *
 * @example
 * ```ts
 * import { open } from 'node:fs/promises';
 * import { writeCOPCTo } from '@margoengine/points/copc-write';
 *
 * const file = await open('site.copc.laz', 'w');
 * async function* tiles() {
 *   for (let x = 0; x < 4; x++) yield { positions: [x, 0, 0, x, 1, 0], intensity: [10, 20] };
 * }
 * const written = await writeCOPCTo((bytes, position) => file.write(bytes, 0, bytes.length, position).then(() => {}), tiles());
 * await file.close();
 * console.log(written.points, written.nodes);
 * ```
 */
export function writeCOPCTo(sink: CopcSink, source: CopcPoints, options: CopcWriteOptions = {}): Promise<CopcWritten> {
  return build(sink, source, options);
}

/**
 * {@link writeCOPCTo} into one array, for clouds that fit in memory.
 *
 * @param source The points: one batch, or an iterable or async iterable of batches.
 * @param options As {@link writeCOPCTo} takes them.
 * @returns The file.
 * @throws As {@link writeCOPCTo} does.
 *
 * @example
 * ```ts
 * import { writeCOPC } from '@margoengine/points/copc-write';
 *
 * const file = await writeCOPC({ positions: [0, 0, 0, 1, 2, 3], wkt: 'GEOGCS["WGS 84"]' });
 * console.log(file.length);
 * ```
 */
export async function writeCOPC(source: CopcPoints, options: CopcWriteOptions = {}): Promise<Uint8Array> {
  let out = new Uint8Array(1 << 16),
    length = 0;
  await build(
    (bytes, position) => {
      const end = position + bytes.length;
      if (end > out.length) {
        const grown = new Uint8Array(Math.max(end, out.length * 2));
        grown.set(out);
        out = grown;
      }
      out.set(bytes, position);
      if (end > length) length = end;
    },
    source,
    options,
  );
  return out.slice(0, length);
}

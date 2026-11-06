// Cloud Optimized Point Cloud reader, from the public COPC 1.0 specification: a LAZ 1.4 file whose first record (user id
// `copc`, id 1) gives a cube and where the hierarchy pages are; each page lists voxels and the byte range of their
// points, one LAZ chunk per voxel. Everything comes by HTTP range requests, so a viewer reads only what it shows.
import type { LASHeader, LASRecord } from './las.js';
import type { OctreeNode, OctreeNodeData, OctreeSource } from './octree.js';
import { readRange } from './range.js';

/** Options of `CopcSource.open`. */
export interface CopcOptions {
  /** Used for every range request. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Cancels the header and hierarchy reads. */
  signal?: AbortSignal;
}
/** The file's info record (user id `copc`, record id 1). */
export interface CopcInfo {
  /** Centre of the octree's cube, world units. */
  readonly center: readonly [number, number, number];
  /** Half of the cube's side. */
  readonly halfSize: number;
  /** Distance between the root node's points. */
  readonly spacing: number;
  readonly rootHierarchyOffset: number;
  readonly rootHierarchySize: number;
  /** Smallest and largest GPS time in the file. */
  readonly gpsTime: readonly [number, number];
}
interface CopcNode extends OctreeNode {
  children: (CopcNode | null)[];
  offset: number;
  bytes: number;
}
const ENTRY_BYTES = 32,
  HEADER_BYTES = 375;

/** Parses the 160-byte COPC info record. Throws a TypeError when the file has none. */
export function copcInfo(records: readonly LASRecord[]): CopcInfo {
  const record = records.find((r) => r.userId === 'copc' && r.recordId === 1);
  if (!record || record.data.byteLength < 160)
    throw new TypeError('Not a COPC file (no copc info record); pass a .copc.laz, or load a plain LAS with loadLAS');
  const view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength),
    f = (o: number) => view.getFloat64(o, true),
    u = (o: number) => Number(view.getBigUint64(o, true));
  return {
    center: [f(0), f(8), f(16)],
    halfSize: f(24),
    spacing: f(32),
    rootHierarchyOffset: u(40),
    rootHierarchySize: u(48),
    gpsTime: [f(56), f(64)],
  };
}

/**
 * An `OctreeSource` over a COPC file on any server that answers range requests: `CopcSource.open(url)`, then
 * `OctreeCloud.attach(engine, points, source)`. The hierarchy pages are read at open, a node's points when it is
 * shown. Positions and bounds are relative to `origin` (the cube's centre), so place the cloud there. A server that
 * ignores `Range` sends the whole file, which works and costs that download per request.
 */
export class CopcSource implements OctreeSource {
  readonly root: OctreeNode;
  /** World position of local [0, 0, 0]: the cube's centre. */
  readonly origin: readonly [number, number, number];
  private constructor(
    private readonly url: string | URL,
    private readonly fetcher: typeof fetch,
    readonly header: LASHeader,
    readonly records: readonly LASRecord[],
    readonly info: CopcInfo,
    root: CopcNode,
  ) {
    this.root = root;
    this.origin = info.center;
  }
  /**
   * Reads the header, the records and every hierarchy page.
   * @throws MargoError `'failed'` when the server answers an error; TypeError when the file is not COPC; RangeError for
   * a hierarchy that is corrupt; the `signal`'s reason when it aborts.
   */
  static async open(url: string | URL, options: CopcOptions = {}): Promise<CopcSource> {
    const fetcher = options.fetch ?? globalThis.fetch,
      signal = options.signal,
      get = (at: number, bytes: number) => readRange(fetcher, url, at, bytes, signal),
      [first, { readLASHeader }] = await Promise.all([get(0, HEADER_BYTES), import('./las.js')]),
      head = readLASHeaderBytes(first),
      { header, records } = readLASHeader(await get(0, head));
    const info = copcInfo(records),
      side = info.halfSize * 2;
    if (!(side > 0)) throw new RangeError('COPC info holds a cube of no size; the file is corrupt');
    const nodes = new Map<string, CopcNode>(),
      made = (d: number, x: number, y: number, z: number, count: number, offset: number, bytes: number) => {
        const cell = side / 2 ** d,
          bounds = new Float64Array(6),
          corner = [x, y, z];
        for (let a = 0; a < 3; a++) {
          bounds[a] = corner[a] * cell - info.halfSize;
          bounds[a + 3] = bounds[a] + cell;
        }
        const node: CopcNode = {
          id: '',
          level: d,
          bounds,
          spacing: info.spacing / 2 ** d,
          count,
          parent: null,
          children: new Array(8).fill(null),
          offset,
          bytes,
        };
        nodes.set(`${d}-${x}-${y}-${z}`, node);
      };
    const pages = [[info.rootHierarchyOffset, info.rootHierarchySize]];
    while (pages.length) {
      const batch = pages.splice(0);
      const read = await Promise.all(batch.map(([at, bytes]) => get(at, bytes)));
      for (const page of read) {
        if (page.byteLength % ENTRY_BYTES)
          throw new RangeError('COPC hierarchy page is not whole entries; the file is corrupt');
        const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
        for (let o = 0; o < page.byteLength; o += ENTRY_BYTES) {
          const d = view.getInt32(o, true),
            x = view.getInt32(o + 4, true),
            y = view.getInt32(o + 8, true),
            z = view.getInt32(o + 12, true),
            offset = Number(view.getBigUint64(o + 16, true)),
            bytes = view.getInt32(o + 24, true),
            count = view.getInt32(o + 28, true),
            span = 2 ** d;
          if (!(d >= 0 && d < 32) || !(x >= 0 && x < span && y >= 0 && y < span && z >= 0 && z < span))
            throw new RangeError(`COPC hierarchy voxel ${d}-${x}-${y}-${z} lies outside the cube; the file is corrupt`);
          if (count === -1) pages.push([offset, bytes]);
          else if (count < 0) throw new RangeError('COPC hierarchy holds a negative point count; the file is corrupt');
          else made(d, x, y, z, count, offset, bytes);
        }
      }
    }
    const root = nodes.get('0-0-0-0');
    if (!root) throw new RangeError('COPC hierarchy has no root voxel; the file is corrupt');
    (root as { id: string }).id = 'r';
    // Parents first: the file's order is not promised, so walk by level. An empty voxel with nothing under it drops out.
    const order = [...nodes].sort((a, b) => (a[1] as CopcNode).level - (b[1] as CopcNode).level);
    for (const [key, node] of order) {
      if (node === root) continue;
      const [d, x, y, z] = key.split('-').map(Number),
        parent = nodes.get(`${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`);
      if (!parent) throw new RangeError(`COPC voxel ${key} has no parent voxel; the file is corrupt`);
      const octant = (x & 1) | ((y & 1) << 1) | ((z & 1) << 2);
      (node as { parent: OctreeNode | null }).parent = parent;
      (node as { id: string }).id = parent.id + octant;
      parent.children[octant] = node;
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const node = order[i][1],
        parent = node.parent as CopcNode | null;
      if (parent && !node.count && !node.children.some(Boolean)) parent.children[parent.children.indexOf(node)] = null;
    }
    return new CopcSource(url, fetcher, header, records, info, root);
  }
  /** Fetches and decodes one node's chunk. An empty node gives no points without a request. */
  async load(node: OctreeNode, signal: AbortSignal): Promise<OctreeNodeData> {
    const { offset, bytes, count } = node as CopcNode;
    if (!count) return { positions: new Float32Array(0) };
    const [chunk, { decodeLazChunk }, { decodePoints }] = await Promise.all([
        readRange(this.fetcher, this.url, offset, bytes, signal),
        import('./laz.js'),
        import('./las.js'),
      ]),
      data = decodeLazChunk(chunk, count, this.header, this.records);
    signal.throwIfAborted();
    const points = decodePoints({ ...this.header, pointCount: count }, this.records, data, { origin: this.origin }),
      rgb = points.rgb;
    if (!rgb) return { positions: points.positions };
    const colors = new Uint8Array(rgb.length);
    // The specification asks for 16-bit colour; files with 8-bit values stored as they are stay visible.
    let wide = false;
    for (let i = 0; i < rgb.length && !wide; i++) wide = rgb[i] > 255;
    for (let i = 0; i < rgb.length; i++) colors[i] = wide ? rgb[i] >> 8 : rgb[i];
    return { positions: points.positions, colors, colorComponents: 3 };
  }
}
/** Where the point data starts, from the first bytes of a LAS 1.4 header. */
function readLASHeaderBytes(bytes: Uint8Array): number {
  if (bytes.byteLength < 100) throw new RangeError('COPC header is cut short; the file is truncated');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(96, true);
}

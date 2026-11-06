// Potree octree folders, written from the public descriptions of the formats PotreeConverter writes.
//   2.0: `metadata.json`, `hierarchy.bin` (22-byte records in chunks joined by proxy records) and `octree.bin` (every
//        node's points), read by HTTP range requests.
//   1.5 to 1.8: `cloud.js`, `.hrc` hierarchy files every `hierarchyStepSize` levels, one `.bin`, `.las` or `.laz` per node.
// Both number a node's children with x as bit 2, y as bit 1 and z as bit 0, the reverse of `OctreeNode.id`.
import { MargoError } from '@margoengine/math/errors';
import type { LazDecoder, parseLAS } from './las.js';
import type { OctreeNode, OctreeNodeData, OctreeSource } from './octree.js';
import { readRange, readWhole } from './range.js';

/** Options of `PotreeSource.open`. */
export interface PotreeOptions {
  /** Used for every request. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Cancels the metadata and hierarchy reads. */
  signal?: AbortSignal;
  /** `parseLAS` from `@margoengine/points/las`, for 1.x folders of LAS or LAZ nodes. Binary folders do not need it. */
  parseLAS?: typeof parseLAS;
  /** A LAZ decoder for 1.x folders of LAZ nodes. Default: what `parseLAS` loads by itself. */
  laz?: LazDecoder;
}
interface PotreeNode extends OctreeNode {
  children: (PotreeNode | null)[];
  /** The node's name in the format's own digits: 'r' and one child index per level. */
  name: string;
  /** Where its points lie in `octree.bin` (2.0). */
  offset: number;
  bytes: number;
}
/** One attribute of a point record. */
interface Attribute {
  name: string;
  size: number;
}
/** What reading a node needs, for one format version. */
interface Layout {
  /** Bytes of one point record. */
  stride: number;
  /** Byte offset of each attribute that is read; -1 when absent. */
  position: number;
  color: number;
  /** Bytes a colour takes: 6 for 16-bit RGB, 4 for packed RGBA. */
  colorSize: number;
  /** World units per position step, per axis. */
  scale: readonly [number, number, number];
}
type Fetcher = typeof fetch;
/** What opening a folder finds. */
interface Opened {
  root: PotreeNode;
  version: string;
  points: number;
  origin: readonly [number, number, number];
  fetchNode(node: PotreeNode, signal: AbortSignal): Promise<OctreeNodeData>;
}

const RECORD_BYTES = 22,
  /** Point record fields of 1.x, by name, in bytes. */
  V1_SIZES: Readonly<Record<string, number>> = {
    POSITION_CARTESIAN: 12,
    COLOR_PACKED: 4,
    RGBA_PACKED: 4,
    INTENSITY: 2,
    CLASSIFICATION: 1,
    RETURN_NUMBER: 1,
    NUMBER_OF_RETURNS: 1,
    SOURCE_ID: 2,
    GPS_TIME: 8,
    NORMAL: 12,
    NORMAL_FLOATS: 12,
    NORMAL_SPHEREMAPPED: 2,
    NORMAL_OCT16: 2,
  };

/** The eight-way digit of `OctreeNode.id` for a Potree child index. */
const octantOf = (index: number) => ((index >> 2) & 1) | (index & 2) | ((index & 1) << 2);

function child(parent: PotreeNode, index: number): PotreeNode {
  const octant = octantOf(index),
    b = parent.bounds,
    bounds = new Float64Array(6);
  for (let axis = 0; axis < 3; axis++) {
    const half = (b[axis + 3] - b[axis]) / 2,
      upper = (octant >> axis) & 1;
    bounds[axis] = b[axis] + upper * half;
    bounds[axis + 3] = bounds[axis] + half;
  }
  const node: PotreeNode = {
    id: parent.id + octant,
    level: parent.level + 1,
    bounds,
    spacing: parent.spacing / 2,
    count: 0,
    parent,
    children: new Array(8).fill(null),
    name: parent.name + index,
    offset: 0,
    bytes: 0,
  };
  parent.children[octant] = node;
  return node;
}
function rootNode(min: ArrayLike<number>, max: ArrayLike<number>, spacing: number): PotreeNode {
  return {
    id: 'r',
    level: 0,
    bounds: Float64Array.of(min[0], min[1], min[2], max[0], max[1], max[2]),
    spacing,
    count: 0,
    parent: null,
    children: new Array(8).fill(null),
    name: 'r',
    offset: 0,
    bytes: 0,
  };
}
const setCount = (node: PotreeNode, count: number) => {
  (node as { count: number }).count = count;
};

/** Drops children with no points and nothing under them. */
function prune(node: PotreeNode): void {
  for (let o = 0; o < 8; o++) {
    const next = node.children[o];
    if (!next) continue;
    prune(next);
    if (!next.count && !next.children.some(Boolean)) node.children[o] = null;
  }
}

/** Reads `hierarchy.bin` from its first chunk, following proxy records; returns nothing, fills `root`. */
async function readHierarchy2(
  root: PotreeNode,
  first: number,
  read: (at: number, bytes: number) => Promise<Uint8Array>,
): Promise<void> {
  let wave: { node: PotreeNode; at: number; bytes: number }[] = [{ node: root, at: 0, bytes: first }];
  while (wave.length) {
    const chunks = await Promise.all(wave.map((chunk) => read(chunk.at, chunk.bytes))),
      next: typeof wave = [];
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      if (!chunk.byteLength || chunk.byteLength % RECORD_BYTES)
        throw new RangeError('Potree hierarchy chunk is not whole records; the file is corrupt');
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        nodes = [wave[c].node];
      for (let i = 0, o = 0; o < chunk.byteLength; i++, o += RECORD_BYTES) {
        const node = nodes[i];
        if (!node) throw new RangeError('Potree hierarchy chunk holds more records than nodes; the file is corrupt');
        const type = view.getUint8(o),
          mask = view.getUint8(o + 1),
          at = Number(view.getBigUint64(o + 6, true)),
          bytes = Number(view.getBigUint64(o + 14, true));
        setCount(node, view.getUint32(o + 2, true));
        if (type === 2) {
          next.push({ node, at, bytes });
          continue;
        }
        if (type > 2) throw new RangeError(`Potree hierarchy holds node type ${type}; the file is corrupt`);
        node.offset = at;
        node.bytes = bytes;
        for (let index = 0; index < 8; index++) if (mask & (1 << index)) nodes.push(child(node, index));
      }
    }
    wave = next;
  }
}

/** Reads the `.hrc` files of 1.x from the root, each `step` levels deep with its last level leading to the next file. */
async function readHierarchy1(
  root: PotreeNode,
  step: number,
  read: (node: PotreeNode) => Promise<Uint8Array>,
): Promise<void> {
  let wave = [root];
  while (wave.length) {
    const files = await Promise.all(wave.map(read)),
      next: PotreeNode[] = [];
    for (let f = 0; f < files.length; f++) {
      const file = files[f],
        top = wave[f],
        view = new DataView(file.buffer, file.byteOffset, file.byteLength),
        queue = [top];
      if (!file.byteLength || file.byteLength % 5)
        throw new RangeError('Potree .hrc file is not whole records; the file is corrupt');
      let i = 0;
      for (let o = 0; o < file.byteLength; i++, o += 5) {
        const node = queue[i];
        if (!node) throw new RangeError('Potree .hrc file holds more records than nodes; the file is corrupt');
        const mask = view.getUint8(o);
        setCount(node, view.getUint32(o + 1, true));
        if (!mask) continue;
        // The file's last level only says it has children: they start the next file.
        if (node.level - top.level >= step) next.push(node);
        else for (let index = 0; index < 8; index++) if (mask & (1 << index)) queue.push(child(node, index));
      }
      if (i !== queue.length) throw new RangeError('Potree .hrc file is cut short; the file is corrupt');
    }
    wave = next;
  }
}

const checkNumbers = (values: unknown, count: number, what: string): readonly number[] => {
  if (!Array.isArray(values) || values.length < count || !values.every(Number.isFinite))
    throw new TypeError(`Potree ${what} is missing or not ${count} numbers; the metadata is corrupt`);
  return values;
};

function layoutOf(attributes: readonly Attribute[], scale: Layout['scale']): Layout {
  const out: Layout = { stride: 0, position: -1, color: -1, colorSize: 0, scale };
  for (const { name, size } of attributes) {
    if (name === 'position' || name === 'POSITION_CARTESIAN') out.position = out.stride;
    else if (name === 'rgb' || name === 'rgba' || name === 'COLOR_PACKED' || name === 'RGBA_PACKED') {
      out.color = out.stride;
      out.colorSize = size;
    }
    out.stride += size;
  }
  if (out.position < 0) throw new TypeError('Potree attributes hold no position; the metadata is corrupt');
  return out;
}

/**
 * An `OctreeSource` over a Potree octree folder on any web server: `PotreeSource.open(url)`, then
 * `OctreeCloud.attach(engine, points, source)`. Reads Potree 2.0 (encoding `DEFAULT`) and Potree 1.5 to 1.8 (binary, LAS
 * or LAZ nodes). The whole hierarchy is read at open, a node's points when it is shown. Positions and bounds are
 * relative to `origin`, the centre of the cloud's box, so place the cloud there. Position and colour are read.
 */
export class PotreeSource implements OctreeSource {
  readonly root: OctreeNode;
  /** World position of local [0, 0, 0]: the centre of the box. */
  readonly origin: readonly [number, number, number];
  /** The format version the folder states. */
  readonly version: string;
  /** Points the folder states it holds. */
  readonly points: number;
  private readonly fetchNode: Opened['fetchNode'];
  private constructor(opened: Opened) {
    this.root = opened.root;
    this.version = opened.version;
    this.points = opened.points;
    this.origin = opened.origin;
    this.fetchNode = opened.fetchNode;
  }

  /**
   * Reads the metadata and the whole hierarchy. `url` is the folder, or its `metadata.json` or `cloud.js`; a folder is
   * taken as 2.0 when it has a `metadata.json`.
   * @throws MargoError `'failed'` when the server answers an error; MargoError `'unsupported'` for a version or encoding
   * not read here; TypeError for metadata that is not Potree's; RangeError for a corrupt hierarchy; the `signal`'s reason
   * when it aborts.
   */
  static async open(url: string | URL, options: PotreeOptions = {}): Promise<PotreeSource> {
    const fetcher = options.fetch ?? globalThis.fetch,
      { signal } = options,
      text = String(url),
      named = /(metadata\.json|cloud\.js)(\?.*)?$/.exec(text),
      folder = named ? text.slice(0, named.index) : text.endsWith('/') ? text : `${text}/`,
      json = (bytes: Uint8Array, name: string) => {
        try {
          return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        } catch {
          throw new TypeError(`${folder + name} is not JSON; pass a Potree folder, metadata.json or cloud.js`);
        }
      },
      read = async (name: string) => json(await readWhole(fetcher, folder + name, signal), name);
    if (named?.[1] === 'cloud.js') return new PotreeSource(await open1(folder, await read('cloud.js'), fetcher, options));
    if (named) return new PotreeSource(await open2(folder, await read('metadata.json'), fetcher, signal));
    const probe = await fetcher(`${folder}metadata.json`, { signal });
    if (!probe.ok) return new PotreeSource(await open1(folder, await read('cloud.js'), fetcher, options));
    const metadata = json(new Uint8Array(await probe.arrayBuffer()), 'metadata.json');
    return new PotreeSource(await open2(folder, metadata, fetcher, signal));
  }

  /** Fetches and decodes one node's points. An empty node gives no points without a request. */
  async load(node: OctreeNode, signal: AbortSignal): Promise<OctreeNodeData> {
    if (!node.count) return { positions: new Float32Array(0) };
    return this.fetchNode(node as PotreeNode, signal);
  }
}

/** The centre of a box, and the box moved so that centre is at zero. */
function centred(min: readonly number[], max: readonly number[]) {
  const origin = [0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number];
  return {
    origin,
    min: [0, 1, 2].map((a) => min[a] - origin[a]),
    max: [0, 1, 2].map((a) => max[a] - origin[a]),
  };
}

async function open2(
  folder: string,
  meta: Record<string, unknown>,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Opened> {
  const version = String(meta.version);
  if (!version.startsWith('2.'))
    throw new MargoError('unsupported', `Potree version ${version} in metadata.json; this reader takes 2.x`);
  if (meta.encoding !== undefined && meta.encoding !== 'DEFAULT')
    throw new MargoError(
      'unsupported',
      `Potree encoding ${String(meta.encoding)} is not read; convert with encoding DEFAULT`,
    );
  const box = meta.boundingBox as { min?: unknown; max?: unknown } | undefined,
    { origin, min, max } = centred(
      checkNumbers(box?.min, 3, 'boundingBox.min'),
      checkNumbers(box?.max, 3, 'boundingBox.max'),
    ),
    scale = checkNumbers(typeof meta.scale === 'number' ? [meta.scale, meta.scale, meta.scale] : meta.scale, 3, 'scale'),
    offset = checkNumbers(meta.offset, 3, 'offset'),
    hierarchy = meta.hierarchy as { firstChunkSize?: unknown } | undefined,
    attributes = meta.attributes as { name: string; size: number; max?: number[] }[] | undefined,
    first = hierarchy?.firstChunkSize;
  if (typeof first !== 'number' || !Array.isArray(attributes))
    throw new TypeError('Potree metadata.json has no hierarchy or attributes; pass a Potree 2.0 metadata.json');
  const layout = layoutOf(attributes, scale as Layout['scale']),
    color = attributes.find((a) => a.name === 'rgb' || a.name === 'rgba'),
    // The file states its colour range; 8-bit values stored in 16-bit fields stay as they are.
    wide = color?.max ? Math.max(...color.max) > 255 : undefined,
    root = rootNode(min, max, Number(meta.spacing) || 1),
    shift = [offset[0] - origin[0], offset[1] - origin[1], offset[2] - origin[2]];
  await readHierarchy2(root, first, (at, bytes) => readRange(fetcher, `${folder}hierarchy.bin`, at, bytes, signal));
  prune(root);
  return {
    root,
    version,
    points: Number(meta.points) || 0,
    origin,
    fetchNode: async (node, nodeSignal) => {
      const bytes = await readRange(fetcher, `${folder}octree.bin`, node.offset, node.bytes, nodeSignal);
      return decode(bytes, node, layout, shift, wide);
    },
  };
}

async function open1(
  folder: string,
  meta: Record<string, unknown>,
  fetcher: Fetcher,
  options: PotreeOptions,
): Promise<Opened> {
  const { signal, parseLAS: parse, laz } = options,
    version = String(meta.version),
    [major, minor] = version.split('.').map(Number);
  if (major !== 1 || !(minor >= 5))
    throw new MargoError('unsupported', `Potree version ${version} in cloud.js; this reader takes 1.5 to 1.8 and 2.x`);
  const box = meta.boundingBox as Record<string, number> | undefined,
    { origin, min, max } = centred(
      checkNumbers([box?.lx, box?.ly, box?.lz], 3, 'boundingBox'),
      checkNumbers([box?.ux, box?.uy, box?.uz], 3, 'boundingBox'),
    ),
    step = Number(meta.hierarchyStepSize),
    directory = `${folder}${String(meta.octreeDir ?? 'data')}/`,
    fields = meta.pointAttributes,
    scale = Number(meta.scale);
  if (!(step >= 1) || !(scale > 0)) throw new TypeError('Potree cloud.js has no hierarchyStepSize or scale; it is corrupt');
  const path = (node: PotreeNode) => {
      const digits = node.name.slice(1);
      let out = `${directory}r/`;
      for (let at = 0; at + step <= digits.length; at += step) out += `${digits.slice(at, at + step)}/`;
      return out + node.name;
    },
    root = rootNode(min, max, Number(meta.spacing) || 1);
  await readHierarchy1(root, step, (node) => readWhole(fetcher, `${path(node)}.hrc`, signal));
  prune(root);
  const opened = { root, version, points: Number(meta.points) || 0, origin };
  if (fields === 'LAS' || fields === 'LAZ') {
    const compressed = fields === 'LAZ';
    if (!parse)
      throw new MargoError('unsupported', `Potree folder of ${fields} nodes needs a reader; pass parseLAS from points/las`);
    return {
      ...opened,
      fetchNode: async (node, nodeSignal) => {
        const bytes = await readWhole(fetcher, `${path(node)}.${compressed ? 'laz' : 'las'}`, nodeSignal),
          las = await parse(bytes, { origin, laz, signal: nodeSignal });
        return { positions: las.positions, ...lasColors(las.rgb) };
      },
    };
  }
  if (!Array.isArray(fields)) throw new TypeError('Potree cloud.js has no pointAttributes; it is corrupt');
  const layout = layoutOf(
    fields.map((name: string) => {
      const size = V1_SIZES[name];
      if (!size) throw new MargoError('unsupported', `Potree point attribute ${name} is not read; convert the folder without it`);
      return { name, size };
    }),
    [scale, scale, scale],
  );
  return {
    ...opened,
    fetchNode: async (node, nodeSignal) => {
      const bytes = await readWhole(fetcher, `${path(node)}.bin`, nodeSignal);
      // Positions count from the corner of their node.
      return decode(bytes, node, layout, [node.bounds[0], node.bounds[1], node.bounds[2]], undefined, true);
    },
  };
}

function lasColors(rgb: ArrayLike<number> | null | undefined): Pick<OctreeNodeData, 'colors' | 'colorComponents'> {
  if (!rgb) return {};
  const colors = new Uint8Array(rgb.length);
  let wide = false;
  for (let i = 0; i < rgb.length && !wide; i++) wide = rgb[i] > 255;
  for (let i = 0; i < rgb.length; i++) colors[i] = wide ? rgb[i] >> 8 : rgb[i];
  return { colors, colorComponents: 3 };
}

/** Decodes interleaved point records. `unsigned` positions are 1.x's, counted from the node's corner. */
function decode(
  bytes: Uint8Array,
  node: OctreeNode,
  layout: Layout,
  shift: readonly number[],
  wideColors: boolean | undefined,
  unsigned = false,
): OctreeNodeData {
  const n = node.count,
    { stride, position, color, colorSize, scale } = layout;
  if (bytes.byteLength < n * stride)
    throw new RangeError(`Potree node ${node.id} holds ${bytes.byteLength} bytes for ${n} points; the file is cut short`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let axis = 0; axis < 3; axis++) {
      const at = i * stride + position + axis * 4,
        value = unsigned ? view.getUint32(at, true) : view.getInt32(at, true);
      positions[i * 3 + axis] = value * scale[axis] + shift[axis];
    }
  if (color < 0) return { positions };
  const colors = new Uint8Array(n * 3);
  if (colorSize >= 6) {
    let wide = wideColors;
    for (let i = 0; i < n && wide === undefined; i++)
      for (let c = 0; c < 3; c++) if (view.getUint16(i * stride + color + c * 2, true) > 255) wide = true;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) {
        const value = view.getUint16(i * stride + color + c * 2, true);
        colors[i * 3 + c] = wide ? value >> 8 : value;
      }
  } else
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) colors[i * 3 + c] = view.getUint8(i * stride + color + c);
  return { positions, colors, colorComponents: 3 };
}

// Potree octree folders. DEFAULT 2.0 and 1.5 to 1.8 come from the public descriptions of the formats PotreeConverter writes;
// 1.4 from the same reference; the layout of a BROTLI node was measured on real folders, as no text gives its bit order.
//   2.0: `metadata.json`, `hierarchy.bin` (22-byte records in chunks joined by proxy records) and `octree.bin` (every
//        node's points), read by HTTP range requests. DEFAULT stores whole records; BROTLI stores each node as a Brotli
//        stream of one block per attribute, positions and colours Morton coded.
//   1.5 to 1.8: `cloud.js`, `.hrc` hierarchy files every `hierarchyStepSize` levels, one `.bin`, `.las` or `.laz` per node.
//   1.4: the hierarchy inside `cloud.js`, every node's file in one folder.
// All number a node's children with x as bit 2, y as bit 1 and z as bit 0, the reverse of `OctreeNode.id`.
import { MargoError } from '@margoengine/math/errors';
import { classificationColors, rampColors } from './attributes.js';
import type { LazDecoder, parseLAS } from './las.js';
import type { OctreeNode, OctreeNodeData, OctreeSource } from './octree.js';
import { readRange, readWhole } from './range.js';

/** Options of `PotreeSource.open`. */
export interface PotreeOptions {
  /** Used for every request. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Cancels the metadata and hierarchy reads. */
  signal?: AbortSignal;
  /** The reader of 1.x folders of LAS or LAZ nodes. Default: `parseLAS` of `@margoengine/points/las`, loaded when one is met. */
  parseLAS?: typeof parseLAS;
  /** A LAZ decoder for 1.x folders of LAZ nodes. Default: what `parseLAS` loads by itself. */
  laz?: LazDecoder;
  /**
   * How Brotli nodes of 2.0 folders decode. Default: `decodeBrotli` of `@margoengine/decoders/brotli`, loaded when one
   * is met.
   */
  brotli?: (bytes: Uint8Array) => Uint8Array;
  /**
   * Which attributes beyond position and colour `load` gives back in `attributes`, by the names of {@link attributeKey}.
   * Default `['intensity', 'classification']`; `'all'` reads every one the folder has.
   */
  attributes?: readonly string[] | 'all';
  /**
   * What a node is coloured by: `'rgb'`, the file's colours; `'classification'`, `classificationColors`; `'intensity'`,
   * `rampColors` over the range the folder states. Default `'rgb'`.
   */
  colorBy?: 'rgb' | 'classification' | 'intensity';
  /**
   * `'lazy'` reads the first hierarchy page at open and each further page when `load` reaches its node; `'eager'` reads
   * every page at open, for code that walks the whole tree. Default `'lazy'`.
   */
  hierarchy?: 'lazy' | 'eager';
}
/** A node's attributes, as `PotreeSource.load` gives them: one value per point, or `numElements` in a row. */
export type PotreeAttribute =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;
/** What `PotreeSource.load` gives: a node's points, and the attributes asked for. */
export interface PotreeNodeData extends OctreeNodeData {
  attributes?: Record<string, PotreeAttribute>;
}
interface PotreeNode extends OctreeNode {
  children: (PotreeNode | null)[];
  /** The node's name in the format's own digits: 'r' and one child index per level. */
  name: string;
  /** Where its points lie in `octree.bin` (2.0). */
  offset: number;
  bytes: number;
  /** Set while the node's hierarchy page is unread: reads it. */
  page?: (signal?: AbortSignal) => Promise<void>;
  /** A 1.x leaf whose record says 0 points: real PotreeConverter folders write that, and the node's file says how many. */
  unsized?: boolean;
}
/** One attribute of a point record. */
interface Attribute {
  name: string;
  size: number;
  /** A key of `ARRAYS`, and how many of it a point has. */
  type?: string;
  numElements?: number;
}
/** An attribute `load` reads: `at` is its byte offset in a record. */
interface Field {
  key: string;
  at: number;
  type: string;
  count: number;
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
  fields: Field[];
}
/** How a node's data becomes what is drawn, once its points are read. */
type Finish = (data: PotreeNodeData) => PotreeNodeData;
type Fetcher = typeof fetch;
/** What opening a folder finds. */
interface Opened {
  root: PotreeNode;
  version: string;
  points: number;
  origin: readonly [number, number, number];
  fetchNode(node: PotreeNode, signal: AbortSignal): Promise<PotreeNodeData>;
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
  },
  /** The element type and count of each 1.x attribute that has plain values. */
  V1_TYPES: Readonly<Record<string, readonly [string, number]>> = {
    INTENSITY: ['uint16', 1],
    CLASSIFICATION: ['uint8', 1],
    RETURN_NUMBER: ['uint8', 1],
    NUMBER_OF_RETURNS: ['uint8', 1],
    SOURCE_ID: ['uint16', 1],
    GPS_TIME: ['double', 1],
    NORMAL: ['float', 3],
    NORMAL_FLOATS: ['float', 3],
  },
  ARRAYS: Readonly<Record<string, new (length: number) => PotreeAttribute>> = {
    int8: Int8Array,
    uint8: Uint8Array,
    int16: Int16Array,
    uint16: Uint16Array,
    int32: Int32Array,
    uint32: Uint32Array,
    float: Float32Array,
    double: Float64Array,
  };

/** The name an attribute goes by in `attributes`: lower case, words joined by `_`, so 2.0's `gps-time` is 1.x's `GPS_TIME`. */
export const attributeKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

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

/** Drops children with no points and nothing under them, known or still to read. */
function prune(node: PotreeNode): void {
  for (let o = 0; o < 8; o++) {
    const next = node.children[o];
    if (!next) continue;
    prune(next);
    if (!next.count && !next.page && !next.unsized && !next.children.some(Boolean)) node.children[o] = null;
  }
}

/** Reads one chunk of `hierarchy.bin`, the page under `top`; a proxy record leaves its node a page of its own. */
async function readChunk2(
  top: PotreeNode,
  at: number,
  size: number,
  read: (at: number, bytes: number, signal?: AbortSignal) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const chunk = await read(at, size, signal);
  if (!chunk.byteLength || chunk.byteLength % RECORD_BYTES)
    throw new RangeError('Potree hierarchy chunk is not whole records; the file is corrupt');
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    nodes = [top];
  for (let i = 0, o = 0; o < chunk.byteLength; i++, o += RECORD_BYTES) {
    const node = nodes[i];
    if (!node) throw new RangeError('Potree hierarchy chunk holds more records than nodes; the file is corrupt');
    const type = view.getUint8(o),
      mask = view.getUint8(o + 1),
      offset = Number(view.getBigUint64(o + 6, true)),
      bytes = Number(view.getBigUint64(o + 14, true));
    setCount(node, view.getUint32(o + 2, true));
    if (type === 2) {
      node.page = (pageSignal) => readChunk2(node, offset, bytes, read, pageSignal);
      continue;
    }
    if (type > 2) throw new RangeError(`Potree hierarchy holds node type ${type}; the file is corrupt`);
    node.offset = offset;
    node.bytes = bytes;
    for (let index = 0; index < 8; index++) if (mask & (1 << index)) nodes.push(child(node, index));
  }
}

/** Reads one `.hrc` file of 1.x, `step` levels from `top`; a node of its last level with children leaves a page of its own. */
async function readHrc(
  top: PotreeNode,
  step: number,
  read: (node: PotreeNode, signal?: AbortSignal) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const file = await read(top, signal),
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
    if (!mask) {
      node.unsized = !node.count;
      continue;
    }
    // The file's last level only says it has children: they start the next file.
    if (node.level - top.level >= step) node.page = (pageSignal) => readHrc(node, step, read, pageSignal);
    else for (let index = 0; index < 8; index++) if (mask & (1 << index)) queue.push(child(node, index));
  }
  if (i !== queue.length) throw new RangeError('Potree .hrc file is cut short; the file is corrupt');
}

/** Reads a node's page, once, and drops what it shows to be empty. */
async function readPage(node: PotreeNode, signal?: AbortSignal): Promise<void> {
  const { page } = node;
  if (!page) return;
  await page(signal);
  if (node.page === page) node.page = undefined;
  prune(node);
}

/** Reads every page under a node, a level of pages at a time. */
async function readAllPages(root: PotreeNode, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const pending: PotreeNode[] = [],
      stack = [root];
    while (stack.length) {
      const node = stack.pop() as PotreeNode;
      if (node.page) pending.push(node);
      for (const next of node.children) if (next) stack.push(next);
    }
    if (!pending.length) return;
    await Promise.all(pending.map((node) => readPage(node, signal)));
  }
}

const checkNumbers = (values: unknown, count: number, what: string): readonly number[] => {
  if (!Array.isArray(values) || values.length < count || !values.every(Number.isFinite))
    throw new TypeError(`Potree ${what} is missing or not ${count} numbers; the metadata is corrupt`);
  return values;
};

function layoutOf(attributes: readonly Attribute[], scale: Layout['scale'], wanted: Wanted): Layout {
  const out: Layout = { stride: 0, position: -1, color: -1, colorSize: 0, scale, fields: [] };
  for (const { name, size, type, numElements } of attributes) {
    if (name === 'position' || name === 'POSITION_CARTESIAN') out.position = out.stride;
    else if (name === 'rgb' || name === 'rgba' || name === 'COLOR_PACKED' || name === 'RGBA_PACKED') {
      out.color = out.stride;
      out.colorSize = size;
    } else if (type && ARRAYS[type] && wanted(attributeKey(name)))
      out.fields.push({ key: attributeKey(name), at: out.stride, type, count: numElements ?? 1 });
    out.stride += size;
  }
  if (out.position < 0) throw new TypeError('Potree attributes hold no position; the metadata is corrupt');
  return out;
}
type Wanted = (key: string) => boolean;

/** Colours a node by what was asked, and takes the attribute it used from what the caller did not ask for. */
function colorStep(options: PotreeOptions, range?: readonly [number, number]): Finish {
  const by = options.colorBy ?? 'rgb';
  if (by === 'rgb') return (data) => data;
  return (data) => {
    const values = data.attributes?.[by];
    if (!values) return data;
    const colors =
      by === 'classification'
        ? classificationColors(values)
        : rampColors(values, range ? { min: range[0], max: range[1] } : {});
    return { ...data, colors, colorComponents: 4 };
  };
}

/**
 * An `OctreeSource` over a Potree octree folder on any web server: `PotreeSource.open(url)`, then
 * `OctreeCloud.attach(engine, points, source)`. Reads Potree 2.0 (encodings `DEFAULT` and `BROTLI`) and Potree 1.4 to 1.8
 * (binary, LAS or LAZ nodes). The first hierarchy page is read at open, the rest and a node's points when it is shown.
 * Positions and bounds are relative to `origin`, the centre of the cloud's box, so place the cloud there.
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
   * Reads the metadata and the first hierarchy page. `url` is the folder, or its `metadata.json` or `cloud.js`; a folder
   * is taken as 2.0 when it has a `metadata.json`.
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
    const finish = async (opened: Opened) => {
      if (options.hierarchy === 'eager') await readAllPages(opened.root, signal);
      return new PotreeSource(opened);
    };
    if (named?.[1] === 'cloud.js') return finish(await open1(folder, await read('cloud.js'), fetcher, options));
    if (named) return finish(await open2(folder, await read('metadata.json'), fetcher, options));
    const probe = await fetcher(`${folder}metadata.json`, { signal });
    if (!probe.ok) return finish(await open1(folder, await read('cloud.js'), fetcher, options));
    const metadata = json(new Uint8Array(await probe.arrayBuffer()), 'metadata.json');
    return finish(await open2(folder, metadata, fetcher, options));
  }

  /** Reads the hierarchy page under a node, if one is still unread; `node.children` then holds its children. */
  async expand(node: OctreeNode, signal?: AbortSignal): Promise<void> {
    await readPage(node as PotreeNode, signal);
  }

  /** Reads the node's hierarchy page if it has one, then fetches and decodes its points. An empty node gives no points. */
  async load(node: OctreeNode, signal: AbortSignal): Promise<PotreeNodeData> {
    await readPage(node as PotreeNode, signal);
    if (!node.count && !(node as PotreeNode).unsized) return { positions: new Float32Array(0) };
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

const wantedBy = (options: PotreeOptions): Wanted => {
  const list = options.attributes ?? ['intensity', 'classification'],
    by = options.colorBy;
  return (key) => list === 'all' || list.includes(key) || key === by;
};

async function open2(
  folder: string,
  meta: Record<string, unknown>,
  fetcher: Fetcher,
  options: PotreeOptions,
): Promise<Opened> {
  const version = String(meta.version),
    { signal } = options;
  if (!version.startsWith('2.'))
    throw new MargoError('unsupported', `Potree version ${version} in metadata.json; this reader takes 2.x`);
  const encoding = meta.encoding ?? 'DEFAULT';
  if (encoding !== 'DEFAULT' && encoding !== 'BROTLI')
    throw new MargoError('unsupported', `Potree encoding ${String(encoding)} is not read; it takes DEFAULT and BROTLI`);
  const box = meta.boundingBox as { min?: unknown; max?: unknown } | undefined,
    { origin, min, max } = centred(
      checkNumbers(box?.min, 3, 'boundingBox.min'),
      checkNumbers(box?.max, 3, 'boundingBox.max'),
    ),
    scale = checkNumbers(typeof meta.scale === 'number' ? [meta.scale, meta.scale, meta.scale] : meta.scale, 3, 'scale'),
    offset = checkNumbers(meta.offset, 3, 'offset'),
    hierarchy = meta.hierarchy as { firstChunkSize?: unknown } | undefined,
    attributes = meta.attributes as (Attribute & { min?: number[]; max?: number[] })[] | undefined,
    first = hierarchy?.firstChunkSize;
  if (typeof first !== 'number' || !Array.isArray(attributes))
    throw new TypeError('Potree metadata.json has no hierarchy or attributes; pass a Potree 2.0 metadata.json');
  const wanted = wantedBy(options),
    layout = layoutOf(attributes, scale as Layout['scale'], wanted),
    color = attributes.find((a) => a.name === 'rgb' || a.name === 'rgba'),
    // The file states its colour range; 8-bit values stored in 16-bit fields stay as they are.
    wide = color?.max ? Math.max(...color.max) > 255 : undefined,
    root = rootNode(min, max, Number(meta.spacing) || 1),
    shift = [offset[0] - origin[0], offset[1] - origin[1], offset[2] - origin[2]],
    stated = attributes.find((a) => attributeKey(a.name) === 'intensity'),
    finish = colorStep(
      options,
      stated?.min && stated.max && stated.max[0] > stated.min[0] ? [stated.min[0], stated.max[0]] : undefined,
    );
  await readChunk2(
    root,
    0,
    first,
    (at, bytes, pageSignal) => readRange(fetcher, `${folder}hierarchy.bin`, at, bytes, pageSignal ?? signal),
    signal,
  );
  prune(root);
  const opened = { root, version, points: Number(meta.points) || 0, origin };
  if (encoding === 'BROTLI') {
    const inflate = options.brotli ?? (await import('@margoengine/decoders/brotli')).decodeBrotli,
      planes = planesOf(attributes, wanted);
    return {
      ...opened,
      fetchNode: async (node, nodeSignal) => {
        const bytes = await readRange(fetcher, `${folder}octree.bin`, node.offset, node.bytes, nodeSignal);
        return finish(decodePlanes(inflate(bytes), node, planes, layout.scale, shift, wide));
      },
    };
  }
  return {
    ...opened,
    fetchNode: async (node, nodeSignal) => {
      const bytes = await readRange(fetcher, `${folder}octree.bin`, node.offset, node.bytes, nodeSignal);
      return finish(decode(bytes, node, layout, shift, wide));
    },
  };
}

/** Where a 1.4 node of `name` sits: one folder for all. A file list inside `cloud.js` is its hierarchy. */
function readInline(root: PotreeNode, list: unknown[]): void {
  const byName = new Map<string, PotreeNode>([['r', root]]);
  for (const entry of list) {
    const [name, count] = entry as [unknown, unknown];
    if (typeof name !== 'string' || !/^r[0-7]*$/.test(name) || typeof count !== 'number')
      throw new TypeError('Potree cloud.js hierarchy holds an entry that is not a node name and count; it is corrupt');
    if (name === 'r') {
      setCount(root, count);
      continue;
    }
    const parent = byName.get(name.slice(0, -1));
    if (!parent) throw new RangeError(`Potree cloud.js hierarchy lists ${name} before its parent; it is corrupt`);
    const node = child(parent, Number(name.at(-1)));
    setCount(node, count);
    byName.set(name, node);
  }
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
  if (major !== 1 || !(minor >= 4))
    throw new MargoError('unsupported', `Potree version ${version} in cloud.js; this reader takes 1.4 to 1.8 and 2.x`);
  const box = meta.boundingBox as Record<string, number> | undefined,
    { origin, min, max } = centred(
      checkNumbers([box?.lx, box?.ly, box?.lz], 3, 'boundingBox'),
      checkNumbers([box?.ux, box?.uy, box?.uz], 3, 'boundingBox'),
    ),
    inline = Array.isArray(meta.hierarchy) ? (meta.hierarchy as unknown[]) : undefined,
    step = Number(meta.hierarchyStepSize),
    directory = `${folder}${String(meta.octreeDir ?? 'data')}/`,
    fields = meta.pointAttributes,
    scale = Number(meta.scale);
  if ((!inline && !(step >= 1)) || !(scale > 0))
    throw new TypeError('Potree cloud.js has no hierarchy, hierarchyStepSize or scale; it is corrupt');
  const path = (node: PotreeNode) => {
      if (inline) return directory + node.name;
      const digits = node.name.slice(1);
      let out = `${directory}r/`;
      for (let at = 0; at + step <= digits.length; at += step) out += `${digits.slice(at, at + step)}/`;
      return out + node.name;
    },
    root = rootNode(min, max, Number(meta.spacing) || 1),
    finish = colorStep(options);
  if (inline) readInline(root, inline);
  else
    await readHrc(root, step, (node, pageSignal) => readWhole(fetcher, `${path(node)}.hrc`, pageSignal ?? signal), signal);
  prune(root);
  const opened = { root, version, points: Number(meta.points) || 0, origin },
    wanted = wantedBy(options);
  if (fields === 'LAS' || fields === 'LAZ') {
    const compressed = fields === 'LAZ';
    return {
      ...opened,
      fetchNode: async (node, nodeSignal) => {
        const bytes = await readWhole(fetcher, `${path(node)}.${compressed ? 'laz' : 'las'}`, nodeSignal),
          reader = parse ?? (await import('./las.js')).parseLAS,
          las = await reader(bytes, { origin, laz, signal: nodeSignal }),
          attributes: Record<string, PotreeAttribute> = {};
        sized(node, las.positions.length / 3);
        if (wanted('intensity')) attributes.intensity = las.intensity;
        if (wanted('classification')) attributes.classification = las.classification;
        return finish({ positions: las.positions, ...lasColors(las.rgb), attributes });
      },
    };
  }
  if (!Array.isArray(fields)) throw new TypeError('Potree cloud.js has no pointAttributes; it is corrupt');
  const layout = layoutOf(
    fields.map((name: string): Attribute => {
      const size = V1_SIZES[name];
      if (!size) throw new MargoError('unsupported', `Potree point attribute ${name} is not read; convert the folder without it`);
      const [type, numElements] = V1_TYPES[name] ?? [];
      return { name, size, type, numElements };
    }),
    [scale, scale, scale],
    wanted,
  );
  return {
    ...opened,
    fetchNode: async (node, nodeSignal) => {
      const bytes = await readWhole(fetcher, `${path(node)}.bin`, nodeSignal);
      if (node.unsized) sized(node, Math.floor(bytes.byteLength / layout.stride));
      // Positions count from the corner of their node.
      return finish(decode(bytes, node, layout, [node.bounds[0], node.bounds[1], node.bounds[2]], undefined, true));
    },
  };
}

/** Sets the count of a node its record did not size, now its file is read. */
function sized(node: PotreeNode, count: number): void {
  if (!node.unsized) return;
  setCount(node, count);
  node.unsized = false;
}

function lasColors(rgb: ArrayLike<number> | null | undefined): Pick<OctreeNodeData, 'colors' | 'colorComponents'> {
  if (!rgb) return {};
  const colors = new Uint8Array(rgb.length);
  let wide = false;
  for (let i = 0; i < rgb.length && !wide; i++) wide = rgb[i] > 255;
  for (let i = 0; i < rgb.length; i++) colors[i] = wide ? rgb[i] >> 8 : rgb[i];
  return { colors, colorComponents: 3 };
}

/** Reads one attribute of `n` points; `stride` is the bytes from one point's value to the next. */
function readField(view: DataView, n: number, stride: number, field: Field): PotreeAttribute {
  const { at, type, count } = field,
    out = new ARRAYS[type](n * count),
    width = out.BYTES_PER_ELEMENT;
  const get =
    type === 'int8'
      ? (o: number) => view.getInt8(o)
      : type === 'uint8'
        ? (o: number) => view.getUint8(o)
        : type === 'int16'
          ? (o: number) => view.getInt16(o, true)
          : type === 'uint16'
            ? (o: number) => view.getUint16(o, true)
            : type === 'int32'
              ? (o: number) => view.getInt32(o, true)
              : type === 'uint32'
                ? (o: number) => view.getUint32(o, true)
                : type === 'float'
                  ? (o: number) => view.getFloat32(o, true)
                  : (o: number) => view.getFloat64(o, true);
  for (let i = 0; i < n; i++)
    for (let e = 0; e < count; e++) out[i * count + e] = get(at + i * stride + e * width);
  return out;
}

/** Keeps every third bit of 24, so 8 bits of one axis of a Morton code. */
function third(bits: number): number {
  let v = bits & 0x249249;
  v = (v | (v >>> 2)) & 0x0c30c3;
  v = (v | (v >>> 4)) & 0x00f00f;
  return (v | (v >>> 8)) & 0xff;
}
/** One axis, 16 bits, of a 48-bit Morton code held as a low 32 bits and a high word; x is the code's lowest bit. */
function axisOf(low: number, high: number, axis: number): number {
  const lower = low & 0xffffff,
    upper = (low >>> 24) | ((high & 0xffff) << 8);
  return third(lower >>> axis) | (third(upper >>> axis) << 8);
}

/** Where each block of a decoded BROTLI node starts, per point: position 16 bytes, colour 8, the rest their own size. */
interface Planes {
  /** Bytes per point of all blocks. */
  perPoint: number;
  color: number;
  fields: { field: Field; size: number; before: number }[];
}
function planesOf(attributes: readonly Attribute[], wanted: Wanted): Planes {
  const out: Planes = { perPoint: 0, color: -1, fields: [] };
  for (const { name, size, type, numElements } of attributes) {
    const key = attributeKey(name);
    if (name === 'position') out.perPoint += 16;
    else if (name === 'rgb') {
      out.color = out.perPoint;
      out.perPoint += 8;
    } else {
      if (type && ARRAYS[type] && wanted(key))
        out.fields.push({ field: { key, at: 0, type, count: numElements ?? 1 }, size, before: out.perPoint });
      out.perPoint += size;
    }
  }
  return out;
}

/**
 * Decodes a decompressed BROTLI node: a block per attribute, in the order `metadata.json` lists them. Positions come first
 * as two 64-bit Morton codes per point, the high 16 bits of x, y and z then their low 16 bits; colours as one 64-bit
 * Morton code of three 16-bit values. Measured on real folders: every point falls in its node at the file's scale.
 */
function decodePlanes(
  bytes: Uint8Array,
  node: OctreeNode,
  planes: Planes,
  scale: readonly number[],
  shift: readonly number[],
  wideColors: boolean | undefined,
): PotreeNodeData {
  const n = node.count;
  if (bytes.byteLength !== n * planes.perPoint)
    throw new RangeError(`Potree node ${node.id} holds ${bytes.byteLength} bytes for ${n} points; the file is corrupt`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    positions = new Float32Array(n * 3);
  for (let i = 0, o = 0; i < n; i++, o += 16) {
    const a = view.getUint32(o, true),
      b = view.getUint32(o + 4, true),
      c = view.getUint32(o + 8, true),
      d = view.getUint32(o + 12, true);
    for (let axis = 0; axis < 3; axis++) {
      const value = (axisOf(a, b, axis) << 16) | axisOf(c, d, axis);
      positions[i * 3 + axis] = value * scale[axis] + shift[axis];
    }
  }
  const out: PotreeNodeData = { positions };
  if (planes.color >= 0) {
    const colors = new Uint8Array(n * 3),
      wide = new Uint16Array(n * 3),
      start = planes.color * n;
    let large = wideColors;
    for (let i = 0; i < n; i++) {
      const a = view.getUint32(start + i * 8, true),
        b = view.getUint32(start + i * 8 + 4, true);
      for (let c = 0; c < 3; c++) {
        wide[i * 3 + c] = axisOf(a, b, c);
        if (large === undefined && wide[i * 3 + c] > 255) large = true;
      }
    }
    for (let i = 0; i < n * 3; i++) colors[i] = large ? wide[i] >> 8 : wide[i];
    out.colors = colors;
    out.colorComponents = 3;
  }
  if (planes.fields.length) {
    out.attributes = {};
    for (const { field, size, before } of planes.fields)
      out.attributes[field.key] = readField(view, n, size, { ...field, at: before * n });
  }
  return out;
}

/** Decodes interleaved point records. `unsigned` positions are 1.x's, counted from the node's corner. */
function decode(
  bytes: Uint8Array,
  node: OctreeNode,
  layout: Layout,
  shift: readonly number[],
  wideColors: boolean | undefined,
  unsigned = false,
): PotreeNodeData {
  const n = node.count,
    { stride, position, color, colorSize, scale, fields } = layout;
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
  const attributes: Record<string, PotreeAttribute> = {};
  for (const field of fields) attributes[field.key] = readField(view, n, stride, field);
  if (color < 0) return { positions, attributes };
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
  return { positions, colors, colorComponents: 3, attributes };
}

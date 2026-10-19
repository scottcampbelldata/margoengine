// MagicaVoxel .vox read/write, from the published format notes (github.com/ephtracy/voxel-model:
// MagicaVoxel-file-format-vox.txt and MagicaVoxel-file-format-vox-extension.txt), versions 150 and 200.
import type { Vec3 } from '@margoengine/math';
import { VoxelWorld, writeChunkCells } from './world.js';

/** One model of a {@link VoxScene}: a SIZE chunk and the XYZI chunk after it. */
export interface VoxModel {
  /** Size in voxels along MagicaVoxel's x, y and z (z points up), each 1-256. */
  size: Vec3;
  /**
   * The voxels as stored, 4 bytes each: x, y, z (each below `size` on its axis) and a palette index 1-255. Order is
   * kept; parseVox copies them out of the file.
   */
  voxels: Uint8Array;
}

/**
 * A material (MATL chunk): the render properties of one palette colour. Typed fields are decoded from `attributes`;
 * writeVox writes `attributes` with each typed field over its own key (the stored text is kept when it decodes to
 * the same value, a key is added when missing and removed when its field is undefined).
 */
export interface VoxMaterial {
  /** Material id: the palette index (1-255) it describes. */
  id: number;
  /** `_type` without its underscore: `'diffuse'`, `'metal'`, `'glass'`, `'emit'`, `'blend'` or `'media'`. */
  type?: string;
  /** `_weight`, 0-1: how much of `type` (metalness, transparency, emission). */
  weight?: number;
  /** `_rough`: roughness. */
  rough?: number;
  /** `_spec`: specular. */
  spec?: number;
  /** `_ior`: index of refraction. */
  ior?: number;
  /** `_att`: attenuation. */
  att?: number;
  /** `_flux`: emission power. */
  flux?: number;
  /** `_plastic`. */
  plastic?: number;
  /** Every property as stored, in file order: keys with their underscore, string values. Always set by parseVox. */
  attributes?: Map<string, string>;
}

/** A layer (LAYR chunk). Typed fields work as on {@link VoxMaterial}. */
export interface VoxLayer {
  /** Layer id: what transform nodes' `layer` refers to. */
  id: number;
  /** `_name`. */
  name?: string;
  /** `_hidden` (any value but `'0'` is true): pasteVoxModel skips the nodes of a hidden layer. */
  hidden?: boolean;
  /** The layer attributes as stored, in file order. Always set by parseVox. */
  attributes?: Map<string, string>;
}

/**
 * A scene-graph node: a transform (nTRN) places its one child, a group (nGRP) holds transforms, a shape (nSHP) shows
 * a model. MagicaVoxel's root is transform 0 over group 1. Typed fields work as on {@link VoxMaterial}.
 */
export type VoxNode = {
  /** Node id, unique in the scene. */
  id: number;
  /** `_name`. */
  name?: string;
  /** `_hidden` (any value but `'0'` is true): pasteVoxModel skips hidden nodes. */
  hidden?: boolean;
  /** The node attributes as stored, in file order. Always set by parseVox. */
  attributes?: Map<string, string>;
} & (
  | {
      /** A transform node (nTRN). */
      type: 'transform';
      /** Id of the group or shape node it places. */
      child: number;
      /** Id of its {@link VoxLayer}; -1 for none. */
      layer: number;
      /** Its keyframes (at least one); frame 0 is the still pose. */
      frames: {
        /**
         * `_r`: a row-major 3 x 3 signed permutation matrix (9 entries; `p' = R p`), stored as the packed rotation
         * byte. Undefined means identity.
         */
        rotation?: readonly number[];
        /** `_t`: integer translation of the child's centre. Undefined means 0. */
        translation?: Vec3;
        /** `_f`: the animation frame index of this keyframe, from 0. */
        frame?: number;
        /** The frame attributes as stored, in file order. Always set by parseVox. */
        attributes?: Map<string, string>;
      }[];
    }
  | {
      /** A group node (nGRP). */
      type: 'group';
      /** Ids of its transform nodes. */
      children: number[];
    }
  | {
      /** A shape node (nSHP). */
      type: 'shape';
      /** Its models per keyframe (at least one). */
      models: {
        /** Index into {@link VoxScene.models}. */
        model: number;
        /** `_f`: the animation frame index from which this model shows. */
        frame?: number;
        /** The model attributes as stored, in file order. Always set by parseVox. */
        attributes?: Map<string, string>;
      }[];
    }
);

/**
 * A top-level chunk of a {@link VoxScene}, in file order. A chunk writeVox encodes from the scene's typed fields
 * (`PACK`, `SIZE` with its `XYZI`, `nTRN`, `nGRP`, `nSHP`, `LAYR`, `RGBA`, `MATL`) has no bytes: it marks where the
 * next item of that kind goes. Any other chunk (rOBJ, rCAM, NOTE, IMAP, META, MATT, a future one) keeps its bytes.
 */
export interface VoxChunk {
  /** Four-character chunk id, such as `'rOBJ'`. */
  id: string;
  /** Content bytes of a kept chunk. */
  content?: Uint8Array;
  /** Child-chunk bytes of a kept chunk, as stored. */
  children?: Uint8Array;
}

/** A MagicaVoxel `.vox` file: {@link parseVox} returns one and {@link writeVox} writes one. */
export interface VoxScene {
  /** File version: 150 or 200 (MagicaVoxel 0.99.7 and later). */
  version: number;
  /** Models in file order; shape nodes refer to them by index. */
  models: VoxModel[];
  /**
   * 256 RGBA8 colours, 4 bytes per palette index: index i at `4 * i`. Voxels use 1-255; index 0 holds the file's last
   * (unused) colour. The file stores colour k as index k + 1 (the format's off-by-one). MagicaVoxel's default palette
   * when the file has no RGBA chunk.
   */
  palette: Uint8Array;
  /** Materials (MATL chunks) in file order. */
  materials: VoxMaterial[];
  /** Scene-graph nodes in file order; empty in a version-150 file. */
  nodes: VoxNode[];
  /** Layers in file order. */
  layers: VoxLayer[];
  /**
   * Every top-level chunk in file order, so writeVox reproduces the file byte for byte (items added past the last
   * marker of their kind follow it). Omit it for a new scene: models, nodes, layers, palette, then materials.
   */
  chunks?: VoxChunk[];
}

type Kind = 'pack' | 'models' | 'nodes' | 'layers' | 'palette' | 'materials';
const KINDS = new Map<string, Kind>([
  ['PACK', 'pack'],
  ['SIZE', 'models'],
  ['nTRN', 'nodes'],
  ['nGRP', 'nodes'],
  ['nSHP', 'nodes'],
  ['LAYR', 'layers'],
  ['RGBA', 'palette'],
  ['MATL', 'materials'],
]);
const NODE_CHUNKS = { transform: 'nTRN', group: 'nGRP', shape: 'nSHP' } as const;
const EMPTY = new Uint8Array(0);
const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** MagicaVoxel's default palette: index 0 empty, 1-215 a 6-level colour cube without black, then four 10-step ramps. */
const DEFAULT_PALETTE = (() => {
  const p = new Uint8Array(1024),
    steps = [0xff, 0xcc, 0x99, 0x66, 0x33, 0],
    ramp = [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11];
  let i = 1;
  for (const r of steps) for (const g of steps) for (const b of steps) if (r | g | b) p.set([r, g, b, 255], 4 * i++);
  // Red, green, blue, then grey ramps.
  for (const mask of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
  ])
    for (const v of ramp) p.set([v * mask[0], v * mask[1], v * mask[2], 255], 4 * i++);
  return p;
})();

// --- Attribute dictionaries -----------------------------------------------------------------------------------------

/** A typed attribute: `read` decodes stored text (undefined when invalid), `write` validates and encodes a value. */
interface Codec {
  read(text: string): unknown;
  write(value: unknown, what: string): string;
}
type Fields = readonly (readonly [prop: string, key: string, codec: Codec])[];

const isInt32 = (v: unknown): v is number => typeof v === 'number' && (v | 0) === v;
const typed = (what: string, value: unknown, kind: string, range: string): Error =>
  typeof value === kind
    ? new RangeError(`${what} ${String(value)} is invalid; pass ${range}`)
    : new TypeError(`${what} must be a ${kind}; pass ${range}`);
const TEXT: Codec = {
  read: (text) => text,
  write(value, what) {
    if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
    return value;
  },
};
const FLAG: Codec = {
  read: (text) => text !== '0',
  write(value, what) {
    if (typeof value !== 'boolean') throw new TypeError(`${what} must be true or false`);
    return value ? '1' : '0';
  },
};
const NUMBER: Codec = {
  read: (text) => (Number.isFinite(Number(text)) ? Number(text) : undefined),
  write(value, what) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw typed(what, value, 'number', 'a finite number');
    return String(value);
  },
};
const FRAME: Codec = {
  read: (text) => (isInt32(Number(text)) && Number(text) >= 0 ? Number(text) : undefined),
  write(value, what) {
    if (!isInt32(value) || value < 0) throw typed(what, value, 'number', 'an integer frame index from 0');
    return String(value);
  },
};
const TYPE: Codec = {
  read: (text) => (text.startsWith('_') ? text.slice(1) : text),
  write: (value, what) => `_${TEXT.write(value, what)}`,
};
const TRANSLATION: Codec = {
  read(text) {
    const t = text.trim().split(/\s+/).map(Number);
    return t.length === 3 && t.every(isInt32) ? t : undefined;
  },
  write(value, what) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(isInt32))
      throw new RangeError(`${what} must be 3 32-bit integers [x, y, z]`);
    return value.join(' ');
  },
};
// The rotation byte: bits 0-1 the column of row 0's non-zero entry, bits 2-3 row 1's, bits 4-6 the signs of rows 0-2
// (1 = negative). Row 2's column is the one left. Bit 7 is unused.
function rotationOf(byte: number): number[] | undefined {
  const c0 = byte & 3,
    c1 = (byte >> 2) & 3;
  if (c0 > 2 || c1 > 2 || c0 === c1) return undefined;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  m[c0] = byte & 16 ? -1 : 1;
  m[3 + c1] = byte & 32 ? -1 : 1;
  m[6 + 3 - c0 - c1] = byte & 64 ? -1 : 1;
  return m;
}
function rotationByte(value: unknown, what: string): number {
  const m = value as readonly number[],
    columns: number[] = [];
  if (Array.isArray(m) && m.length === 9)
    for (let row = 0; row < 3; row++) {
      const cells = m.slice(3 * row, 3 * row + 3),
        c = cells.findIndex((v) => v === 1 || v === -1);
      if (c < 0 || columns.includes(c) || cells.some((v, i) => i !== c && v !== 0)) break;
      columns.push(c);
    }
  if (columns.length !== 3)
    throw new RangeError(`${what} must be a row-major 3 x 3 signed permutation (each row and column one 1 or -1)`);
  return (
    columns[0] |
    (columns[1] << 2) |
    (m[columns[0]] < 0 ? 16 : 0) |
    (m[3 + columns[1]] < 0 ? 32 : 0) |
    (m[6 + columns[2]] < 0 ? 64 : 0)
  );
}
const ROTATION: Codec = {
  read: (text) =>
    isInt32(Number(text)) && (Number(text) & 255) === Number(text) ? rotationOf(Number(text)) : undefined,
  write: (value, what) => String(rotationByte(value, what)),
};

const NODE_FIELDS: Fields = [
  ['name', '_name', TEXT],
  ['hidden', '_hidden', FLAG],
];
const FRAME_FIELDS: Fields = [
  ['rotation', '_r', ROTATION],
  ['translation', '_t', TRANSLATION],
  ['frame', '_f', FRAME],
];
const SHAPE_MODEL_FIELDS: Fields = [['frame', '_f', FRAME]];
const MATERIAL_FIELDS: Fields = [
  ['type', '_type', TYPE],
  ...(['weight', 'rough', 'spec', 'ior', 'att', 'flux', 'plastic'] as const).map((p) => [p, `_${p}`, NUMBER] as const),
];

// Stored text is UTF-8 (a BOM kept); text that is not is read byte for byte as windows-1252.
// ponytail: such text comes back as UTF-8, so its bytes change on a round trip; keep raw bytes if a writer needs them.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
  legacy = new TextDecoder('windows-1252'),
  encoder = new TextEncoder();
const decodeText = (bytes: Uint8Array): string => {
  // Short ASCII (MagicaVoxel's keys and numbers) skips the decoder.
  if (bytes.length <= 64 && bytes.every((b) => b < 128)) return String.fromCharCode(...bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    return legacy.decode(bytes);
  }
};

// --- Parsing --------------------------------------------------------------------------------------------------------

const bad = (problem: string): RangeError =>
  new RangeError(`Vox file ${problem}; pass a complete .vox file as written by MagicaVoxel or writeVox`);
const quote = (text: string): string => JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);

/**
 * Parses a MagicaVoxel `.vox` file (version 150 or 200). Models, palette, materials, scene graph and layers are
 * decoded; every other chunk is kept as bytes in `chunks`, so {@link writeVox} gives the same bytes back. The result
 * shares no memory with `bytes`.
 * @throws TypeError when `bytes` is not a Uint8Array or ArrayBuffer, or does not start with `VOX ` and a MAIN chunk.
 * @throws RangeError for a truncated, oversized or inconsistent file: a chunk past its parent, trailing bytes, a SIZE
 * outside 1-256 or without its XYZI, a voxel outside its SIZE or with palette index 0, a PACK count that does not
 * match, a duplicate RGBA or PACK, an invalid rotation byte or attribute, or a scene graph with a missing, mistyped,
 * shared or cyclic node reference.
 */
export function parseVox(bytes: Uint8Array | ArrayBuffer): VoxScene {
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!(data instanceof Uint8Array))
    throw new TypeError('parseVox expects the file bytes as a Uint8Array or ArrayBuffer');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    id = (at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
  if (data.length < 20 || id(0) !== 'VOX ' || id(8) !== 'MAIN')
    throw new TypeError('Bytes are not a .vox file (no "VOX " header and MAIN chunk); pass a MagicaVoxel .vox file');
  if (view.getInt32(12, true)) throw bad('MAIN chunk has content bytes');
  if (view.getInt32(16, true) !== data.length - 20)
    throw bad(`MAIN chunk declares ${view.getInt32(16, true)} bytes of chunks but ${data.length - 20} follow`);
  const scene: VoxScene = {
    version: view.getInt32(4, true),
    models: [],
    palette: DEFAULT_PALETTE.slice(),
    materials: [],
    nodes: [],
    layers: [],
    chunks: [],
  };
  const chunks = scene.chunks as VoxChunk[];
  let at = 20,
    pack = -1,
    palette = false,
    // The chunk being read: its id, header offset, content cursor `p` and content end.
    name = '',
    p = 0,
    end = 0;
  const where = () => `chunk ${name} at byte ${at}`,
    // A chunk header at `at`: id, content size and children size, all within the file.
    header = (): [string, number, number] => {
      if (data.length - at < 12) throw bad(`is truncated: a chunk header at byte ${at} needs 12 bytes`);
      const n = view.getInt32(at + 4, true),
        m = view.getInt32(at + 8, true);
      if (n < 0 || m < 0 || n + m > data.length - at - 12)
        throw bad(
          `is truncated: chunk ${quote(id(at))} at byte ${at} declares ${n} + ${m} bytes, ${data.length - at - 12} remain`,
        );
      return [id(at), n, m];
    },
    // Content reads, each bounds checked against `end`.
    need = (count: number) => {
      if (count > end - p) throw bad(`${where()} is truncated at byte ${p}`);
    },
    int = () => {
      need(4);
      p += 4;
      return view.getInt32(p - 4, true);
    },
    count = (min: number, each: number, what: string) => {
      const c = int();
      if (c < min || c > (end - p) / each)
        throw bad(`${where()} has ${c} ${what}, ${c < min ? `fewer than ${min}` : 'more than its bytes hold'}`);
      return c;
    },
    text = () => {
      const length = int();
      if (length < 0) throw bad(`${where()} has a string of ${length} bytes`);
      need(length);
      p += length;
      return decodeText(data.subarray(p - length, p));
    },
    dict = () => {
      const map = new Map<string, string>();
      for (let pairs = count(0, 8, 'attributes'); pairs--; ) {
        const key = text();
        if (map.has(key)) throw bad(`${where()} has attribute ${quote(key)} twice`);
        map.set(key, text());
      }
      return map;
    },
    // Decodes `list`'s typed fields of `attributes` onto `item`.
    fields = <T extends object>(item: T, attributes: Map<string, string>, list: Fields, what: string): T => {
      for (const [prop, key, codec] of list) {
        const raw = attributes.get(key),
          value = raw === undefined ? undefined : codec.read(raw);
        if (raw !== undefined && value === undefined) throw bad(`${what} attribute ${key} ${quote(raw)} is invalid`);
        if (value !== undefined) (item as Record<string, unknown>)[prop] = value;
      }
      return item;
    };
  while (at < data.length) {
    const [chunk, n, m] = header();
    name = chunk;
    p = at + 12;
    end = p + n;
    if (name === 'MAIN' || name === 'XYZI')
      throw bad(
        name === 'MAIN'
          ? `has a second MAIN chunk at byte ${at}`
          : `has an XYZI chunk at byte ${at} without a SIZE before it`,
      );
    if (!KINDS.has(name)) {
      chunks.push({ id: name, content: data.slice(p, end), children: data.slice(end, end + m) });
      at = end + m;
      continue;
    }
    if (m) throw bad(`${where()} has child chunks`);
    if (name === 'PACK') {
      if (pack >= 0) throw bad(`has a second PACK chunk at byte ${at}`);
      pack = int();
      if (pack < 0) throw bad(`${where()} counts ${pack} models`);
    } else if (name === 'SIZE') {
      const size = [int(), int(), int()];
      if (!size.every((s) => s >= 1 && s <= 256))
        throw bad(`${where()} has size ${size.join(' x ')}, not 1-256 per axis`);
      if (p !== end) throw bad(`${where()} has ${end - p} extra bytes`);
      const sizeAt = at;
      at = end;
      const [next, xn, xm] = at < data.length ? header() : ['', 0, 0];
      if (next !== 'XYZI') throw bad(`chunk SIZE at byte ${sizeAt} is not followed by its XYZI chunk`);
      const voxels = xn >= 4 ? view.getInt32(at + 12, true) : -1;
      if (xm || voxels < 0 || xn !== 4 + 4 * voxels)
        throw bad(`chunk XYZI at byte ${at} has ${xn} content bytes, not 4 + 4 per voxel (and no children)`);
      const v = data.slice(at + 16, at + 16 + 4 * voxels);
      for (let i = 0; i < v.length; i += 4)
        if (v[i] >= size[0] || v[i + 1] >= size[1] || v[i + 2] >= size[2] || !v[i + 3])
          throw bad(
            `voxel ${i / 4} of model ${scene.models.length} (${v.subarray(i, i + 4).join(', ')}) is outside ${size.join(' x ')} or has palette index 0`,
          );
      scene.models.push({ size: size as unknown as Vec3, voxels: v });
      name = 'SIZE';
      p = end = at + 12 + xn;
    } else if (name === 'RGBA') {
      if (palette) throw bad(`has a second RGBA chunk at byte ${at}`);
      need(1024);
      palette = true;
      // File colour k is palette index k + 1; the last one lands on index 0.
      for (let k = 0; k < 256; k++) scene.palette.set(data.subarray(p + 4 * k, p + 4 * k + 4), 4 * ((k + 1) & 255));
      p += 1024;
    } else if (name === 'MATL') {
      const material: VoxMaterial = { id: int(), attributes: dict() };
      scene.materials.push(
        fields(material, material.attributes as Map<string, string>, MATERIAL_FIELDS, `material ${material.id}`),
      );
    } else if (name === 'LAYR') {
      const layer: VoxLayer = { id: int(), attributes: dict() };
      int(); // reserved id, -1 (writeVox writes -1)
      scene.layers.push(fields(layer, layer.attributes as Map<string, string>, NODE_FIELDS, `layer ${layer.id}`));
    } else {
      const nodeId = int(),
        attributes = dict();
      let node: VoxNode;
      if (name === 'nTRN') {
        const child = int();
        int(); // reserved id, -1 (writeVox writes -1)
        const layer = int(),
          frames = Array.from({ length: count(1, 4, 'frames') }, (_, f) => {
            const a = dict();
            return fields({ attributes: a }, a, FRAME_FIELDS, `node ${nodeId} frame ${f}`);
          });
        node = { id: nodeId, type: 'transform', child, layer, frames, attributes };
      } else if (name === 'nGRP')
        node = {
          id: nodeId,
          type: 'group',
          children: Array.from({ length: count(0, 4, 'children') }, int),
          attributes,
        };
      else {
        const models = Array.from({ length: count(1, 8, 'models') }, (_, f) => {
          const model = int(),
            a = dict();
          return fields({ model, attributes: a }, a, SHAPE_MODEL_FIELDS, `node ${nodeId} model ${f}`);
        });
        node = { id: nodeId, type: 'shape', models, attributes };
      }
      scene.nodes.push(fields(node, attributes, NODE_FIELDS, `node ${nodeId}`));
    }
    if (p !== end) throw bad(`${where()} has ${end - p} bytes after its content`);
    chunks.push({ id: name });
    at = end;
  }
  if (pack >= 0 && pack !== scene.models.length)
    throw bad(`PACK counts ${pack} models but ${scene.models.length} follow`);
  checkGraph(scene.nodes, scene.models.length, bad);
  return scene;
}

// Scene-graph rules both directions enforce: unique ids, a transform's child is a group or shape, a group's children
// are transforms, a shape's models exist, one parent per node and no cycles (so walks are linear).
function checkGraph(nodes: readonly VoxNode[], models: number, fail: (problem: string) => Error): void {
  const byId = new Map<number, VoxNode>(),
    parents = new Map<number, number>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw fail(`has two nodes with id ${node.id}`);
    byId.set(node.id, node);
  }
  const link = (parent: number, id: number, transform: boolean) => {
    const child = byId.get(id);
    if (!child || (child.type === 'transform') !== transform)
      throw fail(`node ${parent} has child ${id}, which is not a ${transform ? 'transform' : 'group or shape'} node`);
    if (parents.has(id)) throw fail(`node ${id} has two parents, ${parents.get(id)} and ${parent}`);
    parents.set(id, parent);
  };
  for (const node of nodes)
    if (node.type === 'transform') link(node.id, node.child, false);
    else if (node.type === 'group') for (const child of node.children) link(node.id, child, true);
    else
      for (const { model } of node.models)
        if (!(Number.isInteger(model) && model >= 0 && model < models))
          throw fail(`has shape node ${node.id} showing model ${model} of ${models}`);
  // With one parent each, a node is on a cycle exactly when its parent chain never reaches a root.
  const rooted = new Set<number>();
  for (const node of nodes) {
    const chain: number[] = [];
    for (let id: number | undefined = node.id; id !== undefined && !rooted.has(id); id = parents.get(id)) {
      chain.push(id);
      if (chain.length > nodes.length) throw fail(`has node ${node.id} on a cycle of parents`);
    }
    for (const id of chain) rooted.add(id);
  }
}

// --- Writing --------------------------------------------------------------------------------------------------------

/** Little-endian output into one growing buffer. */
class Out {
  bytes = new Uint8Array(4096);
  view = new DataView(this.bytes.buffer);
  at = 0;
  private room(n: number): void {
    if (this.at + n <= this.bytes.length) return;
    if (this.at + n > 0x7fffffff) throw sceneError("is over the format's 2 GiB");
    const grown = new Uint8Array(Math.min(0x7fffffff, Math.max(2 * this.bytes.length, this.at + n)));
    grown.set(this.bytes.subarray(0, this.at));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
  push(bytes: Uint8Array): void {
    this.room(bytes.length);
    this.bytes.set(bytes, this.at);
    this.at += bytes.length;
  }
  int(...values: number[]): void {
    this.room(4 * values.length);
    for (const v of values) {
      this.view.setInt32(this.at, v, true);
      this.at += 4;
    }
  }
  text(value: string): void {
    if (value.length > 64 || /[^\0-\x7f]/.test(value)) {
      const bytes = encoder.encode(value);
      this.int(bytes.length);
      this.push(bytes);
      return;
    }
    // Short ASCII (MagicaVoxel's keys and numbers) skips the encoder.
    this.int(value.length);
    this.room(value.length);
    for (let i = 0; i < value.length; i++) this.bytes[this.at++] = value.charCodeAt(i);
  }
  dict(map: Map<string, string>): void {
    this.int(map.size);
    for (const [key, value] of map) {
      this.text(key);
      this.text(value);
    }
  }
  // Starts chunk `id` and returns where its two sizes go; close() fills them in.
  open(id: string): number {
    this.room(4);
    for (let i = 0; i < 4; i++) this.bytes[this.at++] = id.charCodeAt(i);
    this.int(0, 0);
    return this.at - 8;
  }
  close(sizes: number, children: Uint8Array = EMPTY): void {
    this.view.setInt32(sizes, this.at - sizes - 8, true);
    this.push(children);
    this.view.setInt32(sizes + 4, children.length, true);
  }
}

const sceneError = (problem: string): RangeError => new RangeError(`Vox scene ${problem}; fix the scene first`);
const int32 = (value: unknown, what: string): number => {
  if (!isInt32(value)) throw typed(what, value, 'number', 'a 32-bit integer');
  return value;
};
const list = <T>(value: readonly T[] | undefined, what: string, min = 0): readonly T[] => {
  if (!Array.isArray(value) || value.length < min)
    throw new TypeError(`${what} must be an array${min ? ` of at least ${min}` : ''}`);
  return value;
};
// The attributes to store for `item`: its stored ones in order, each typed field written over its own key.
function attributesOf(item: object, list: Fields, what: string): Map<string, string> {
  if (!item || typeof item !== 'object') throw new TypeError(`${what} must be an object`);
  const from = item as Record<string, unknown>,
    stored = from.attributes;
  if (stored !== undefined && !(stored instanceof Map))
    throw new TypeError(`${what} attributes must be a Map of strings`);
  const out = new Map<string, string>(stored as Map<string, string> | undefined);
  for (const [key, value] of out)
    if (typeof key !== 'string' || typeof value !== 'string') throw new TypeError(`${what} attributes must be strings`);
  for (const [prop, key, codec] of list) {
    const value = from[prop];
    if (value === undefined) {
      out.delete(key);
      continue;
    }
    const text = codec.write(value, `${what} ${prop}`),
      raw = out.get(key),
      old = raw === undefined ? undefined : codec.read(raw);
    if (old === undefined || codec.write(old, '') !== text) out.set(key, text);
  }
  return out;
}
// Validates the shape of user-built nodes, then the graph.
function checkNodes(value: readonly VoxNode[] | undefined, models: number): readonly VoxNode[] {
  const nodes = list(value, 'Vox scene nodes');
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(NODE_CHUNKS, node.type))
      throw new TypeError("Vox scene node type must be 'transform', 'group' or 'shape'");
    const what = `Vox scene node ${int32(node.id, 'Vox scene node id')}`;
    if (node.type === 'transform') {
      int32(node.child, `${what} child`);
      int32(node.layer, `${what} layer`);
      for (const frame of list(node.frames, `${what} frames`, 1))
        if (!frame || typeof frame !== 'object') throw new TypeError(`${what} frames must be objects`);
    } else if (node.type === 'group')
      for (const child of list(node.children, `${what} children`)) int32(child, `${what} child`);
    else
      for (const entry of list(node.models, `${what} models`, 1))
        if (!entry || typeof entry !== 'object') throw new TypeError(`${what} models must be {model} objects`);
  }
  checkGraph(nodes, models, sceneError);
  return nodes;
}
// Validates a model (writeVox and pasteVoxModel rely on voxels inside the size).
function checkModel(model: VoxModel, what: string): void {
  if (!model || typeof model !== 'object') throw new TypeError(`${what} must be {size, voxels}`);
  const { size, voxels } = model;
  if (!Array.isArray(size) || size.length !== 3 || !size.every((s) => (s & 511) === s && s >= 1 && s <= 256))
    throw new RangeError(`${what} size must be 3 integers in 1-256`);
  if (!(voxels instanceof Uint8Array) || voxels.length % 4)
    throw new TypeError(`${what} voxels must be a Uint8Array of [x, y, z, palette index] quadruples`);
  for (let i = 0; i < voxels.length; i += 4)
    if (voxels[i] >= size[0] || voxels[i + 1] >= size[1] || voxels[i + 2] >= size[2] || !voxels[i + 3])
      throw new RangeError(
        `${what} voxel ${i / 4} is outside the size or has palette index 0; keep x, y, z below size and indices 1-255`,
      );
}

/**
 * Writes `scene` as a `.vox` file. A parsed scene gives its file back byte for byte (except non-UTF-8 text and the
 * reserved ids, written as -1); edits land where their chunks were. Anything writeVox writes, parseVox reads.
 * @throws TypeError when a field has the wrong type, or `chunks` gives bytes for a chunk the typed fields encode.
 * @throws RangeError for a value out of range (version, ids, sizes, voxels outside their size, rotations that are not
 * signed permutations, non-integer translations), a scene graph parseVox would reject, or a file over 2 GiB.
 */
export function writeVox(scene: VoxScene): Uint8Array {
  if (!scene || typeof scene !== 'object')
    throw new TypeError('writeVox expects a VoxScene, such as parseVox() returns');
  const version = int32(scene.version, 'Vox scene version'),
    models = list(scene.models, 'Vox scene models'),
    nodes = checkNodes(scene.nodes, models.length),
    layers = list(scene.layers, 'Vox scene layers'),
    materials = list(scene.materials, 'Vox scene materials'),
    order = scene.chunks === undefined ? [] : list(scene.chunks, 'Vox scene chunks');
  checkPalette(scene.palette);
  const out = new Out(),
    next = { models: 0, nodes: 0, layers: 0, materials: 0, palette: 0, pack: 0 },
    counts = {
      models: models.length,
      nodes: nodes.length,
      layers: layers.length,
      materials: materials.length,
      palette: 1,
      pack: 0,
    };
  out.push(ascii('VOX '));
  out.int(version);
  out.push(ascii('MAIN'));
  out.int(0, 0); // MAIN: no content; its children size is filled in last
  const emit = (kind: Kind) => {
    const i = next[kind]++;
    if (kind === 'models') {
      const model = models[i];
      checkModel(model, `Vox scene model ${i}`);
      let sizes = out.open('SIZE');
      out.int(...model.size);
      out.close(sizes);
      sizes = out.open('XYZI');
      out.int(model.voxels.length / 4);
      out.push(model.voxels);
      out.close(sizes);
    } else if (kind === 'nodes') {
      const node = nodes[i],
        what = `Vox scene node ${node.id}`,
        sizes = out.open(NODE_CHUNKS[node.type]);
      out.int(node.id);
      out.dict(attributesOf(node, NODE_FIELDS, what));
      if (node.type === 'transform') {
        out.int(node.child, -1, node.layer, node.frames.length);
        node.frames.forEach((f, k) => out.dict(attributesOf(f, FRAME_FIELDS, `${what} frame ${k}`)));
      } else if (node.type === 'group') {
        out.int(node.children.length);
        for (const child of node.children) out.int(child);
      } else {
        out.int(node.models.length);
        node.models.forEach((m, k) => {
          out.int(m.model);
          out.dict(attributesOf(m, SHAPE_MODEL_FIELDS, `${what} model ${k}`));
        });
      }
      out.close(sizes);
    } else if (kind === 'layers' || kind === 'materials') {
      const item = kind === 'layers' ? layers[i] : materials[i],
        what = `Vox scene ${kind === 'layers' ? 'layer' : 'material'} ${i}`,
        attributes = attributesOf(item, kind === 'layers' ? NODE_FIELDS : MATERIAL_FIELDS, what),
        sizes = out.open(kind === 'layers' ? 'LAYR' : 'MATL');
      out.int(int32(item.id, `${what} id`));
      out.dict(attributes);
      if (kind === 'layers') out.int(-1);
      out.close(sizes);
    } else if (kind === 'palette') {
      const sizes = out.open('RGBA');
      for (let k = 0; k < 256; k++) out.push(scene.palette.subarray(4 * ((k + 1) & 255), 4 * ((k + 1) & 255) + 4));
      out.close(sizes);
    } else {
      const sizes = out.open('PACK');
      out.int(models.length);
      out.close(sizes);
    }
  };
  const last = new Map<Kind, number>();
  order.forEach((chunk, i) => {
    const kind = KINDS.get(chunk?.id);
    if (kind) last.set(kind, i);
  });
  order.forEach((chunk, i) => {
    const kind = KINDS.get(chunk?.id);
    if (!kind) {
      const { id, content = EMPTY, children = EMPTY } = chunk ?? {};
      if (typeof id !== 'string' || id.length !== 4 || /[^\0-\xff]/.test(id) || id === 'MAIN' || id === 'XYZI')
        throw new TypeError(
          `Vox scene chunk ${i} id ${JSON.stringify(id)} must be 4 Latin-1 characters other than MAIN and XYZI`,
        );
      if (!(content instanceof Uint8Array) || !(children instanceof Uint8Array))
        throw new TypeError(`Vox scene chunk ${id} content and children must be Uint8Arrays`);
      const sizes = out.open(id);
      out.push(content);
      out.close(sizes, children);
      return;
    }
    if (chunk.content || chunk.children)
      throw new TypeError(
        `Vox scene chunk ${chunk.id} is written from the scene's fields; drop its content and children`,
      );
    if (kind === 'pack' || kind === 'palette') {
      if (next[kind]) throw sceneError(`chunks list ${chunk.id} twice`);
      emit(kind);
      return;
    }
    if (next[kind] < counts[kind]) emit(kind);
    if (i === last.get(kind)) while (next[kind] < counts[kind]) emit(kind);
  });
  for (const kind of ['models', 'nodes', 'layers', 'palette', 'materials'] as const) {
    if (kind === 'palette' && (next.palette || (scene.chunks && sameBytes(scene.palette, DEFAULT_PALETTE)))) continue;
    while (next[kind] < counts[kind]) emit(kind);
  }
  out.view.setInt32(16, out.at - 20, true);
  return out.bytes.slice(0, out.at);
}

const ascii = (id: string): Uint8Array => Uint8Array.from(id, (c) => c.charCodeAt(0));
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const checkPalette = (palette: unknown): void => {
  if (!(palette instanceof Uint8Array) || palette.length !== 1024)
    throw new TypeError('Vox scene palette must be a Uint8Array of 1024 bytes (256 RGBA colours)');
};

// --- Pasting into a world -------------------------------------------------------------------------------------------

// One placed model: world cell on axis a = base[a] + sign[a] * voxel coordinate source[a].
interface Placement {
  model: VoxModel;
  source: number[];
  sign: number[];
  base: number[];
}
const multiply = (a: readonly number[], b: readonly number[]): number[] =>
  Array.from(
    { length: 9 },
    (_, i) => a[i - (i % 3)] * b[i % 3] + a[i - (i % 3) + 1] * b[3 + (i % 3)] + a[i - (i % 3) + 2] * b[6 + (i % 3)],
  );

// A model under rotation `r` and translation `t` (MagicaVoxel space, z up), as cells of a y-up world.
function place(model: VoxModel, r: readonly number[], t: readonly number[]): Placement {
  const p: Placement = { model, source: [], sign: [], base: [] };
  // MagicaVoxel axis i of cell c: voxel v maps to t + floor(R (v + 0.5 - size / 2)), the model's centre at t. For a
  // signed permutation that is v' - floor(s / 2) per axis, with v' = v or (s - 1 - v) where the row's sign flips it.
  // World x = c0, y = c2 (MagicaVoxel's up), z = -1 - c1: a right-handed y-up frame, so models are not mirrored.
  for (const [row, flip] of [
    [0, false],
    [2, false],
    [1, true],
  ] as const) {
    const column = [0, 1, 2].find((c) => r[3 * row + c] !== 0) ?? 0,
      negative = r[3 * row + column] < 0,
      s = model.size[column],
      offset = t[row] - Math.floor(s / 2) + (negative ? s - 1 : 0);
    p.source.push(column);
    p.sign.push((negative ? -1 : 1) * (flip ? -1 : 1));
    p.base.push(flip ? -1 - offset : offset);
  }
  return p;
}

// Every visible shape of `scene` at frame 0, through its transforms.
function placements(scene: VoxScene): Placement[] {
  const models = list(scene.models, 'Vox scene models'),
    nodes = checkNodes(scene.nodes, models.length);
  models.forEach((m, i) => checkModel(m, `Vox scene model ${i}`));
  if (!nodes.length) return models.length ? [place(models[0], IDENTITY, [0, 0, 0])] : [];
  const byId = new Map(nodes.map((n) => [n.id, n])),
    children = new Set(
      nodes.flatMap((n) => (n.type === 'transform' ? [n.child] : n.type === 'group' ? n.children : [])),
    ),
    hidden = new Set(list(scene.layers, 'Vox scene layers').flatMap((l) => (l?.hidden ? [l.id] : []))),
    out: Placement[] = [],
    stack: [VoxNode, readonly number[], readonly number[]][] = nodes
      .filter((n) => !children.has(n.id))
      .map((n) => [n, IDENTITY, [0, 0, 0]]);
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [node, r, t] = item;
    if (node.hidden) continue;
    if (node.type === 'transform') {
      if (hidden.has(node.layer)) continue;
      const frame = node.frames[0],
        fr = frame.rotation ?? IDENTITY,
        ft = frame.translation ?? [0, 0, 0];
      rotationByte(fr, `Vox scene node ${node.id} rotation`);
      TRANSLATION.write(ft, `Vox scene node ${node.id} translation`);
      const child = byId.get(node.child) as VoxNode,
        moved = [0, 1, 2].map((i) => r[3 * i] * ft[0] + r[3 * i + 1] * ft[1] + r[3 * i + 2] * ft[2] + t[i]);
      stack.push([child, multiply(r, fr), moved]);
    } else if (node.type === 'group')
      for (let k = node.children.length; k--; ) stack.push([byId.get(node.children[k]) as VoxNode, r, t]);
    else out.push(place(models[node.models[0].model], r, t));
  }
  return out;
}

/**
 * Writes voxels into `world` and returns how many cells changed. `model` is a {@link VoxModel}, pasted unrotated, or
 * a whole {@link VoxScene}: every visible shape (hidden nodes and layers skipped) at frame 0 through its transforms,
 * each model centred on its translation (a scene without nodes pastes its first model). MagicaVoxel's z (up) becomes
 * world y and its y becomes world -z, and the pasted box (the models' sizes) has its minimum corner at cell `at`.
 * `mapping[i]` is the block state for palette index i (0 skips those voxels). Without a mapping a scene's colours
 * become block types named `vox:rrggbb` with that colour, defined in `world.blocks` unless already there; a bare model
 * has no palette, so it needs a mapping. Empty cells of a model leave the world as it was. Nothing is written when a
 * check fails. Voxels are written chunk by chunk (each chunk's in file order), with the results of one
 * {@link VoxelWorld.setBlock} per voxel: the same cells, dirty keys and count, and `onChange` once per changed cell
 * right after it is written; only the order across chunks differs.
 * @throws TypeError for a world that is not a VoxelWorld, a bare model without a mapping, or fields of the wrong type.
 * @throws RangeError when `at` is not 3 integers, the pasted box leaves the world's y range or 32-bit x and z, a used
 * mapping entry is not a defined block state, or the model or scene is invalid as for {@link writeVox}.
 */
export function pasteVoxModel(
  world: VoxelWorld,
  model: VoxModel | VoxScene,
  at: Vec3,
  mapping?: ArrayLike<number>,
): number {
  if (!(world instanceof VoxelWorld)) throw new TypeError('pasteVoxModel needs a VoxelWorld to write into');
  if (!Array.isArray(at) || at.length !== 3 || !at.every((v) => typeof v === 'number'))
    throw new TypeError('pasteVoxModel at must be a cell [x, y, z]');
  if (!at.every((v) => isInt32(v)))
    throw new RangeError(`pasteVoxModel at [${at.join(', ')}] must be 3 32-bit integers; floor it`);
  if (!model || typeof model !== 'object') throw new TypeError('pasteVoxModel model must be a VoxModel or a VoxScene');
  const scene = 'models' in model ? model : undefined;
  if (!scene && mapping === undefined)
    throw new TypeError(
      'pasteVoxModel needs a mapping (palette index -> block state) for a bare model; pass one, or pass the scene',
    );
  if (mapping !== undefined && (!mapping || typeof mapping !== 'object' || !Number.isInteger(mapping.length)))
    throw new TypeError('pasteVoxModel mapping must be an array of block states indexed by palette index');
  if (!scene) checkModel(model as VoxModel, 'Vox model');
  else if (mapping === undefined) checkPalette(scene.palette);
  const placed = scene ? placements(scene) : [place(model as VoxModel, IDENTITY, [0, 0, 0])],
    used = new Uint8Array(256),
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const p of placed) {
    for (let i = 3; i < p.model.voxels.length; i += 4) used[p.model.voxels[i]] = 1;
    for (let a = 0; a < 3; a++) {
      const span = p.sign[a] * (p.model.size[p.source[a]] - 1);
      min[a] = Math.min(min[a], p.base[a] + Math.min(0, span));
      max[a] = Math.max(max[a], p.base[a] + Math.max(0, span));
    }
  }
  if (!placed.length) return 0;
  const shift = at.map((v, a) => v - min[a]);
  if (
    !isInt32(max[0] + shift[0]) ||
    !isInt32(max[2] + shift[2]) ||
    max[1] + shift[1] > world.maxY ||
    at[1] < world.minY
  )
    throw new RangeError(
      `Vox paste box [${at.join(', ')}]..[${max.map((v, a) => v + shift[a]).join(', ')}] leaves the world (y ${world.minY}..${world.maxY}); move it`,
    );
  const states = new Uint32Array(256);
  for (let i = 1; i < 256; i++) {
    if (!used[i] || mapping === undefined) continue;
    const s = mapping[i];
    if (s >>> 0 !== s || (s & 0xffff) >= world.blocks.table.length)
      throw new RangeError(
        `pasteVoxModel mapping[${i}] ${s} is not a block state of world.blocks; define the type first`,
      );
    states[i] = s;
  }
  if (mapping === undefined) {
    const palette = (scene as VoxScene).palette,
      names = new Map(world.blocks.table.map((t) => [t.name, t.id]));
    for (let i = 1; i < 256; i++) {
      if (!used[i]) continue;
      const hex = Array.from(palette.subarray(4 * i, 4 * i + 3), (c) => c.toString(16).padStart(2, '0')).join(''),
        name = `vox:${hex}`;
      states[i] = names.get(name) ?? world.blocks.define(name, { color: `#${hex}` });
      names.set(name, states[i]);
    }
  }
  return paste(world, placed, shift, states);
}

// Chunk bounds [cx0, cy0, cz0, cx1, cy1, cz1] of placements moved by `shift`.
function chunkBounds(placed: readonly Placement[], shift: readonly number[]): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of placed)
    for (let a = 0; a < 3; a++) {
      const span = p.sign[a] * (p.model.size[p.source[a]] - 1),
        lo = p.base[a] + shift[a] + Math.min(0, span),
        hi = p.base[a] + shift[a] + Math.max(0, span);
      out[a] = Math.min(out[a], lo >> 5);
      out[a + 3] = Math.max(out[a + 3], hi >> 5);
    }
  return out;
}

// Writes the placed voxels chunk by chunk, each chunk once: setBlock per voxel in file order looks the chunk up again
// whenever the chunk changes and widens a palette one step at a time. A stable counting sort by chunk keeps the voxel
// order within each chunk, so every cell ends as its last voxel says and changes as often as setBlock would make it.
function paste(world: VoxelWorld, placed: readonly Placement[], shift: readonly number[], states: Uint32Array): number {
  const [x0, y0, z0, x1, y1, z1] = chunkBounds(placed, shift),
    nx = x1 - x0 + 1,
    ny = y1 - y0 + 1,
    nz = z1 - z0 + 1,
    grid = nx * ny * nz;
  // Models spread far apart would need a huge chunk grid: paste them one at a time (one model spans <= 9^3 chunks).
  if (placed.length > 1 && grid > placed.reduce((sum, p) => sum + p.model.voxels.length, 0) + 4096) {
    let changed = 0;
    for (const p of placed) changed += paste(world, [p], shift, states);
    return changed;
  }
  // Pass 1 notes each voxel's chunk, local cell and colour and counts the voxels per chunk; pass 2 places each at its
  // chunk's next slot.
  const total = placed.reduce((sum, p) => sum + p.model.voxels.length / 4, 0),
    chunkOf = new Int32Array(total),
    localOf = new Uint16Array(total),
    colorOf = new Uint8Array(total),
    starts = new Uint32Array(grid + 1);
  let k = 0;
  for (const { model, source, sign, base } of placed) {
    const v = model.voxels,
      s0 = source[0],
      s1 = source[1],
      s2 = source[2],
      // 0 or -1 per axis: (v ^ m) - m is v or -v in integer arithmetic (sign * v would make -0, a float).
      g0 = sign[0] < 0 ? -1 : 0,
      g1 = sign[1] < 0 ? -1 : 0,
      g2 = sign[2] < 0 ? -1 : 0,
      bx = base[0] + shift[0],
      by = base[1] + shift[1],
      bz = base[2] + shift[2];
    for (let i = 0; i < v.length; i += 4, k++) {
      const color = v[i + 3];
      if (!states[color]) {
        chunkOf[k] = -1;
        continue;
      }
      const x = bx + ((v[i + s0] ^ g0) - g0),
        y = by + ((v[i + s1] ^ g1) - g1),
        z = bz + ((v[i + s2] ^ g2) - g2),
        chunk = (((x >> 5) - x0) * ny + (y >> 5) - y0) * nz + (z >> 5) - z0;
      chunkOf[k] = chunk;
      localOf[k] = (x & 31) | ((z & 31) << 5) | ((y & 31) << 10);
      colorOf[k] = color;
      starts[chunk + 1]++;
    }
  }
  for (let c = 0; c < grid; c++) starts[c + 1] += starts[c];
  if (!starts[grid]) return 0;
  const cells = new Uint16Array(starts[grid]),
    colors = new Uint8Array(starts[grid]);
  for (let i = 0; i < total; i++) {
    const chunk = chunkOf[i];
    if (chunk < 0) continue;
    const slot = starts[chunk]++;
    cells[slot] = localOf[i];
    colors[slot] = colorOf[i];
  }
  // After pass 2, starts[c] is where chunk c's voxels end, which is where chunk c + 1's begin.
  let changed = 0;
  for (let c = 0, from = 0; c < grid; from = starts[c++]) {
    if (starts[c] === from) continue;
    changed += writeChunkCells(
      world,
      x0 + Math.floor(c / (ny * nz)),
      y0 + (Math.floor(c / nz) % ny),
      z0 + (c % nz),
      cells,
      colors,
      states,
      from,
      starts[c],
    );
  }
  return changed;
}

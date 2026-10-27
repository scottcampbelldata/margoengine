// Implicit tiling (3D Tiles 1.1, "Implicit Tiling"): a quadtree or octree whose tiles are named by level and x, y, z
// and whose availability is stored in subtree files (binary "subt" or JSON), as bitstreams in Morton order.
import { TileBounds, regionBounds } from './bounds.js';

/** `implicitTiling` of a tile in tileset JSON. */
export interface ImplicitTilingJSON {
  subdivisionScheme: 'QUADTREE' | 'OCTREE';
  subtreeLevels: number;
  availableLevels: number;
  subtrees: { uri: string };
}

/** An availability: one constant for every bit, or a bitstream. */
export interface Availability {
  /** Whether bit `index` is set. */
  get(index: number): boolean;
  /** Number of set bits (for tests and statistics). */
  readonly count: number;
}

/** A parsed subtree: tile, content and child-subtree availability. */
export interface Subtree {
  readonly tiles: Availability;
  /** One per content of the tile (3D Tiles 1.1 allows several contents); index 0 is the first. */
  readonly contents: readonly Availability[];
  readonly childSubtrees: Availability;
  /** The subtree's `subtreeMetadata` entity, when present. */
  readonly metadata?: Record<string, unknown>;
}

/** Interleaves the bits of x, y (and z): x in bit 0, y in bit 1, z in bit 2 (the Morton order the specification uses). */
export function mortonIndex(x: number, y: number, z?: number): number {
  let index = 0,
    bit = 1;
  const dims = z === undefined ? 2 : 3;
  for (let i = 0; i < 26; i++) {
    if ((x >> i) & 1) index += bit;
    bit *= 2;
    if ((y >> i) & 1) index += bit;
    bit *= 2;
    if (dims === 3) {
      if ((z! >> i) & 1) index += bit;
      bit *= 2;
    }
    if (x >> i === 0 && y >> i === 0 && (z === undefined || z >> i === 0)) break;
  }
  return index;
}

/** Index of a tile in a subtree's tile availability: the levels above, then the Morton index at its level. */
export function availabilityIndex(localLevel: number, x: number, y: number, z: number | undefined): number {
  const branching = z === undefined ? 4 : 8;
  return (branching ** localLevel - 1) / (branching - 1) + mortonIndex(x, y, z);
}

function constant(value: boolean, length: number): Availability {
  return { get: (i) => value && i >= 0 && i < length, count: value ? length : 0 };
}

function bitstream(bytes: Uint8Array, length: number): Availability {
  if (bytes.byteLength * 8 < length)
    throw new RangeError(
      `Subtree availability has ${bytes.byteLength} bytes for ${length} bits; the subtree file is truncated`,
    );
  let count = 0;
  for (let i = 0; i < length; i++) if ((bytes[i >> 3] >> (i & 7)) & 1) count++;
  return { get: (i) => i >= 0 && i < length && ((bytes[i >> 3] >> (i & 7)) & 1) === 1, count };
}

interface SubtreeJSON {
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset: number; byteLength: number }[];
  tileAvailability?: AvailabilityJSON;
  contentAvailability?: AvailabilityJSON[] | AvailabilityJSON;
  childSubtreeAvailability?: AvailabilityJSON;
  subtreeMetadata?: Record<string, unknown>;
}
interface AvailabilityJSON {
  constant?: number;
  bitstream?: number;
  bufferView?: number;
}

const text = /* @__PURE__ */ new TextDecoder();

/**
 * Parses a subtree file: the binary form (magic "subt", version 1, JSON and binary chunk lengths as uint64) or the
 * JSON form. `external(uri)` resolves buffers that name a `uri`; the binary chunk is buffer 0 when it has no uri.
 */
export async function parseSubtree(
  bytes: Uint8Array,
  scheme: 'QUADTREE' | 'OCTREE',
  subtreeLevels: number,
  external: (uri: string) => Promise<Uint8Array> = () =>
    Promise.reject(new TypeError('External subtree buffers need a fetch')),
): Promise<Subtree> {
  let json: SubtreeJSON, binary: Uint8Array | undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 4 && view.getUint32(0, true) === 0x74627573) {
    if (bytes.byteLength < 24)
      throw new RangeError('Subtree file too short for its 24-byte header; the file is truncated');
    const version = view.getUint32(4, true),
      jsonLength = Number(view.getBigUint64(8, true)),
      binaryLength = Number(view.getBigUint64(16, true));
    if (version !== 1) throw new TypeError(`Unsupported subtree version ${version}; only version 1 is defined`);
    if (24 + jsonLength + binaryLength > bytes.byteLength)
      throw new RangeError(`Subtree chunks (${jsonLength} + ${binaryLength} bytes) run past the file; it is truncated`);
    json = parseJSON(bytes.subarray(24, 24 + jsonLength));
    binary = bytes.subarray(24 + jsonLength, 24 + jsonLength + binaryLength);
  } else json = parseJSON(bytes);
  const buffers: Uint8Array[] = [];
  for (const [i, buffer] of (json.buffers ?? []).entries()) {
    if (!buffer || typeof buffer.byteLength !== 'number') throw new TypeError(`Subtree buffer ${i} needs a byteLength`);
    const data = buffer.uri !== undefined ? await external(buffer.uri) : binary;
    if (!data)
      throw new TypeError(`Subtree buffer ${i} has no uri and the file has no binary chunk; the subtree is corrupt`);
    if (data.byteLength < buffer.byteLength)
      throw new RangeError(`Subtree buffer ${i} is shorter than its byteLength; it is truncated`);
    buffers.push(data);
  }
  const branching = scheme === 'QUADTREE' ? 4 : 8,
    tileBits = (branching ** subtreeLevels - 1) / (branching - 1),
    childBits = branching ** subtreeLevels;
  const read = (a: AvailabilityJSON | undefined, length: number, what: string): Availability => {
    if (!a || typeof a !== 'object') throw new TypeError(`Subtree has no ${what}; the subtree is corrupt`);
    if (a.constant !== undefined) return constant(a.constant === 1, length);
    const index = a.bitstream ?? a.bufferView;
    const bufferView = index === undefined ? undefined : json.bufferViews?.[index];
    if (!bufferView) throw new TypeError(`Subtree ${what} names a missing bufferView; the subtree is corrupt`);
    const buffer = buffers[bufferView.buffer];
    if (!buffer || bufferView.byteOffset < 0 || bufferView.byteOffset + bufferView.byteLength > buffer.byteLength)
      throw new RangeError(`Subtree ${what} bufferView runs past its buffer; the subtree is truncated or corrupt`);
    return bitstream(buffer.subarray(bufferView.byteOffset, bufferView.byteOffset + bufferView.byteLength), length);
  };
  const contents =
    json.contentAvailability === undefined
      ? []
      : Array.isArray(json.contentAvailability)
        ? json.contentAvailability
        : [json.contentAvailability];
  return {
    tiles: read(json.tileAvailability, tileBits, 'tileAvailability'),
    contents: contents.map((c, i) => read(c, tileBits, `contentAvailability[${i}]`)),
    childSubtrees: read(json.childSubtreeAvailability, childBits, 'childSubtreeAvailability'),
    metadata: json.subtreeMetadata,
  };
}

function parseJSON(bytes: Uint8Array): SubtreeJSON {
  try {
    const value = JSON.parse(text.decode(bytes).replace(/[\0\s]+$/, ''));
    if (value && typeof value === 'object') return value;
  } catch {
    // Reported below with the fix.
  }
  throw new TypeError('Invalid subtree JSON; the subtree file is corrupt');
}

/** Replaces `{level}`, `{x}`, `{y}` and `{z}` in an implicit tiling template URI. */
export function expandTemplate(template: string, level: number, x: number, y: number, z = 0): string {
  return template.replace(/\{(level|x|y|z)\}/g, (_, key: string) =>
    String(key === 'level' ? level : key === 'x' ? x : key === 'y' ? y : z),
  );
}

/**
 * The bounding volume of implicit tile (level, x, y, z) inside the root volume: boxes split their first two half-axes
 * (and the third for octrees) in halves per level; regions split longitude and latitude (and height for octrees).
 */
export function implicitBounds(
  root: TileBounds,
  scheme: 'QUADTREE' | 'OCTREE',
  level: number,
  x: number,
  y: number,
  z = 0,
): TileBounds {
  const n = 2 ** level;
  if (root.region) {
    const [west, south, east, north, minH, maxH] = root.region;
    const dLon = (east - west) / n,
      dLat = (north - south) / n,
      dH = scheme === 'OCTREE' ? (maxH - minH) / n : maxH - minH,
      h0 = scheme === 'OCTREE' ? minH + dH * z : minH;
    return regionBounds([
      west + dLon * x,
      south + dLat * y,
      west + dLon * (x + 1),
      south + dLat * (y + 1),
      h0,
      h0 + dH,
    ]);
  }
  const c = root.center,
    h = root.halfAxes,
    fx = (2 * x + 1) / n - 1,
    fy = (2 * y + 1) / n - 1,
    fz = scheme === 'OCTREE' ? (2 * z + 1) / n - 1 : 0,
    sz = scheme === 'OCTREE' ? 1 / n : 1;
  return new TileBounds(
    [0, 1, 2].map((k) => c[k] + h[k] * fx + h[3 + k] * fy + h[6 + k] * fz),
    [h[0] / n, h[1] / n, h[2] / n, h[3] / n, h[4] / n, h[5] / n, h[6] * sz, h[7] * sz, h[8] * sz],
  );
}

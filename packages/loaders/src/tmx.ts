import { LoaderError, type AssetResolver, type LoadedGeometry, type LoadedGroup } from './types.js';
import { resolvePath, throwIfAborted, toBytes, type BinaryInput } from './util.js';
import { decodeXML, readXMLTree, type XMLElement } from './xml.js';
import { inflate } from './zip.js';

const F = 'TMX';
/** Cells per tile layer (4096 x 4096). */
const MAX_TILES = 1 << 24;
const GID = 0x0fffffff;

/** Custom properties by name, in a null-prototype object: `int` and `float` become numbers, `bool` booleans. */
export type TMXProperties = Record<string, string | number | boolean>;

/** A tileset. Tilesets whose atlas image and grid are the same are merged into one. */
export interface TMXTileset {
  name?: string;
  /** TSX path relative to the TMX folder, for an external tileset. */
  source?: string;
  tilewidth: number;
  tileheight: number;
  spacing: number;
  margin: number;
  /** Tiles per atlas row, from the file or computed from the image width. */
  columns: number;
  tilecount: number;
  /** The atlas: path relative to the TMX folder (for the resolver) and size in pixels. Absent for image collections. */
  image?: { path: string; width: number; height: number };
  properties: TMXProperties;
}

/** Where a tileset's global tile ids start. A gid belongs to the reference with the largest `firstgid` <= gid. */
export interface TMXTilesetRef {
  firstgid: number;
  /** Index into `LoadedTMX.tilesets`. */
  tileset: number;
}

/** Fields every layer has. Group layers are flattened: these already include the enclosing groups. */
export interface TMXLayerCommon {
  id?: number;
  name: string;
  visible: boolean;
  opacity: number;
  /** Pixel offset. */
  offsetx: number;
  offsety: number;
  properties: TMXProperties;
}

/** A tile layer as a dense grid of cells, row by row. */
export interface TMXTileLayer extends TMXLayerCommon {
  type: 'tile';
  /** Cell of the grid's top-left corner: 0 for fixed maps, the smallest chunk position for infinite ones. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Global tile id per cell with the flip bits cleared; 0 is empty. */
  gids: Uint32Array;
  /** Flip bits per cell: 1 horizontal, 2 vertical, 4 diagonal (applied first, as in Tiled). */
  flips: Uint8Array;
}

/** An object of an object layer, in pixels. */
export interface TMXObject {
  id?: number;
  name: string;
  /** `type` (or `class` in Tiled 1.9+). */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  /** Tile objects: global tile id with the flip bits cleared, and the flip bits as in `TMXTileLayer.flips`. */
  gid?: number;
  flips?: number;
  properties: TMXProperties;
}

/** An object layer (`<objectgroup>`). */
export interface TMXObjectLayer extends TMXLayerCommon {
  type: 'object';
  objects: TMXObject[];
}

/** A tile or object layer. */
export type TMXLayer = TMXTileLayer | TMXObjectLayer;

/** A parsed Tiled map. */
export interface LoadedTMX {
  orientation: 'orthogonal';
  renderorder: string;
  /** Size in tiles (for infinite maps, as saved). */
  width: number;
  height: number;
  /** Grid cell size in pixels. */
  tilewidth: number;
  tileheight: number;
  infinite: boolean;
  tilesets: TMXTileset[];
  /** Sorted by `firstgid`. */
  tilesetRefs: TMXTilesetRef[];
  /** Tile and object layers in drawing order, groups flattened. */
  layers: TMXLayer[];
  properties: TMXProperties;
  /** What was skipped: image layers, image-collection tilesets. */
  warnings: string[];
}

/** Options of `parseTMX`. */
export interface TMXParseOptions {
  /** Reads external tilesets (`<tileset source>`), given their path relative to the TMX folder. */
  resolve?: AssetResolver;
  signal?: AbortSignal;
}

const kid = (e: XMLElement | undefined, name: string): XMLElement | undefined =>
  e?.children.find((c) => c.name === name);
const kids = (e: XMLElement | undefined, name: string): XMLElement[] =>
  e?.children.filter((c) => c.name === name) ?? [];
const text = (input: Uint8Array | string): string => (typeof input === 'string' ? input : decodeXML(input));

function number(value: string | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || value.trim() === '')
    throw new LoaderError(F, 'syntax', `${what} must be a number, got "${value.slice(0, 32)}"`);
  return result;
}

function integer(value: string | undefined, fallback: number, what: string, min = 0): number {
  const result = number(value, fallback, what);
  if (!Number.isSafeInteger(result) || result < min)
    throw new LoaderError(F, 'syntax', `${what} must be an integer of at least ${min}, got "${value}"`);
  return result;
}

const flipsOf = (gid: number): number => (gid >>> 31) | (((gid >>> 30) & 1) << 1) | (((gid >>> 29) & 1) << 2);

function readProperties(e: XMLElement): TMXProperties {
  const properties: TMXProperties = Object.create(null);
  for (const p of kids(kid(e, 'properties'), 'property')) {
    const name = p.attributes.name;
    if (name === undefined) continue;
    const raw = p.attributes.value ?? p.text,
      type = p.attributes.type;
    properties[name] =
      type === 'int' || type === 'float'
        ? number(raw, 0, `property "${name}"`)
        : type === 'bool'
          ? raw === 'true'
          : raw;
  }
  return properties;
}

function readTileset(e: XMLElement, from: string): TMXTileset {
  const a = e.attributes,
    what = `tileset "${a.name ?? ''}"`;
  const tileset: TMXTileset = {
    tilewidth: integer(a.tilewidth, 0, `${what} tilewidth`, 1),
    tileheight: integer(a.tileheight, 0, `${what} tileheight`, 1),
    spacing: integer(a.spacing, 0, `${what} spacing`),
    margin: integer(a.margin, 0, `${what} margin`),
    columns: 0,
    tilecount: 0,
    properties: readProperties(e),
  };
  if (a.name !== undefined) tileset.name = a.name;
  const image = kid(e, 'image');
  if (image?.attributes.source !== undefined)
    tileset.image = {
      path: resolvePath(from, image.attributes.source),
      width: integer(image.attributes.width, 0, `${what} image width`),
      height: integer(image.attributes.height, 0, `${what} image height`),
    };
  const { tilewidth, tileheight, spacing, margin } = tileset,
    fit = (size: number, tile: number): number =>
      Math.max(0, Math.floor((size - 2 * margin + spacing) / (tile + spacing)));
  tileset.columns = integer(a.columns, tileset.image ? fit(tileset.image.width, tilewidth) : 0, `${what} columns`);
  tileset.tilecount = integer(
    a.tilecount,
    tileset.image ? tileset.columns * fit(tileset.image.height, tileheight) : 0,
    `${what} tilecount`,
  );
  return tileset;
}

function base64(value: string, what: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value.replace(/\s+/g, ''));
  } catch {
    throw new LoaderError(F, 'syntax', `${what} is not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes a `<data>` or `<chunk>` of `count` cells into raw gids (flip bits included). */
async function decodeCells(
  e: XMLElement,
  encoding: string | undefined,
  compression: string | undefined,
  count: number,
  what: string,
  signal: AbortSignal | undefined,
): Promise<Uint32Array> {
  const cells = new Uint32Array(count);
  if (encoding === 'csv') {
    const values = e.text.split(/[\s,]+/).filter(Boolean);
    if (values.length !== count)
      throw new LoaderError(F, 'syntax', `${what} has ${values.length} csv values, expected ${count}`);
    for (let i = 0; i < count; i++) {
      const gid = Number(values[i]);
      if (!Number.isInteger(gid) || gid < 0 || gid > 0xffffffff)
        throw new LoaderError(F, 'syntax', `${what} has the invalid gid "${values[i].slice(0, 16)}"`);
      cells[i] = gid;
    }
  } else if (encoding === 'base64') {
    let bytes = base64(e.text, what);
    if (compression)
      bytes = await inflate(bytes, count * 4, what, signal, compression === 'zlib' ? 'deflate' : 'gzip', F);
    if (bytes.length !== count * 4)
      throw new LoaderError(F, 'syntax', `${what} holds ${bytes.length} bytes, expected ${count * 4}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) cells[i] = view.getUint32(i * 4, true);
  } else if (encoding === undefined) {
    const tiles = kids(e, 'tile');
    if (tiles.length !== count)
      throw new LoaderError(F, 'syntax', `${what} has ${tiles.length} <tile>s, expected ${count}`);
    for (let i = 0; i < count; i++) {
      const gid = number(tiles[i].attributes.gid, 0, `${what} tile gid`);
      if (!Number.isInteger(gid) || gid < 0 || gid > 0xffffffff)
        throw new LoaderError(F, 'syntax', `${what} has the invalid gid "${tiles[i].attributes.gid}"`);
      cells[i] = gid;
    }
  } else throw new LoaderError(F, 'unsupported', `${what} uses the unknown encoding "${encoding.slice(0, 16)}"`);
  return cells;
}

async function readTileLayer(
  e: XMLElement,
  common: TMXLayerCommon,
  map: { width: number; height: number; infinite: boolean },
  signal: AbortSignal | undefined,
): Promise<TMXTileLayer> {
  const what = `layer "${common.name}"`,
    data = kid(e, 'data');
  if (!data) throw new LoaderError(F, 'syntax', `${what} has no <data>`);
  const { encoding, compression } = data.attributes;
  if (compression === 'zstd')
    throw new LoaderError(
      F,
      'unsupported',
      `${what} uses zstd compression; save the map with zlib, gzip or no compression`,
    );
  if (compression !== undefined && compression !== 'zlib' && compression !== 'gzip')
    throw new LoaderError(F, 'unsupported', `${what} uses the unknown compression "${compression.slice(0, 16)}"`);
  const chunks = kids(data, 'chunk').map((c) => ({
    element: c,
    x: integer(c.attributes.x, 0, `${what} chunk x`, -Number.MAX_SAFE_INTEGER),
    y: integer(c.attributes.y, 0, `${what} chunk y`, -Number.MAX_SAFE_INTEGER),
    width: integer(c.attributes.width, 0, `${what} chunk width`),
    height: integer(c.attributes.height, 0, `${what} chunk height`),
  }));
  let x = 0,
    y = 0,
    width = integer(e.attributes.width, map.width, `${what} width`),
    height = integer(e.attributes.height, map.height, `${what} height`);
  if (map.infinite && !chunks.length) width = height = 0;
  else if (chunks.length) {
    // reduce, not Math.min(...spread): a large map has more chunks than a call takes arguments.
    x = chunks.reduce((m, c) => Math.min(m, c.x), Infinity);
    y = chunks.reduce((m, c) => Math.min(m, c.y), Infinity);
    width = chunks.reduce((m, c) => Math.max(m, c.x + c.width), -Infinity) - x;
    height = chunks.reduce((m, c) => Math.max(m, c.y + c.height), -Infinity) - y;
  }
  if (width * height > MAX_TILES)
    throw new LoaderError(F, 'limit', `${what} spans ${width} x ${height} cells, more than the limit of ${MAX_TILES}`);
  let raw: Uint32Array;
  if (!width || !height) raw = new Uint32Array(0);
  else if (!chunks.length) raw = await decodeCells(data, encoding, compression, width * height, `${what} data`, signal);
  else {
    raw = new Uint32Array(width * height);
    for (const c of chunks) {
      const cells = await decodeCells(
        c.element,
        encoding,
        compression,
        c.width * c.height,
        `${what} chunk ${c.x},${c.y}`,
        signal,
      );
      for (let row = 0; row < c.height; row++)
        raw.set(cells.subarray(row * c.width, (row + 1) * c.width), (c.y - y + row) * width + (c.x - x));
    }
  }
  const gids = new Uint32Array(raw.length),
    flips = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    gids[i] = raw[i] & GID;
    flips[i] = flipsOf(raw[i]);
  }
  return { type: 'tile', ...common, x, y, width, height, gids, flips };
}

function readObject(e: XMLElement): TMXObject {
  const a = e.attributes,
    what = `object ${a.id ?? a.name ?? ''}`;
  const object: TMXObject = {
    name: a.name ?? '',
    type: a.type ?? a.class ?? '',
    x: number(a.x, 0, `${what} x`),
    y: number(a.y, 0, `${what} y`),
    width: number(a.width, 0, `${what} width`),
    height: number(a.height, 0, `${what} height`),
    rotation: number(a.rotation, 0, `${what} rotation`),
    visible: a.visible !== '0',
    properties: readProperties(e),
  };
  if (a.id !== undefined) object.id = integer(a.id, 0, `${what} id`);
  if (a.gid !== undefined) {
    const gid = integer(a.gid, 0, `${what} gid`);
    if (gid > 0xffffffff) throw new LoaderError(F, 'syntax', `${what} gid ${gid} is not a 32-bit id`);
    object.gid = gid & GID;
    object.flips = flipsOf(gid);
  }
  return object;
}

/**
 * Parses a Tiled TMX map (orthogonal; other orientations throw `unsupported`): map attributes, embedded and external
 * (TSX, through `resolve`) tilesets merged when their image and grid match, tile layers in csv, base64 (plain, zlib or
 * gzip; zstd throws `unsupported`) or legacy `<tile>` data and infinite-map chunks, GID flip bits split into `flips`,
 * object layers, custom properties, and group layers flattened with their offsets, visibility and opacity combined.
 * Turn a tile layer into geometry with `tmxLayerQuads`.
 */
export async function parseTMX(input: BinaryInput | string, options: TMXParseOptions = {}): Promise<LoadedTMX> {
  const { resolve, signal } = options;
  throwIfAborted(signal, F);
  if (resolve !== undefined && typeof resolve !== 'function')
    throw new TypeError('TMX resolve option is not a function; pass (path) => Promise<Uint8Array | string>');
  const root = readXMLTree(typeof input === 'string' ? input : decodeXML(toBytes(input, F)), F).children[0];
  if (root?.name !== 'map') throw new LoaderError(F, 'header', `root element is <${root?.name ?? ''}>, not <map>`);
  const a = root.attributes,
    orientation = a.orientation ?? 'orthogonal';
  if (orientation !== 'orthogonal')
    throw new LoaderError(F, 'unsupported', `${orientation.slice(0, 16)} maps are not supported; only orthogonal ones`);
  const map: LoadedTMX = {
    orientation,
    renderorder: a.renderorder ?? 'right-down',
    width: integer(a.width, 0, 'map width'),
    height: integer(a.height, 0, 'map height'),
    tilewidth: integer(a.tilewidth, 0, 'map tilewidth', 1),
    tileheight: integer(a.tileheight, 0, 'map tileheight', 1),
    infinite: a.infinite === '1',
    tilesets: [],
    tilesetRefs: [],
    layers: [],
    properties: readProperties(root),
    warnings: [],
  };
  const sources = new Map<string, XMLElement>(),
    merged = new Map<string, number>();
  for (const e of kids(root, 'tileset')) {
    const firstgid = integer(e.attributes.firstgid, 0, 'tileset firstgid', 1);
    let element = e,
      source: string | undefined;
    if (e.attributes.source !== undefined) {
      source = resolvePath('', e.attributes.source);
      let tsx = sources.get(source);
      if (!tsx) {
        if (!resolve)
          throw new LoaderError(F, 'fetch', `tileset "${source}" is external; pass resolve(path) to read it`);
        let content: Uint8Array | string;
        try {
          content = await resolve(source);
        } catch (error) {
          throwIfAborted(signal, F);
          throw new LoaderError(
            F,
            'fetch',
            `tileset "${source}" could not be read (${(error as Error)?.message ?? error})`,
          );
        }
        throwIfAborted(signal, F);
        tsx = readXMLTree(text(content), 'TSX').children[0];
        if (tsx?.name !== 'tileset')
          throw new LoaderError(F, 'header', `tileset "${source}" root element is <${tsx?.name ?? ''}>, not <tileset>`);
        sources.set(source, tsx);
      }
      element = tsx;
    }
    const tileset = readTileset(element, source ?? '');
    if (source !== undefined) tileset.source = source;
    if (!tileset.image)
      map.warnings.push(
        `tileset "${tileset.name ?? source ?? firstgid}" has no atlas image (image collections are not imported)`,
      );
    const key = tileset.image
      ? [tileset.image.path, tileset.tilewidth, tileset.tileheight, tileset.spacing, tileset.margin].join('|')
      : undefined;
    let index = key === undefined ? undefined : merged.get(key);
    if (index === undefined) {
      index = map.tilesets.push(tileset) - 1;
      if (key !== undefined) merged.set(key, index);
    }
    map.tilesetRefs.push({ firstgid, tileset: index });
  }
  map.tilesetRefs.sort((p, q) => p.firstgid - q.firstgid);
  const walk = async (parent: XMLElement, outer: Omit<TMXLayerCommon, 'name' | 'properties'>): Promise<void> => {
    for (const e of parent.children) {
      if (e.name !== 'layer' && e.name !== 'objectgroup' && e.name !== 'group' && e.name !== 'imagelayer') continue;
      const b = e.attributes,
        name = b.name ?? '',
        inherited = {
          visible: outer.visible && b.visible !== '0',
          opacity: outer.opacity * number(b.opacity, 1, `layer "${name}" opacity`),
          offsetx: outer.offsetx + number(b.offsetx, 0, `layer "${name}" offsetx`),
          offsety: outer.offsety + number(b.offsety, 0, `layer "${name}" offsety`),
        };
      if (e.name === 'group') {
        await walk(e, inherited);
        continue;
      }
      if (e.name === 'imagelayer') {
        map.warnings.push(`image layer "${name}" is not imported`);
        continue;
      }
      const common: TMXLayerCommon = { name, ...inherited, properties: readProperties(e) };
      if (b.id !== undefined) common.id = integer(b.id, 0, `layer "${name}" id`);
      map.layers.push(
        e.name === 'layer'
          ? await readTileLayer(e, common, map, signal)
          : { type: 'object', ...common, objects: kids(e, 'object').map(readObject) },
      );
    }
  };
  await walk(root, { visible: true, opacity: 1, offsetx: 0, offsety: 0 });
  return map;
}

/** Options of `tmxLayerQuads`. */
export interface TileQuadsOptions {
  /** World size of one map cell along X and Z. Default 1. */
  tileSize?: number;
}

/** A tileset's quads of one tile layer. */
export interface TileQuadsGroup extends LoadedGroup {
  /** Index into `LoadedTMX.tilesets`. */
  tileset: number;
}

/**
 * One quad per non-empty cell of a tile layer: four vertices each (top-left, bottom-left, bottom-right, top-right as
 * seen from +Y), triangles (0, 1, 2) and (0, 2, 3), so `faceSizes` is all 4.
 */
export interface TileQuads extends LoadedGeometry {
  kind: 'mesh';
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  faceSizes: Uint32Array;
  /** One group per tileset, in tileset order. */
  groups: TileQuadsGroup[];
  /** Layer cell (row * width + column) of each quad. */
  cells: Uint32Array;
}

/**
 * Turns a tile layer into quads on the XZ plane, facing +Y: map column x runs along +X and row y along +Z, one cell
 * `tileSize` wide, layer pixel offsets scaled by the map's tile size. Tiles larger than a cell grow from its
 * bottom-left corner, as Tiled draws them. UVs (Margo's convention, v = 0 at the top of the image) cover each tile's
 * atlas rectangle, honoring spacing and margin, with the diagonal, horizontal and vertical flips applied in Tiled's
 * order.
 */
export function tmxLayerQuads(map: LoadedTMX, layer: TMXTileLayer, options: TileQuadsOptions = {}): TileQuads {
  const size = options.tileSize ?? 1;
  if (!(size > 0) || !Number.isFinite(size)) throw new RangeError(`tileSize must be a positive number, got ${size}`);
  if (!layer || layer.type !== 'tile' || layer.gids.length !== layer.width * layer.height)
    throw new TypeError('tmxLayerQuads needs a tile layer from parseTMX; pass map.layers[i] with type "tile"');
  const refs = map.tilesetRefs,
    owner = new Uint32Array(layer.gids.length),
    counts = new Uint32Array(map.tilesets.length);
  let quads = 0;
  for (let cell = 0; cell < layer.gids.length; cell++) {
    const gid = layer.gids[cell];
    if (!gid) continue;
    let r = refs.length - 1;
    while (r >= 0 && refs[r].firstgid > gid) r--;
    if (r < 0) throw new LoaderError(F, 'range', `layer "${layer.name}" gid ${gid} belongs to no tileset`);
    const tileset = map.tilesets[refs[r].tileset];
    if (!tileset.image?.width || !tileset.image.height || !tileset.columns)
      throw new LoaderError(
        F,
        'unsupported',
        `tileset "${tileset.name ?? ''}" has no atlas image size; save it with Tiled 1.0 or later`,
      );
    if (gid - refs[r].firstgid >= tileset.tilecount)
      throw new LoaderError(
        F,
        'range',
        `layer "${layer.name}" gid ${gid} is past the end of tileset "${tileset.name ?? ''}"`,
      );
    owner[cell] = r;
    counts[refs[r].tileset]++;
    quads++;
  }
  const positions = new Float32Array(quads * 12),
    normals = new Float32Array(quads * 12),
    uvs = new Float32Array(quads * 8),
    indices = new Uint32Array(quads * 6),
    cells = new Uint32Array(quads),
    groups: TileQuadsGroup[] = [],
    next = new Uint32Array(map.tilesets.length);
  for (let t = 0, start = 0; t < counts.length; start += counts[t++]) {
    next[t] = start;
    if (counts[t]) {
      const group: TileQuadsGroup = { start: start * 6, count: counts[t] * 6, tileset: t };
      if (map.tilesets[t].name !== undefined) group.name = map.tilesets[t].name;
      groups.push(group);
    }
  }
  const ox = (layer.offsetx / map.tilewidth) * size,
    oz = (layer.offsety / map.tileheight) * size;
  // Corner order TL, BL, BR, TR as (sx, sy) inside the tile, sy down.
  const corners = [0, 0, 0, 1, 1, 1, 1, 0];
  for (let cell = 0; cell < layer.gids.length; cell++) {
    const gid = layer.gids[cell];
    if (!gid) continue;
    const ref = refs[owner[cell]],
      tileset = map.tilesets[ref.tileset],
      image = tileset.image as NonNullable<TMXTileset['image']>,
      q = next[ref.tileset]++,
      local = gid - ref.firstgid,
      px = tileset.margin + (local % tileset.columns) * (tileset.tilewidth + tileset.spacing),
      py = tileset.margin + Math.floor(local / tileset.columns) * (tileset.tileheight + tileset.spacing),
      flip = layer.flips[cell],
      x0 = (layer.x + (cell % layer.width)) * size + ox,
      z1 = (layer.y + Math.floor(cell / layer.width) + 1) * size + oz,
      w = (tileset.tilewidth / map.tilewidth) * size,
      h = (tileset.tileheight / map.tileheight) * size;
    cells[q] = cell;
    for (let k = 0; k < 4; k++) {
      let sx = corners[k * 2],
        sy = corners[k * 2 + 1];
      positions[q * 12 + k * 3] = x0 + sx * w;
      positions[q * 12 + k * 3 + 2] = z1 - (1 - sy) * h;
      normals[q * 12 + k * 3 + 1] = 1;
      // The displayed corner shows the texel D(H(V(corner))): undo the flips in reverse order.
      if (flip & 2) sy = 1 - sy;
      if (flip & 1) sx = 1 - sx;
      if (flip & 4) [sx, sy] = [sy, sx];
      uvs[q * 8 + k * 2] = (px + sx * tileset.tilewidth) / image.width;
      uvs[q * 8 + k * 2 + 1] = (py + sy * tileset.tileheight) / image.height;
    }
    indices.set(
      [0, 1, 2, 0, 2, 3].map((i) => q * 4 + i),
      q * 6,
    );
  }
  return {
    kind: 'mesh',
    positions,
    normals,
    uvs,
    indices,
    faceSizes: new Uint32Array(quads).fill(4),
    groups,
    cells,
  };
}

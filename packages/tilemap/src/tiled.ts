import type { Vec2 } from '@margoengine/math';
import {
  FLIP_D,
  FLIP_H,
  FLIP_V,
  type MapLayer,
  type MapObject,
  type MapShape,
  type MapTileset,
  type Properties,
  type PropertyValue,
  type TileAnimationStep,
  type TileDef,
  type TileMapData,
} from './index.js';
import {
  MAX_TILES,
  MapImportError,
  cleanGid,
  isObj,
  list,
  num,
  parseJson,
  setOwn,
  str,
  throwIfAborted,
  type Obj,
} from './import.js';

export { MapImportError, type MapImportErrorCode } from './import.js';

const F = 'Tiled';
const fail = (code: ConstructorParameters<typeof MapImportError>[1], message: string): never => {
  throw new MapImportError(F, code, message);
};

/** Options of `parseTiled`. */
export interface TiledOptions {
  /** Loads an external tileset (`.tsj`) by the `source` path written in the map. Needed only when the map has one. */
  readonly resolve?: (source: string, signal?: AbortSignal) => Promise<string | Uint8Array | object>;
  /** Called once per skipped thing (image layers, text, object templates). */
  readonly onWarning?: (message: string) => void;
  readonly signal?: AbortSignal;
}

function readProperties(v: unknown): Properties | undefined {
  const out: { [name: string]: PropertyValue } = {};
  if (Array.isArray(v)) {
    for (const p of v) if (isObj(p) && typeof p.name === 'string') setOwn(out, p.name, p.value as PropertyValue);
  } else if (isObj(v)) for (const k of Object.keys(v)) setOwn(out, k, v[k] as PropertyValue);
  return Object.keys(out).length ? out : undefined;
}

const points = (v: readonly unknown[]): Vec2[] =>
  v.map((p) => (isObj(p) ? ([num(p, 'x'), num(p, 'y')] as const) : ([0, 0] as const)));

/** The outline of a Tiled object relative to the object's own position. */
function outline(o: Obj): MapShape {
  const poly = list(o, 'polygon');
  if (poly.length) return { kind: 'polygon', x: 0, y: 0, points: points(poly) };
  const line = list(o, 'polyline');
  if (line.length) return { kind: 'polyline', x: 0, y: 0, points: points(line) };
  if (o.point === true) return { kind: 'point', x: 0, y: 0 };
  const box = { x: 0, y: 0, width: num(o, 'width'), height: num(o, 'height') };
  return o.ellipse === true ? { kind: 'ellipse', ...box } : { kind: 'rect', ...box };
}

function collisionShape(o: Obj): MapShape {
  const shape = { ...outline(o), x: num(o, 'x'), y: num(o, 'y') };
  const rotation = num(o, 'rotation');
  return rotation && shape.kind !== 'point' ? { ...shape, rotation } : shape;
}

function readObject(o: Obj, warn: (m: string) => void): MapObject {
  if (o.template !== undefined)
    warn(`object ${num(o, 'id')} uses a template; Tiled templates are not read, save the map with templates detached`);
  if (isObj(o.text)) warn(`object ${num(o, 'id')} is a text object; drawn as its rectangle`);
  const gid = typeof o.gid === 'number' ? cleanGid(o.gid) : undefined;
  const type = str(o, 'class') || str(o, 'type');
  const rotation = num(o, 'rotation');
  const name = str(o, 'name');
  const properties = readProperties(o.properties);
  return {
    id: num(o, 'id'),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    x: num(o, 'x'),
    y: num(o, 'y'),
    ...(rotation ? { rotation } : {}),
    ...(o.visible === false ? { visible: false } : {}),
    ...(gid !== undefined ? { gid } : { shape: outline(o) }),
    ...(properties ? { properties } : {}),
  };
}

function readTile(t: Obj): TileDef {
  const type = str(t, 'class') || str(t, 'type');
  const properties = readProperties(t.properties);
  const animation: TileAnimationStep[] = list(t, 'animation').flatMap((f) =>
    isObj(f) ? [{ tileId: num(f, 'tileid'), duration: num(f, 'duration') }] : [],
  );
  const group = isObj(t.objectgroup) ? list(t.objectgroup, 'objects').filter(isObj) : [];
  const image = str(t, 'image');
  return {
    id: num(t, 'id'),
    ...(type ? { type } : {}),
    ...(properties ? { properties } : {}),
    ...(animation.length ? { animation } : {}),
    ...(group.length ? { collision: group.map(collisionShape) } : {}),
    ...(image ? { image: { source: image, width: num(t, 'imagewidth'), height: num(t, 'imageheight') } } : {}),
  };
}

async function readTileset(ref: Obj, options: TiledOptions): Promise<MapTileset> {
  let set: Obj = ref;
  const source = str(ref, 'source');
  if (source !== undefined) {
    if (!options.resolve)
      return fail('missing', `tileset "${source}" is a separate file; pass options.resolve to load it by its path.`);
    const got = await options.resolve(source, options.signal);
    throwIfAborted(F, options.signal);
    if (typeof got === 'string' && got.trimStart().startsWith('<'))
      return fail(
        'unsupported',
        `tileset "${source}" is TSX (XML); export it as .tsj JSON, or load the map with parseTMX and fromTMX.`,
      );
    set = parseJson(F, got);
  }
  const tiles = list(set, 'tiles').filter(isObj).map(readTile);
  const image = str(set, 'image');
  const spacing = num(set, 'spacing');
  const margin = num(set, 'margin');
  const offset = isObj(set.tileoffset) ? ([num(set.tileoffset, 'x'), num(set.tileoffset, 'y')] as const) : undefined;
  const properties = readProperties(set.properties);
  return {
    name: str(set, 'name') ?? '',
    firstGid: num(ref, 'firstgid', 1),
    tileWidth: num(set, 'tilewidth'),
    tileHeight: num(set, 'tileheight'),
    tileCount: num(set, 'tilecount', tiles.length),
    columns: num(set, 'columns'),
    ...(spacing ? { spacing } : {}),
    ...(margin ? { margin } : {}),
    ...(offset && (offset[0] || offset[1]) ? { tileOffset: offset } : {}),
    ...(image ? { image: { source: image, width: num(set, 'imagewidth'), height: num(set, 'imageheight') } } : {}),
    ...(tiles.length ? { tiles } : {}),
    ...(properties ? { properties } : {}),
  };
}

/** Inflate with a hard output cap, so a small file cannot expand without limit. */
async function inflate(bytes: Uint8Array, format: 'deflate' | 'gzip', cap: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    return fail('unsupported', 'this runtime has no DecompressionStream; save the layers uncompressed or as CSV.');
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap)
        return fail('limit', `a compressed layer expands past its ${cap} byte size; the file is damaged.`);
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof MapImportError) throw e;
    return fail('syntax', `the compressed layer data cannot be inflated (${format}); re-save the map.`);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function decodeCells(
  layer: Obj,
  data: unknown,
  count: number,
  signal?: AbortSignal,
  hex = false,
): Promise<Uint32Array> {
  const name = str(layer, 'name') ?? '';
  const out = new Uint32Array(count);
  if (Array.isArray(data)) {
    if (data.length !== count)
      return fail('truncated', `layer "${name}" has ${data.length} tiles for ${count} cells; re-save the map.`);
    for (let i = 0; i < count; i++) {
      const v = data[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff)
        return fail('syntax', `layer "${name}" tile ${i} is ${String(v)}, not an unsigned 32 bit integer.`);
      out[i] = cleanGid(v, hex);
    }
    return out;
  }
  if (typeof data !== 'string')
    return fail('syntax', `layer "${name}" has no tile data; expected an array or a base64 string.`);
  if (layer.encoding !== 'base64')
    return fail('unsupported', `layer "${name}" is encoded as "${String(layer.encoding)}"; use CSV or base64.`);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  } catch {
    return fail('syntax', `layer "${name}" holds invalid base64; re-save the map.`);
  }
  const compression = str(layer, 'compression') ?? '';
  if (compression === 'zlib') bytes = await inflate(bytes, 'deflate', count * 4);
  else if (compression === 'gzip') bytes = await inflate(bytes, 'gzip', count * 4);
  else if (compression)
    return fail(
      'unsupported',
      `layer "${name}" uses ${compression} compression; save it as zlib, gzip or uncompressed.`,
    );
  throwIfAborted(F, signal);
  if (bytes.length !== count * 4)
    return fail(
      bytes.length < count * 4 ? 'truncated' : 'syntax',
      `layer "${name}" decodes to ${bytes.length} bytes, expected ${count * 4}; re-save the map.`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = cleanGid(view.getUint32(i * 4, true), hex);
  return out;
}

interface Inherited {
  ox: number;
  oy: number;
  opacity: number;
  visible: boolean;
  px: number;
  py: number;
}

/**
 * Read a Tiled map saved as JSON (`.tmj`) into `TileMapData`. Takes the text, UTF-8 bytes or the parsed object;
 * orthogonal maps only. Throws `MapImportError` (coded, the message names the fix) for malformed, truncated, oversized
 * or unsupported input.
 */
export async function parseTiled(
  input: string | Uint8Array | object,
  options: TiledOptions = {},
): Promise<TileMapData> {
  const root = parseJson(F, input);
  const warn = options.onWarning ?? (() => {});
  if (!Array.isArray(root.layers) || !Array.isArray(root.tilesets))
    return fail(
      'syntax',
      'this is not a Tiled map: "layers" and "tilesets" are missing; pass the .tmj / .json file contents.',
    );
  const orientation = str(root, 'orientation') ?? 'orthogonal';
  if (
    orientation !== 'orthogonal' &&
    orientation !== 'isometric' &&
    orientation !== 'staggered' &&
    orientation !== 'hexagonal'
  )
    return fail(
      'unsupported',
      `the map is ${orientation}; orthogonal, isometric, staggered and hexagonal maps are read, change the orientation in Tiled.`,
    );
  const hex = orientation === 'hexagonal';
  if (orientation !== 'orthogonal' && root.infinite === true)
    return fail('unsupported', `the map is an infinite ${orientation} map; untick Infinite in Tiled's map properties.`);
  const staggerAxis = str(root, 'staggeraxis'),
    staggerIndex = str(root, 'staggerindex'),
    hexSideLength = num(root, 'hexsidelength');
  if ((staggerAxis ?? 'y') !== 'x' && (staggerAxis ?? 'y') !== 'y')
    return fail('syntax', `staggeraxis is "${staggerAxis}"; Tiled writes x or y.`);
  if ((staggerIndex ?? 'odd') !== 'odd' && (staggerIndex ?? 'odd') !== 'even')
    return fail('syntax', `staggerindex is "${staggerIndex}"; Tiled writes odd or even.`);
  const layout: Pick<TileMapData, 'orientation' | 'staggerAxis' | 'staggerIndex' | 'hexSideLength'> =
    orientation === 'orthogonal'
      ? {}
      : orientation === 'isometric'
        ? { orientation }
        : {
            orientation,
            staggerAxis: (staggerAxis ?? 'y') as 'x' | 'y',
            staggerIndex: (staggerIndex ?? 'odd') as 'odd' | 'even',
            ...(hex ? { hexSideLength: Math.max(0, hexSideLength) } : {}),
          };
  const tileWidth = num(root, 'tilewidth');
  const tileHeight = num(root, 'tileheight');
  if (!(tileWidth > 0 && tileHeight > 0)) return fail('syntax', 'tilewidth and tileheight must be positive numbers.');
  const mapWidth = num(root, 'width');
  const mapHeight = num(root, 'height');
  if (mapWidth * mapHeight > MAX_TILES && root.infinite !== true)
    return fail('limit', `the map is ${mapWidth} x ${mapHeight} tiles; the limit is ${MAX_TILES} cells per layer.`);

  const tilesets: MapTileset[] = [];
  for (const ref of root.tilesets) {
    throwIfAborted(F, options.signal);
    if (isObj(ref)) tilesets.push(await readTileset(ref, options));
  }

  const layers: MapLayer[] = [];
  let width = mapWidth;
  let height = mapHeight;
  const walk = async (source: readonly unknown[], up: Inherited): Promise<void> => {
    for (const l of source) {
      throwIfAborted(F, options.signal);
      if (!isObj(l)) continue;
      const ctx: Inherited = {
        ox: up.ox + num(l, 'offsetx'),
        oy: up.oy + num(l, 'offsety'),
        opacity: up.opacity * num(l, 'opacity', 1),
        visible: up.visible && l.visible !== false,
        px: up.px * num(l, 'parallaxx', 1),
        py: up.py * num(l, 'parallaxy', 1),
      };
      const type = str(l, 'type');
      if (type === 'group') {
        await walk(list(l, 'layers'), ctx);
        continue;
      }
      if (type !== 'tilelayer' && type !== 'objectgroup') {
        warn(`layer "${str(l, 'name') ?? ''}" is a ${type ?? 'layer of unknown type'}; skipped`);
        continue;
      }
      const tint = str(l, 'tintcolor');
      const properties = readProperties(l.properties);
      const common = {
        name: str(l, 'name') ?? '',
        ...(typeof l.id === 'number' ? { id: l.id } : {}),
        ...(ctx.opacity !== 1 ? { opacity: ctx.opacity } : {}),
        ...(ctx.visible ? {} : { visible: false }),
        ...(ctx.px !== 1 || ctx.py !== 1 ? { parallax: [ctx.px, ctx.py] as const } : {}),
        ...(tint ? { tint } : {}),
        ...(properties ? { properties } : {}),
      };
      const offset = (x: number, y: number) =>
        ctx.ox + x || ctx.oy + y ? { offset: [ctx.ox + x, ctx.oy + y] as const } : {};
      if (type === 'objectgroup') {
        layers.push({
          type: 'object',
          ...common,
          ...offset(0, 0),
          objects: list(l, 'objects')
            .filter(isObj)
            .map((o) => readObject(o, warn)),
        });
        continue;
      }
      if (root.infinite === true && Array.isArray(l.chunks)) {
        const chunks = l.chunks.filter(isObj);
        if (!chunks.length) {
          layers.push({ type: 'tile', ...common, ...offset(0, 0), width: 0, height: 0, data: new Uint32Array(0) });
          continue;
        }
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const c of chunks) {
          x0 = Math.min(x0, num(c, 'x'));
          y0 = Math.min(y0, num(c, 'y'));
          x1 = Math.max(x1, num(c, 'x') + num(c, 'width'));
          y1 = Math.max(y1, num(c, 'y') + num(c, 'height'));
        }
        const w = x1 - x0;
        const h = y1 - y0;
        if (w * h > MAX_TILES)
          return fail(
            'limit',
            `layer "${common.name}" spans ${w} x ${h} tiles; the limit is ${MAX_TILES} cells. Split the map or use fewer chunks.`,
          );
        const data = new Uint32Array(w * h);
        for (const c of chunks) {
          const cw = num(c, 'width');
          const ch = num(c, 'height');
          const cells = await decodeCells(l, c.data, cw * ch, options.signal);
          for (let y = 0; y < ch; y++)
            data.set(cells.subarray(y * cw, y * cw + cw), (num(c, 'y') - y0 + y) * w + num(c, 'x') - x0);
        }
        width = Math.max(width, x1);
        height = Math.max(height, y1);
        layers.push({ type: 'tile', ...common, ...offset(x0 * tileWidth, y0 * tileHeight), width: w, height: h, data });
        continue;
      }
      const w = num(l, 'width', mapWidth);
      const h = num(l, 'height', mapHeight);
      if (w * h > MAX_TILES)
        return fail('limit', `layer "${common.name}" is ${w} x ${h} tiles; the limit is ${MAX_TILES} cells.`);
      layers.push({
        type: 'tile',
        ...common,
        ...offset(0, 0),
        width: w,
        height: h,
        data: await decodeCells(l, l.data, w * h, options.signal, hex),
      });
    }
  };
  await walk(root.layers, { ox: 0, oy: 0, opacity: 1, visible: true, px: 1, py: 1 });

  const background = str(root, 'backgroundcolor');
  const properties = readProperties(root.properties);
  return {
    width,
    height,
    tileWidth,
    tileHeight,
    ...layout,
    tilesets,
    layers,
    ...(background ? { backgroundColor: background } : {}),
    ...(properties ? { properties } : {}),
  };
}

/** The parts of the `@margoengine/loaders` `LoadedTMX` that `fromTMX` reads. A `LoadedTMX` fits as it is. */
export interface TMXMapLike {
  readonly width: number;
  readonly height: number;
  readonly tilewidth: number;
  readonly tileheight: number;
  readonly tilesets: readonly {
    readonly name?: string;
    readonly tilewidth: number;
    readonly tileheight: number;
    readonly spacing: number;
    readonly margin: number;
    readonly columns: number;
    readonly tilecount: number;
    readonly image?: { readonly path: string; readonly width: number; readonly height: number };
    readonly properties: Properties;
  }[];
  readonly tilesetRefs: readonly { readonly firstgid: number; readonly tileset: number }[];
  readonly layers: readonly (
    | {
        readonly type: 'tile';
        readonly name: string;
        readonly id?: number;
        readonly visible: boolean;
        readonly opacity: number;
        readonly offsetx: number;
        readonly offsety: number;
        readonly properties: Properties;
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly gids: Uint32Array;
        readonly flips: Uint8Array;
      }
    | {
        readonly type: 'object';
        readonly name: string;
        readonly id?: number;
        readonly visible: boolean;
        readonly opacity: number;
        readonly offsetx: number;
        readonly offsety: number;
        readonly properties: Properties;
        readonly objects: readonly {
          readonly id?: number;
          readonly name: string;
          readonly type: string;
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
          readonly rotation: number;
          readonly visible: boolean;
          readonly gid?: number;
          readonly flips?: number;
          readonly properties: Properties;
        }[];
      }
  )[];
  readonly properties: Properties;
}

const flipBits = (flips: number): number =>
  (flips & 1 ? FLIP_H : 0) | (flips & 2 ? FLIP_V : 0) | (flips & 4 ? FLIP_D : 0);
const some = (p: Properties): Properties | undefined => (Object.keys(p).length ? p : undefined);

/** Turn a map from the loaders' `parseTMX` into `TileMapData`, so TMX and Tiled JSON share one format and one parser. */
export function fromTMX(map: TMXMapLike): TileMapData {
  const tilesets: MapTileset[] = map.tilesetRefs.map((ref) => {
    const t = map.tilesets[ref.tileset];
    const properties = some(t.properties);
    return {
      name: t.name ?? '',
      firstGid: ref.firstgid,
      tileWidth: t.tilewidth,
      tileHeight: t.tileheight,
      tileCount: t.tilecount,
      columns: t.columns,
      ...(t.spacing ? { spacing: t.spacing } : {}),
      ...(t.margin ? { margin: t.margin } : {}),
      ...(t.image ? { image: { source: t.image.path, width: t.image.width, height: t.image.height } } : {}),
      ...(properties ? { properties } : {}),
    };
  });
  const layers: MapLayer[] = map.layers.map((l) => {
    const properties = some(l.properties);
    const common = {
      name: l.name,
      ...(l.id !== undefined ? { id: l.id } : {}),
      ...(l.opacity !== 1 ? { opacity: l.opacity } : {}),
      ...(l.visible ? {} : { visible: false }),
      ...(properties ? { properties } : {}),
    };
    if (l.type === 'object')
      return {
        type: 'object',
        ...common,
        ...(l.offsetx || l.offsety ? { offset: [l.offsetx, l.offsety] as const } : {}),
        objects: l.objects.map((o): MapObject => {
          const props = some(o.properties);
          return {
            id: o.id ?? 0,
            ...(o.name ? { name: o.name } : {}),
            ...(o.type ? { type: o.type } : {}),
            x: o.x,
            y: o.y,
            ...(o.rotation ? { rotation: o.rotation } : {}),
            ...(o.visible ? {} : { visible: false }),
            ...(o.gid !== undefined
              ? { gid: (o.gid | flipBits(o.flips ?? 0)) >>> 0 }
              : {
                  shape:
                    o.width && o.height
                      ? { kind: 'rect', x: 0, y: 0, width: o.width, height: o.height }
                      : { kind: 'point', x: 0, y: 0 },
                }),
            ...(props ? { properties: props } : {}),
          };
        }),
      };
    const data = new Uint32Array(l.gids.length);
    for (let i = 0; i < data.length; i++) data[i] = (l.gids[i] | flipBits(l.flips[i])) >>> 0;
    const ox = l.offsetx + l.x * map.tilewidth;
    const oy = l.offsety + l.y * map.tileheight;
    return {
      type: 'tile',
      ...common,
      ...(ox || oy ? { offset: [ox, oy] as const } : {}),
      width: l.width,
      height: l.height,
      data,
    };
  });
  const properties = some(map.properties);
  return {
    width: map.width,
    height: map.height,
    tileWidth: map.tilewidth,
    tileHeight: map.tileheight,
    tilesets,
    layers,
    ...(properties ? { properties } : {}),
  };
}

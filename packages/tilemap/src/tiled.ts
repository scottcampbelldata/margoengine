import type { Vec2 } from '@margoengine/math';
import {
  FLIP_D,
  FLIP_H,
  FLIP_V,
  type MapLayer,
  type MapObject,
  type MapText,
  type MapShape,
  type MapTileset,
  type Properties,
  type PropertyValue,
  type TileAnimationStep,
  type TileDef,
  type TileMapData,
} from './index.js';
import type { WangRuleSet, WangTile } from './autotile.js';
import { mapColor } from './chunks.js';
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
  /** Load a tileset or template. Paths are relative to baseUrl, including references inside external files. */
  readonly resolve?: (source: string, signal?: AbortSignal) => Promise<string | Uint8Array | object>;
  /** Map document path or URL, used to resolve relative resources. Default empty. */
  readonly baseUrl?: string;
  /** Called for unknown layer types. Supported Tiled features are never skipped. */
  readonly onWarning?: (message: string) => void;
  readonly signal?: AbortSignal;
}

function pathFrom(base: string, source: string): string {
  if (/^[a-z][\w+.-]*:/i.test(source)) return source;
  if (/^[a-z][\w+.-]*:/i.test(base)) return new URL(source, base).href;
  if (source.startsWith('/')) return source;
  const parts: string[] = [];
  for (const part of (base.slice(0, base.lastIndexOf('/') + 1) + source).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function multiplyTint(parent?: string, child?: string): string | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const a = mapColor(parent),
    b = mapColor(child);
  if (!a || !b) return fail('syntax', 'invalid layer tint; use Tiled hexadecimal colours.');
  const c = a.map((v, i) =>
    Math.round(v * b[i] * 255)
      .toString(16)
      .padStart(2, '0'),
  );
  return '#' + c[3] + c[0] + c[1] + c[2];
}

async function document(input: string | Uint8Array | object): Promise<Obj> {
  const text = input instanceof Uint8Array ? new TextDecoder().decode(input) : input;
  if (
    (typeof text === 'string' && text.trimStart().startsWith('<')) ||
    (input instanceof Uint8Array &&
      ((input[0] === 0xff && input[1] === 0xfe) || (input[0] === 0xfe && input[1] === 0xff)))
  ) {
    try {
      return (await import('./tiled-xml.js')).tiledXML(input as string | Uint8Array);
    } catch (error) {
      if (error instanceof MapImportError) throw error;
      return fail(
        'syntax',
        `invalid Tiled XML (${error instanceof Error ? error.message : String(error)}); re-save the file.`,
      );
    }
  }
  return parseJson(F, input);
}

async function resource(path: string, options: TiledOptions): Promise<Obj> {
  throwIfAborted(F, options.signal);
  if (!options.resolve)
    return fail('missing', `resource "${path}" is external; pass options.resolve to load it by path.`);
  const signal = options.signal;
  let abort: (() => void) | undefined;
  try {
    const loaded = options.resolve(path, signal);
    const input = signal
      ? await Promise.race([
          loaded,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new MapImportError(F, 'aborted', 'the import was aborted by its signal.'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ])
      : await loaded;
    throwIfAborted(F, signal);
    return await document(input);
  } finally {
    if (abort) signal!.removeEventListener('abort', abort);
  }
}

function readText(text: Obj): MapText {
  const h = str(text, 'halign') ?? 'left',
    v = str(text, 'valign') ?? 'top';
  if (
    !['left', 'center', 'right', 'justify'].includes(h) ||
    !['top', 'center', 'bottom'].includes(v) ||
    !(num(text, 'pixelsize', 16) > 0)
  )
    return fail('syntax', 'text style is invalid; use a positive font size and Tiled alignments.');
  return {
    text: str(text, 'text') ?? '',
    fontFamily: str(text, 'fontfamily') ?? 'sans-serif',
    pixelSize: num(text, 'pixelsize', 16),
    color: str(text, 'color') ?? '#000000',
    bold: text.bold === true,
    italic: text.italic === true,
    underline: text.underline === true,
    strikeout: text.strikeout === true,
    kerning: text.kerning !== false,
    wrap: text.wrap === true,
    horizontalAlign: h as MapText['horizontalAlign'],
    verticalAlign: v as MapText['verticalAlign'],
  };
}

function readWang(set: Obj): WangRuleSet[] {
  return list(set, 'wangsets')
    .filter(isObj)
    .map((w) => {
      const colors = list(w, 'colors')
        .filter(isObj)
        .map((c) => ({
          name: str(c, 'name') ?? '',
          color: str(c, 'color') ?? '#000000',
          tile: num(c, 'tile', -1),
          probability: num(c, 'probability', 1),
          properties: readProperties(c.properties),
        }));
      const tiles: WangTile[] = list(w, 'wangtiles')
        .filter(isObj)
        .map((t) => {
          const pattern = list(t, 'wangid');
          if (
            pattern.length !== 8 ||
            pattern.some((c) => typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > colors.length)
          )
            return fail('syntax', 'a Wang tile needs eight defined colour ids; re-save the tileset.');
          const id = num(t, 'tileid'),
            weight = num(
              list(set, 'tiles')
                .filter(isObj)
                .find((d) => num(d, 'id') === id) ?? {},
              'probability',
              1,
            );
          if (!Number.isInteger(id) || id < 0 || weight < 0)
            return fail('syntax', 'a Wang tile has an invalid id or probability; re-save the tileset.');
          return {
            tile: id,
            colors: pattern as unknown as WangTile['colors'],
            weight,
            flags: (t.hflip ? FLIP_H : 0) | (t.vflip ? FLIP_V : 0) | (t.dflip ? FLIP_D : 0),
          };
        });
      const type =
        str(w, 'type') ?? (tiles.some((t) => t.colors.some((v, i) => i % 2 === 0 && v)) ? 'mixed' : 'corner');
      if (!['edge', 'corner', 'mixed'].includes(type))
        return fail('syntax', 'unknown Wang set type; use edge, corner or mixed.');
      return {
        mode: 'wang',
        name: str(w, 'name') ?? '',
        type: type as WangRuleSet['type'],
        colors,
        tiles,
        properties: readProperties(w.properties),
      };
    });
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

function readObject(o: Obj, hex = false): MapObject {
  const gid = typeof o.gid === 'number' ? cleanGid(o.gid, hex) : undefined;
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
    ...(typeof o.width === 'number' ? { width: num(o, 'width') } : {}),
    ...(typeof o.height === 'number' ? { height: num(o, 'height') } : {}),
    ...(isObj(o.text) ? { text: readText(o.text) } : {}),
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
    set = await resource(pathFrom(options.baseUrl ?? '', source), options);
  }
  const base = source === undefined ? (options.baseUrl ?? '') : pathFrom(options.baseUrl ?? '', source);
  if (!(num(set, 'tilewidth') > 0 && num(set, 'tileheight') > 0))
    return fail('syntax', 'tileset tilewidth and tileheight must be positive; re-save the tileset.');
  const tiles = list(set, 'tiles')
    .filter(isObj)
    .map((t) => readTile({ ...t, ...(typeof t.image === 'string' ? { image: pathFrom(base, t.image) } : {}) }));
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
    tileCount: Math.max(num(set, 'tilecount', tiles.length), ...tiles.map((t) => t.id + 1)),
    columns: num(set, 'columns'),
    ...(typeof set.objectalignment === 'string'
      ? { objectAlignment: set.objectalignment as MapTileset['objectAlignment'] }
      : {}),
    ...(spacing ? { spacing } : {}),
    ...(margin ? { margin } : {}),
    ...(offset && (offset[0] || offset[1]) ? { tileOffset: offset } : {}),
    ...(image
      ? { image: { source: pathFrom(base, image), width: num(set, 'imagewidth'), height: num(set, 'imageheight') } }
      : {}),
    ...(tiles.length ? { tiles } : {}),
    ...(Array.isArray(set.wangsets) ? { wangSets: readWang(set) } : {}),
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
  tint?: string;
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
  throwIfAborted(F, options.signal);
  const root = await document(input);
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
  const references = new Map<string, MapTileset>();
  for (const ref of root.tilesets) {
    throwIfAborted(F, options.signal);
    if (isObj(ref)) {
      const set = await readTileset(ref, options);
      tilesets.push(set);
      if (typeof ref.source === 'string') references.set(pathFrom(options.baseUrl ?? '', ref.source), set);
    }
  }

  const templates = new Map<string, Promise<Obj>>();
  const expandObject = async (o: Obj, base = options.baseUrl ?? '', stack: readonly string[] = []): Promise<Obj> => {
    if (typeof o.template !== 'string') return o;
    const path = pathFrom(base, o.template);
    if (stack.includes(path) || stack.length >= 32)
      return fail('limit', `template cycle or nesting past 32 at "${path}"; detach the cyclic reference.`);
    let loading = templates.get(path);
    if (!loading) {
      loading = resource(path, options);
      templates.set(path, loading);
    }
    const doc = await loading;
    if (!isObj(doc.object)) return fail('syntax', `template "${path}" needs an object; re-save it in Tiled.`);
    let inherited = await expandObject(doc.object, path, [...stack, path]);
    if (o.gid === undefined && typeof doc.object.gid === 'number' && isObj(doc.tileset)) {
      const ref = doc.tileset;
      if (typeof ref.source !== 'string')
        return fail('syntax', `template "${path}" needs an external tileset reference.`);
      const source = pathFrom(path, ref.source);
      let set = references.get(source);
      if (!set) {
        const firstGid = Math.max(1, ...tilesets.map((s) => s.firstGid + s.tileCount));
        set = await readTileset({ ...ref, source, firstgid: firstGid }, { ...options, baseUrl: '' });
        tilesets.push(set);
        references.set(source, set);
      }
      const raw = cleanGid(doc.object.gid, hex),
        local = (raw & 0x0fffffff) - num(ref, 'firstgid', 1);
      if (local < 0 || local >= set.tileCount)
        return fail('syntax', `template "${path}" tile id is outside its tileset; re-save the template.`);
      inherited = { ...inherited, gid: ((raw & 0xf0000000) | (set.firstGid + local)) >>> 0 };
    }
    const merged = {
      ...inherited,
      ...o,
      template: undefined,
      properties: { ...readProperties(inherited.properties), ...readProperties(o.properties) },
      ...(isObj(inherited.text) || isObj(o.text)
        ? { text: { ...(isObj(inherited.text) ? inherited.text : {}), ...(isObj(o.text) ? o.text : {}) } }
        : {}),
    };
    if (o.type !== undefined && o.class === undefined) delete (merged as Record<string, unknown>).class;
    return merged;
  };

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
        tint: multiplyTint(up.tint, str(l, 'tintcolor')),
      };
      const type = str(l, 'type');
      if (type === 'group') {
        await walk(list(l, 'layers'), ctx);
        continue;
      }
      if (type !== 'tilelayer' && type !== 'objectgroup' && type !== 'imagelayer') {
        warn(`layer "${str(l, 'name') ?? ''}" is a ${type ?? 'layer of unknown type'}; skipped`);
        continue;
      }
      const tint = ctx.tint;
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
      if (type === 'imagelayer') {
        const source = str(l, 'image');
        if (!source) return fail('missing', `image layer "${common.name}" needs its image path.`);
        layers.push({
          type: 'image',
          ...common,
          ...offset(num(l, 'x'), num(l, 'y')),
          image: {
            source: pathFrom(options.baseUrl ?? '', source),
            ...(num(l, 'imagewidth') > 0 ? { width: num(l, 'imagewidth') } : {}),
            ...(num(l, 'imageheight') > 0 ? { height: num(l, 'imageheight') } : {}),
          },
          ...(l.repeatx === true ? { repeatX: true } : {}),
          ...(l.repeaty === true ? { repeatY: true } : {}),
        });
        continue;
      }
      if (type === 'objectgroup') {
        const objects: MapObject[] = [];
        for (const o of list(l, 'objects').filter(isObj)) objects.push(readObject(await expandObject(o), hex));
        layers.push({
          type: 'object',
          ...common,
          ...offset(0, 0),
          ...(l.draworder === 'index' ? { drawOrder: 'index' } : {}),
          objects,
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
    ...(typeof root.renderorder === 'string' ? { renderOrder: root.renderorder as TileMapData['renderOrder'] } : {}),
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

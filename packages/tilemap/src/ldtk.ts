import {
  FLIP_H,
  FLIP_V,
  type MapLayer,
  type MapObject,
  type MapTileset,
  type ObjectLayer,
  type TileDef,
  type TileLayer,
  type TileMapData,
} from './index.js';
import {
  isObj,
  list,
  MapImportError,
  MAX_TILES,
  num,
  type Obj,
  parseJson,
  type Properties,
  type PropertyValue,
  setOwn,
  str,
  throwIfAborted,
} from './import.js';

export { MapImportError, type MapImportErrorCode } from './import.js';

const FORMAT = 'LDtk';

/** Options of {@link parseLDtk}. */
export interface ParseLDtkOptions {
  /** Called for each thing the import drops or moves. Default ignores them. */
  onWarning?: (message: string) => void;
  /** Stops the import between levels. */
  signal?: AbortSignal;
}

/** A placed LDtk entity. */
export interface LDtkEntity {
  /** The entity's identifier in the project. */
  readonly name: string;
  readonly iid?: string;
  /** The layer it was placed on. */
  readonly layer: string;
  /** Pixel position in the level: the entity's pivot point. */
  readonly x: number;
  readonly y: number;
  /** Pixel position in the world. */
  readonly worldX: number;
  readonly worldY: number;
  readonly width: number;
  readonly height: number;
  /** Pivot, 0 to 1 from the top left. Default [0, 0]. */
  readonly pivot: readonly [number, number];
  readonly tags: readonly string[];
  /** Field values by identifier. */
  readonly fields: Properties;
}

/** The value grid of an IntGrid layer, row by row from the top left; 0 is empty. */
export interface LDtkIntGrid {
  readonly width: number;
  readonly height: number;
  /** Pixels per cell. */
  readonly gridSize: number;
  readonly values: Int32Array;
}

/** One level. */
export interface LDtkLevel {
  readonly name: string;
  readonly iid?: string;
  /** The world this level belongs to, when the project has several. */
  readonly world?: string;
  /** Pixel position in the world. */
  readonly worldX: number;
  readonly worldY: number;
  readonly worldDepth: number;
  /** Tile layers and one object layer per entity layer, back to front. */
  readonly map: TileMapData;
  readonly entities: readonly LDtkEntity[];
  /** IntGrid layers by identifier. */
  readonly intGrids: { readonly [layer: string]: LDtkIntGrid };
  /** Level field values by identifier. */
  readonly fields: Properties;
}

/** A parsed LDtk project. */
export interface LDtkProject {
  /** The format version the file was saved with. */
  readonly version?: string;
  readonly levels: readonly LDtkLevel[];
}

const fail = (code: 'syntax' | 'truncated' | 'missing' | 'unsupported' | 'limit', message: string): never => {
  throw new MapImportError(FORMAT, code, message);
};

function fieldsOf(items: readonly unknown[]): Properties {
  const out: { [key: string]: PropertyValue } = {};
  for (const item of items)
    if (isObj(item) && typeof item.__identifier === 'string')
      setOwn(out, item.__identifier, (item.__value ?? null) as PropertyValue);
  return out;
}

function makeTilesets(defs: Obj): { sets: MapTileset[]; byUid: Map<number, MapTileset> } {
  const sets: MapTileset[] = [],
    byUid = new Map<number, MapTileset>();
  let firstGid = 1;
  for (const item of list(defs, 'tilesets')) {
    if (!isObj(item)) continue;
    const grid = num(item, 'tileGridSize'),
      columns = num(item, '__cWid'),
      rows = num(item, '__cHei'),
      name = str(item, 'identifier') ?? `tileset${num(item, 'uid')}`,
      source = str(item, 'relPath');
    if (!(grid > 0) || !(columns > 0) || !(rows > 0))
      fail('missing', `tileset "${name}" has no tileGridSize, __cWid or __cHei; save the project again with LDtk.`);
    const tiles = new Map<number, { id: number; type?: string; properties?: Properties }>(),
      tile = (id: number) => {
        let found = tiles.get(id);
        if (!found) tiles.set(id, (found = { id }));
        return found;
      };
    for (const entry of list(item, 'customData'))
      if (isObj(entry)) tile(num(entry, 'tileId')).properties = { customData: str(entry, 'data') ?? '' };
    for (const entry of list(item, 'enumTags'))
      if (isObj(entry))
        for (const id of list(entry, 'tileIds')) if (typeof id === 'number') tile(id).type = str(entry, 'enumValueId');
    const set: MapTileset = {
      name,
      firstGid,
      tileWidth: grid,
      tileHeight: grid,
      tileCount: columns * rows,
      columns,
      spacing: num(item, 'spacing'),
      margin: num(item, 'padding'),
      ...(source ? { image: { source, width: num(item, 'pxWid'), height: num(item, 'pxHei') } } : {}),
      ...(tiles.size ? { tiles: [...tiles.values()].sort((a, b) => a.id - b.id) as TileDef[] } : {}),
    };
    sets.push(set);
    byUid.set(num(item, 'uid'), set);
    firstGid += set.tileCount;
  }
  return { sets, byUid };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A list of placed tiles as one tile layer per stack depth: a cell holds one tile, LDtk rules can stack several. */
function tileLayers(
  raw: Obj,
  tiles: readonly unknown[],
  set: MapTileset,
  name: string,
  cell: number,
  width: number,
  height: number,
  warn: (message: string) => void,
): TileLayer[] {
  const out: Uint32Array[] = [];
  let moved = 0,
    faded = 0;
  for (const tile of tiles) {
    if (!isObj(tile) || !Array.isArray(tile.px))
      fail('syntax', `layer "${name}" has a tile with no px; save it again.`);
    const placed = tile as Obj,
      id = num(placed, 't', -1),
      flips = num(placed, 'f');
    if (id < 0 || id >= set.tileCount)
      fail('syntax', `layer "${name}" uses tile ${id}, outside tileset "${set.name}" (0..${set.tileCount - 1}).`);
    const [px, py] = placed.px as number[],
      // The renderer sits a tile on the bottom left of its cell.
      x = px / cell,
      y = (py + set.tileHeight) / cell - 1,
      column = Math.round(x),
      row = Math.round(y);
    if (column !== x || row !== y) moved++;
    if (num(placed, 'a', 1) !== 1) faded++;
    if (column < 0 || row < 0 || column >= width || row >= height) {
      moved++;
      continue;
    }
    const at = row * width + column,
      value = (set.firstGid + id + (flips & 1 ? FLIP_H : 0) + (flips & 2 ? FLIP_V : 0)) >>> 0;
    let depth = 0;
    while (depth < out.length && out[depth][at]) depth++;
    if (depth === out.length) out.push(new Uint32Array(width * height));
    out[depth][at] = value;
  }
  if (moved) warn(`layer "${name}": ${moved} tiles off the grid moved to the nearest cell or dropped past the edge.`);
  if (faded)
    warn(`layer "${name}": ${faded} tiles have their own alpha, which a tile layer cannot hold; drawn opaque.`);
  const base = {
    opacity: num(raw, '__opacity', 1),
    visible: raw.visible !== false,
    offset: [num(raw, '__pxTotalOffsetX'), num(raw, '__pxTotalOffsetY')] as [number, number],
  };
  // Tiles are sorted back to front, so the first depth is at the back.
  return out.map((data, depth) => ({
    ...base,
    type: 'tile' as const,
    name: depth ? `${name}#${depth + 1}` : name,
    width,
    height,
    data,
  }));
}

function readEntities(raw: Obj, name: string, offset: number, entities: LDtkEntity[]): ObjectLayer {
  const objects: MapObject[] = [];
  for (const item of list(raw, 'entityInstances')) {
    if (!isObj(item)) continue;
    const px = Array.isArray(item.px) ? (item.px as number[]) : [0, 0],
      pivot = (Array.isArray(item.__pivot) ? item.__pivot : [0, 0]) as [number, number],
      width = num(item, 'width'),
      height = num(item, 'height'),
      entity = str(item, '__identifier') ?? 'entity',
      fields = fieldsOf(list(item, 'fieldInstances'));
    entities.push({
      name: entity,
      iid: str(item, 'iid'),
      layer: name,
      x: px[0],
      y: px[1],
      worldX: num(item, '__worldX'),
      worldY: num(item, '__worldY'),
      width,
      height,
      pivot,
      tags: list(item, '__tags').filter((t): t is string => typeof t === 'string'),
      fields,
    });
    objects.push({
      id: offset + objects.length,
      name: entity,
      type: entity,
      x: px[0] - pivot[0] * width,
      y: px[1] - pivot[1] * height,
      shape: { kind: 'rect', x: 0, y: 0, width, height },
      properties: fields,
    });
  }
  return {
    type: 'object',
    name,
    objects,
    opacity: num(raw, '__opacity', 1),
    visible: raw.visible !== false,
    offset: [num(raw, '__pxTotalOffsetX'), num(raw, '__pxTotalOffsetY')],
  };
}

function readLevel(
  raw: Obj,
  sets: readonly MapTileset[],
  byUid: ReadonlyMap<number, MapTileset>,
  world: string | undefined,
  warn: (message: string) => void,
): LDtkLevel {
  const name = str(raw, 'identifier') ?? 'level',
    pxWid = num(raw, 'pxWid'),
    pxHei = num(raw, 'pxHei');
  if (!Array.isArray(raw.layerInstances))
    fail(
      'unsupported',
      `level "${name}" is saved in its own .ldtkl file; turn off "Save levels to separate files" in LDtk, or merge its layerInstances into the level first.`,
    );
  // LDtk lists the front layer first; maps list the back layer first.
  const raws = (raw.layerInstances as unknown[]).filter(isObj).reverse();
  let cell = 0;
  for (const layer of raws) {
    if (list(layer, 'gridTiles').length + list(layer, 'autoLayerTiles').length)
      cell = gcd(cell, num(layer, '__gridSize'));
  }
  if (!cell) for (const layer of raws) cell = gcd(cell, num(layer, '__gridSize'));
  cell ||= 16;
  const width = Math.ceil(pxWid / cell),
    height = Math.ceil(pxHei / cell);
  if (width * height > MAX_TILES)
    fail('limit', `level "${name}" has ${width} x ${height} cells, past the limit of ${MAX_TILES}; split the level.`);
  const layers: MapLayer[] = [],
    entities: LDtkEntity[] = [],
    intGrids: { [layer: string]: LDtkIntGrid } = {};
  for (const layer of raws) {
    const layerName = str(layer, '__identifier') ?? 'layer',
      type = str(layer, '__type');
    if (type === 'Entities') {
      layers.push(readEntities(layer, layerName, entities.length + 1, entities));
      continue;
    }
    if (type === 'IntGrid') {
      const wide = num(layer, '__cWid'),
        high = num(layer, '__cHei'),
        csv = list(layer, 'intGridCsv');
      if (wide * high > MAX_TILES)
        fail(
          'limit',
          `layer "${layerName}" has ${wide} x ${high} cells, past the limit of ${MAX_TILES}; split the level.`,
        );
      if (csv.length !== wide * high)
        fail(
          'truncated',
          `layer "${layerName}" has ${csv.length} intGridCsv values for ${wide} x ${high} cells; save the project again.`,
        );
      setOwn(intGrids, layerName, {
        width: wide,
        height: high,
        gridSize: num(layer, '__gridSize'),
        values: Int32Array.from(csv as number[]),
      });
    } else if (type !== 'Tiles' && type !== 'AutoLayer')
      fail(
        'unsupported',
        `layer "${layerName}" has type "${type}"; this importer reads IntGrid, Entities, Tiles and AutoLayer.`,
      );
    const tiles = [...list(layer, 'autoLayerTiles'), ...list(layer, 'gridTiles')];
    if (!tiles.length) continue;
    const uid = num(layer, 'overrideTilesetUid', num(layer, '__tilesetDefUid', -1)),
      set = byUid.get(uid);
    if (!set)
      return fail(
        'missing',
        `layer "${layerName}" uses tileset ${uid}, which defs.tilesets does not list; save the project again.`,
      );
    layers.push(...tileLayers(layer, tiles, set, layerName, cell, width, height, warn));
  }
  const background = str(raw, '__bgColor');
  return {
    name,
    iid: str(raw, 'iid'),
    world,
    worldX: num(raw, 'worldX'),
    worldY: num(raw, 'worldY'),
    worldDepth: num(raw, 'worldDepth'),
    map: {
      width,
      height,
      tileWidth: cell,
      tileHeight: cell,
      tilesets: sets,
      layers,
      ...(background ? { backgroundColor: background } : {}),
    },
    entities,
    intGrids,
    fields: fieldsOf(list(raw, 'fieldInstances')),
  };
}

/**
 * Reads an LDtk project saved as JSON (`.ldtk`): text, UTF-8 bytes or the parsed object. Each level becomes a
 * {@link TileMapData} plus its entities, IntGrid values and fields. All worlds of a multi-world project are read.
 * @throws MapImportError with a `code` (`syntax`, `truncated`, `missing`, `unsupported`, `limit`, `aborted`) and a message
 * that names the fix. Levels saved to separate `.ldtkl` files are refused.
 */
export function parseLDtk(input: string | Uint8Array | object, options: ParseLDtkOptions = {}): LDtkProject {
  const { signal, onWarning } = options,
    warn = (message: string) => onWarning?.(message);
  throwIfAborted(FORMAT, signal);
  const root = parseJson(FORMAT, input);
  if (!isObj(root.defs) || (!Array.isArray(root.levels) && !Array.isArray(root.worlds)))
    fail('syntax', 'expected "defs" and "levels" at the top level; pass the .ldtk project file itself.');
  const { sets, byUid } = makeTilesets(root.defs as Obj),
    levels: LDtkLevel[] = [],
    worlds = list(root, 'worlds').filter(isObj),
    groups: readonly [string | undefined, readonly unknown[]][] = worlds.length
      ? worlds.map((world) => [str(world, 'identifier'), list(world, 'levels')])
      : [[undefined, list(root, 'levels')]];
  for (const [world, items] of groups)
    for (const item of items) {
      throwIfAborted(FORMAT, signal);
      if (isObj(item)) levels.push(readLevel(item, sets, byUid, world, warn));
    }
  return { version: str(root, 'jsonVersion'), levels };
}

// What the 2D engine exports read from a tile map: the shape of TileMapData (@margoengine/tilemap), named here so this
// package needs no dependency on it, and the steps they share. And the clip description both take.

type Point = readonly [number, number] | { readonly x: number; readonly y: number };

/** A collision shape in tile pixels, as `TileDef.collision` holds it. */
export interface MapSourceShape {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: number;
  readonly points?: readonly Point[];
}
/** Per-tile data of a {@link MapSourceTileset}. */
export interface MapSourceTile {
  readonly id: number;
  readonly type?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly animation?: readonly { readonly tileId: number; readonly duration: number }[];
  readonly collision?: readonly MapSourceShape[];
}
/** A tileset of a {@link MapSource}. */
export interface MapSourceTileset {
  readonly name: string;
  readonly firstGid: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tileCount: number;
  readonly columns: number;
  readonly spacing?: number;
  readonly margin?: number;
  readonly image?: { readonly source: string; readonly width: number; readonly height: number };
  readonly tiles?: readonly MapSourceTile[];
}
/** A layer of a {@link MapSource}; object layers are left out of the exports. */
export interface MapSourceLayer {
  readonly type: string;
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly data?: Uint32Array;
  readonly visible?: boolean;
}
/** A tile map: a `TileMapData` from `@margoengine/tilemap` fits this. */
export interface MapSource {
  readonly width: number;
  readonly height: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesets: readonly MapSourceTileset[];
  readonly layers: readonly MapSourceLayer[];
}

/** One animation of named atlas frames, for the 2D engine exports. */
export interface EngineClip {
  /** Atlas frame names in play order. */
  readonly frames: readonly string[];
  /** Frames per second for frames without a time. Default 12. */
  readonly fps?: number;
  /** Default true. */
  readonly loop?: boolean;
  /** Seconds per frame, in place of `fps`; one per frame. */
  readonly durations?: readonly number[];
}

/** A placed tile: its source tileset, atlas column and row, and the Tiled flip flags. */
export interface MapCell {
  x: number;
  y: number;
  source: number;
  column: number;
  row: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
}

/** The checked seconds of each frame of a clip. */
export function clipSeconds(name: string, clip: EngineClip, known: Readonly<Record<string, unknown>>): number[] {
  const { frames, fps = 12, durations } = clip ?? ({} as EngineClip);
  if (!frames?.length) throw new RangeError(`Clip ${name} has no frames; list atlas frame names in play order`);
  if (!(fps > 0 && Number.isFinite(fps)))
    throw new RangeError(`Clip ${name} fps ${fps} is invalid; pass a rate above 0`);
  if (durations && durations.length !== frames.length)
    throw new RangeError(`Clip ${name} has ${durations.length} durations for ${frames.length} frames; pass one each`);
  return frames.map((frame, i) => {
    if (!Object.hasOwn(known, frame))
      throw new RangeError(`Clip ${name} names frame ${frame}, not in the atlas; pack it`);
    const seconds = durations ? durations[i] : 1 / fps;
    if (!(seconds > 0 && Number.isFinite(seconds)))
      throw new RangeError(`Clip ${name} frame ${i} lasts ${seconds} s; pass a time above 0`);
    return seconds;
  });
}

/** The grid tilesets only: an image collection has no atlas to cut. */
export function gridTilesets(map: MapSource): readonly MapSourceTileset[] {
  if (!map?.tilesets?.length) throw new RangeError('Tile map has no tilesets; pass a TileMapData with at least one');
  for (const tileset of map.tilesets)
    if (!tileset.columns || !tileset.image)
      throw new RangeError(`Tileset ${tileset.name} is an image collection; pack it into one atlas image first`);
  return map.tilesets;
}

/** Every visible tile layer's placed tiles, in layer order, row by row from the top left. */
export function mapCells(map: MapSource): { name: string; cells: MapCell[] }[] {
  const tilesets = gridTilesets(map);
  return map.layers
    .filter((layer) => layer.type === 'tile' && layer.visible !== false)
    .map((layer) => {
      const cells: MapCell[] = [],
        width = layer.width ?? map.width,
        data = layer.data ?? new Uint32Array(0);
      data.forEach((value, i) => {
        const gid = value & 0x0fffffff;
        if (!gid) return;
        let source = -1;
        tilesets.forEach((tileset, t) => {
          if (gid >= tileset.firstGid && gid < tileset.firstGid + tileset.tileCount) source = t;
        });
        if (source < 0) throw new RangeError(`Layer ${layer.name} uses tile ${gid}, in no tileset; add its tileset`);
        const id = gid - tilesets[source].firstGid,
          { columns } = tilesets[source];
        cells.push({
          x: i % width,
          y: Math.floor(i / width),
          source,
          column: id % columns,
          row: Math.floor(id / columns),
          flipH: !!(value & 0x80000000),
          flipV: !!(value & 0x40000000),
          flipD: !!(value & 0x20000000),
        });
      });
      return { name: layer.name, cells };
    });
}

/**
 * A collision shape as a closed outline in tile pixels from the tile's top left. An ellipse becomes 16 sides.
 * @throws RangeError for a point or polyline, which enclose no area.
 */
export function shapeOutline(shape: MapSourceShape, tileset: string, id: number): [number, number][] {
  const { kind, x, y, width = 0, height = 0, rotation = 0, points = [] } = shape;
  let outline: [number, number][];
  if (kind === 'rect')
    outline = [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ];
  else if (kind === 'ellipse')
    outline = Array.from({ length: 16 }, (_, i) => [
      (width / 2) * (1 + Math.cos((i * Math.PI) / 8)),
      (height / 2) * (1 + Math.sin((i * Math.PI) / 8)),
    ]);
  else if (kind === 'polygon') outline = points.map((p): [number, number] => ('x' in p ? [p.x, p.y] : [p[0], p[1]]));
  else
    throw new RangeError(
      `Tile ${id} of ${tileset} collides with a ${kind}, which encloses no area; draw a rectangle, ellipse or polygon`,
    );
  const c = Math.cos((rotation * Math.PI) / 180),
    s = Math.sin((rotation * Math.PI) / 180);
  return outline.map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
}

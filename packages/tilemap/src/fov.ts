// Field of view and fog of war over tile maps by shadowcasting: light leaves the centre of the viewer's cell, walls are
// whole squares, and each of the eight octants around the viewer is scanned row by row outward (B. Bergstrom, "FOV
// using recursive shadowcasting", 2001, describes the octants, the outward row scans and the slope windows that
// blockers narrow). Here the window is kept as an exact set of lit slope intervals instead of a recursion: a cell is
// seen when a lit interval overlaps its own slope range by more than a point, and a wall then removes its range from
// the set, so the rows behind it see only what passes beside it.
import { GID_MASK, type TileLayer, type TileMapData } from './index.js';

/** Cells that may block sight: `opaque[y * width + x]` truthy blocks it. */
export interface SightGrid {
  readonly width: number;
  readonly height: number;
  readonly opaque: ArrayLike<number | boolean>;
  /** The map's orientation; staggered and hexagonal maps are refused (their cells are not squares in a grid). */
  readonly orientation?: TileMapData['orientation'];
}

/** Settings of {@link fieldOfView}. */
export interface SightOptions {
  /** Cells whose centre is farther than this from the viewer's centre, in cells, are not seen. Default Infinity. */
  radius?: number;
  /** Marks the seen cells with 1 in this mask (other cells are left as they are), to join several viewers. */
  into?: Uint8Array;
}

/** Settings of {@link tileOpacity}. */
export interface TileOpacityOptions {
  /** Tile layers to read, by name; a cell blocks when any of its tiles does. Default every tile layer. */
  layers?: readonly string[];
  /** Tile property that blocks sight when true. Default `'opaque'`. */
  property?: string;
}

/** Which cells block sight, from the tiles' `opaque: true` property (or `options.property`). */
export function tileOpacity(map: TileMapData, options: TileOpacityOptions = {}): SightGrid {
  const property = options.property ?? 'opaque',
    { width, height } = map,
    opaque = new Uint8Array(width * height),
    blocks = new Map<number, boolean>();
  const blocking = (gid: number): boolean => {
    let b = blocks.get(gid);
    if (b !== undefined) return b;
    b = false;
    for (const set of map.tilesets)
      if (gid >= set.firstGid && gid < set.firstGid + set.tileCount)
        b = set.tiles?.find((t) => t.id === gid - set.firstGid)?.properties?.[property] === true;
    blocks.set(gid, b);
    return b;
  };
  for (const layer of map.layers) {
    if (layer.type !== 'tile' || (options.layers && !options.layers.includes(layer.name))) continue;
    const tiles = layer as TileLayer;
    if (tiles.width !== width || tiles.height !== height)
      throw new RangeError(
        `layer "${tiles.name}" is ${tiles.width} x ${tiles.height}, the map ${width} x ${height}; every tile layer must match the map size.`,
      );
    for (let i = 0; i < opaque.length; i++) {
      const gid = tiles.data[i] & GID_MASK;
      if (gid && blocking(gid)) opaque[i] = 1;
    }
  }
  return { width, height, opaque, orientation: map.orientation };
}

const checkGrid = (grid: SightGrid): void => {
  if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height) || grid.width < 1 || grid.height < 1)
    throw new RangeError('a SightGrid needs a whole width and height of 1 or more.');
  if (grid.opaque?.length !== grid.width * grid.height)
    throw new RangeError(
      `a SightGrid of ${grid.width} x ${grid.height} needs ${grid.width * grid.height} opaque values.`,
    );
  const o = grid.orientation ?? 'orthogonal';
  if (o !== 'orthogonal' && o !== 'isometric')
    throw new RangeError(`field of view needs an orthogonal or isometric grid, got ${o}.`);
};

/**
 * The cells a viewer at (`x`, `y`) sees, as a mask of `width * height` (1 seen). A cell is seen when a fan of sight
 * lines of more than zero width from the centre of the viewer's cell reaches it without first passing through a
 * blocking cell; blocking cells that are reached are seen too, and the viewer's own cell always is. Cells outside the
 * grid block. Sight is not symmetric: a cell seen from here may not see back.
 */
export function fieldOfView(grid: SightGrid, x: number, y: number, options: SightOptions = {}): Uint8Array {
  checkGrid(grid);
  const { width, height, opaque } = grid,
    radius = options.radius ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height)
    throw new RangeError(`viewer (${x}, ${y}) is outside the ${width} x ${height} grid; pass a cell inside it.`);
  if (!(radius >= 0)) throw new RangeError(`radius must be 0 or more, got ${radius}.`);
  const seen = options.into ?? new Uint8Array(width * height);
  if (seen.length !== width * height)
    throw new RangeError(`into holds ${seen.length} cells, the grid ${width * height}; pass a mask of width * height.`);
  seen[y * width + x] = 1;
  const r2 = radius * radius,
    farthest = Math.min(Math.max(width, height), Math.floor(radius));
  // Eight octants: depth runs along one axis (sign sx or sy), the column along the other, 0 <= column <= depth.
  for (let octant = 0; octant < 8; octant++) {
    const swap = octant >= 4,
      sa = octant & 1 ? -1 : 1,
      sb = octant & 2 ? -1 : 1;
    // Lit slopes (column / depth) as closed intervals [lit[2i], lit[2i + 1]], each longer than a point.
    let lit = [0, 1];
    for (let depth = 1; depth <= farthest && lit.length; depth++) {
      for (let col = 0; col <= depth && lit.length; col++) {
        const dx = swap ? sb * col : sa * depth,
          dy = swap ? sa * depth : sb * col,
          cx = x + dx,
          cy = y + dy;
        // The cell's square, depth +-0.5 and column +-0.5, spans these slopes as seen from the viewer's centre.
        const lo = col === 0 ? -0.5 / (depth - 0.5) : (col - 0.5) / (depth + 0.5),
          hi = (col + 0.5) / (depth - 0.5);
        let reached = false;
        for (let i = 0; i < lit.length && !reached; i += 2) reached = Math.min(lit[i + 1], hi) > Math.max(lit[i], lo);
        if (!reached) continue;
        const inside = cx >= 0 && cy >= 0 && cx < width && cy < height;
        if (inside && dx * dx + dy * dy <= r2) seen[cy * width + cx] = 1;
        if (inside && !opaque[cy * width + cx]) continue;
        // A blocking cell takes its open slope range out of the lit set; slivers of zero width are dropped.
        const rest: number[] = [];
        for (let i = 0; i < lit.length; i += 2) {
          const a = lit[i],
            b = lit[i + 1];
          if (b <= lo || a >= hi) rest.push(a, b);
          else {
            if (lo > a) rest.push(a, lo);
            if (hi < b) rest.push(hi, b);
          }
        }
        lit = rest;
      }
    }
  }
  return seen;
}

/** A viewer of {@link FogOfWar.update}: its cell and how far it sees, in cells (default Infinity). */
export interface Viewer {
  readonly x: number;
  readonly y: number;
  readonly radius?: number;
}

/** Fog states of {@link FogOfWar.state}. */
export const FOG_UNSEEN = 0,
  FOG_EXPLORED = 1,
  FOG_VISIBLE = 2;

/** RGBA colours of {@link FogOfWar.image}, 0 to 255 each. */
export interface FogColors {
  /** Default black, opaque. */
  unseen?: readonly [number, number, number, number];
  /** Default black at alpha 128. */
  explored?: readonly [number, number, number, number];
  /** Default clear. */
  visible?: readonly [number, number, number, number];
}

/**
 * What the player sees now and what they have seen before: `update` recomputes `visible` from the viewers and adds it
 * to `explored`, which persists (save it, and pass it back to the constructor to restore it).
 */
export class FogOfWar {
  readonly width: number;
  readonly height: number;
  /** 1 where a viewer sees the cell after the last `update`. */
  readonly visible: Uint8Array;
  /** 1 where any viewer has ever seen the cell. */
  readonly explored: Uint8Array;
  constructor(
    readonly grid: SightGrid,
    explored?: ArrayLike<number>,
  ) {
    checkGrid(grid);
    this.width = grid.width;
    this.height = grid.height;
    this.visible = new Uint8Array(grid.width * grid.height);
    this.explored = new Uint8Array(grid.width * grid.height);
    if (explored) {
      if (explored.length !== this.explored.length)
        throw new RangeError(
          `explored holds ${explored.length} cells, the grid ${this.explored.length}; pass the explored mask saved from this grid.`,
        );
      for (let i = 0; i < explored.length; i++) this.explored[i] = explored[i] ? 1 : 0;
    }
  }

  /** Recomputes what the viewers see now (the grid's `opaque` is read again, so opened doors count) and explores it. */
  update(viewers: readonly Viewer[]): this {
    this.visible.fill(0);
    for (const v of viewers) fieldOfView(this.grid, v.x, v.y, { radius: v.radius, into: this.visible });
    for (let i = 0; i < this.visible.length; i++) if (this.visible[i]) this.explored[i] = 1;
    return this;
  }

  /** {@link FOG_VISIBLE}, {@link FOG_EXPLORED} or {@link FOG_UNSEEN}; cells outside the grid are unseen. */
  state(x: number, y: number): number {
    if (!(x >= 0 && y >= 0 && x < this.width && y < this.height)) return FOG_UNSEEN;
    const i = Math.floor(y) * this.width + Math.floor(x);
    return this.visible[i] ? FOG_VISIBLE : this.explored[i] ? FOG_EXPLORED : FOG_UNSEEN;
  }

  /** One RGBA pixel per cell, rows from the top, to draw over the map as a fog texture scaled to the map's size. */
  image(colors: FogColors = {}): { width: number; height: number; data: Uint8Array } {
    const unseen = colors.unseen ?? [0, 0, 0, 255],
      explored = colors.explored ?? [0, 0, 0, 128],
      visible = colors.visible ?? [0, 0, 0, 0],
      data = new Uint8Array(this.width * this.height * 4);
    for (let i = 0; i < this.visible.length; i++)
      data.set(this.visible[i] ? visible : this.explored[i] ? explored : unseen, i * 4);
    return { width: this.width, height: this.height, data };
  }
}

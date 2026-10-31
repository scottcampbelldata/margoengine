import type { ColliderOptions2D, Vec2D } from './shapes.js';

interface TileBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Clockwise degrees about (x, y). */
  readonly rotation?: number;
}
interface TilePoints {
  readonly x: number;
  readonly y: number;
  readonly points: readonly Vec2D[];
  readonly rotation?: number;
}

/** A tile collision shape in tile pixels, from the tile's top left. Same fields as a Tiled collision object. */
export type TileShape =
  | (TileBox & { readonly kind: 'rect' })
  | (TileBox & { readonly kind: 'ellipse' })
  | (TilePoints & { readonly kind: 'polygon' })
  | (TilePoints & { readonly kind: 'polyline' })
  | { readonly kind: 'point'; readonly x: number; readonly y: number };

/** The part of a tile map that collision needs. A `TileMapData` from `@margoengine/tilemap` fits as is. */
export interface TileMapSource {
  /** Cell size in pixels. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesets: readonly {
    readonly firstGid: number;
    readonly tileCount: number;
    readonly tileWidth: number;
    readonly tileHeight: number;
    readonly tileOffset?: Vec2D;
    readonly tiles?: readonly {
      readonly id: number;
      readonly properties?: { readonly [name: string]: unknown };
      readonly collision?: readonly TileShape[];
    }[];
  }[];
  readonly layers: readonly (
    | {
        readonly type: 'tile';
        readonly name: string;
        readonly width: number;
        readonly height: number;
        /** Row by row from the top left; low 28 bits are the global tile id, the top three bits are flips. */
        readonly data: Uint32Array;
        readonly offset?: Vec2D;
      }
    | { readonly type: 'object'; readonly name: string }
  )[];
}

/** Options for `Physics2D.addTileMap`. */
export interface TileMapBodyOptions {
  /** World2D position of the map's top left corner. Default [0, 0]. */
  position?: Vec2D;
  /** Which tile layers collide: names, or a test. Default every tile layer. */
  layers?: readonly string[] | ((layer: { readonly name: string }) => boolean);
  friction?: number;
  restitution?: number;
  collisionGroups?: number;
  userData?: unknown;
}

const FLIP_H = 0x80000000,
  FLIP_V = 0x40000000,
  FLIP_D = 0x20000000,
  GID_MASK = 0x0fffffff;

type Pt = [number, number];

/** Outlines of the filled cells as closed point loops in cell units: shared edges vanish, straight runs merge. */
function cellOutlines(solid: Uint8Array, width: number, height: number): Pt[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && solid[y * width + x] === 1;
  const edges = new Map<number, number[]>(), // start vertex -> end vertices
    stride = width + 1;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const key = y0 * stride + x0,
      list = edges.get(key);
    if (list) list.push(y1 * stride + x1);
    else edges.set(key, [y1 * stride + x1]);
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  const loops: Pt[][] = [],
    point = (v: number): Pt => [v % stride, Math.floor(v / stride)];
  for (const [first] of edges) {
    while (edges.get(first)?.length) {
      const path: number[] = [first];
      let v = first;
      for (;;) {
        const out = edges.get(v);
        if (!out?.length) break;
        v = out.pop() as number;
        path.push(v);
        if (v === first && !edges.get(v)?.length) break;
      }
      // Drop vertices in the middle of a straight run (the loop is closed: path[0] equals the last).
      const pts = path.slice(0, -1).map(point),
        keep: Pt[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length],
          b = pts[i],
          c = pts[(i + 1) % pts.length];
        if ((b[0] - a[0]) * (c[1] - b[1]) !== (b[1] - a[1]) * (c[0] - b[0])) keep.push(b);
      }
      loops.push(keep);
    }
  }
  return loops;
}

function shapePoints(shape: TileShape): { points: Pt[]; box: boolean; circle?: { c: Pt; r: number } } | null {
  if (shape.kind === 'point') return null;
  const rad = ((shape.rotation ?? 0) * Math.PI) / 180,
    cos = Math.cos(rad),
    sin = Math.sin(rad);
  const place = (px: number, py: number): Pt => [shape.x + px * cos - py * sin, shape.y + px * sin + py * cos];
  if (shape.kind === 'rect') {
    const { width: w, height: h } = shape;
    return { points: [place(0, 0), place(w, 0), place(w, h), place(0, h)], box: true };
  }
  if (shape.kind === 'ellipse') {
    const { width: w, height: h } = shape;
    if (w === h) return { points: [], box: false, circle: { c: place(w / 2, h / 2), r: w / 2 } };
    const pts: Pt[] = [];
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      pts.push(place(w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)));
    }
    return { points: pts, box: false };
  }
  return { points: shape.points.map((p) => place(p[0], p[1])), box: false };
}

/**
 * Collider2D descriptions for a tile map's solid tiles. Whole-cell squares merge into outline loops (no seams for a body
 * to catch on); every other shape becomes its own collider. Coordinates are world units.
 */
export function tileMapColliders(map: TileMapSource, options: TileMapBodyOptions = {}): ColliderOptions2D[] {
  const { tileWidth: tw, tileHeight: th } = map;
  if (!(tw > 0 && th > 0))
    throw new RangeError(`map tile size must be above 0, got ${tw} x ${th}; fix tileWidth and tileHeight.`);
  const [px, py] = options.position ?? [0, 0],
    pick = options.layers,
    wanted = (layer: { readonly name: string }) =>
      !pick ? true : typeof pick === 'function' ? pick(layer) : pick.includes(layer.name);
  const settings = {
    friction: options.friction,
    restitution: options.restitution,
    collisionGroups: options.collisionGroups,
  };
  const out: ColliderOptions2D[] = [];
  const grids = new Map<string, { solid: Uint8Array; width: number; height: number; ox: number; oy: number }>();
  const defs = new Map<number, { set: TileMapSource['tilesets'][number]; shapes: readonly TileShape[] | null }>();
  const lookup = (gid: number) => {
    let hit = defs.get(gid);
    if (hit) return hit;
    let set: TileMapSource['tilesets'][number] | undefined;
    for (const s of map.tilesets)
      if (s.firstGid <= gid && gid < s.firstGid + s.tileCount && (!set || s.firstGid > set.firstGid)) set = s;
    if (!set) return null;
    const tile = set.tiles?.find((t) => t.id === gid - set.firstGid);
    const shapes = tile?.collision?.length
      ? tile.collision
      : tile?.properties?.solid === true
        ? ([{ kind: 'rect', x: 0, y: 0, width: set.tileWidth, height: set.tileHeight }] as const)
        : null;
    defs.set(gid, (hit = { set, shapes }));
    return hit;
  };
  for (const layer of map.layers) {
    if (layer.type !== 'tile' || !wanted(layer)) continue;
    if (layer.data.length !== layer.width * layer.height)
      throw new RangeError(
        `layer "${layer.name}" has ${layer.data.length} values for ${layer.width} x ${layer.height} tiles; resize it to width * height.`,
      );
    const [lx, ly] = layer.offset ?? [0, 0],
      key = `${lx},${ly}`;
    let grid = grids.get(key);
    if (!grid) {
      const width = Math.max(0, ...map.layers.map((l) => (l.type === 'tile' ? l.width : 0))),
        height = Math.max(0, ...map.layers.map((l) => (l.type === 'tile' ? l.height : 0)));
      grids.set(key, (grid = { solid: new Uint8Array(width * height), width, height, ox: lx, oy: ly }));
    }
    for (let cy = 0; cy < layer.height; cy++)
      for (let cx = 0; cx < layer.width; cx++) {
        const value = layer.data[cy * layer.width + cx],
          gid = value & GID_MASK;
        if (!gid) continue;
        const def = lookup(gid);
        if (!def?.shapes) continue;
        const { set } = def,
          W = set.tileWidth,
          H = set.tileHeight,
          ox = px + lx + cx * tw + (set.tileOffset?.[0] ?? 0),
          oy = py + ly + (cy + 1) * th - H + (set.tileOffset?.[1] ?? 0);
        const flip = (p: Pt): Pt => {
          let [x, y] = p;
          if (value & FLIP_D) [x, y] = [(y * W) / H, (x * H) / W];
          if (value & FLIP_H) x = W - x;
          if (value & FLIP_V) y = H - y;
          return [x, y];
        };
        for (const shape of def.shapes) {
          const s = shapePoints(shape);
          if (!s) continue;
          if (s.circle) {
            const [x, y] = flip(s.circle.c);
            out.push({ shape: 'circle', radius: s.circle.r, offset: [ox + x, oy + y], ...settings });
            continue;
          }
          const pts = s.points.map(flip);
          if (s.box) {
            const xs = pts.map((p) => p[0]),
              ys = pts.map((p) => p[1]),
              x0 = Math.min(...xs),
              x1 = Math.max(...xs),
              y0 = Math.min(...ys),
              y1 = Math.max(...ys);
            if (pts.every((p) => (p[0] === x0 || p[0] === x1) && (p[1] === y0 || p[1] === y1))) {
              if (
                x0 === 0 &&
                y0 === 0 &&
                x1 === tw &&
                y1 === th &&
                W === tw &&
                H === th &&
                oy === py + ly + cy * th &&
                ox === px + lx + cx * tw
              )
                grid.solid[cy * grid.width + cx] = 1;
              else
                out.push({
                  shape: 'box',
                  width: x1 - x0,
                  height: y1 - y0,
                  offset: [ox + (x0 + x1) / 2, oy + (y0 + y1) / 2],
                  ...settings,
                });
              continue;
            }
          }
          const world = pts.map((p): Vec2D => [ox + p[0], oy + p[1]]);
          if (shape.kind === 'polyline') out.push({ shape: 'polyline', points: world, ...settings });
          else out.push({ shape: 'polygon', points: world, ...settings });
        }
      }
  }
  for (const grid of grids.values())
    for (const loop of cellOutlines(grid.solid, grid.width, grid.height)) {
      const points = loop.map((p): Vec2D => [px + grid.ox + p[0] * tw, py + grid.oy + p[1] * th]);
      points.push(points[0]);
      out.push({ shape: 'polyline', points, ...settings });
    }
  return out;
}

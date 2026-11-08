// Cell geometry of orthogonal, isometric, staggered and hexagonal tile maps, as the Tiled map format defines the layouts
// (orientation, staggeraxis, staggerindex, hexsidelength). A staggered map is a hexagonal one whose side length is 0,
// so one set of formulas covers both: along the stagger axis cells step by (size + side) / 2, and every other row (or
// column) is pushed half a cell across.
import type { TileMapData } from './index.js';

/** The grid fields of a map, as {@link TileMapData} carries them. */
export type MapGrid = Pick<
  TileMapData,
  'width' | 'height' | 'tileWidth' | 'tileHeight' | 'orientation' | 'staggerAxis' | 'staggerIndex' | 'hexSideLength'
>;

/** A cell's place: its bounding box's top left in map pixels, and its size. */
export interface CellBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Grid {
  kind: 'orthogonal' | 'isometric' | 'stagger';
  tw: number;
  th: number;
  /** Rows (or columns) of the map, for the isometric origin. */
  rows: number;
  /** Stagger along y (rows shifted across) or x (columns shifted down). */
  axisY: boolean;
  /** Odd rows (or columns) are the pushed ones. */
  odd: boolean;
  side: number;
}

const grid = (map: MapGrid): Grid => {
  const orientation = map.orientation ?? 'orthogonal',
    tw = map.tileWidth,
    th = map.tileHeight;
  if (!(tw > 0 && th > 0)) throw new RangeError(`tile size must be positive, got ${tw} x ${th}.`);
  if (orientation === 'orthogonal' || orientation === 'isometric')
    return { kind: orientation, tw, th, rows: map.height, axisY: true, odd: true, side: 0 };
  if (orientation !== 'staggered' && orientation !== 'hexagonal')
    throw new RangeError(
      `orientation "${orientation}" is not a layout; use orthogonal, isometric, staggered or hexagonal.`,
    );
  const axisY = (map.staggerAxis ?? 'y') === 'y',
    side = orientation === 'hexagonal' ? (map.hexSideLength ?? 0) : 0;
  if (!(side >= 0) || side > (axisY ? th : tw))
    throw new RangeError(
      `hexSideLength must be 0 to the tile ${axisY ? 'height' : 'width'}, got ${map.hexSideLength}.`,
    );
  return { kind: 'stagger', tw, th, rows: map.height, axisY, odd: (map.staggerIndex ?? 'odd') === 'odd', side };
};
const pushed = (g: Grid, i: number): boolean => ((i & 1) === 1) === g.odd;

/** Where cell (`x`, `y`) sits: the top left of its bounding box in map pixels, and its size (the map's tile size). */
export function cellBox(map: MapGrid, x: number, y: number): CellBox {
  const g = grid(map);
  let left: number, top: number;
  if (g.kind === 'orthogonal') {
    left = x * g.tw;
    top = y * g.th;
  } else if (g.kind === 'isometric') {
    // The diamond of (0, 0) has its top corner at x = rows * tw / 2, so the whole map starts at x = 0.
    left = ((x - y + g.rows - 1) * g.tw) / 2;
    top = ((x + y) * g.th) / 2;
  } else if (g.axisY) {
    left = x * g.tw + (pushed(g, y) ? g.tw / 2 : 0);
    top = (y * (g.th + g.side)) / 2;
  } else {
    left = (x * (g.tw + g.side)) / 2;
    top = y * g.th + (pushed(g, x) ? g.th / 2 : 0);
  }
  return { x: left, y: top, width: g.tw, height: g.th };
}

/** The centre of cell (`x`, `y`) in map pixels. */
export function cellCenter(map: MapGrid, x: number, y: number): [number, number] {
  const b = cellBox(map, x, y);
  return [b.x + b.width / 2, b.y + b.height / 2];
}

/**
 * The outline of cell (`x`, `y`) in map pixels, clockwise from the top: 4 corners for orthogonal, isometric and
 * staggered cells, 6 for hexagonal ones with a side length above 0.
 */
export function cellPolygon(map: MapGrid, x: number, y: number): [number, number][] {
  const g = grid(map),
    { x: l, y: t, width: w, height: h } = cellBox(map, x, y);
  if (g.kind === 'orthogonal')
    return [
      [l, t],
      [l + w, t],
      [l + w, t + h],
      [l, t + h],
    ];
  const s = g.side;
  if (!s)
    return [
      [l + w / 2, t],
      [l + w, t + h / 2],
      [l + w / 2, t + h],
      [l, t + h / 2],
    ];
  return g.axisY
    ? [
        [l + w / 2, t],
        [l + w, t + (h - s) / 2],
        [l + w, t + (h + s) / 2],
        [l + w / 2, t + h],
        [l, t + (h + s) / 2],
        [l, t + (h - s) / 2],
      ]
    : [
        [l + (w - s) / 2, t],
        [l + (w + s) / 2, t],
        [l + w, t + h / 2],
        [l + (w + s) / 2, t + h],
        [l + (w - s) / 2, t + h],
        [l, t + h / 2],
      ];
}

// Inside a convex polygon given clockwise on screen (y down): on the inner side of every edge, edges included.
const inside = (polygon: readonly [number, number][], px: number, py: number): boolean => {
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i],
      [bx, by] = polygon[(i + 1) % polygon.length];
    if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0) return false;
  }
  return true;
};

/**
 * The cell under map pixel (`px`, `py`), which may lie outside the map. A point on a shared edge goes to the cell
 * found first: the lower row, then the lower column.
 */
export function pixelToCell(map: MapGrid, px: number, py: number): [number, number] {
  const g = grid(map);
  if (g.kind === 'orthogonal') return [Math.floor(px / g.tw), Math.floor(py / g.th)];
  if (g.kind === 'isometric') {
    const u = (px - (g.rows * g.tw) / 2) / g.tw,
      v = py / g.th;
    return [Math.floor(v + u), Math.floor(v - u)];
  }
  // Near cells by the row and column steps, then the one whose outline holds the point.
  const across = g.axisY ? py / ((g.th + g.side) / 2) : px / ((g.tw + g.side) / 2),
    a0 = Math.floor(across);
  let best: [number, number] | undefined,
    distance = Infinity;
  for (let a = a0 - 1; a <= a0 + 1; a++) {
    const shift = pushed(g, a) ? 0.5 : 0,
      b0 = Math.floor((g.axisY ? px / g.tw : py / g.th) - shift);
    for (let b = b0 - 1; b <= b0 + 1; b++) {
      const [x, y] = g.axisY ? [b, a] : [a, b];
      if (inside(cellPolygon(map, x, y), px, py)) return [x, y];
      const [cx, cy] = cellCenter(map, x, y),
        d = ((px - cx) / g.tw) ** 2 + ((py - cy) / g.th) ** 2;
      if (d < distance) {
        distance = d;
        best = [x, y];
      }
    }
  }
  // Only rounding at a corner reaches here; the nearest centre is the cell.
  return best!;
}

/**
 * The cells that share an edge with (`x`, `y`), clockwise from the top or top right: 4 on orthogonal, isometric and
 * staggered maps, 6 on hexagonal ones. Cells outside the map are included; filter them with the map size.
 */
export function cellNeighbors(map: MapGrid, x: number, y: number): [number, number][] {
  const g = grid(map);
  if (g.kind === 'orthogonal')
    return [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ];
  if (g.kind === 'isometric')
    return [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ];
  const hex = g.side > 0;
  if (g.axisY) {
    // A pushed row reaches one column further right on the rows above and below.
    const o = pushed(g, y) ? 0 : -1;
    const list: [number, number][] = [[x + o + 1, y - 1]];
    if (hex) list.push([x + 1, y]);
    list.push([x + o + 1, y + 1], [x + o, y + 1]);
    if (hex) list.push([x - 1, y]);
    list.push([x + o, y - 1]);
    return list;
  }
  const o = pushed(g, x) ? 0 : -1;
  const list: [number, number][] = [];
  if (hex) list.push([x, y - 1]);
  // A pushed column reaches one row further down on the columns beside it.
  list.push([x + 1, y + o], [x + 1, y + o + 1]);
  if (hex) list.push([x, y + 1]);
  list.push([x - 1, y + o + 1], [x - 1, y + o]);
  return list;
}

/** The map's size in pixels: the box around every cell. */
export function mapPixelSize(map: MapGrid): [number, number] {
  const g = grid(map),
    w = map.width,
    h = map.height;
  if (!w || !h) return [0, 0];
  if (g.kind === 'orthogonal') return [w * g.tw, h * g.th];
  if (g.kind === 'isometric') return [((w + h) * g.tw) / 2, ((w + h) * g.th) / 2];
  if (g.axisY) return [w * g.tw + (h > 1 || pushed(g, 0) ? g.tw / 2 : 0), ((h - 1) * (g.th + g.side)) / 2 + g.th];
  return [((w - 1) * (g.tw + g.side)) / 2 + g.tw, h * g.th + (w > 1 || pushed(g, 0) ? g.th / 2 : 0)];
}

/**
 * Every cell of a `width` x `height` layer in painter's order, back to front: the order that lets tall tiles cover the
 * cells behind them. Rows top to bottom on orthogonal and y-staggered maps, diagonals (x + y) on isometric ones, and on
 * x-staggered maps each row's raised columns before its lowered ones. Returns cell indices `y * width + x`.
 */
export function paintOrder(map: MapGrid, width = map.width, height = map.height): Uint32Array {
  const g = grid(map),
    order = new Uint32Array(width * height);
  let at = 0;
  if (g.kind === 'isometric') {
    for (let d = 0; d < width + height - 1; d++)
      for (let y = Math.min(d, height - 1); y >= 0 && d - y < width; y--) order[at++] = y * width + d - y;
  } else if (g.kind === 'stagger' && !g.axisY) {
    for (let y = 0; y < height; y++)
      for (const low of [false, true])
        for (let x = 0; x < width; x++) if (pushed(g, x) === low) order[at++] = y * width + x;
  } else for (let i = 0; i < order.length; i++) order[i] = i;
  return order;
}

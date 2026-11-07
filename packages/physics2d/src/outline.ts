// @margoengine/physics2d/outline: colliders from a sprite's alpha. Marching squares over the alpha at pixel centres
// finds the edge at the threshold, the Douglas-Peucker method thins it to the corners that matter, and the outline is
// cut into convex pieces: ear clipping (@margoengine/geometry), then a greedy merge of triangles across every diagonal
// that keeps both ends convex. Sources, and what of them was read: docs/clean-room.md.
import { triangulate } from '@margoengine/geometry/triangulate';
import type { SpriteLike } from './body.js';
import type { ColliderOptions2D, ColliderSettings2D, Vec2D } from './shapes.js';

/** Straight-alpha RGBA8 pixels, row by row from the top: `ImageData` fits. */
export interface AlphaImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** Options of {@link traceOutlines}. */
export interface TraceOptions {
  /** Alpha from 1 to 255 that counts as solid (default 128). The edge is placed between pixels by their alpha. */
  threshold?: number;
  /** Farthest the simplified outline may stray from the traced one, in pixels (default 1). 0 keeps every point on a line out. */
  tolerance?: number;
  /** Outlines and holes enclosing less than this many square pixels are left out: specks of noise (default 4). */
  minArea?: number;
  /** The part of the image to trace, [x, y, width, height] in pixels: one frame of an atlas. Default the whole image. */
  rect?: readonly [number, number, number, number];
}

/** One solid island of the image. Points run in pixels from the top left of the traced area. */
export interface Outline {
  /** The island's edge. */
  outer: Vec2D[];
  /** Its holes, each a closed loop. */
  holes: Vec2D[][];
}

/** Options of {@link outlineColliders}: the trace, where it sits on the body, and the settings of every collider. */
export interface OutlineColliderOptions extends TraceOptions, Omit<ColliderSettings2D, 'offset' | 'rotation'> {
  /**
   * The sprite the colliders are for: its `rect` is traced unless `rect` is given, and its pivot and scale place them
   * on the body, as `physics.addBody(sprite)` places a fitted box. Without it, the body sits at the top left of the
   * traced area at scale 1.
   */
  sprite?: SpriteLike;
  /**
   * False (default) gives filled convex `polygon` colliders, for bodies that move. True gives one closed `polyline` per
   * outline and hole: edges with no area, for fixed terrain, with fewer colliders.
   */
  edges?: boolean;
}

const cross = (o: Vec2D, a: Vec2D, b: Vec2D): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function signedArea(loop: readonly Vec2D[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i],
      b = loop[(i + 1) % loop.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function inside(point: Vec2D, loop: readonly Vec2D[]): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i],
      b = loop[j];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < a[0] + ((point[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
      hit = !hit;
  }
  return hit;
}

function checkOptions(image: AlphaImage, options: TraceOptions): [number, number, number, number] {
  const { width, height, data } = image ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !data)
    throw new TypeError('An outline needs an image with a whole width and height and RGBA data: ImageData fits.');
  if (data.length !== width * height * 4)
    throw new RangeError(`Image data holds ${data.length} values, not 4 per pixel of ${width} by ${height}; pass RGBA8.`);
  const { threshold = 128, tolerance = 1, minArea = 4, rect = [0, 0, width, height] } = options;
  if (!(threshold >= 1 && threshold <= 255)) throw new RangeError('Outline threshold is out of range; pass an alpha from 1 to 255.');
  if (!(tolerance >= 0) || !Number.isFinite(tolerance))
    throw new RangeError('Outline tolerance must be a finite number of pixels of at least 0.');
  if (!(minArea >= 0) || !Number.isFinite(minArea))
    throw new RangeError('Outline minArea must be a finite number of square pixels of at least 0.');
  const [x, y, w, h] = rect;
  if (
    ![x, y, w, h].every(Number.isInteger) ||
    x < 0 ||
    y < 0 ||
    w < 1 ||
    h < 1 ||
    x + w > width ||
    y + h > height
  )
    throw new RangeError(`Outline rect ${rect.join(', ')} is outside the ${width} by ${height} image; pass whole pixels inside it.`);
  return [x, y, w, h];
}

/**
 * Every closed edge of the field at `threshold`, as loops with the solid on the same side of each, so an island's edge
 * and a hole's wind opposite ways. Marching squares: samples sit on pixel centres, a ring of empty samples closes loops
 * at the border, and each grid edge the field crosses holds one point, placed by the two samples' alpha.
 */
function march(image: AlphaImage, area: readonly number[], threshold: number): Vec2D[][] {
  const [left, top, w, h] = area,
    columns = w + 2,
    rows = h + 2,
    { data, width } = image,
    field = new Float32Array(columns * rows);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) field[(y + 1) * columns + x + 1] = data[((top + y) * width + left + x) * 4 + 3];
  // Grid edge ids: 2 i for the edge from sample i to its right neighbour, 2 i + 1 to the one below.
  const next = new Int32Array(columns * rows * 2).fill(-1),
    link = (from: number, to: number) => {
      next[from] = to;
    };
  for (let y = 0; y < rows - 1; y++)
    for (let x = 0; x < columns - 1; x++) {
      const i = y * columns + x,
        a = field[i],
        b = field[i + 1],
        c = field[i + columns + 1],
        d = field[i + columns],
        code = (a >= threshold ? 1 : 0) | (b >= threshold ? 2 : 0) | (c >= threshold ? 4 : 0) | (d >= threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const north = 2 * i,
        south = 2 * (i + columns),
        west = 2 * i + 1,
        east = 2 * (i + 1) + 1;
      // Each segment runs with the solid on its left on screen, so an island winds counter-clockwise on screen.
      switch (code) {
        case 1:
          link(west, north);
          break;
        case 2:
          link(north, east);
          break;
        case 3:
          link(west, east);
          break;
        case 4:
          link(east, south);
          break;
        case 6:
          link(north, south);
          break;
        case 7:
          link(west, south);
          break;
        case 8:
          link(south, west);
          break;
        case 9:
          link(south, north);
          break;
        case 11:
          link(south, east);
          break;
        case 12:
          link(east, west);
          break;
        case 13:
          link(east, north);
          break;
        case 14:
          link(north, west);
          break;
        // A saddle: two corners are solid across the cell. The mean of the four says whether they join.
        case 5:
          if ((a + b + c + d) / 4 >= threshold) {
            link(west, south);
            link(east, north);
          } else {
            link(west, north);
            link(east, south);
          }
          break;
        case 10:
          if ((a + b + c + d) / 4 >= threshold) {
            link(north, west);
            link(south, east);
          } else {
            link(north, east);
            link(south, west);
          }
          break;
      }
    }
  const point = (id: number): Vec2D => {
    const i = id >> 1,
      x = i % columns,
      y = (i - x) / columns,
      from = field[i],
      to = field[i + (id & 1 ? columns : 1)],
      t = (threshold - from) / (to - from);
    // Sample (x, y) is the centre of traced pixel (x - 1, y - 1).
    return id & 1 ? [x - 0.5, y - 0.5 + t] : [x - 0.5 + t, y - 0.5];
  };
  const loops: Vec2D[][] = [];
  for (let start = 0; start < next.length; start++) {
    if (next[start] < 0) continue;
    const loop: Vec2D[] = [];
    for (let id = start; next[id] >= 0; ) {
      loop.push(point(id));
      const after = next[id];
      next[id] = -1;
      id = after;
    }
    loops.push(loop);
  }
  return loops;
}

/** The Douglas-Peucker method on a closed loop: cut it at two far-apart points, then keep the farthest point of any stretch that strays past `tolerance`. */
function simplify(loop: readonly Vec2D[], tolerance: number): Vec2D[] {
  const n = loop.length;
  if (n < 4) return [...loop];
  let far = 0,
    best = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack: number[] = [0, far, far, n];
  while (stack.length) {
    const end = stack.pop()!,
      start = stack.pop()!,
      a = loop[start],
      b = loop[end % n],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    let worst = -1,
      split = -1;
    for (let i = start + 1; i < end; i++) {
      const p = loop[i],
        d = length ? Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > worst) {
        worst = d;
        split = i;
      }
    }
    if (split >= 0 && worst > tolerance) {
      keep[split] = 1;
      stack.push(start, split, split, end);
    }
  }
  const out: Vec2D[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[i]);
  return out;
}

/**
 * The outlines of an image's solid parts, in pixels from the top left of the traced area: the alpha at each pixel centre
 * is contoured at `threshold`, so a hard edge lands on the pixel boundary and a soft one between pixels by its alpha.
 * @example const [island] = traceOutlines(imageData, {threshold: 64, tolerance: 0.5});
 * @throws TypeError or RangeError for an image that is not RGBA8 or options out of range.
 */
export function traceOutlines(image: AlphaImage, options: TraceOptions = {}): Outline[] {
  const area = checkOptions(image, options),
    { threshold = 128, tolerance = 1, minArea = 4 } = options,
    outers: Outline[] = [],
    holes: Vec2D[][] = [];
  // With y down, counter-clockwise on screen is a negative area: islands, and holes the other way round.
  for (const loop of march(image, area, threshold)) {
    const size = signedArea(loop);
    if (Math.abs(size) < minArea || !size) continue;
    const thin = simplify(loop, tolerance);
    if (thin.length < 3 || !signedArea(thin)) continue;
    if (size < 0) outers.push({ outer: thin, holes: [] });
    else holes.push(thin);
  }
  // A hole belongs to the smallest island around it.
  for (const hole of holes) {
    let owner: Outline | undefined,
      smallest = Infinity;
    for (const island of outers) {
      const size = Math.abs(signedArea(island.outer));
      if (size < smallest && inside(hole[0], island.outer)) {
        smallest = size;
        owner = island;
      }
    }
    owner?.holes.push(hole);
  }
  return outers;
}

/** Convex pieces of one outline: ear clipping, then drop each diagonal that leaves both of its ends convex. */
function convexPieces({ outer, holes }: Outline): Vec2D[][] {
  const points = [outer, ...holes].flat(),
    flat = points.flat(),
    starts: number[] = [];
  let at = outer.length;
  for (const hole of holes) {
    starts.push(at);
    at += hole.length;
  }
  const triangles = triangulate(flat, starts);
  let pieces: number[][] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const piece = [triangles[i], triangles[i + 1], triangles[i + 2]];
    if (Math.abs(cross(points[piece[0]], points[piece[1]], points[piece[2]])) > 1e-6) pieces.push(piece);
  }
  const turn = pieces.length ? Math.sign(cross(points[pieces[0][0]], points[pieces[0][1]], points[pieces[0][2]])) : 1,
    bends = (a: number, b: number, c: number) => cross(points[a], points[b], points[c]) * turn >= 0;
  for (let merged = true; merged; ) {
    merged = false;
    const owner = new Map<number, number>(),
      key = (a: number, b: number) => a * points.length + b;
    pieces.forEach((piece, p) => piece.forEach((v, k) => owner.set(key(v, piece[(k + 1) % piece.length]), p)));
    search: for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p];
      for (let k = 0; k < piece.length; k++) {
        const a = piece[k],
          b = piece[(k + 1) % piece.length],
          q = owner.get(key(b, a));
        if (q === undefined || q <= p) continue;
        // Join along a -> b: this piece from b round to a, then the other from a round to b, leaving out the shared ends.
        const other = pieces[q],
          from = other.indexOf(a),
          join = [
            ...Array.from({ length: piece.length }, (_, i) => piece[(k + 1 + i) % piece.length]),
            ...Array.from({ length: other.length - 2 }, (_, i) => other[(from + 1 + i) % other.length]),
          ],
          n = join.length,
          at = (v: number) => join.indexOf(v),
          convex = (v: number) => bends(join[(at(v) + n - 1) % n], v, join[(at(v) + 1) % n]);
        if (!convex(a) || !convex(b)) continue;
        pieces[p] = join;
        pieces = pieces.filter((_, i) => i !== q);
        merged = true;
        break search;
      }
    }
  }
  return pieces.map((piece) => piece.map((v) => points[v]));
}

/**
 * Colliders that follow a sprite's alpha, for `physics.addBody(sprite, {colliders})`. By default filled convex polygons
 * that keep a sprite's holes and hollows, so a ball can rest in a cup; `edges: true` gives closed polylines for terrain.
 * An image with nothing solid gives an empty array.
 * @example physics.addBody(sprite, {colliders: outlineColliders(imageData, {sprite, friction: 0.4})});
 * @throws TypeError or RangeError for an image that is not RGBA8 or options out of range.
 */
export function outlineColliders(image: AlphaImage, options: OutlineColliderOptions = {}): ColliderOptions2D[] {
  const { sprite, edges = false, threshold, tolerance, minArea, rect = sprite?.rect, ...settings } = options,
    outlines = traceOutlines(image, { threshold, tolerance, minArea, rect }),
    [, , w, h] = rect ?? [0, 0, image.width, image.height],
    sx = sprite?.scaleX ?? 1,
    sy = sprite?.scaleY ?? 1,
    px = (sprite?.pivotX ?? 0) * w,
    py = (sprite?.pivotY ?? 0) * h,
    place = (p: Vec2D): Vec2D => [(p[0] - px) * sx, (p[1] - py) * sy];
  const out: ColliderOptions2D[] = [];
  for (const outline of outlines) {
    if (edges)
      for (const loop of [outline.outer, ...outline.holes])
        out.push({ ...settings, shape: 'polyline', points: [...loop, loop[0]].map(place) });
    else for (const piece of convexPieces(outline)) out.push({ ...settings, shape: 'polygon', points: piece.map(place) });
  }
  return out;
}

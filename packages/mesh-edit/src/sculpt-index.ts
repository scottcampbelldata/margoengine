// Finds what a sculpt dab or pick touches without visiting the whole surface: faces around each vertex, a hash grid of
// vertices for the brush and a hash grid of triangles for rays. A BVH would need a whole-tree refit after every dab and a
// rebuild after every split, while a grid cell only changes when something crosses into it. Everything here is derived
// from the surface, so the session changes the surface and then says what it changed.
import type { Vec3 } from '@margoengine/math';
import type { SurfaceTri, TriSurface } from './tri-surface.js';

/** Cells each way from the grid's center. Coordinates past it share the last cell: still correct, only slower. */
const SPAN = 65536;
/** A triangle covering more cells than this is kept apart and tested by every ray. */
const LARGE_CELLS = 512;
/** Triangle boxes grow by this share of a cell, so rounding in a ray walk cannot step past a cell a triangle is in. */
const MARGIN = 1e-4;

const NOT_BINNED = 0,
  BINNED = 1,
  LARGE = 2;

const keyOf = (i: number, j: number, k: number): number => (i + SPAN) * 2 ** 34 + (j + SPAN) * 2 ** 17 + (k + SPAN);

function removeFrom(cells: Map<number, number[]>, key: number, item: number): void {
  const list = cells.get(key)!;
  if (list.length === 1) {
    cells.delete(key);
    return;
  }
  list[list.indexOf(item)] = list[list.length - 1];
  list.pop();
}

function addTo(cells: Map<number, number[]>, key: number, item: number): void {
  const list = cells.get(key);
  if (list) list.push(item);
  else cells.set(key, [item]);
}

export class SculptIndex {
  /** Faces around each vertex, in no particular order. */
  readonly around: number[][] = [];
  /** Vertices the last {@link SculptIndex.within} tested. */
  tested = 0;
  /** Live triangles. */
  live = 0;

  #surface: TriSurface;
  #size: number;
  #center: readonly number[];
  #vertexKey: number[] = [];
  #vertices = new Map<number, number[]>();
  /** Each triangle's corners as this index knows them, three a triangle, -1 when it has none. */
  #corners: number[] = [];
  /** Each triangle's state and cell box: state, then low and high cell on each axis. */
  #boxes: number[] = [];
  #triangles = new Map<number, number[]>();
  #large = new Set<number>();
  #stale = new Set<number>();
  #low = [Infinity, Infinity, Infinity];
  #high = [-Infinity, -Infinity, -Infinity];
  #seen: number[] = [];
  #walk = 0;

  constructor(surface: TriSurface, size: number) {
    this.#surface = surface;
    this.#size = size;
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (const tri of surface.tris)
      for (const v of tri.v)
        for (let k = 0; k < 3; k++) {
          low[k] = Math.min(low[k], surface.points[v][k]);
          high[k] = Math.max(high[k], surface.points[v][k]);
        }
    this.#center = low.map((x, k) => (x + high[k]) / 2);
    this.refresh(
      surface.tris.map((_, f) => f),
      [],
    );
    this.#stale.clear();
  }

  /** Triangles that are always tested, because they cover too many cells. */
  get large(): ReadonlySet<number> {
    return this.#large;
  }

  #cell(x: number, k: number): number {
    return Math.min(SPAN - 1, Math.max(-SPAN, Math.floor((x - this.#center[k]) / this.#size)));
  }

  /** Puts a vertex in its cell, or out of the grid when no triangle uses it. */
  #place(v: number): void {
    const have = this.#vertexKey[v] ?? -1,
      p = this.#surface.points[v],
      want = this.around[v]?.length ? keyOf(this.#cell(p[0], 0), this.#cell(p[1], 1), this.#cell(p[2], 2)) : -1;
    if (want === have) return;
    if (have >= 0) removeFrom(this.#vertices, have, v);
    if (want >= 0) addTo(this.#vertices, want, v);
    this.#vertexKey[v] = want;
  }

  /** A vertex moved. */
  moved(v: number): void {
    this.#place(v);
    this.#stale.add(v);
  }

  /** Triangles and vertices changed, in any way: added, removed, turned, moved. */
  refresh(faces: Iterable<number>, vertices: Iterable<number>): void {
    const { tris } = this.#surface,
      corners = this.#corners,
      changed = new Set<number>(vertices);
    for (const f of faces) {
      const tri = (tris[f] ?? null) as SurfaceTri | null,
        at = f * 3,
        had = corners[at] !== undefined && corners[at] >= 0;
      if (had && tri && tri.v[0] === corners[at] && tri.v[1] === corners[at + 1] && tri.v[2] === corners[at + 2]) continue;
      if (had) {
        this.live--;
        for (let c = 0; c < 3; c++) {
          const list = this.around[corners[at + c]];
          list[list.indexOf(f)] = list[list.length - 1];
          list.pop();
          changed.add(corners[at + c]);
        }
        corners[at] = -1;
      }
      if (tri) {
        this.live++;
        for (let c = 0; c < 3; c++) {
          const v = tri.v[c];
          (this.around[v] ??= []).push(f);
          corners[at + c] = v;
          changed.add(v);
        }
      }
      this.#bin(f);
    }
    for (const v of changed) {
      this.#place(v);
      this.#stale.add(v);
    }
  }

  /** Used vertices closer to `center` than `reach`, ascending. */
  within(center: Vec3, reach: number): number[] {
    const { points } = this.#surface,
      from = [0, 1, 2].map((k) => this.#cell(center[k] - reach, k)),
      to = [0, 1, 2].map((k) => this.#cell(center[k] + reach, k)),
      out: number[] = [];
    let tested = 0;
    const scan = (list: readonly number[]): void => {
      tested += list.length;
      for (const v of list) {
        const p = points[v];
        if (Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) < reach) out.push(v);
      }
    };
    if ((to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1) > this.#vertices.size)
      for (const list of this.#vertices.values()) scan(list);
    else
      for (let i = from[0]; i <= to[0]; i++)
        for (let j = from[1]; j <= to[1]; j++)
          for (let k = from[2]; k <= to[2]; k++) {
            const list = this.#vertices.get(keyOf(i, j, k));
            if (list) scan(list);
          }
    this.tested = tested;
    return out.sort((a, b) => a - b);
  }

  /** The faces around these vertices, ascending. */
  facesOf(vertices: Iterable<number>): number[] {
    const out = new Set<number>();
    for (const v of vertices) for (const f of this.around[v]) out.add(f);
    return [...out].sort((a, b) => a - b);
  }

  /** Brings the triangle grid up to date with moved vertices. Rays need it; dabs do not. */
  #settle(): void {
    for (const v of this.#stale) for (const f of this.around[v] ?? []) this.#bin(f);
    this.#stale.clear();
  }

  #bin(f: number): void {
    const { points, tris } = this.#surface,
      tri = (tris[f] ?? null) as SurfaceTri | null,
      boxes = this.#boxes,
      at = f * 7,
      box = [NOT_BINNED, 0, 0, 0, 0, 0, 0];
    if (tri) {
      const margin = this.#size * MARGIN;
      let cells = 1;
      for (let k = 0; k < 3; k++) {
        const a = points[tri.v[0]][k],
          b = points[tri.v[1]][k],
          c = points[tri.v[2]][k];
        box[1 + k] = this.#cell(Math.min(a, b, c) - margin, k);
        box[4 + k] = this.#cell(Math.max(a, b, c) + margin, k);
        cells *= box[4 + k] - box[1 + k] + 1;
      }
      box[0] = cells > LARGE_CELLS ? LARGE : BINNED;
    }
    const was = boxes[at] ?? NOT_BINNED;
    if (was === box[0] && (was !== BINNED || box.every((value, i) => boxes[at + i] === value))) return;
    if (was === LARGE) this.#large.delete(f);
    else if (was === BINNED) this.#eachCell(at, boxes, (key) => removeFrom(this.#triangles, key, f));
    for (let i = 0; i < 7; i++) boxes[at + i] = box[i];
    if (box[0] === LARGE) this.#large.add(f);
    else if (box[0] === BINNED) {
      this.#eachCell(at, boxes, (key) => addTo(this.#triangles, key, f));
      for (let k = 0; k < 3; k++) {
        this.#low[k] = Math.min(this.#low[k], box[1 + k]);
        this.#high[k] = Math.max(this.#high[k], box[4 + k]);
      }
    }
  }

  #eachCell(at: number, box: readonly number[], visit: (key: number) => void): void {
    for (let i = box[at + 1]; i <= box[at + 4]; i++)
      for (let j = box[at + 2]; j <= box[at + 5]; j++)
        for (let k = box[at + 3]; k <= box[at + 6]; k++) visit(keyOf(i, j, k));
  }

  /**
   * Walks a ray through the triangle grid from near to far, calling `visit` once for each triangle in a cell it crosses,
   * until a cell starts past `limit()`. Returns false when the walk would cost more than testing every triangle: the
   * caller does that instead.
   */
  walk(origin: Vec3, d: Vec3, visit: (f: number) => void, limit: () => number): boolean {
    this.#settle();
    if (!(this.#low[0] <= this.#high[0])) return true;
    if (this.#low.some((c) => c <= -SPAN) || this.#high.some((c) => c >= SPAN - 1)) return false;
    const size = this.#size,
      center = this.#center;
    let enter = 0,
      leave = Infinity;
    for (let k = 0; k < 3; k++) {
      const min = (this.#low[k] - 1) * size + center[k],
        max = (this.#high[k] + 2) * size + center[k];
      if (d[k] === 0) {
        if (origin[k] < min || origin[k] > max) return true;
        continue;
      }
      const a = (min - origin[k]) / d[k],
        b = (max - origin[k]) / d[k];
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
    if (enter > leave) return true;
    const cell = [0, 1, 2].map((k) =>
        Math.min(this.#high[k] + 1, Math.max(this.#low[k] - 1, this.#cell(origin[k] + d[k] * enter, k))),
      ),
      step = [0, 1, 2].map((k) => Math.sign(d[k])),
      budget = this.live,
      seen = this.#seen,
      walk = ++this.#walk;
    for (let steps = 0; ; steps++) {
      if (steps > budget) return false;
      const list = this.#triangles.get(keyOf(cell[0], cell[1], cell[2]));
      if (list)
        for (const f of list) {
          if (seen[f] === walk) continue;
          seen[f] = walk;
          visit(f);
        }
      let axis = -1,
        next = Infinity;
      for (let k = 0; k < 3; k++) {
        if (!step[k]) continue;
        const t = ((cell[k] + (step[k] > 0 ? 1 : 0)) * size + center[k] - origin[k]) / d[k];
        if (t < next) {
          next = t;
          axis = k;
        }
      }
      if (axis < 0 || next > leave || next > limit()) return true;
      cell[axis] += step[axis];
    }
  }
}

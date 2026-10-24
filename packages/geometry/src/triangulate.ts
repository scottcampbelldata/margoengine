import type { MutableVec2 } from './math.js';

// Polygon-with-holes triangulation by ear clipping.
//
// Method: D. Eberly, "Triangulation by Ear Clipping" (Geometric Tools, 2002). Each hole is joined to the boundary by a
// two-way bridge to a mutually visible vertex (§5: cast a ray from the hole's rightmost vertex, take the nearest edge
// hit, then the visible vertex of smallest angle inside the hit triangle), so the region becomes one weakly simple
// ring. Ears (a convex corner whose triangle holds no other ring vertex) are then cut off, best-shaped first. G.
// Meisters, "Polygons have ears" (Amer. Math. Monthly 82, 1975) guarantees that a simple polygon with more than three
// corners has at least two ears, and cutting an ear changes the ear status of its two neighbours only, so a correct
// ear test always makes progress. A uniform grid over the ring vertices keeps each ear test local.
//
// Touching rings: before bridging, edges are split where another ring's vertex lies inside them and pairs of opposite
// edges are removed, so holes sharing a side merge into one hole and a hole on the outer side becomes a notch. A hole
// that still touches the boundary at a corner is spliced in right there. Where the ring meets itself (a pinch), an ear
// must also have no edge of another copy of its corners reaching into it, nothing crossing its cut, and its centroid
// inside the ring.
//
// Robustness, in the spirit of M. Held, "FIST: Fast Industrial-Strength Triangulation of Polygons" (Algorithmica
// 30(4), 2001): when no ear passes the test (rounding, touching or self-intersecting rings) the clipper first removes
// opposite edge pairs left by earlier cuts and regroups, then escalates: drop straight corners, accept ears with
// vertices on their sides, split the ring along a valid diagonal, and finally cut convex corners unconditionally, so
// it always terminates. Orientation tests are plain floating-point signs.

/** Twice the signed area of triangle abc: > 0 when a, b, c turn counter-clockwise (y up). */
const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Edge tests the fallback searches (hole bridging by brute force, diagonal splits) may spend per call. */
const SEARCH_BUDGET = 2e7;

/** Linked ring vertices in growable parallel arrays. A vertex may appear as several nodes (bridge and split copies). */
class Nodes {
  size = 0;
  x = new Float64Array(0);
  y = new Float64Array(0);
  /** Input vertex index. */
  src = new Int32Array(0);
  prev = new Int32Array(0);
  next = new Int32Array(0);
  /** 1 while the node is part of a ring that still needs cutting. */
  live = new Uint8Array(0);
  /** Bumped whenever the node is reclassified, so stale heap entries can be skipped. */
  stamp = new Int32Array(0);
  /** Next node in the same grid cell. */
  link = new Int32Array(0);

  constructor(capacity: number) {
    this.reserve(capacity);
  }

  private reserve(capacity: number): void {
    const grow = <T extends Float64Array | Int32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
      const b = make(capacity);
      b.set(a);
      return b;
    };
    this.x = grow(this.x, (n) => new Float64Array(n));
    this.y = grow(this.y, (n) => new Float64Array(n));
    this.src = grow(this.src, (n) => new Int32Array(n));
    this.prev = grow(this.prev, (n) => new Int32Array(n));
    this.next = grow(this.next, (n) => new Int32Array(n));
    this.live = grow(this.live, (n) => new Uint8Array(n));
    this.stamp = grow(this.stamp, (n) => new Int32Array(n));
    this.link = grow(this.link, (n) => new Int32Array(n));
  }

  add(x: number, y: number, src: number): number {
    if (this.size === this.x.length) this.reserve(Math.max(16, this.size * 2));
    const i = this.size++;
    this.x[i] = x;
    this.y[i] = y;
    this.src[i] = src;
    this.prev[i] = this.next[i] = i;
    this.live[i] = 1;
    this.link[i] = -1;
    return i;
  }

  /** A second node at the same vertex (for bridges and splits). */
  copy(i: number): number {
    return this.add(this.x[i], this.y[i], this.src[i]);
  }

  same(i: number, j: number): boolean {
    return this.x[i] === this.x[j] && this.y[i] === this.y[j];
  }

  remove(i: number): void {
    const p = this.prev[i],
      n = this.next[i];
    this.next[p] = n;
    this.prev[n] = p;
    this.live[i] = 0;
  }

  ringLength(start: number): number {
    let count = 0,
      i = start;
    do {
      count++;
      i = this.next[i];
    } while (i !== start);
    return count;
  }

  /** Winding number of ring `start` around point (x, y) (not on the ring): +1 inside a counter-clockwise ring. */
  winding(start: number, x: number, y: number): number {
    let w = 0,
      e = start;
    do {
      const f = this.next[e],
        ey = this.y[e],
        fy = this.y[f];
      if (ey <= y) {
        if (fy > y && orient(this.x[e], ey, this.x[f], fy, x, y) > 0) w++;
      } else if (fy <= y && orient(this.x[e], ey, this.x[f], fy, x, y) < 0) w--;
      e = f;
    } while (e !== start);
    return w;
  }

  /** Like {@link inSector} but also true along either edge at `a`. */
  inSectorOrEdge(a: number, tx: number, ty: number): boolean {
    const ax = this.x[a],
      ay = this.y[a];
    for (const n of [this.prev[a], this.next[a]]) {
      const nx = this.x[n],
        ny = this.y[n];
      if (orient(ax, ay, nx, ny, tx, ty) === 0 && (nx - ax) * (tx - ax) + (ny - ay) * (ty - ay) > 0) return true;
    }
    return this.inSector(a, tx, ty);
  }

  /** Whether the direction from node `a` toward point (tx, ty) points strictly into the region at `a` (left side). */
  inSector(a: number, tx: number, ty: number): boolean {
    const p = this.prev[a],
      n = this.next[a],
      ax = this.x[a],
      ay = this.y[a],
      px = this.x[p],
      py = this.y[p],
      nx = this.x[n],
      ny = this.y[n];
    const left = orient(px, py, ax, ay, tx, ty),
      right = orient(ax, ay, nx, ny, tx, ty);
    // Along either edge is on the boundary, not inside.
    if (right === 0 && (nx - ax) * (tx - ax) + (ny - ay) * (ty - ay) > 0) return false;
    if (orient(ax, ay, px, py, tx, ty) === 0 && (px - ax) * (tx - ax) + (py - ay) * (ty - ay) > 0) return false;
    return orient(px, py, ax, ay, nx, ny) > 0 ? left > 0 && right > 0 : left > 0 || right > 0;
  }
}

/** Whether segment pq touches or crosses segment uv anywhere except at a point equal to p or q. */
function blocks(
  px: number,
  py: number,
  qx: number,
  qy: number,
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  overlap = true,
): boolean {
  if (Math.max(ux, vx) < Math.min(px, qx) || Math.min(ux, vx) > Math.max(px, qx)) return false;
  if (Math.max(uy, vy) < Math.min(py, qy) || Math.min(uy, vy) > Math.max(py, qy)) return false;
  const du = orient(px, py, qx, qy, ux, uy),
    dv = orient(px, py, qx, qy, vx, vy),
    dp = orient(ux, uy, vx, vy, px, py),
    dq = orient(ux, uy, vx, vy, qx, qy);
  if (((du > 0 && dv < 0) || (du < 0 && dv > 0)) && ((dp > 0 && dq < 0) || (dp < 0 && dq > 0))) return true;
  if (overlap && du === 0 && dv === 0) {
    // Collinear: any shared stretch of positive length blocks (a bridge must not run along an edge).
    const alongX = Math.abs(qx - px) >= Math.abs(qy - py),
      s0 = alongX ? Math.min(px, qx) : Math.min(py, qy),
      s1 = alongX ? Math.max(px, qx) : Math.max(py, qy),
      e0 = alongX ? Math.min(ux, vx) : Math.min(uy, vy),
      e1 = alongX ? Math.max(ux, vx) : Math.max(uy, vy);
    if (Math.min(s1, e1) > Math.max(s0, e0)) return true;
  }
  const isEnd = (x: number, y: number) => (x === px && y === py) || (x === qx && y === qy);
  const within = (x: number, y: number, ax: number, ay: number, bx: number, by: number) =>
    x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by);
  // An edge endpoint lying on pq (other than at p or q) blocks it.
  if (du === 0 && !isEnd(ux, uy) && within(ux, uy, px, py, qx, qy)) return true;
  if (dv === 0 && !isEnd(vx, vy) && within(vx, vy, px, py, qx, qy)) return true;
  // p or q lying inside the edge (not at its ends) blocks it too.
  const atEdgeEnd = (x: number, y: number) => (x === ux && y === uy) || (x === vx && y === vy);
  if (dp === 0 && !atEdgeEnd(px, py) && within(px, py, ux, uy, vx, vy)) return true;
  if (dq === 0 && !atEdgeEnd(qx, qy) && within(qx, qy, ux, uy, vx, vy)) return true;
  return false;
}

/** Uniform grid of nodes for the ear test; dead nodes are unlinked lazily while scanning. */
class Grid {
  readonly head: Int32Array;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minY: number;
  readonly sx: number;
  readonly sy: number;

  constructor(
    private readonly nodes: Nodes,
    count: number,
  ) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < nodes.size; i++) {
      if (!nodes.live[i]) continue;
      const x = nodes.x[i],
        y = nodes.y[i];
      if (Number.isFinite(x)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      if (Number.isFinite(y)) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!(maxX >= minX)) minX = maxX = 0;
    if (!(maxY >= minY)) minY = maxY = 0;
    const w = maxX - minX,
      h = maxY - minY,
      // About two vertices per cell.
      target = Math.max(1, Math.ceil(count / 2));
    let cols = 1,
      rows = 1;
    if (w > 0 && h > 0) {
      cols = Math.min(target, Math.max(1, Math.round(Math.sqrt((target * w) / h))));
      rows = Math.min(target, Math.max(1, Math.round(target / cols)));
    } else if (w > 0) cols = target;
    else if (h > 0) rows = target;
    this.cols = cols;
    this.rows = rows;
    this.minX = minX;
    this.minY = minY;
    this.sx = w > 0 ? cols / w : 0;
    this.sy = h > 0 ? rows / h : 0;
    this.head = new Int32Array(cols * rows).fill(-1);
    for (let i = 0; i < nodes.size; i++) if (nodes.live[i]) this.insert(i);
  }

  col(x: number): number {
    const c = ((x - this.minX) * this.sx) | 0;
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  row(y: number): number {
    const r = ((y - this.minY) * this.sy) | 0;
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  insert(i: number): void {
    const cell = this.row(this.nodes.y[i]) * this.cols + this.col(this.nodes.x[i]);
    this.nodes.link[i] = this.head[cell];
    this.head[cell] = i;
  }

  /** Calls `visit` for every live node in the cells overlapping the box. */
  visit(minX: number, maxX: number, minY: number, maxY: number, visit: (node: number) => void): void {
    const c0 = this.col(minX),
      c1 = this.col(maxX),
      r0 = this.row(minY),
      r1 = this.row(maxY);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        for (let q = this.head[r * this.cols + c]; q >= 0; q = this.nodes.link[q]) if (this.nodes.live[q]) visit(q);
  }

  /**
   * Whether a live node other than a, b, c (and not at their positions) lies in triangle abc (counter-clockwise).
   * `strict` counts points on the sides; otherwise only points strictly inside block.
   */
  occupied(a: number, b: number, c: number, strict: boolean): boolean {
    const { nodes } = this,
      X = nodes.x,
      Y = nodes.y,
      live = nodes.live,
      link = nodes.link;
    const ax = X[a],
      ay = Y[a],
      bx = X[b],
      by = Y[b],
      cx = X[c],
      cy = Y[c];
    const minX = Math.min(ax, bx, cx),
      maxX = Math.max(ax, bx, cx),
      minY = Math.min(ay, by, cy),
      maxY = Math.max(ay, by, cy);
    const c0 = this.col(minX),
      c1 = this.col(maxX),
      r0 = this.row(minY),
      r1 = this.row(maxY);
    let pinched = false;
    for (let r = r0; r <= r1; r++)
      for (let col = c0; col <= c1; col++) {
        const cell = r * this.cols + col;
        let before = -1,
          q = this.head[cell];
        while (q >= 0) {
          const after = link[q];
          if (!live[q]) {
            if (before < 0) this.head[cell] = after;
            else link[before] = after;
            q = after;
            continue;
          }
          before = q;
          const id = q,
            qx = X[q],
            qy = Y[q];
          q = after;
          if (qx < minX || qx > maxX || qy < minY || qy > maxY) continue;
          const atA = qx === ax && qy === ay,
            atB = qx === bx && qy === by,
            atC = qx === cx && qy === cy;
          if (atA || atB || atC) {
            if (id === a || id === b || id === c) continue;
            // Another copy of a corner (a pinch where the ring meets itself): if one of its edges runs into the
            // triangle, the triangle is not all region. Edges along the sides are settled by the checks below.
            const qp = nodes.prev[id],
              qn = nodes.next[id];
            pinched = true;
            for (const r of [qp, qn]) {
              const rx = X[r],
                ry = Y[r],
                ab = orient(ax, ay, bx, by, rx, ry),
                bc = orient(bx, by, cx, cy, rx, ry),
                ca = orient(cx, cy, ax, ay, rx, ry);
              if (atA ? ab > 0 && ca > 0 : atB ? ab > 0 && bc > 0 : bc > 0 && ca > 0) return true;
            }
            continue;
          }
          const o1 = orient(ax, ay, bx, by, qx, qy),
            o2 = orient(bx, by, cx, cy, qx, qy),
            o3 = orient(cx, cy, ax, ay, qx, qy);
          if (strict ? o1 >= 0 && o2 >= 0 && o3 >= 0 : o1 > 0 && o2 > 0 && o3 > 0) return true;
        }
      }
    // At a pinch the local tests cannot see a hole enclosed by edges of neighbouring holes (holes sharing edges):
    // the triangle must then also lie inside the ring, judged by the winding number at its centroid.
    // At a pinch, or when vertices on the sides are let through, local tests cannot see everything: edges of
    // neighbouring holes may cross the cut a -> c, or enclose a hole between edges that share the triangle's sides
    // (holes sharing edges). The triangle is then accepted only if nothing touches the open cut and its centroid is
    // inside the ring (with nothing reaching into it, the interior is one face of the arrangement).
    if (!pinched && strict) return false;
    let e = a;
    do {
      const f = nodes.next[e];
      if (blocks(ax, ay, cx, cy, X[e], Y[e], X[f], Y[f], false)) return true;
      e = f;
    } while (e !== a);
    return nodes.winding(a, (ax + bx + cx) / 3, (ay + by + cy) / 3) !== 1;
  }
}

/** Max-heap of candidate ears keyed by shape quality (drops first), with stale entries skipped on pop. */
class EarHeap {
  private keys: number[] = [];
  private ids: number[] = [];
  private stamps: number[] = [];

  clear(): void {
    this.keys.length = this.ids.length = this.stamps.length = 0;
  }

  private above(i: number, j: number): boolean {
    const a = this.keys[i],
      b = this.keys[j];
    return a > b || (a === b && this.ids[i] < this.ids[j]);
  }

  private swap(i: number, j: number): void {
    const { keys, ids, stamps } = this;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    [ids[i], ids[j]] = [ids[j], ids[i]];
    [stamps[i], stamps[j]] = [stamps[j], stamps[i]];
  }

  push(key: number, id: number, stamp: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.ids.push(id);
    this.stamps.push(stamp);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.above(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** The best current ear, or -1 when none is left. */
  pop(nodes: Nodes): number {
    const { keys, ids, stamps } = this;
    while (keys.length) {
      const id = ids[0],
        stamp = stamps[0],
        end = keys.length - 1;
      this.swap(0, end);
      keys.pop();
      ids.pop();
      stamps.pop();
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let best = i;
        if (l < keys.length && this.above(l, best)) best = l;
        if (r < keys.length && this.above(r, best)) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
      if (nodes.live[id] && nodes.stamp[id] === stamp) return id;
    }
    return -1;
  }
}

/** Escalation levels when no ear is found. */
const enum Level {
  Strict = 0,
  DropStraight = 1,
  Relaxed = 2,
  Split = 3,
  Forced = 4,
}

interface Context {
  nodes: Nodes;
  grid: Grid;
  heap: EarHeap;
  out: number[];
  budget: number;
  /** Stuck-ring recoveries left (bounds the work on pathological input). */
  untangles: number;
}

/** Ear priority of a node: -1 not an ear, Infinity a zero-area corner to drop, else a quality in (0, 1]. */
function classify(ctx: Context, i: number, level: Level): number {
  const { nodes } = ctx,
    X = nodes.x,
    Y = nodes.y,
    p = nodes.prev[i],
    n = nodes.next[i];
  const o = orient(X[p], Y[p], X[i], Y[i], X[n], Y[n]);
  if (o > 0) {
    if (ctx.grid.occupied(p, i, n, level < Level.Relaxed)) return -1;
    // Area over the sum of squared sides, scaled so an equilateral triangle scores 1.
    const ab = (X[i] - X[p]) ** 2 + (Y[i] - Y[p]) ** 2,
      bc = (X[n] - X[i]) ** 2 + (Y[n] - Y[i]) ** 2,
      ca = (X[p] - X[n]) ** 2 + (Y[p] - Y[n]) ** 2;
    return (o * 2 * Math.sqrt(3)) / (ab + bc + ca);
  }
  if (o < 0) return -1;
  // Zero (or NaN) area. A straight corner is kept at first (it can still be a triangle corner); spikes go.
  if (o === 0 && level === Level.Strict && (X[i] - X[p]) * (X[n] - X[i]) + (Y[i] - Y[p]) * (Y[n] - Y[i]) > 0) return -1;
  return Infinity;
}

function push(ctx: Context, i: number, level: Level): void {
  const stamp = ++ctx.nodes.stamp[i],
    key = classify(ctx, i, level);
  if (key >= 0) ctx.heap.push(key, i, stamp);
}

function emit(ctx: Context, a: number, b: number, c: number): void {
  const src = ctx.nodes.src;
  ctx.out.push(src[a], src[b], src[c]);
}

/** Finds a diagonal ab of the ring that lies inside it and crosses no edge, within the search budget. */
function findDiagonal(ctx: Context, start: number): [number, number] | null {
  const { nodes } = ctx,
    X = nodes.x,
    Y = nodes.y;
  let a = start;
  do {
    for (let b = nodes.next[nodes.next[a]]; b !== nodes.prev[a]; b = nodes.next[b]) {
      if (nodes.same(a, b) || !nodes.inSector(a, X[b], Y[b]) || !nodes.inSector(b, X[a], Y[a])) continue;
      let clear = true,
        e = start;
      do {
        const f = nodes.next[e];
        if (--ctx.budget < 0) return null;
        if (blocks(X[a], Y[a], X[b], Y[b], X[e], Y[e], X[f], Y[f])) {
          clear = false;
          break;
        }
        e = f;
      } while (e !== start);
      if (clear && nodes.winding(start, (X[a] + X[b]) / 2, (Y[a] + Y[b]) / 2) === 1) return [a, b];
    }
    a = nodes.next[a];
  } while (a !== start);
  return null;
}

/**
 * Recovers a stuck ring whose cuts have left doubled opposite edges (a seam along a hole that touches the ring at
 * both ends): removes them, sorts the pieces into outer rings and holes again, rejoins the holes and queues the
 * outer rings. Returns false when there was nothing to remove.
 */
function untangle(ctx: Context, start: number, pending: number[]): boolean {
  const { nodes } = ctx,
    size = nodes.ringLength(start),
    rings = cancelSharedEdges(nodes, [start]);
  if (rings.length === 1 && nodes.ringLength(rings[0]) === size) return false;
  const before = nodes.size;
  for (const [outer, holes] of groupRings(nodes, rings)) {
    if (holes.length) joinHoles(ctx, outer, holes);
    pending.push(outer);
  }
  for (let i = before; i < nodes.size; i++) if (nodes.live[i]) ctx.grid.insert(i);
  return true;
}

/** Cuts one ring into triangles; rings split off along diagonals go onto `pending`. */
function clipRing(ctx: Context, start: number, pending: number[]): void {
  const { nodes, heap } = ctx,
    X = nodes.x,
    Y = nodes.y;
  let size = nodes.ringLength(start),
    level = Level.Strict,
    cursor = start;
  const scan = () => {
    heap.clear();
    let i = cursor;
    do {
      push(ctx, i, level);
      i = nodes.next[i];
    } while (i !== cursor);
  };
  scan();
  while (size > 3) {
    if (level === Level.Forced) {
      // Last resort for invalid rings: cut any convex corner, drop flat ones, and drop a reflex one after a full lap.
      // A ring that has turned inside out (no positive area left) holds nothing to fill.
      if (!(ringArea(nodes, cursor) > 0)) {
        let i = cursor;
        do {
          nodes.live[i] = 0;
          i = nodes.next[i];
        } while (i !== cursor);
        return;
      }
      let lap = 0;
      while (size > 3) {
        const i = cursor,
          p = nodes.prev[i],
          n = nodes.next[i],
          o = orient(X[p], Y[p], X[i], Y[i], X[n], Y[n]);
        if (o > 0 || !(o < 0) || ++lap > size) {
          if (o > 0) emit(ctx, p, i, n);
          nodes.remove(i);
          size--;
          lap = 0;
        }
        cursor = n;
      }
      break;
    }
    const i = heap.pop(nodes);
    if (i < 0) {
      if (level === Level.Strict && ctx.untangles > 0) {
        ctx.untangles--;
        if (untangle(ctx, cursor, pending)) return;
      }
      if (level === Level.Split) {
        // Try to cut the ring in two along an inside diagonal.
        const diagonal = findDiagonal(ctx, cursor);
        if (!diagonal) {
          level = Level.Forced;
          continue;
        }
        const [a, b] = diagonal,
          a2 = nodes.copy(a),
          b2 = nodes.copy(b),
          an = nodes.next[a],
          bp = nodes.prev[b];
        nodes.next[a] = b;
        nodes.prev[b] = a;
        nodes.next[a2] = an;
        nodes.prev[an] = a2;
        nodes.next[b2] = a2;
        nodes.prev[a2] = b2;
        nodes.next[bp] = b2;
        nodes.prev[b2] = bp;
        ctx.grid.insert(a2);
        ctx.grid.insert(b2);
        pending.push(a2);
        cursor = a;
        size = nodes.ringLength(a);
        level = Level.Strict;
        scan();
        continue;
      }
      level++;
      if (level < Level.Split) scan();
      continue;
    }
    const p = nodes.prev[i],
      n = nodes.next[i];
    if (orient(X[p], Y[p], X[i], Y[i], X[n], Y[n]) > 0) emit(ctx, p, i, n);
    nodes.remove(i);
    size--;
    cursor = n;
    push(ctx, p, level);
    push(ctx, n, level);
  }
  if (size === 3) {
    const p = nodes.prev[cursor],
      n = nodes.next[cursor];
    if (orient(X[p], Y[p], X[cursor], Y[cursor], X[n], Y[n]) > 0) emit(ctx, p, cursor, n);
    nodes.live[p] = nodes.live[cursor] = nodes.live[n] = 0;
  }
}

/** Vertex indices of ring [from, to) without consecutive repeats or closing repeats of the first point. */
function cleanRing(data: ArrayLike<number>, dim: number, from: number, to: number): number[] {
  const ring: number[] = [];
  for (let v = from; v < to; v++) {
    const last = ring[ring.length - 1];
    if (last !== undefined && data[v * dim] === data[last * dim] && data[v * dim + 1] === data[last * dim + 1])
      continue;
    ring.push(v);
  }
  while (
    ring.length > 1 &&
    data[ring[0] * dim] === data[ring[ring.length - 1] * dim] &&
    data[ring[0] * dim + 1] === data[ring[ring.length - 1] * dim + 1]
  )
    ring.pop();
  return ring;
}

function ringArea2(data: ArrayLike<number>, dim: number, ring: readonly number[]): number {
  let sum = 0;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++)
    sum += data[ring[j] * dim] * data[ring[k] * dim + 1] - data[ring[k] * dim] * data[ring[j] * dim + 1];
  return sum;
}

/** Links ring vertices into a circular node list, reversed when `reverse`; returns its first node. */
function linkRing(
  nodes: Nodes,
  data: ArrayLike<number>,
  dim: number,
  ring: readonly number[],
  reverse: boolean,
): number {
  let first = -1,
    last = -1;
  for (let k = 0; k < ring.length; k++) {
    const v = ring[reverse ? ring.length - 1 - k : k],
      i = nodes.add(data[v * dim], data[v * dim + 1], v);
    if (first < 0) first = i;
    else {
      nodes.next[last] = i;
      nodes.prev[i] = last;
    }
    last = i;
  }
  nodes.next[last] = first;
  nodes.prev[first] = last;
  return first;
}

interface Hole {
  start: number;
  /** Node with the largest x (smallest y on ties). */
  right: number;
}

/** Whether the bridge from hole node m to boundary node p is inside the region and crosses nothing. */
function bridgeClear(nodes: Nodes, m: number, p: number, rings: readonly number[]): boolean {
  const X = nodes.x,
    Y = nodes.y,
    mx = X[m],
    my = Y[m],
    px = X[p],
    py = Y[p];
  if (!nodes.inSector(p, mx, my) || !nodes.inSector(m, px, py)) return false;
  for (const start of rings) {
    let e = start;
    do {
      const f = nodes.next[e];
      if (blocks(mx, my, px, py, X[e], Y[e], X[f], Y[f])) return false;
      e = f;
    } while (e !== start);
  }
  // Nothing touches the open bridge, so its midpoint tells whether all of it is in the region (this catches a
  // bridge slipping into a hole that touches the target vertex from another side).
  let w = 0;
  for (const start of rings) w += nodes.winding(start, (mx + px) / 2, (my + py) / 2);
  return w === 1;
}

/**
 * Joins a hole that touches the boundary at a shared vertex right there (swapping the two copies' successors) when the hole's corner
 * fits inside the region wedge of one boundary copy of that vertex (and the boundary's edges stay outside the hole).
 * Bridging such a hole elsewhere would leave its copy of the shared vertex claiming the wedges of its neighbours.
 */
function joinAtPinch(nodes: Nodes, at: Map<string, number[]>, merged: Uint8Array, hole: number): boolean {
  const X = nodes.x,
    Y = nodes.y;
  let h = hole;
  do {
    for (const c of at.get(`${X[h]} ${Y[h]}`) ?? []) {
      if (!merged[c]) continue;
      const hp = nodes.prev[h],
        hn = nodes.next[h],
        cp = nodes.prev[c],
        cn = nodes.next[c];
      // A direction into the hole at this corner (bisector of its two edges, flipped at a reflex corner).
      const ux = X[hp] - X[h],
        uy = Y[hp] - Y[h],
        vx = X[hn] - X[h],
        vy = Y[hn] - Y[h],
        ul = Math.hypot(ux, uy),
        vl = Math.hypot(vx, vy);
      let dx = ux / ul + vx / vl,
        dy = uy / ul + vy / vl;
      const turn = orient(X[hp], Y[hp], X[h], Y[h], X[hn], Y[hn]);
      if (turn === 0) [dx, dy] = [vy / vl, -vx / vl];
      else if (turn > 0) [dx, dy] = [-dx, -dy];
      if (
        nodes.inSector(c, X[h] + dx, Y[h] + dy) &&
        nodes.inSectorOrEdge(c, X[hp], Y[hp]) &&
        nodes.inSectorOrEdge(c, X[hn], Y[hn]) &&
        nodes.inSectorOrEdge(h, X[cp], Y[cp]) &&
        nodes.inSectorOrEdge(h, X[cn], Y[cn])
      ) {
        // Swap successors: the ring runs cp -> c -> (around the hole) -> hp -> h -> cn.
        nodes.next[c] = hn;
        nodes.prev[hn] = c;
        nodes.next[h] = cn;
        nodes.prev[cn] = h;
        return true;
      }
    }
    h = nodes.next[h];
  } while (h !== hole);
  return false;
}

/** Splices hole node m into the boundary at node p with a two-way bridge. */
function bridge(nodes: Nodes, m: number, p: number): void {
  const m2 = nodes.copy(m),
    p2 = nodes.copy(p),
    pn = nodes.next[p],
    mp = nodes.prev[m];
  nodes.next[p] = m;
  nodes.prev[m] = p;
  nodes.next[mp] = m2;
  nodes.prev[m2] = mp;
  nodes.next[m2] = p2;
  nodes.prev[p2] = m2;
  nodes.next[p2] = pn;
  nodes.prev[pn] = p2;
}

/** Eberly's visible vertex for hole node m: ray to +x, nearest hit, then smallest angle inside the hit triangle. */
function rayCandidates(nodes: Nodes, outer: number, m: number): number[] {
  const X = nodes.x,
    Y = nodes.y,
    mx = X[m],
    my = Y[m];
  let best = Infinity,
    hitVertex = -1,
    hitA = -1,
    hitB = -1,
    a = outer;
  do {
    const b = nodes.next[a],
      ax = X[a],
      ay = Y[a],
      bx = X[b],
      by = Y[b];
    if (ay === my && ax > mx && ax <= best) {
      if (ax < best || hitVertex < 0) hitVertex = a;
      best = ax;
    }
    if ((ay < my && by > my) || (ay > my && by < my)) {
      const x = ax + ((my - ay) * (bx - ax)) / (by - ay);
      if (x > mx && x < best) {
        best = x;
        hitVertex = -1;
        hitA = a;
        hitB = b;
      }
    }
    a = b;
  } while (a !== outer);
  if (best === Infinity) return [];
  let tx: number, ty: number;
  if (hitVertex >= 0) {
    tx = X[hitVertex];
    ty = Y[hitVertex];
  } else {
    const p = X[hitA] >= X[hitB] ? hitA : hitB;
    tx = X[p];
    ty = Y[p];
    // A boundary vertex inside triangle (m, hit, p) may hide p; take the one closest in angle to the ray.
    let bestDy = Math.abs(ty - my),
      bestDx = tx - mx,
      r = outer;
    do {
      const rx = X[r],
        ry = Y[r],
        dx = rx - mx;
      if (dx > 0 && !(rx === tx && ry === ty)) {
        const o1 = orient(mx, my, best, my, rx, ry),
          o2 = orient(best, my, tx, ty, rx, ry),
          o3 = orient(tx, ty, mx, my, rx, ry);
        if ((o1 >= 0 && o2 >= 0 && o3 >= 0) || (o1 <= 0 && o2 <= 0 && o3 <= 0)) {
          const dy = Math.abs(ry - my),
            lhs = dy * bestDx,
            rhs = bestDy * dx;
          if (lhs < rhs || (lhs === rhs && dx < bestDx)) {
            bestDy = dy;
            bestDx = dx;
            tx = rx;
            ty = ry;
          }
        }
      }
      r = nodes.next[r];
    } while (r !== outer);
  }
  const copies: number[] = [];
  let c = outer;
  do {
    if (X[c] === tx && Y[c] === ty) copies.push(c);
    c = nodes.next[c];
  } while (c !== outer);
  return copies;
}

/** Joins every hole to the outer ring, rightmost holes first. Holes that cannot be joined are dropped. */
function joinHoles(ctx: { nodes: Nodes; budget: number }, outer: number, holes: Hole[]): void {
  const { nodes } = ctx,
    X = nodes.x,
    Y = nodes.y;
  holes.sort((a, b) => X[b.right] - X[a.right] || a.start - b.start);
  // Nodes by position, and which of them are already on the boundary, for joins at shared vertices.
  const at = new Map<string, number[]>(),
    merged = new Uint8Array(nodes.size + 2 * holes.length),
    place = (i: number) => {
      const k = `${X[i]} ${Y[i]}`,
        list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    },
    absorb = (start: number) => {
      let i = start;
      do {
        merged[i] = 1;
        i = nodes.next[i];
      } while (i !== start);
    };
  for (const start of [outer, ...holes.map((o) => o.start)]) {
    let i = start;
    do {
      place(i);
      i = nodes.next[i];
    } while (i !== start);
  }
  absorb(outer);
  for (let h = 0; h < holes.length; h++) {
    const hole = holes[h],
      rings = [outer, ...holes.slice(h).map((o) => o.start)],
      before = nodes.size;
    let joined = joinAtPinch(nodes, at, merged, hole.start);
    // Otherwise the ray-cast vertex (a single linear pass, not budgeted).
    if (!joined)
      for (const p of rayCandidates(nodes, outer, hole.right)) {
        if (bridgeClear(nodes, hole.right, p, rings)) {
          bridge(nodes, hole.right, p);
          joined = true;
          break;
        }
      }
    if (!joined && Number.isFinite(X[hole.right])) {
      // Rounding or touching rings defeated the ray cast: try hole corners from the right against boundary vertices
      // in order of distance, within the search budget.
      const corners: number[] = [];
      let i = hole.start;
      do {
        corners.push(i);
        i = nodes.next[i];
      } while (i !== hole.start);
      corners.sort((a, b) => X[b] - X[a] || Y[a] - Y[b] || a - b);
      const boundary: number[] = [];
      i = outer;
      do {
        boundary.push(i);
        i = nodes.next[i];
      } while (i !== outer);
      search: for (const m of corners) {
        const near = boundary
          .filter((p) => !nodes.same(p, m))
          .map((p) => [(X[p] - X[m]) ** 2 + (Y[p] - Y[m]) ** 2, p] as const)
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [, p] of near) {
          if ((ctx.budget -= nodes.size) < 0) break search;
          if (bridgeClear(nodes, m, p, rings)) {
            bridge(nodes, m, p);
            joined = true;
            break search;
          }
        }
      }
    }
    if (joined) {
      absorb(hole.start);
      for (let i = before; i < nodes.size; i++) {
        merged[i] = 1;
        place(i);
      }
    } else {
      // Not connected (e.g. outside the outer ring): leave it out.
      let i = hole.start;
      do {
        nodes.live[i] = 0;
        i = nodes.next[i];
      } while (i !== hole.start);
    }
  }
}

/** Adds a single interior point as a vertex by splitting the triangle (or the two triangles) it lies in. */
function insertPoint(out: number[], data: ArrayLike<number>, dim: number, s: number): void {
  const sx = data[s * dim],
    sy = data[s * dim + 1],
    x = (v: number) => data[v * dim],
    y = (v: number) => data[v * dim + 1];
  for (let t = 0; t < out.length; t += 3) {
    const a = out[t],
      b = out[t + 1],
      c = out[t + 2];
    const o = [
      orient(x(a), y(a), x(b), y(b), sx, sy),
      orient(x(b), y(b), x(c), y(c), sx, sy),
      orient(x(c), y(c), x(a), y(a), sx, sy),
    ];
    if (!(o[0] >= 0 && o[1] >= 0 && o[2] >= 0)) continue;
    const zeros = (o[0] === 0 ? 1 : 0) + (o[1] === 0 ? 1 : 0) + (o[2] === 0 ? 1 : 0);
    if (zeros === 0) {
      out[t + 2] = s;
      out.push(b, c, s, c, a, s);
      return;
    }
    if (zeros > 1) return; // already a vertex
    // On a side: rotate so the side is u -> v, then split this triangle and the one across the side.
    const k = o.indexOf(0),
      tri = [a, b, c],
      u = tri[k],
      v = tri[(k + 1) % 3],
      w = tri[(k + 2) % 3];
    out[t] = v;
    out[t + 1] = w;
    out[t + 2] = s;
    out.push(w, u, s);
    for (let q = 0; q < out.length; q += 3) {
      if (q === t) continue;
      for (let j = 0; j < 3; j++) {
        const e0 = out[q + j],
          e1 = out[q + ((j + 1) % 3)],
          e2 = out[q + ((j + 2) % 3)];
        if (x(e0) === x(v) && y(e0) === y(v) && x(e1) === x(u) && y(e1) === y(u)) {
          out[q] = e1;
          out[q + 1] = e2;
          out[q + 2] = s;
          out.push(e2, e0, s);
          return;
        }
      }
    }
    return;
  }
}

/**
 * Triangulates a flat polygon with holes. `data` holds the outer ring then each hole ring, `dim` numbers per vertex
 * (only the first two, x and y, are read). `holeIndices` are the starting vertex indices of each hole, in order.
 * Returns vertex-index triples, each counter-clockwise (positive area in a y-up frame). Ring orientation in the
 * input does not matter. Collinear and repeated corners may be left out of the output.
 *
 * A hole with a single point is an interior (Steiner) point that becomes a vertex of the triangulation. Holes that
 * cannot be connected to the outer ring are ignored; degenerate input (fewer than three distinct points, zero area)
 * gives `[]`. Self-intersecting rings still terminate with a best-effort result.
 *
 * @param data - Vertex coordinates, `dim` numbers per vertex (plain or typed array).
 * @param holeIndices - Start vertex of each hole ring, non-decreasing; equal entries are empty holes.
 * @param dim - Numbers per vertex, an integer of 2 or more.
 * @returns A new array of vertex indices, three per counter-clockwise triangle.
 * @throws RangeError when `dim` or a hole index is invalid.
 */
export function triangulate(data: ArrayLike<number>, holeIndices: ArrayLike<number> = [], dim = 2): number[] {
  if (typeof dim !== 'number' || !Number.isSafeInteger(dim) || dim < 2)
    throw new RangeError('triangulate: dim must be an integer of 2 or more; pass the count of numbers per vertex');
  const length = data.length,
    holeCount = holeIndices.length;
  let previous = 0;
  for (let h = 0; h < holeCount; h++) {
    const start = holeIndices[h];
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < previous || start * dim > length)
      throw new RangeError(
        'triangulate: hole start indices must be non-decreasing whole vertex indices within the data; fix holeIndices',
      );
    previous = start;
  }
  const vertexCount = Math.floor(length / dim),
    outerRing = cleanRing(data, dim, 0, holeCount ? holeIndices[0] : vertexCount);
  if (outerRing.length < 3) return [];
  const outerArea = ringArea2(data, dim, outerRing);
  if (outerArea === 0) return [];

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const v of outerRing) {
    const x = data[v * dim],
      y = data[v * dim + 1];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const nodes = new Nodes(vertexCount + 2 * holeCount + 8),
    // Outer ring counter-clockwise, holes clockwise: the region is always on the left.
    rings = [linkRing(nodes, data, dim, outerRing, outerArea < 0)],
    steiner: number[] = [];
  for (let h = 0; h < holeCount; h++) {
    const ring = cleanRing(data, dim, holeIndices[h], h + 1 < holeCount ? holeIndices[h + 1] : vertexCount);
    if (ring.length === 1) {
      steiner.push(ring[0]);
      continue;
    }
    if (ring.length < 3) continue;
    const area = ringArea2(data, dim, ring);
    if (!(Math.abs(area) > 0)) continue;
    let hx0 = Infinity,
      hx1 = -Infinity,
      hy0 = Infinity,
      hy1 = -Infinity;
    for (const v of ring) {
      hx0 = Math.min(hx0, data[v * dim]);
      hx1 = Math.max(hx1, data[v * dim]);
      hy0 = Math.min(hy0, data[v * dim + 1]);
      hy1 = Math.max(hy1, data[v * dim + 1]);
    }
    if (hx0 > maxX || hx1 < minX || hy0 > maxY || hy1 < minY) continue; // cannot be inside the outer ring
    rings.push(linkRing(nodes, data, dim, ring, area > 0));
  }

  const ctx: Context = {
    nodes,
    grid: undefined as unknown as Grid,
    heap: new EarHeap(),
    out: [],
    budget: SEARCH_BUDGET,
    untangles: vertexCount + 16,
  };
  // Rings that touch along edges (holes sharing a side, a hole on the outer boundary) are merged first: their shared
  // stretches are split at common vertices and the doubled, opposite edges removed, so only true pinches remain.
  if (rings.length > 1) splitTouchingEdges(ctx, rings);
  const pending: number[] = [];
  for (const [outer, holes] of groupRings(nodes, cancelSharedEdges(nodes, rings))) {
    if (holes.length) joinHoles(ctx, outer, holes);
    pending.push(outer);
  }
  let live = 0;
  for (let i = 0; i < nodes.size; i++) live += nodes.live[i];
  ctx.grid = new Grid(nodes, live);
  while (pending.length) clipRing(ctx, pending.pop() as number, pending);
  for (const s of steiner) insertPoint(ctx.out, data, dim, s);
  return ctx.out;
}

/** Inserts a vertex wherever a ring vertex lies inside another edge (a T-junction), within the search budget. */
function splitTouchingEdges(ctx: Context, rings: readonly number[]): void {
  const { nodes } = ctx,
    X = nodes.x,
    Y = nodes.y;
  let count = 0;
  for (const start of rings) count += nodes.ringLength(start);
  const grid = new Grid(nodes, count),
    splits: [number, number, number][] = [];
  for (const start of rings) {
    let e = start;
    do {
      const f = nodes.next[e],
        ex = X[e],
        ey = Y[e],
        fx = X[f],
        fy = Y[f],
        length2 = (fx - ex) ** 2 + (fy - ey) ** 2;
      grid.visit(Math.min(ex, fx), Math.max(ex, fx), Math.min(ey, fy), Math.max(ey, fy), (q) => {
        ctx.budget--;
        const qx = X[q],
          qy = Y[q];
        if ((qx === ex && qy === ey) || (qx === fx && qy === fy) || orient(ex, ey, fx, fy, qx, qy) !== 0) return;
        const t = ((qx - ex) * (fx - ex) + (qy - ey) * (fy - ey)) / length2;
        if (t > 0 && t < 1) splits.push([e, t, q]);
      });
      e = f;
    } while (e !== start && ctx.budget > 0);
  }
  // Insert from the far end of each edge back toward its start, skipping repeats of the same point.
  splits.sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2]);
  for (let k = 0; k < splits.length; k++) {
    const [e, t, q] = splits[k];
    if (k > 0 && splits[k - 1][0] === e && splits[k - 1][1] === t) continue;
    const i = nodes.copy(q),
      f = nodes.next[e];
    nodes.next[e] = i;
    nodes.prev[i] = e;
    nodes.next[i] = f;
    nodes.prev[f] = i;
  }
}

/**
 * Removes pairs of opposite edges u -> v and v -> u. Between two rings this merges them (two holes sharing a side
 * become one hole; a hole on the outer boundary becomes a notch); within a ring it splits off the part between.
 * Returns one node of every resulting ring.
 */
function cancelSharedEdges(nodes: Nodes, rings: readonly number[]): number[] {
  const X = nodes.x,
    Y = nodes.y,
    key = (i: number, j: number) => `${X[i]} ${Y[i]} ${X[j]} ${Y[j]}`,
    edges = new Map<string, number[]>(),
    all: number[] = [];
  for (const start of rings) {
    let e = start;
    do {
      all.push(e);
      const k = key(e, nodes.next[e]),
        list = edges.get(k);
      if (list) list.push(e);
      else edges.set(k, [e]);
      e = nodes.next[e];
    } while (e !== start);
  }
  for (const e of all) {
    if (!nodes.live[e]) continue;
    const en = nodes.next[e],
      list = edges.get(key(en, e));
    if (!list) continue;
    const f = list.find((c) => nodes.live[c] && c !== en && nodes.next[c] !== e && nodes.same(nodes.next[c], e));
    if (f === undefined) continue;
    const pe = nodes.prev[e],
      pf = nodes.prev[f],
      fn = nodes.next[f];
    nodes.next[pe] = fn;
    nodes.prev[fn] = pe;
    nodes.next[pf] = en;
    nodes.prev[en] = pf;
    nodes.live[e] = nodes.live[f] = 0;
  }
  const seen = new Uint8Array(nodes.size),
    out: number[] = [];
  for (const e of all) {
    if (!nodes.live[e] || seen[e]) continue;
    let i = e;
    do {
      seen[i] = 1;
      i = nodes.next[i];
    } while (i !== e);
    out.push(e);
  }
  return out;
}

function ringArea(nodes: Nodes, start: number): number {
  let sum = 0,
    i = start;
  do {
    const j = nodes.next[i];
    sum += nodes.x[i] * nodes.y[j] - nodes.x[j] * nodes.y[i];
    i = j;
  } while (i !== start);
  return sum / 2;
}

/** 1 inside, 0 outside, -1 on the ring. */
function locate(nodes: Nodes, start: number, x: number, y: number): number {
  let e = start;
  do {
    const f = nodes.next[e];
    if (
      orient(nodes.x[e], nodes.y[e], nodes.x[f], nodes.y[f], x, y) === 0 &&
      x >= Math.min(nodes.x[e], nodes.x[f]) &&
      x <= Math.max(nodes.x[e], nodes.x[f]) &&
      y >= Math.min(nodes.y[e], nodes.y[f]) &&
      y <= Math.max(nodes.y[e], nodes.y[f])
    )
      return -1;
    e = f;
  } while (e !== start);
  return nodes.winding(start, x, y) === 1 ? 1 : 0;
}

/**
 * Sorts rings into counter-clockwise outer rings, each with the clockwise holes it contains (the smallest such outer
 * when nested). Zero-area and two-point rings are dropped.
 */
function groupRings(nodes: Nodes, rings: readonly number[]): [number, Hole[]][] {
  const outers: [number, number][] = [],
    holes: number[] = [],
    kill = (start: number) => {
      let i = start;
      do {
        nodes.live[i] = 0;
        i = nodes.next[i];
      } while (i !== start);
    };
  for (const start of rings) {
    const area = nodes.ringLength(start) < 3 ? 0 : ringArea(nodes, start);
    if (area > 0) outers.push([start, area]);
    else if (area < 0) holes.push(start);
    else kill(start);
  }
  const groups = new Map<number, Hole[]>(outers.map(([o]) => [o, []]));
  for (const hole of holes) {
    let owner = -1;
    if (outers.length === 1) owner = outers[0][0];
    else {
      let best = Infinity;
      for (const [outer, area] of outers) {
        if (area >= best) continue;
        // A hole vertex off the outer ring decides; failing that, an edge midpoint.
        let inside = -1,
          i = hole;
        do {
          inside = locate(nodes, outer, nodes.x[i], nodes.y[i]);
          if (inside < 0) {
            const j = nodes.next[i];
            inside = locate(nodes, outer, (nodes.x[i] + nodes.x[j]) / 2, (nodes.y[i] + nodes.y[j]) / 2);
          }
          i = nodes.next[i];
        } while (inside < 0 && i !== hole);
        if (inside === 1) {
          best = area;
          owner = outer;
        }
      }
    }
    if (owner < 0) kill(hole);
    else (groups.get(owner) as Hole[]).push({ start: hole, right: rightmost(nodes, hole) });
  }
  return [...groups];
}

function rightmost(nodes: Nodes, start: number): number {
  let right = start,
    i = nodes.next[start];
  while (i !== start) {
    if (nodes.x[i] > nodes.x[right] || (nodes.x[i] === nodes.x[right] && nodes.y[i] < nodes.y[right])) right = i;
    i = nodes.next[i];
  }
  return right;
}

/**
 * Signed area of a closed 2D ring by the shoelace (Gauss area) formula: positive for counter-clockwise rings in a
 * y-up frame, 0 for an empty ring.
 */
export function shapeArea(contour: readonly MutableVec2[]): number {
  let sum = 0;
  for (let k = 0, j = contour.length - 1; k < contour.length; j = k++)
    sum += contour[j][0] * contour[k][1] - contour[k][0] * contour[j][1];
  return sum / 2;
}

/** Whether a 2D ring winds clockwise in a y-up frame (`shapeArea < 0`; a zero-area ring is not clockwise). */
export function isClockWise(points: readonly MutableVec2[]): boolean {
  return shapeArea(points) < 0;
}

/** Whether two points coincide within 1e-10 of their largest coordinate magnitude (exact repeats always do). */
function nearlySame(a: readonly number[], b: readonly number[]): boolean {
  const scale = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
  return (a[0] === b[0] && a[1] === b[1]) || Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-10 * scale;
}

/**
 * Removes consecutive points of a closed ring that are closer than 1e-10 relative to their magnitude (exact repeats
 * always merge). Scanning forward, the later point of a coincident pair goes; the wrap-around pair (last, first) is
 * checked last and there the first point goes. Returns a new array of new points; the input is untouched.
 */
export function mergeOverlappingPoints(points: readonly MutableVec2[]): MutableVec2[] {
  const result = points.map((p) => [p[0], p[1]] as MutableVec2);
  for (let k = 0; k + 1 < result.length && result.length >= 2; )
    if (nearlySame(result[k], result[k + 1])) result.splice(k + 1, 1);
    else k++;
  while (result.length >= 2 && nearlySame(result[result.length - 1], result[0])) result.shift();
  return result;
}

/** A copy of a ring without trailing points bit-equal to its first point (keeps at least two points). */
function withoutClosingRepeat(ring: readonly MutableVec2[]): MutableVec2[] {
  const copy = ring.slice();
  while (copy.length > 2 && copy[copy.length - 1][0] === copy[0][0] && copy[copy.length - 1][1] === copy[0][1])
    copy.pop();
  return copy;
}

/**
 * Triangulates a 2D contour with holes. Exact closing repeats are stripped from every ring and holes left with fewer
 * than three points are dropped; ring orientation does not matter.
 *
 * @returns `indices`: counter-clockwise triples into `[...contour, ...holes.flat()]`, with the cleaned `contour` and
 * `holes` as new arrays.
 */
export function triangulateShape(
  contour: readonly MutableVec2[],
  holes: readonly (readonly MutableVec2[])[] = [],
): { indices: number[]; contour: MutableVec2[]; holes: MutableVec2[][] } {
  const outer = withoutClosingRepeat(contour),
    kept = holes.map(withoutClosingRepeat).filter((h) => h.length >= 3),
    data: number[] = [],
    starts: number[] = [];
  for (const p of outer) data.push(p[0], p[1]);
  for (const hole of kept) {
    starts.push(data.length / 2);
    for (const p of hole) data.push(p[0], p[1]);
  }
  return { indices: triangulate(data, starts), contour: outer, holes: kept };
}

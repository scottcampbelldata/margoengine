// @margoengine/mesh-edit/sculpt: brushes that push a mesh's vertices around, for apps like Margo Mesh. A session owns a
// triangle surface; dabs change it in place and `mesh()` hands back a polygon mesh when the caller wants one. With
// dynamic topology, the edges under a brush split and collapse to hold a detail size, so a stroke never stretches.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh } from './polygon.js';
import { SculptDrawing } from './sculpt-draw.js';
import { SculptIndex } from './sculpt-index.js';
import {
  collapseShortEdges,
  edgeFaces,
  markSharpEdges,
  polygonMeshOfSurface,
  splitLongEdges,
  type SurfaceTri,
  type SurfaceWatch,
  triNormal,
  type TriSurface,
  triSurfaceOf,
} from './tri-surface.js';
import type { PolygonMesh } from './types.js';

export type { SculptDrawing, SculptDrawRange } from './sculpt-draw.js';

/** A sculpt brush. */
export type SculptBrush = 'draw' | 'smooth' | 'grab' | 'inflate' | 'crease';

/** How strength fades from the brush center to its edge. */
export type SculptFalloff = 'smooth' | 'linear' | 'sharp' | 'constant';

/** Brush settings. Each field can also be passed per stroke. */
export interface SculptBrushOptions {
  /** What the brush does. Default `'draw'`. */
  brush?: SculptBrush;
  /** World-size radius, positive. Default 0.25. */
  radius?: number;
  /** Strength from 0 to 1. Default 0.5. */
  strength?: number;
  /** Fade toward the edge. Default `'smooth'`. */
  falloff?: SculptFalloff;
  /** Push in, not out (draw, inflate and crease). Default false. */
  invert?: boolean;
  /** Mirror each dab across this axis plane through the origin. Default none. */
  symmetry?: 'x' | 'y' | 'z';
}

/** Options for {@link MeshSculptSession}. */
export interface SculptSessionOptions extends SculptBrushOptions {
  /** Add and remove triangles under the brush. Default false. */
  dynamicTopology?: boolean;
  /** Edge length dynamic topology holds, positive. Default the mesh's mean edge length. */
  detailSize?: number;
  /** Strokes kept for undo, 0 to 1000. Default 32. */
  undoLimit?: number;
  /** Face ID generator for {@link MeshSculptSession.mesh} (default `crypto.randomUUID`). */
  createId?: () => string;
}

/** Where a ray meets the sculpted surface. */
export interface SculptHit {
  point: MutableVec3;
  normal: MutableVec3;
  distance: number;
}

/** What the session did last, for checking that the work follows the brush and not the mesh. */
export interface SculptStats {
  /** Triangles the last {@link MeshSculptSession.pick} tested. */
  pickTriangles: number;
  /** Vertices the last {@link MeshSculptSession.dab} looked at. */
  dabVertices: number;
  /** Vertices, triangles and edges all undo and redo steps hold together. */
  undoEntries: number;
}

/**
 * What one step changed, as the state before it: the lengths of `points` and `tris`, and each older item the step
 * touched. Undoing swaps this with the state it replaces, which is then the redo step.
 */
interface Delta {
  points: number;
  tris: number;
  moved: Map<number, MutableVec3>;
  faces: Map<number, SurfaceTri | null>;
  edges: Map<string, boolean>;
}

const AXES = { x: 0, y: 1, z: 2 } as const;

const falloffs: Record<SculptFalloff, (t: number) => number> = {
  smooth: (t) => {
    const s = 1 - t;
    return s * s * (3 - 2 * s);
  },
  linear: (t) => 1 - t,
  sharp: (t) => (1 - t) ** 3,
  constant: () => 1,
};

function checkBrush(options: SculptBrushOptions): void {
  const { brush, radius, strength, falloff, symmetry } = options;
  if (brush !== undefined && !['draw', 'smooth', 'grab', 'inflate', 'crease'].includes(brush))
    throw new TypeError("Sculpt brush must be 'draw', 'smooth', 'grab', 'inflate' or 'crease'; choose one.");
  if (radius !== undefined && !(radius > 0 && Number.isFinite(radius)))
    throw new RangeError('Sculpt radius must be positive; choose a size in mesh units.');
  if (strength !== undefined && !(strength >= 0 && strength <= 1))
    throw new RangeError('Sculpt strength must be 0 to 1; choose a fraction.');
  if (falloff !== undefined && !Object.hasOwn(falloffs, falloff))
    throw new TypeError("Sculpt falloff must be 'smooth', 'linear', 'sharp' or 'constant'; choose one.");
  if (symmetry !== undefined && !Object.hasOwn(AXES, symmetry))
    throw new TypeError("Sculpt symmetry must be 'x', 'y' or 'z'; choose one or omit it.");
}

function checkPoint(p: unknown, label: string): asserts p is Vec3 {
  if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => Number.isFinite(x)))
    throw new TypeError(`Sculpt ${label} must be three finite numbers; supply [x, y, z].`);
}

/**
 * A sculpting session on a copy of a mesh. Call {@link MeshSculptSession.pick} to find the surface under the pointer,
 * then {@link MeshSculptSession.beginStroke}, one {@link MeshSculptSession.dab} per pointer move and
 * {@link MeshSculptSession.endStroke}. Each stroke is one undo step.
 *
 * ```ts
 * const session = new MeshSculptSession(mesh, { radius: 0.3 });
 * const hit = session.pick([0, 0, 5], [0, 0, -1]);
 * if (hit) {
 *   session.beginStroke({ brush: 'draw' });
 *   session.dab(hit.point);
 *   session.endStroke();
 * }
 * const sculpted = session.mesh();
 * ```
 */
export class MeshSculptSession {
  #surface: TriSurface;
  #defaults: SculptBrushOptions;
  #dynamic: boolean;
  #detail: number;
  #undoLimit: number;
  #createId: () => string;
  #index: SculptIndex;
  #drawing: SculptDrawing | null = null;
  #undo: Delta[] = [];
  #redo: Delta[] = [];
  /** The open stroke's undo step. */
  #step: Delta | null = null;
  #pickTriangles = 0;
  #dabVertices = 0;
  /** The stroke in progress: its settings and, for grab, the vertices it holds and where they started. */
  #stroke: {
    brush: Required<Pick<SculptBrushOptions, 'brush' | 'radius' | 'strength' | 'falloff'>> & SculptBrushOptions;
    held: { start: Vec3; mirror: number; vertices: { v: number; from: MutableVec3; weight: number }[] }[];
  } | null = null;

  /** @throws TypeError or RangeError for a bad mesh or options. */
  constructor(mesh: PolygonMesh, options: SculptSessionOptions = {}) {
    assertPolygonMesh(mesh);
    assertOptions(options, 'Sculpt');
    checkBrush(options);
    const { dynamicTopology = false, undoLimit = 32, createId, detailSize, ...brush } = options;
    if (!Number.isInteger(undoLimit) || undoLimit < 0 || undoLimit > 1000)
      throw new RangeError('Sculpt undoLimit must be an integer from 0 to 1000; choose a stroke count.');
    if (createId !== undefined && typeof createId !== 'function')
      throw new TypeError('Sculpt createId must be a function; supply a generator or omit it.');
    this.#surface = triSurfaceOf(mesh);
    markSharpEdges(this.#surface, Math.PI, false);
    this.#defaults = brush;
    this.#dynamic = dynamicTopology;
    this.#undoLimit = undoLimit;
    this.#createId = createId ?? (() => globalThis.crypto.randomUUID());
    let sum = 0,
      count = 0;
    const { points } = this.#surface;
    for (const key of edgeFaces(this.#surface.tris).keys()) {
      const [a, b] = key.split(':').map(Number);
      sum += Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
      count++;
    }
    const mean = sum / count;
    this.#detail = detailSize ?? mean;
    if (!(this.#detail > 0 && Number.isFinite(this.#detail)))
      throw new RangeError('Sculpt detailSize must be positive; choose an edge length in mesh units.');
    this.#index = new SculptIndex(this.#surface, 2 * Math.min(this.#detail, mean > 0 ? mean : this.#detail));
  }

  /** Number of triangles now. */
  get triangleCount(): number {
    return this.#index.live;
  }

  /** Strokes that can be undone. */
  get undoSteps(): number {
    return this.#undo.length;
  }

  /** Strokes that can be redone. */
  get redoSteps(): number {
    return this.#redo.length;
  }

  /** What the last pick and dab visited, and what the undo steps hold. */
  get stats(): SculptStats {
    let undoEntries = 0;
    for (const step of [...this.#undo, ...this.#redo]) undoEntries += step.moved.size + step.faces.size + step.edges.size;
    return { pickTriangles: this.#pickTriangles, dabVertices: this.#dabVertices, undoEntries };
  }

  /**
   * The surface as draw buffers that follow it. Call {@link SculptDrawing.update} after dabs: it refreshes only the
   * vertices that changed and says which to upload. `@margoengine/mesh-edit/sculpt-view` does this for a gltf-pro model.
   */
  drawing(): SculptDrawing {
    return (this.#drawing ??= new SculptDrawing(this.#surface, this.#index));
  }

  /**
   * The nearest surface point along a ray, with the face normal there. `direction` need not be unit length.
   * @throws TypeError for a bad origin or direction.
   */
  pick(origin: Vec3, direction: Vec3): SculptHit | null {
    checkPoint(origin, 'origin');
    checkPoint(direction, 'direction');
    const { points, tris } = this.#surface,
      size = Math.hypot(direction[0], direction[1], direction[2]);
    if (!size) throw new TypeError('Sculpt direction must have length; supply a nonzero vector.');
    const d: MutableVec3 = [direction[0] / size, direction[1] / size, direction[2] / size];
    let best: SculptHit | null = null,
      bestFace = -1,
      tested = 0;
    const test = (face: number): void => {
      const tri = tris[face];
      tested++;
      const a = points[tri.v[0]],
        b = points[tri.v[1]],
        c = points[tri.v[2]],
        e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        p = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]],
        det = e[0] * p[0] + e[1] * p[1] + e[2] * p[2];
      if (!det) return;
      const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]],
        u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) return;
      const q = [s[1] * e[2] - s[2] * e[1], s[2] * e[0] - s[0] * e[2], s[0] * e[1] - s[1] * e[0]],
        v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (v < 0 || u + v > 1) return;
      const t = (f[0] * q[0] + f[1] * q[1] + f[2] * q[2]) / det;
      // The lowest face wins a tie, whatever order the grid visits them in.
      if (t < 0 || (best && (t > best.distance || (t === best.distance && face > bestFace)))) return;
      const n = triNormal(a, b, c),
        length = Math.hypot(n[0], n[1], n[2]) || 1;
      best = {
        point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t],
        normal: [n[0] / length, n[1] / length, n[2] / length],
        distance: t,
      };
      bestFace = face;
    };
    const walked = this.#index.walk(origin, d, test, () => best?.distance ?? Infinity);
    if (walked) for (const face of this.#index.large) test(face);
    else for (let face = 0; face < tris.length; face++) if (tris[face]) test(face);
    this.#pickTriangles = tested;
    return best;
  }

  /**
   * Start a stroke, one undo step. `options` override the session's brush for this stroke.
   * @throws TypeError or RangeError for a bad brush; RangeError when a stroke is already open.
   */
  beginStroke(options: SculptBrushOptions = {}): void {
    assertOptions(options, 'Sculpt stroke');
    checkBrush(options);
    if (this.#stroke) throw new RangeError('A sculpt stroke is already open; call endStroke first.');
    this.#stroke = {
      brush: { brush: 'draw', radius: 0.25, strength: 0.5, falloff: 'smooth', ...this.#defaults, ...options },
      held: [],
    };
    const { points, tris } = this.#surface;
    this.#step = { points: points.length, tris: tris.length, moved: new Map(), faces: new Map(), edges: new Map() };
    this.#undo.push(this.#step);
    if (this.#undo.length > this.#undoLimit) this.#undo.shift();
    this.#redo = [];
  }

  /**
   * Apply the brush at `point`, normally a {@link MeshSculptSession.pick} hit. For `grab`, the first dab takes hold of
   * the vertices under the brush and later dabs drag them, so they keep following the pointer off the surface.
   * @throws TypeError for a bad point; RangeError with no open stroke.
   */
  dab(point: Vec3): void {
    checkPoint(point, 'point');
    const stroke = this.#stroke;
    if (!stroke) throw new RangeError('No sculpt stroke is open; call beginStroke first.');
    this.#dabVertices = 0;
    const axis: number = stroke.brush.symmetry === undefined ? -1 : AXES[stroke.brush.symmetry],
      centers: { at: Vec3; mirror: number }[] = [{ at: point, mirror: -1 }];
    if (axis >= 0) {
      const flipped: MutableVec3 = [point[0], point[1], point[2]];
      flipped[axis] = -flipped[axis];
      centers.push({ at: flipped, mirror: axis });
    }
    for (const { at, mirror } of centers) {
      if (stroke.brush.brush === 'grab') this.#grab(at, mirror);
      else this.#apply(at);
    }
    if (this.#dynamic && stroke.brush.brush !== 'grab') for (const { at } of centers) this.#retopologize(at);
  }

  /** Finish the stroke. @throws RangeError with no open stroke. */
  endStroke(): void {
    if (!this.#stroke) throw new RangeError('No sculpt stroke is open; call beginStroke first.');
    if (this.#dynamic && this.#stroke.brush.brush === 'grab')
      for (const { start } of this.#stroke.held) this.#retopologize(start);
    this.#stroke = null;
    this.#step = null;
  }

  /** Step back one stroke. Returns false when there is nothing to undo. @throws RangeError during a stroke. */
  undo(): boolean {
    return this.#walkHistory(this.#undo, this.#redo);
  }

  /** Step forward one stroke. Returns false when there is nothing to redo. @throws RangeError during a stroke. */
  redo(): boolean {
    return this.#walkHistory(this.#redo, this.#undo);
  }

  /** The sculpted surface as a new polygon mesh of triangles. */
  mesh(): PolygonMesh {
    const { points, tris, sharp } = this.#surface,
      live = { points, sharp, tris: tris.filter(Boolean) },
      copy = polygonMeshOfSurface(live, () => this.#createId());
    return {
      vertices: copy.vertices.map((p) => [p[0], p[1], p[2]]),
      faces: copy.faces,
    };
  }

  #walkHistory(from: Delta[], to: Delta[]): boolean {
    if (this.#stroke) throw new RangeError('A sculpt stroke is open; call endStroke first.');
    const step = from.pop();
    if (!step) return false;
    to.push(this.#swap(step));
    return true;
  }

  /** Puts a step's state back and returns the state it replaced. */
  #swap(step: Delta): Delta {
    const { points, tris, sharp } = this.#surface,
      back: Delta = { points: points.length, tris: tris.length, moved: new Map(), faces: new Map(), edges: new Map() },
      vertices = new Set(step.moved.keys()),
      faces = new Set(step.faces.keys());
    for (let v = step.points; v < points.length; v++) vertices.add(v);
    for (let f = step.tris; f < tris.length; f++) faces.add(f);
    for (const v of vertices) if (v < points.length) back.moved.set(v, points[v]);
    for (const f of faces) if (f < tris.length) back.faces.set(f, tris[f]);
    points.length = step.points;
    tris.length = step.tris;
    for (const [v, p] of step.moved) points[v] = p;
    for (const [f, tri] of step.faces) (tris as (SurfaceTri | null)[])[f] = tri;
    for (const [key, had] of step.edges) {
      back.edges.set(key, sharp.has(key));
      if (had) sharp.add(key);
      else sharp.delete(key);
    }
    this.#index.refresh(faces, vertices);
    if (faces.size) this.#drawing?.rebuild();
    else for (const v of vertices) this.#drawing?.moved(v);
    return back;
  }

  /** Moves a vertex, keeping what it was for undo. */
  #move(v: number, p: MutableVec3): void {
    this.#notePoint(v);
    this.#surface.points[v] = p;
    this.#index.moved(v);
    this.#drawing?.moved(v);
  }

  #notePoint(v: number): void {
    const step = this.#step!;
    if (v < step.points && !step.moved.has(v)) step.moved.set(v, this.#surface.points[v]);
  }

  /** A topology pass over what is near `center` now, and what it must do afterwards. */
  #watch(center: Vec3, reach: number): { watch: SurfaceWatch; finish: () => void } {
    const step = this.#step!,
      { tris, sharp } = this.#surface,
      index = this.#index,
      faces = new Set<number>(),
      vertices = new Set<number>(),
      inReach = index.within(center, reach);
    this.#dabVertices += index.tested;
    return {
      watch: {
        faces: index.facesOf(inReach),
        around: index.around,
        point: (v) => {
          this.#notePoint(v);
          vertices.add(v);
        },
        face: (f) => {
          faces.add(f);
          if (f >= step.tris || step.faces.has(f)) return;
          const tri = tris[f] as SurfaceTri | null;
          step.faces.set(f, tri && { v: tri.v, uv: tri.uv, source: tri.source });
        },
        edge: (key) => {
          if (!step.edges.has(key)) step.edges.set(key, sharp.has(key));
        },
      },
      finish: () => {
        index.refresh(faces, vertices);
        if (faces.size) this.#drawing?.rebuild();
      },
    };
  }

  /** Vertices in the brush, each with its falloff weight. */
  #under(center: Vec3): { v: number; weight: number }[] {
    const stroke = this.#stroke!,
      { radius, falloff } = stroke.brush,
      curve = falloffs[falloff],
      { points } = this.#surface,
      inside = this.#index.within(center, radius);
    this.#dabVertices += this.#index.tested;
    return inside.map((v) => {
      const p = points[v];
      return { v, weight: curve(Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) / radius) };
    });
  }

  /** Area-weighted vertex normals, and each vertex's edge neighbors, for the vertices given. */
  #local(vertices: readonly number[]): { normals: Map<number, MutableVec3>; rings: Map<number, Set<number>> } {
    const { points, tris } = this.#surface,
      wanted = new Set(vertices),
      normals = new Map<number, MutableVec3>(),
      rings = new Map<number, Set<number>>();
    for (const v of vertices) {
      normals.set(v, [0, 0, 0]);
      rings.set(v, new Set());
    }
    for (const face of this.#index.facesOf(vertices)) {
      const tri = tris[face],
        n = triNormal(points[tri.v[0]], points[tri.v[1]], points[tri.v[2]]);
      tri.v.forEach((v, c) => {
        if (!wanted.has(v)) return;
        const sum = normals.get(v)!,
          ring = rings.get(v)!;
        for (let k = 0; k < 3; k++) sum[k] += n[k];
        ring.add(tri.v[(c + 1) % 3]);
        ring.add(tri.v[(c + 2) % 3]);
      });
    }
    for (const n of normals.values()) {
      const length = Math.hypot(n[0], n[1], n[2]) || 1;
      for (let k = 0; k < 3; k++) n[k] /= length;
    }
    return { normals, rings };
  }

  #apply(center: Vec3): void {
    const { brush, radius, strength, invert } = this.#stroke!.brush,
      { points } = this.#surface,
      under = this.#under(center);
    if (!under.length) return;
    const { normals, rings } = this.#local(under.map((item) => item.v)),
      sign = invert ? -1 : 1,
      reach = radius * strength * 0.25,
      area: MutableVec3 = [0, 0, 0];
    for (const { v, weight } of under) {
      const n = normals.get(v)!;
      for (let k = 0; k < 3; k++) area[k] += n[k] * weight;
    }
    const size = Math.hypot(area[0], area[1], area[2]) || 1,
      facing = area.map((x) => x / size),
      moves = under.map(({ v, weight }): [number, MutableVec3] => {
        const p = points[v],
          n = normals.get(v)!,
          out: MutableVec3 = [p[0], p[1], p[2]],
          ring = rings.get(v)!,
          mean: MutableVec3 = [0, 0, 0];
        for (const w of ring) for (let k = 0; k < 3; k++) mean[k] += points[w][k] / (ring.size || 1);
        for (let k = 0; k < 3; k++) {
          if (brush === 'draw') out[k] += facing[k] * reach * weight * sign;
          else if (brush === 'inflate') out[k] += n[k] * reach * weight * sign;
          else if (brush === 'smooth') out[k] += (mean[k] - p[k]) * strength * weight;
          else {
            // Crease: sink along the brush's normal and pinch toward the center line, for sharp valleys.
            out[k] += -facing[k] * reach * weight * sign + (center[k] - p[k]) * strength * weight * 0.25;
          }
        }
        return [v, out];
      });
    for (const [v, p] of moves) this.#move(v, p);
  }

  #grab(center: Vec3, mirror: number): void {
    const stroke = this.#stroke!,
      { points } = this.#surface;
    let hold = stroke.held.find((item) => item.mirror === mirror);
    if (!hold) {
      hold = {
        start: [center[0], center[1], center[2]],
        mirror,
        vertices: this.#under(center).map(({ v, weight }) => ({
          v,
          weight,
          from: [points[v][0], points[v][1], points[v][2]],
        })),
      };
      stroke.held.push(hold);
      return;
    }
    const move = [center[0] - hold.start[0], center[1] - hold.start[1], center[2] - hold.start[2]];
    for (const { v, from, weight } of hold.vertices)
      this.#move(v, [from[0] + move[0] * weight, from[1] + move[1] * weight, from[2] + move[2] * weight]);
  }

  /** Hold the detail size under the brush: split long edges there, collapse short ones. */
  #retopologize(center: Vec3): void {
    const stroke = this.#stroke!,
      reach = stroke.brush.radius * 1.25,
      surface = this.#surface,
      inside = (v: number): boolean => {
        const p = surface.points[v];
        return Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) < reach;
      },
      near = (a: number, b: number): boolean => inside(a) || inside(b),
      high = this.#detail * (4 / 3),
      low = this.#detail * (4 / 5);
    for (let pass = 0; pass < 4; pass++) {
      const { watch, finish } = this.#watch(center, reach),
        split = splitLongEdges(surface, high, near, watch);
      finish();
      if (!split) break;
    }
    const { watch, finish } = this.#watch(center, reach);
    collapseShortEdges(surface, low, high, near, watch);
    finish();
  }
}

/// <reference lib="esnext.disposable" preserve="true" />
// Section caps and cut edges for an IFC scene's clipping planes, computed on the CPU (no stencil pass):
// 1. each triangle of each shown element is cut by each plane (a vertex exactly on the plane counts as in front, so
//    every crossing triangle gives one segment, and the two triangles that share an edge compute the same point from
//    the same two corners, in the same order);
// 2. the segments are joined head to tail into loops through a hash of their end points (Minetto et al. 2017, linear
//    contour construction); ends left open (a mesh that is not closed) are joined to the nearest open end within the
//    tolerance, and what stays open still draws as cut edges but gets no cap;
// 3. the closed loops of one element on one plane are nested by even-odd containment (a loop inside an odd number of
//    others is a hole of the smallest one around it), so the cap does not depend on the triangles' winding, and each
//    outer loop with its holes is triangulated by @margoengine/geometry's ear clipping;
// 4. caps and edges are trimmed against the other planes (Sutherland and Hodgman's reentrant clipping, one half space
//    at a time), so they end where the clipped model ends.
// The stencil method of Rossignac, Megahed and Schneider (1992) caps on the GPU without this work, but needs closed
// solids, one ordered stencil pass per plane and gives no polygons; these caps are geometry, per element, for any
// number of planes and also on the WebGL2 layer, and the loops are the section drawing.
import type { EngineKernel } from '@margoengine/core';
import { triangulate } from '@margoengine/geometry/triangulate';
import { Material } from '@margoengine/materials';
import type { MaterialMesh } from '@margoengine/materials';
import { BatchedMesh } from '@margoengine/materials/batched';
import type { Line, Lines } from '@margoengine/lines';
import { checkAbort, fail } from './open.js';
import type { IFCMeshGeometry, IFCScene } from './scene.js';

/** One placed geometry to cut: what `IFCScene.placementsOf` returns, with its element. */
export interface IFCSectionSource {
  element: number;
  geometry: IFCMeshGeometry;
  /** Column-major placement into the planes' space. */
  matrix: ArrayLike<number>;
}
/** What one plane cuts out of one element. */
export interface IFCSectionCut {
  element: number;
  /** Index of the plane in the list given. */
  plane: number;
  /** Cap triangles on the plane: x, y, z per corner, already trimmed by the other planes. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Cut edges, two points (six numbers) per segment, trimmed by the other planes. */
  edges: Float32Array;
  /** Section loops in the plane, closed ones first, x, y, z per point; `closed` of them are closed. */
  loops: Float32Array[];
  closed: number;
}
/** Options of sectionIFC. */
export interface IFCSectionOptions {
  /** Open loop ends closer than this (meters) are joined. Default 1e-5. */
  tolerance?: number;
  signal?: AbortSignal;
}

type V3 = [number, number, number];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function checkPlanes(planes: readonly (readonly number[])[]): number[][] {
  if (!Array.isArray(planes)) fail('range', 'section planes must be an array of [a, b, c, d]');
  return planes.map((p) => {
    if (!Array.isArray(p) || p.length !== 4 || !p.every(Number.isFinite)) fail('range', 'a section plane must be four finite numbers [a, b, c, d]');
    const l = Math.hypot(p[0], p[1], p[2]);
    if (!(l > 0)) fail('range', 'a section plane needs a non-zero normal [a, b, c]');
    return [p[0] / l, p[1] / l, p[2] / l, p[3] / l];
  });
}

/** Clips a convex polygon (x, y, z points) to the half spaces `dot(n, p) + d >= 0` of `planes` except `skip`. */
function trimPolygon(poly: V3[], planes: number[][], skip: number): V3[] {
  let out = poly;
  for (let j = 0; j < planes.length && out.length; j++) {
    if (j === skip) continue;
    const q = planes[j],
      next: V3[] = [];
    for (let k = 0; k < out.length; k++) {
      const a = out[k],
        b = out[(k + 1) % out.length],
        sa = dot(q, a) + q[3],
        sb = dot(q, b) + q[3];
      if (sa >= 0) next.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const t = sa / (sa - sb);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    out = next;
  }
  return out;
}

/** The part of segment a-b in front of every plane but `skip`, or undefined. */
function trimSegment(a: V3, b: V3, planes: number[][], skip: number): [V3, V3] | undefined {
  let t0 = 0,
    t1 = 1;
  for (let j = 0; j < planes.length; j++) {
    if (j === skip) continue;
    const q = planes[j],
      sa = dot(q, a) + q[3],
      sb = dot(q, b) + q[3];
    if (sa < 0 && sb < 0) return;
    if (sa < 0) t0 = Math.max(t0, sa / (sa - sb));
    else if (sb < 0) t1 = Math.min(t1, sa / (sa - sb));
  }
  if (t0 >= t1) return;
  const at = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return [at(t0), at(t1)];
}

/** Joins segments (point pairs) head to tail into loops: closed ones, then open chains. */
function joinSegments(segments: V3[][], tolerance: number): { loops: V3[][]; closed: number } {
  const key = (p: V3) => `${p[0]},${p[1]},${p[2]}`,
    ends = new Map<string, number[]>(),
    used = new Uint8Array(segments.length);
  segments.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      const list = ends.get(k);
      if (list) list.push(i);
      else ends.set(k, [i]);
    }
  });
  const nextFrom = (p: V3) => ends.get(key(p))?.find((i) => !used[i]);
  const walk = (chain: V3[]) => {
    for (;;) {
      const tail = chain[chain.length - 1],
        i = nextFrom(tail);
      if (i === undefined) return;
      used[i] = 1;
      const s = segments[i];
      chain.push(key(s[0]) === key(tail) ? s[1] : s[0]);
    }
  };
  const closed: V3[][] = [],
    open: V3[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [segments[i][0], segments[i][1]];
    walk(chain);
    if (key(chain[0]) === key(chain[chain.length - 1])) {
      chain.pop();
      closed.push(chain);
      continue;
    }
    chain.reverse();
    walk(chain);
    open.push(chain);
  }
  // Open chains whose ends lie within the tolerance join: nearest first, closing a chain on itself when its own ends are.
  const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
  for (let merged = true; merged && open.length; ) {
    merged = false;
    for (let i = 0; i < open.length && !merged; i++) {
      const a = open[i];
      if (a.length > 2 && near(a[0], a[a.length - 1])) {
        a.pop();
        closed.push(a);
        open.splice(i, 1);
        merged = true;
        break;
      }
      for (let j = 0; j < open.length && !merged; j++) {
        if (i === j) continue;
        const b = open[j],
          tail = a[a.length - 1];
        if (near(tail, b[0])) a.push(...b.slice(1));
        else if (near(tail, b[b.length - 1])) a.push(...b.slice(0, -1).reverse());
        else continue;
        open.splice(j, 1);
        merged = true;
      }
    }
  }
  return { loops: [...closed.map((l) => straighten(l, true)), ...open.map((l) => straighten(l, false))], closed: closed.length };
}

/** `loop` without the points that lie on the straight line between their neighbours (a face split into triangles). */
function straighten(loop: V3[], closed: boolean): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < loop.length; i++) {
    if ((!closed && (i === 0 || i === loop.length - 1)) || loop.length - (i - out.length) <= 3) {
      out.push(loop[i]);
      continue;
    }
    const a = out.length ? out[out.length - 1] : loop[loop.length - 1],
      b = loop[i],
      c = loop[(i + 1) % loop.length],
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]],
      x = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (x > 1e-12 * Math.hypot(...u) * Math.hypot(...v) || dot(u, v) <= 0) out.push(b);
  }
  return out;
}

function inside(ring: number[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i + 1],
      yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((ring[j] - ring[i]) * (y - yi)) / (yj - yi) + ring[i]) c = !c;
  }
  return c;
}
const ringArea = (ring: number[]) => {
  let s = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) s += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  return s / 2;
};

/** Cap triangles (3D, untrimmed) of closed loops on a plane with normal `n`: even-odd nesting, then ear clipping. */
function capTriangles(loops: V3[][], n: ArrayLike<number>): V3[][] {
  const a: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
    u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]],
    ul = Math.hypot(u[0], u[1], u[2]);
  for (let k = 0; k < 3; k++) u[k] /= ul;
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const rings = loops.map((l) => l.flatMap((p) => [dot(u, p), dot(v, p)])),
    areas = rings.map((r) => Math.abs(ringArea(r))),
    keep = rings.map((r, i) => r.length >= 6 && areas[i] > 0);
  // A loop's parent is the smallest loop around it; its depth is how many loops are around it.
  const around = rings.map((r, i) =>
    keep[i] ? rings.map((_, j) => j).filter((j) => j !== i && keep[j] && areas[j] > areas[i] && inside(rings[j], r[0], r[1])) : [],
  );
  const out: V3[][] = [];
  rings.forEach((outer, i) => {
    if (!keep[i] || around[i].length % 2) return;
    const holes = rings
      .map((_, j) => j)
      .filter((j) => keep[j] && around[j].length === around[i].length + 1 && around[j].includes(i));
    const flat = [...outer],
      points = [...loops[i]],
      starts: number[] = [];
    for (const h of holes) {
      starts.push(flat.length / 2);
      flat.push(...rings[h]);
      points.push(...loops[h]);
    }
    const tri = triangulate(flat, starts, 2);
    for (let t = 0; t < tri.length; t += 3) out.push([points[tri[t]], points[tri[t + 1]], points[tri[t + 2]]]);
  });
  return out;
}

/**
 * Cuts `sources` by `planes` (`[a, b, c, d]`, what has `a x + b y + c z + d < 0` is cut away, as `clippingPlanes`)
 * and returns, per element and plane, the cap triangles and cut edges, trimmed by the other planes, and the section
 * loops. Pure CPU; throws a coded RangeError for a bad plane and the signal's reason when aborted.
 */
export function sectionIFC(
  sources: Iterable<IFCSectionSource>,
  planes: readonly (readonly number[])[],
  options: IFCSectionOptions = {},
): IFCSectionCut[] {
  const list = checkPlanes(planes),
    tolerance = options.tolerance ?? 1e-5;
  if (!(tolerance >= 0) || !Number.isFinite(tolerance)) fail('range', 'tolerance must be a finite number of meters, 0 or more');
  const byElement = new Map<number, IFCSectionSource[]>();
  for (const s of sources) {
    const list = byElement.get(s.element);
    if (list) list.push(s);
    else byElement.set(s.element, [s]);
  }
  const cuts: IFCSectionCut[] = [];
  for (const [element, parts] of byElement) {
    checkAbort(options.signal);
    const world = parts.map(({ geometry: { positions }, matrix: m }) => {
      const w = new Float64Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i],
          y = positions[i + 1],
          z = positions[i + 2];
        for (let r = 0; r < 3; r++) w[i + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
      }
      return w;
    });
    list.forEach((q, plane) => {
      const segments: V3[][] = [];
      parts.forEach(({ geometry: { indices } }, k) => {
        const w = world[k],
          s = new Float64Array(w.length / 3);
        let lo = Infinity,
          hi = -Infinity;
        for (let i = 0; i < s.length; i++) {
          s[i] = q[0] * w[i * 3] + q[1] * w[i * 3 + 1] + q[2] * w[i * 3 + 2] + q[3];
          lo = Math.min(lo, s[i]);
          hi = Math.max(hi, s[i]);
        }
        if (!(lo < 0 && hi >= 0)) return;
        // The point where edge (behind, front) crosses, always computed from the corner behind.
        const cross = (b: number, f: number): V3 => {
          const t = s[b] / (s[b] - s[f]);
          return [w[b * 3] + (w[f * 3] - w[b * 3]) * t, w[b * 3 + 1] + (w[f * 3 + 1] - w[b * 3 + 1]) * t, w[b * 3 + 2] + (w[f * 3 + 2] - w[b * 3 + 2]) * t];
        };
        for (let t = 0; t < indices.length; t += 3) {
          const c = [indices[t], indices[t + 1], indices[t + 2]],
            behind = c.filter((i) => s[i] < 0);
          if (behind.length === 0 || behind.length === 3) continue;
          const front = c.filter((i) => s[i] >= 0);
          segments.push(
            behind.length === 1
              ? [cross(behind[0], front[0]), cross(behind[0], front[1])]
              : [cross(behind[0], front[0]), cross(behind[1], front[0])],
          );
        }
      });
      if (!segments.length) return;
      const { loops, closed } = joinSegments(segments, tolerance);
      const positions: number[] = [],
        indices: number[] = [];
      for (const tri of capTriangles(loops.slice(0, closed), q)) {
        const poly = trimPolygon(tri, list, plane);
        const base = positions.length / 3;
        for (const p of poly) positions.push(p[0], p[1], p[2]);
        for (let k = 1; k + 1 < poly.length; k++) indices.push(base, base + k, base + k + 1);
      }
      const edges: number[] = [];
      for (const [i, loop] of loops.entries())
        for (let k = 0; k < loop.length - (i < closed ? 0 : 1); k++) {
          const part = trimSegment(loop[k], loop[(k + 1) % loop.length], list, plane);
          if (part) edges.push(...part[0], ...part[1]);
        }
      if (!positions.length && !edges.length) return;
      cuts.push({
        element,
        plane,
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
        edges: new Float32Array(edges),
        loops: loops.map((l) => new Float32Array(l.flat())),
        closed,
      });
    });
  }
  return cuts;
}

/** Options of IFCSectionView. */
export interface IFCSectionViewOptions {
  /** Draw caps. Default true. */
  caps?: boolean;
  /** Cap colour, sRGB 0..1, or 'element' for each element's own colour (its override, else its file colour). Default 'element'. */
  capColor?: 'element' | readonly number[];
  /** A Lines plugin of @margoengine/lines and its Line class, to draw cut edges. Default none (no edges). */
  edges?: { lines: Lines; Line: typeof Line };
  /** Edge width in CSS pixels. Default 2. */
  edgeWidth?: number;
  /** Edge colour, sRGB 0..1. Default black. */
  edgeColor?: readonly number[];
  /** As sectionIFC's. */
  tolerance?: number;
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function rgb(c: readonly number[] | undefined, what: string, fallback: number[]): number[] {
  if (c === undefined) return fallback;
  if (!Array.isArray(c) || c.length < 3 || c.slice(0, 3).some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    fail('range', `${what} must be three sRGB components from 0 to 1`);
  return [c[0], c[1], c[2]];
}

/**
 * Section caps and cut edges for an IFCScene's clipping planes: call `update()` after changing the planes or which
 * elements are shown (it does nothing when neither changed). Caps draw through @margoengine/materials, edges through a
 * Lines plugin you pass. Dispose it to free its meshes and lines.
 */
export class IFCSectionView {
  /** The cap material (unlit look: roughness 1, double sided); set shared options on it. */
  readonly material: Material;
  /** The last update's cuts (sectionIFC's result). */
  cuts: readonly IFCSectionCut[] = [];
  private batch?: BatchedMesh;
  private lines: Line[] = [];
  private stamp = '';
  private readonly capColor: 'element' | number[];
  private readonly edgeColor: number[];
  private readonly edgeWidth: number;
  private disposed = false;

  constructor(
    private readonly engine: EngineKernel,
    private readonly scene: IFCScene,
    private readonly options: IFCSectionViewOptions = {},
  ) {
    this.capColor = options.capColor === undefined || options.capColor === 'element' ? 'element' : rgb(options.capColor, 'capColor', [0, 0, 0]).map(linear);
    this.edgeColor = rgb(options.edgeColor, 'edgeColor', [0, 0, 0]);
    this.edgeWidth = options.edgeWidth ?? 2;
    if (!(this.edgeWidth > 0) || !Number.isFinite(this.edgeWidth)) fail('range', 'edgeWidth must be a positive number of pixels');
    if (options.edges && (typeof options.edges.Line !== 'function' || typeof options.edges.lines?.add !== 'function'))
      fail('range', 'edges takes { lines, Line } from @margoengine/lines');
    this.material = new Material({ roughness: 1, metalness: 0, doubleSided: true });
    this.update();
  }

  /** Caps and cut edges for `scene` on `engine`: the same as `new IFCSectionView(engine, scene, options)`. */
  static attach(engine: EngineKernel, scene: IFCScene, options: IFCSectionViewOptions = {}): IFCSectionView {
    return new IFCSectionView(engine, scene, options);
  }
  /** The cap meshes (one batch, or none), for shadows, SSAO or picking filters. */
  get meshes(): readonly MaterialMesh[] {
    return this.batch ? [this.batch.mesh] : [];
  }
  /** The linear RGB a cap of `element` draws in: `capColor`, else the element's override, else its file colour. */
  capColorOf(element: number): [number, number, number] {
    if (this.capColor !== 'element') return [this.capColor[0], this.capColor[1], this.capColor[2]];
    const own = this.scene.stateOf(element)?.color;
    if (own) return [linear(own[0]), linear(own[1]), linear(own[2])];
    const c = this.scene.placementsOf(element)[0]?.color ?? [0.5, 0.5, 0.5];
    return [c[0], c[1], c[2]];
  }
  /** Recomputes caps and edges when the planes or the shown elements changed since the last call. Returns this. */
  update(): this {
    if (this.disposed) fail('range', 'the section view is disposed; create a new one');
    const planes = this.scene.clippingPlanes,
      shown = this.scene.elements.filter((id) => {
        const s = this.scene.stateOf(id);
        return s && !s.hidden && !s.ghosted;
      }),
      colors = this.capColor === 'element' ? shown.map((id) => this.scene.stateOf(id)?.color?.join() ?? '') : [],
      stamp = JSON.stringify([planes, shown, colors]);
    if (stamp === this.stamp) return this;
    this.stamp = stamp;
    this.clear();
    if (!planes.length) return this;
    const sources = shown.flatMap((element) =>
      this.scene.placementsOf(element).map((p) => ({ element, geometry: p.geometry, matrix: p.matrix })),
    );
    this.cuts = sectionIFC(sources, planes, { tolerance: this.options.tolerance });
    if (this.options.caps !== false) this.drawCaps();
    const edges = this.options.edges;
    if (edges) {
      const all = this.cuts.flatMap((c) => Array.from(c.edges));
      if (all.length) {
        const line = new edges.Line({ positions: all, mode: 'segments', color: this.edgeColor.map(linear) as [number, number, number], width: this.edgeWidth });
        edges.lines.add(line);
        this.lines.push(line);
      }
    }
    return this;
  }

  private drawCaps(): void {
    const caps = this.cuts.filter((c) => c.indices.length);
    if (!caps.length) return;
    const vertices = caps.reduce((n, c) => n + c.positions.length / 3, 0),
      indices = caps.reduce((n, c) => n + c.indices.length, 0);
    const batch = BatchedMesh.attach(this.engine, this.material, {
      maxVertices: Math.max(3, vertices),
      maxIndices: Math.max(3, indices),
      maxItems: caps.length,
    });
    this.batch = batch;
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const c of caps) {
      const n = this.scene.clippingPlanes[c.plane],
        normals = new Float32Array(c.positions.length);
      for (let i = 0; i < normals.length; i += 3) normals.set([-n[0], -n[1], -n[2]], i);
      batch.add({ positions: c.positions, normals, indices: c.indices }, { matrix: identity, color: this.capColorOf(c.element) });
    }
  }

  private clear(): void {
    this.batch?.dispose();
    this.batch = undefined;
    for (const l of this.lines.splice(0)) this.options.edges?.lines.remove(l);
    this.cuts = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.material.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

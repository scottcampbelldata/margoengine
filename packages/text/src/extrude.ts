import type { FontVariationOptions } from './font-variation.js';
export type { FontVariationOptions, FontVariationAxis } from './font-variation.js';
import { fontError, FONT_HELP } from './font-reader.js';
import { FontOutlines, parseFontOutlines, subdivision, type Point2D } from './font-outlines.js';
export { FontOutlines, parseFontOutlines } from './font-outlines.js';
// Clean-room OpenType font outline parser, polygon triangulation with holes, and 3D text extrusion.
// Specifications & Papers:
// - ISO/IEC 14496-22 (OpenType specification) / Microsoft OpenType specification (sfnt, head, maxp, hhea, hmtx, cmap, loca, glyf)
// - Adobe Technical Notes #5176 (CFF) and #5177 (Type 2 Charstrings)
// - Eberly, D. (2002), "Triangulation by Ear Clipping", Geometric Tools
import { MargoError } from '@margoengine/math/errors';

export type { Point2D } from './font-outlines.js';

/** A draw range sharing one material, in index units. */
export interface GeometryGroup {
  start: number;
  count: number;
  materialIndex: number;
}

/** 3D geometry data with vertex attributes, indices and material groups. */
export interface ExtrudedTextGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: GeometryGroup[];
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  /** Convert into a @margoengine/core Geometry instance when its constructor is passed; otherwise return attributes. */
  toGeometry<T = unknown>(
    GeometryClass?: new (positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>) => T,
  ):
    | T
    | {
        positions: Float32Array;
        normals: Float32Array;
        uvs: Float32Array;
        indices: Uint32Array;
        groups: GeometryGroup[];
      };
}

/** Minimal font outline provider interface for text extrusion. */
export interface FontLike {
  readonly unitsPerEm: number;
  glyphIndex(char: string): number;
  glyphAdvance(glyphIndex: number): number;
  getGlyphContours(glyphIndex: number, curveSegments?: number): Array<Array<[number, number] | number[]>>;
  /** Optional shaping provider; called once per block when shapedRuns is not supplied. Output values use em units. */
  shape?(text: string): readonly ShapedTextRun[];
  /** Optional variable-instance provider for a custom font. */
  withVariations?(variations: Readonly<Record<string, number>>): FontLike;
}

/** A positioned shaping result, in em units, in the shaper's visual glyph order. */
export interface ShapedExtrusionGlyph {
  /** Font glyph ID after substitution. */
  glyphIndex: number;
  /** Horizontal advance, including positioning adjustments. */
  xAdvance: number;
  /** Vertical advance. Default 0. */
  yAdvance?: number;
  /** Horizontal origin adjustment. Default 0. */
  xOffset?: number;
  /** Vertical origin adjustment. Default 0. */
  yOffset?: number;
  /** Optional UTF-16 source cluster offset; letter spacing is added only between different clusters. */
  cluster?: number;
}

/** One shaping run belonging to a logical line. Multiple runs on a line concatenate in supplied order. */
export interface ShapedTextRun {
  /** Glyph IDs, advances and offsets after substitution, kerning and mark placement. */
  glyphs: readonly ShapedExtrusionGlyph[];
  /** Zero-based line. Default 0. */
  line?: number;
}

/** Options for text extrusion. Only glyph coordinates and spacing are scaled by `size`; bevels and depth use world units. */
export interface ExtrudeTextOptions extends FontVariationOptions {
  /** Font binary buffer (TTF/OTF), parsed FontOutlines, or custom FontLike instance. */
  font: FontOutlines | FontLike | ArrayBuffer | ArrayBufferView;
  /** Font size in world units. Default 1. */
  size?: number;
  /** Extrusion depth along +Z. Default 0.2. */
  depth?: number;
  /** Integer subdivisions per quadratic/cubic Bezier segment, 1..256. Default 12. */
  curveSegments?: number;
  /** Enable bevels on the front and back edges. Default false. */
  bevelEnabled?: boolean;
  /** Depth of the bevel along Z. Default 0.02. */
  bevelThickness?: number;
  /** Extent of the bevel outward in XY. Default 0.02. */
  bevelSize?: number;
  /** Offset of the bevel relative to the outline. Default 0. */
  bevelOffset?: number;
  /** Integer bevel subdivisions, 0..64 (0 or 1 for a flat chamfer). Default 3. */
  bevelSegments?: number;
  /** Integer subdivisions along the extrusion depth, 1..256. Default 1. */
  steps?: number;
  /** Additional spacing between characters in em units. Default 0. */
  letterSpacing?: number;
  /** Line height multiplier for multiline text. Default 1.2. */
  lineHeight?: number;
  /** Text alignment across lines ('left', 'center', 'right'). Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Pre-shaped runs from any shaping engine. IDs refer to this font instance; coordinates are em units. Default font.shape(), then Unicode cmap fallback. */
  shapedRuns?: readonly ShapedTextRun[];
}

// ---------------------------------------------------------------------------
// Binary Stream Reader
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2D Polygon Triangulation with Holes (Ear Clipping & Seam Cuts)
// ---------------------------------------------------------------------------

/** Computes the signed shoelace area of a 2D loop. Positive values are counter-clockwise, negative clockwise. */
export function polygonArea(loop: readonly Point2D[]): number {
  if (loop.length < 3) return 0;
  let area = 0;
  const [x, y] = loop[0];
  for (let i = 1; i < loop.length - 1; i++)
    area += (loop[i][0] - x) * (loop[i + 1][1] - y) - (loop[i][1] - y) * (loop[i + 1][0] - x);
  return area / 2;
}

/** Tests whether a 2D point lies inside a polygon loop using ray casting. */
export function pointInPolygon(point: Point2D, loop: readonly Point2D[]): boolean {
  const [x, y] = point;
  let inside = false;
  const n = loop.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop[i][0];
    const yi = loop[i][1];
    const xj = loop[j][0];
    const yj = loop[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

interface PolygonShape {
  outer: Point2D[];
  holes: Point2D[][];
}

/** Classifies loops into outer boundaries and nested holes by point-in-polygon containment. */
export function classifyLoops(loops: readonly (readonly Point2D[])[]): PolygonShape[] {
  const clean = loops
    .map((loop) => loop.filter((p, i) => !samePoint(p, loop[(i + loop.length - 1) % loop.length])))
    .filter((loop) => loop.length >= 3);
  if (!clean.length) return [];
  const points = clean.flat();
  if (points.length > 16384 || points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
    polygonError('outline exceeds 16384 vertices or contains nonfinite coordinates');
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!scale) return [];
  // Operate in glyph-relative coordinates so a legal small font has exactly the same topology.
  const normalized = clean.map((loop) => loop.map(([x, y]): Point2D => [(x - minX) / scale, (y - minY) / scale]));
  type Edge = { a: Point2D; b: Point2D; cuts: number[] };
  const edges: Edge[] = normalized.flatMap((loop) =>
    loop.map((a, i) => ({ a, b: loop[(i + 1) % loop.length], cuts: [0, 1] })),
  );
  const cut = (edge: Edge, t: number) => {
    if (t > 0 && t < 1) edge.cuts.push(t);
  };
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i],
        f = edges[j];
      if (
        Math.max(e.a[0], e.b[0]) < Math.min(f.a[0], f.b[0]) ||
        Math.max(f.a[0], f.b[0]) < Math.min(e.a[0], e.b[0]) ||
        Math.max(e.a[1], e.b[1]) < Math.min(f.a[1], f.b[1]) ||
        Math.max(f.a[1], f.b[1]) < Math.min(e.a[1], e.b[1])
      )
        continue;
      const ex = e.b[0] - e.a[0],
        ey = e.b[1] - e.a[1],
        fx = f.b[0] - f.a[0],
        fy = f.b[1] - f.a[1];
      const dx = f.a[0] - e.a[0],
        dy = f.a[1] - e.a[1],
        den = ex * fy - ey * fx;
      if (den !== 0) {
        const t = (dx * fy - dy * fx) / den,
          u = (dx * ey - dy * ex) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          cut(e, t);
          cut(f, u);
        }
      } else if (dx * ey - dy * ex === 0) {
        const et = ex * ex + ey * ey,
          ft = fx * fx + fy * fy;
        for (const p of [f.a, f.b]) cut(e, ((p[0] - e.a[0]) * ex + (p[1] - e.a[1]) * ey) / et);
        for (const p of [e.a, e.b]) cut(f, ((p[0] - f.a[0]) * fx + (p[1] - f.a[1]) * fy) / ft);
      }
    }
  const winding = (p: Point2D) => {
    let n = 0;
    for (const e of edges) {
      if (e.a[1] <= p[1] && e.b[1] > p[1] && cross(e.a, e.b, p) > 0) n++;
      if (e.b[1] <= p[1] && e.a[1] > p[1] && cross(e.a, e.b, p) < 0) n--;
    }
    return n;
  };
  const vertices: Point2D[] = [],
    buckets = new Map<string, number[]>();
  const vertex = (p: Point2D) => {
    const ix = Math.round(p[0] * 1e12),
      iy = Math.round(p[1] * 1e12);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of buckets.get(`${ix + dx},${iy + dy}`) ?? [])
          if (Math.hypot(vertices[i][0] - p[0], vertices[i][1] - p[1]) < 1e-12) return i;
      }
    const key = `${ix},${iy}`,
      list = buckets.get(key) ?? [],
      i = vertices.length;
    vertices.push(p);
    list.push(i);
    buckets.set(key, list);
    return i;
  };
  const boundary = new Map<string, { a: number; b: number }>();
  for (const edge of edges) {
    const cuts = [...new Set(edge.cuts)].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const at = (t: number): Point2D =>
        t === 0
          ? edge.a
          : t === 1
            ? edge.b
            : [edge.a[0] + t * (edge.b[0] - edge.a[0]), edge.a[1] + t * (edge.b[1] - edge.a[1])];
      const a = at(cuts[i]),
        b = at(cuts[i + 1]),
        dx = b[0] - a[0],
        dy = b[1] - a[1],
        len = Math.hypot(dx, dy);
      if (!len) continue;
      const mid: Point2D = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let offset = len * 1e-7;
      // Stay inside the adjacent arrangement faces, even around thin strokes.
      for (const other of edges) {
        const distance = pointSegmentDistance(mid, other.a, other.b);
        if (distance > 1e-14) offset = Math.min(offset, distance / 4);
      }
      const left = winding([mid[0] - (dy / len) * offset, mid[1] + (dx / len) * offset]) !== 0;
      const right = winding([mid[0] + (dy / len) * offset, mid[1] - (dx / len) * offset]) !== 0;
      if (left === right) continue;
      const ai = vertex(left ? a : b),
        bi = vertex(left ? b : a);
      if (ai === bi) continue;
      boundary.set(`${ai},${bi}`, { a: ai, b: bi });
    }
  }
  const remaining = new Set(boundary.values()),
    outgoing = new Map<number, Array<{ a: number; b: number }>>();
  for (const edge of remaining) {
    const list = outgoing.get(edge.a) ?? [];
    list.push(edge);
    outgoing.set(edge.a, list);
  }
  const result: Point2D[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    let edge = first;
    const loop: Point2D[] = [];
    do {
      if (!remaining.delete(edge)) polygonError('boundary cannot be closed');
      loop.push(vertices[edge.a]);
      if (edge.b === first.a) break;
      const prev = vertices[edge.a],
        current = vertices[edge.b],
        reverse = Math.atan2(prev[1] - current[1], prev[0] - current[0]);
      const candidates = (outgoing.get(edge.b) ?? []).filter((e) => remaining.has(e));
      candidates.sort((a, b) => {
        const turn = (e: { b: number }) =>
          (reverse - Math.atan2(vertices[e.b][1] - current[1], vertices[e.b][0] - current[0]) + Math.PI * 2) %
          (Math.PI * 2);
        return turn(a) - turn(b);
      });
      if (!candidates.length) polygonError('boundary has an unmatched endpoint');
      edge = candidates[0];
    } while (loop.length <= boundary.size);
    if (loop.length >= 3 && polygonArea(loop) !== 0) result.push(loop);
  }
  const shapes: PolygonShape[] = result
    .filter((loop) => polygonArea(loop) > 0)
    .map((loop) => ({ outer: loop, holes: [] }));
  for (const hole of result.filter((loop) => polygonArea(loop) < 0)) {
    const parents = shapes
      .filter((shape) => pointInPolygon(hole[0], shape.outer))
      .sort((a, b) => polygonArea(a.outer) - polygonArea(b.outer));
    if (!parents.length) polygonError('hole has no containing outline');
    parents[0].holes.push(hole);
  }
  for (const shape of shapes) {
    const world = (loop: Point2D[]) => loop.map(([x, y]): Point2D => [minX + x * scale, minY + y * scale]);
    shape.outer = world(shape.outer);
    shape.holes = shape.holes.map(world);
  }
  return shapes;
}

function polygonError(detail: string): never {
  throw new MargoError(
    'failed',
    `Text extrusion polygon ${detail}; provide finite nondegenerate outlines or reduce the bevel. Help: ${FONT_HELP}`,
  );
}
function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
function cross(a: Point2D, b: Point2D, c: Point2D): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function pointSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    n = dx * dx + dy * dy;
  const t = n ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentBlocked(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return false;
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  const on = (p: Point2D, x: Point2D, y: Point2D) =>
    cross(x, y, p) === 0 &&
    p[0] >= Math.min(x[0], y[0]) &&
    p[0] <= Math.max(x[0], y[0]) &&
    p[1] >= Math.min(x[1], y[1]) &&
    p[1] <= Math.max(x[1], y[1]);
  return on(c, a, b) || on(d, a, b) || on(a, c, d) || on(b, c, d);
}

/** Triangulates a polygon by visible hole bridges and complete ear clipping (Eberly, sections 2-5). */
export function triangulatePolygon(
  outer: readonly Point2D[],
  holes: readonly (readonly Point2D[])[] = [],
): { vertices: Point2D[]; indices: number[] } {
  if (outer.length < 3) return { vertices: [], indices: [] };
  let polygon = outer.map(([x, y]): Point2D => [x, y]);
  if (polygonArea(polygon) < 0) polygon.reverse();
  const inside = holes
    .filter((h) => h.length >= 3)
    .map((h) => {
      const loop = h.map(([x, y]): Point2D => [x, y]);
      if (polygonArea(loop) > 0) loop.reverse();
      return loop;
    });
  inside.sort((a, b) => Math.max(...b.map((p) => p[0])) - Math.max(...a.map((p) => p[0])));
  for (const hole of inside) {
    let hi = 0;
    for (let i = 1; i < hole.length; i++)
      if (hole[i][0] > hole[hi][0] || (hole[i][0] === hole[hi][0] && hole[i][1] < hole[hi][1])) hi = i;
    const h = hole[hi];
    let best = -1,
      distance = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i],
        dist = Math.hypot(p[0] - h[0], p[1] - h[1]);
      if (dist >= distance) continue;
      const prev = polygon[(i + polygon.length - 1) % polygon.length],
        next = polygon[(i + 1) % polygon.length];
      const leftPrev = cross(prev, p, h) > 0,
        leftNext = cross(p, next, h) > 0;
      if (cross(prev, p, next) > 0 ? !(leftPrev && leftNext) : !(leftPrev || leftNext)) continue;
      const mid: Point2D = [(p[0] + h[0]) / 2, (p[1] + h[1]) / 2];
      if (!pointInPolygon(mid, outer) || inside.some((loop) => pointInPolygon(mid, loop))) continue;
      if (
        [polygon, ...inside].some((loop) => loop.some((a, j) => segmentBlocked(h, p, a, loop[(j + 1) % loop.length])))
      )
        continue;
      best = i;
      distance = dist;
    }
    if (best < 0) polygonError('has no visible hole bridge');
    const rotated = [...hole.slice(hi), ...hole.slice(0, hi)];
    polygon = [...polygon.slice(0, best + 1), ...rotated, h, polygon[best], ...polygon.slice(best + 1)];
  }
  const active = polygon.map((_, i) => i),
    indices: number[] = [];
  let cursor = 0,
    misses = 0;
  while (active.length > 3) {
    const n = active.length,
      ai = active[(cursor + n - 1) % n],
      bi = active[cursor],
      ci = active[(cursor + 1) % n];
    const a = polygon[ai],
      b = polygon[bi],
      c = polygon[ci];
    const ear =
      cross(a, b, c) > 0 &&
      !active.some((i) => {
        const p = polygon[i];
        if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) return false;
        return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
      });
    if (ear) {
      indices.push(ai, bi, ci);
      active.splice(cursor, 1);
      cursor %= active.length;
      misses = 0;
    } else {
      cursor = (cursor + 1) % n;
      if (++misses >= n) polygonError('ear clipping could not complete');
    }
  }
  if (active.length === 3 && cross(polygon[active[0]], polygon[active[1]], polygon[active[2]]) > 0)
    indices.push(...active);
  else polygonError('triangulation ended with a degenerate triangle');
  const expected = Math.abs(polygonArea(outer)) - inside.reduce((sum, h) => sum + Math.abs(polygonArea(h)), 0);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3)
    area += cross(polygon[indices[i]], polygon[indices[i + 1]], polygon[indices[i + 2]]) / 2;
  if (Math.abs(area - expected) > Math.abs(expected) * 1e-10) polygonError('triangulation area is incomplete');
  return { vertices: polygon, indices };
}

// ---------------------------------------------------------------------------
// 3D Extrusion Engine
// ---------------------------------------------------------------------------

function extrudeShapeGeometry(
  outer: Point2D[],
  holes: Point2D[][],
  options: ExtrudeTextOptions,
  capVertices: number[],
  capNormals: number[],
  capUVs: number[],
  capIndices: number[],
  wallVertices: number[],
  wallNormals: number[],
  wallUVs: number[],
  wallIndices: number[],
  bbox: { min: [number, number, number]; max: [number, number, number] },
): void {
  const depth = options.depth ?? 0.2,
    steps = options.steps ?? 1;
  const enabled = options.bevelEnabled ?? false,
    thickness = enabled ? (options.bevelThickness ?? 0.02) : 0;
  const size = enabled ? (options.bevelSize ?? 0.02) : 0,
    offset = enabled ? (options.bevelOffset ?? 0) : 0;
  const bevelSegments = Math.max(1, options.bevelSegments ?? 3);
  const loops = [outer, ...holes];
  const miters = loops.map((loop) =>
    loop.map((p, i): Point2D => {
      if (!size && !offset) return [0, 0];
      const prev = loop[(i + loop.length - 1) % loop.length],
        next = loop[(i + 1) % loop.length];
      const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]),
        l2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
      const n1: Point2D = [(p[1] - prev[1]) / l1, (prev[0] - p[0]) / l1],
        n2: Point2D = [(next[1] - p[1]) / l2, (p[0] - next[0]) / l2];
      const denominator = 1 + n1[0] * n2[0] + n1[1] * n2[1];
      if (denominator <= 1e-12) polygonError('bevel corner reverses direction');
      return [(n1[0] + n2[0]) / denominator, (n1[1] + n2[1]) / denominator];
    }),
  );
  const ring = (distance: number) =>
    loops.map((loop, j) =>
      loop.map((p, i): Point2D => [p[0] + miters[j][i][0] * distance, p[1] + miters[j][i][1] * distance]),
    );
  const profile: Array<{ z: number; offset: number }> = [];
  if (enabled && (size || thickness)) {
    for (let i = 0; i <= bevelSegments; i++) {
      const angle = ((i / bevelSegments) * Math.PI) / 2;
      profile.push({
        z: i === 0 ? 0 : i === bevelSegments ? thickness : thickness * (1 - Math.cos(angle)),
        offset: offset + (i === bevelSegments ? size : size * Math.sin(angle)),
      });
    }
    for (let i = 1; i <= steps; i++)
      profile.push({ z: thickness + ((depth - 2 * thickness) * i) / steps, offset: offset + size });
    for (let i = bevelSegments - 1; i >= 0; i--) {
      const angle = ((i / bevelSegments) * Math.PI) / 2;
      profile.push({
        z: i === 0 ? depth : depth - thickness * (1 - Math.cos(angle)),
        offset: offset + size * Math.sin(angle),
      });
    }
  } else for (let i = 0; i <= steps; i++) profile.push({ z: (depth * i) / steps, offset });
  const pointCount = loops.reduce((n, loop) => n + loop.length, 0);
  if ((capVertices.length + wallVertices.length) / 3 + pointCount * (4 + 4 * (profile.length - 1)) > 1000000)
    polygonError('mesh exceeds 1000000 vertices');
  // No cap ring is inferred separately: caps and walls consume these exact same coordinates.
  const rings = profile.map((level) => ring(level.offset));
  for (const level of rings) {
    for (let j = 0; j < level.length; j++) {
      const loop = level[j],
        source = loops[j];
      if (polygonArea(loop) * polygonArea(source) <= 0) polygonError('bevel collapses a contour');
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i],
          b = loop[(i + 1) % loop.length],
          sa = source[i],
          sb = source[(i + 1) % loop.length];
        if ((b[0] - a[0]) * (sb[0] - sa[0]) + (b[1] - a[1]) * (sb[1] - sa[1]) <= 0)
          polygonError('bevel reverses an edge');
        for (let k = i + 2; k < loop.length; k++) {
          if (i === 0 && k === loop.length - 1) continue;
          if (segmentBlocked(a, b, loop[k], loop[(k + 1) % loop.length])) polygonError('bevel intersects itself');
        }
        for (let k = j + 1; k < level.length; k++)
          for (let l = 0; l < level[k].length; l++) {
            if (segmentBlocked(a, b, level[k][l], level[k][(l + 1) % level[k].length]))
              polygonError('bevel contours intersect');
          }
      }
    }
  }
  const bounds = (x: number, y: number, z: number) => {
    bbox.min[0] = Math.min(bbox.min[0], x);
    bbox.max[0] = Math.max(bbox.max[0], x);
    bbox.min[1] = Math.min(bbox.min[1], y);
    bbox.max[1] = Math.max(bbox.max[1], y);
    bbox.min[2] = Math.min(bbox.min[2], z);
    bbox.max[2] = Math.max(bbox.max[2], z);
  };
  for (const end of [0, rings.length - 1]) {
    const level = rings[end],
      z = profile[end].z,
      front = end === 0;
    const { vertices, indices } = triangulatePolygon(level[0], level.slice(1)),
      start = capVertices.length / 3;
    for (const [x, y] of vertices) {
      capVertices.push(x, y, z);
      capNormals.push(0, 0, front ? -1 : 1);
      capUVs.push(x, y);
      bounds(x, y, z);
    }
    for (let i = 0; i < indices.length; i += 3) {
      capIndices.push(start + indices[i], start + indices[i + (front ? 2 : 1)], start + indices[i + (front ? 1 : 2)]);
    }
  }
  for (let j = 0; j < loops.length; j++) {
    const source = loops[j],
      n = source.length,
      lengths = [0];
    for (let i = 0; i < n; i++)
      lengths.push(
        lengths[i] + Math.hypot(source[(i + 1) % n][0] - source[i][0], source[(i + 1) % n][1] - source[i][1]),
      );
    for (let l = 0; l < rings.length - 1; l++) {
      if (profile[l].z === profile[l + 1].z && profile[l].offset === profile[l + 1].offset) continue;
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const a = [...rings[l][j][i], profile[l].z],
          b = [...rings[l][j][next], profile[l].z];
        const c = [...rings[l + 1][j][next], profile[l + 1].z],
          d = [...rings[l + 1][j][i], profile[l + 1].z];
        const ux = b[0] - a[0],
          uy = b[1] - a[1],
          uz = b[2] - a[2],
          vx = c[0] - a[0],
          vy = c[1] - a[1],
          vz = c[2] - a[2];
        const nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx,
          len = Math.hypot(nx, ny, nz);
        if (!len) {
          if (depth === 0) continue;
          polygonError('wall triangle is degenerate');
        }
        const start = wallVertices.length / 3;
        for (const p of [a, b, c, d]) {
          wallVertices.push(...p);
          wallNormals.push(nx / len, ny / len, nz / len);
          bounds(p[0], p[1], p[2]);
        }
        const u0 = lengths[i] / lengths[n],
          u1 = lengths[i + 1] / lengths[n];
        wallUVs.push(
          u0,
          l / (rings.length - 1),
          u1,
          l / (rings.length - 1),
          u1,
          (l + 1) / (rings.length - 1),
          u0,
          (l + 1) / (rings.length - 1),
        );
        wallIndices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extruded Text High-Level API
// ---------------------------------------------------------------------------


/**
 * Creates 3D extruded geometry for text with front/back caps, side walls and optional bevels.
 * Material group 0 is front and back caps; material group 1 is side and bevel walls.
 */
export function extrudeText(text: string, options: ExtrudeTextOptions): ExtrudedTextGeometry {
  if (!options || !options.font) {
    throw new TypeError('extrudeText requires a font; pass {font: parseFontOutlines(bytes)} or font bytes');
  }

  let font: FontLike =
    options.font instanceof FontOutlines || typeof (options.font as any).getGlyphContours === 'function'
      ? (options.font as FontLike)
      : parseFontOutlines(options.font as ArrayBuffer | ArrayBufferView);
  if (options.variations) {
    if (!font.withVariations) fontError('custom font has no withVariations provider');
    font = font.withVariations(options.variations);
  }
  const size = options.size ?? 1;
  if (typeof size !== 'number' || size <= 0 || !Number.isFinite(size)) {
    throw new RangeError(`extrudeText size must be a positive finite number; got ${size}`);
  }

  const depth = options.depth ?? 0.2;
  if (typeof depth !== 'number' || depth < 0 || !Number.isFinite(depth)) {
    throw new RangeError(`extrudeText depth must be a non-negative finite number; got ${depth}`);
  }

  const letterSpacing = options.letterSpacing ?? 0;
  const lineHeight = options.lineHeight ?? 1.2;
  const align = options.align ?? 'left';
  const curveSegments = subdivision('curveSegments', options.curveSegments ?? 12, 1);
  subdivision('steps', options.steps ?? 1, 1);
  subdivision('bevelSegments', options.bevelSegments ?? 3, 0, 64);
  for (const name of ['bevelThickness', 'bevelSize', 'bevelOffset', 'letterSpacing', 'lineHeight'] as const) {
    const value = options[name];
    if (value !== undefined && !Number.isFinite(value)) polygonError(`${name} must be finite`);
  }
  if (options.bevelEnabled) {
    const t = options.bevelThickness ?? 0.02,
      s = options.bevelSize ?? 0.02;
    if (t < 0 || s < 0 || t > depth / 2 || (t === 0) !== (s === 0))
      polygonError('bevel size and thickness must be positive together and thickness at most half the depth');
  }

  const lines = text.split('\n');
  type Positioned = { index: number; advance: number; yAdvance: number; xOffset: number; yOffset: number; cluster?: number };
  const lineMetrics: { glyphs: Positioned[]; width: number }[] = [];
  const shaped = options.shapedRuns ?? font.shape?.(text);
  if (shaped !== undefined) {
    for (let i=0;i<lines.length;i++) lineMetrics.push({glyphs:[],width:0});
    for (const run of shaped) {
      const line = run.line ?? 0;
      if (!Number.isInteger(line) || line < 0 || line >= lines.length) fontError('shaping run line is outside the text');
      for (const g of run.glyphs) {
        const values=[g.xAdvance,g.yAdvance??0,g.xOffset??0,g.yOffset??0];
        if (!Number.isInteger(g.glyphIndex) || g.glyphIndex < 0 || (font instanceof FontOutlines && g.glyphIndex >= font.glyphCount) || !values.every(Number.isFinite) ||
          (g.cluster !== undefined && (!Number.isInteger(g.cluster) || g.cluster < 0 || g.cluster > text.length)))
          fontError('shaping run glyph ID, cluster or position is invalid');
        lineMetrics[line].glyphs.push({index:g.glyphIndex,advance:g.xAdvance*size,yAdvance:(g.yAdvance??0)*size,
          xOffset:(g.xOffset??0)*size,yOffset:(g.yOffset??0)*size,cluster:g.cluster});
      }
    }
    for (const line of lineMetrics) for (let i=0;i<line.glyphs.length;i++) {
      const g=line.glyphs[i],next=line.glyphs[i+1];
      if (next && (g.cluster===undefined || g.cluster!==next.cluster)) g.advance += letterSpacing*size;
      line.width += g.advance;
    }
  }

  if (shaped === undefined) for (const line of lines) {
    const glyphs: Positioned[] = [];
    let lineWidth = 0;
    for (const char of line) {
      const index = font.glyphIndex(char);
      const advance = font.glyphAdvance(index) * size;
      glyphs.push({ index, advance: advance + letterSpacing*size, yAdvance:0, xOffset:0, yOffset:0 });
      lineWidth += advance + letterSpacing * size;
    }
    if (glyphs.length > 0) { lineWidth -= letterSpacing * size; glyphs[glyphs.length-1].advance -= letterSpacing*size; }
    lineMetrics.push({ glyphs, width: lineWidth });
  }

  const maxLineWidth = Math.max(0, ...lineMetrics.map((l) => l.width));

  const capVertices: number[] = [];
  const capNormals: number[] = [];
  const capUVs: number[] = [];
  const capIndices: number[] = [];

  const wallVertices: number[] = [];
  const wallNormals: number[] = [];
  const wallUVs: number[] = [];
  const wallIndices: number[] = [];

  const bbox = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number, number],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] as [number, number, number],
  };

  const lineSpacing = size * lineHeight;
  let cursorY = 0;

  for (let l = 0; l < lineMetrics.length; l++) {
    const { glyphs, width } = lineMetrics[l];
    let cursorX = 0;
    if (align === 'center') cursorX = (maxLineWidth - width) * 0.5;
    else if (align === 'right') cursorX = maxLineWidth - width;

    let advanceY = 0;
    for (const { index, advance, yAdvance, xOffset, yOffset } of glyphs) {
      const contours = font.getGlyphContours(index, curveSegments);
      if (contours.length > 0) {
        // Scale and translate glyph contours to world space
        const worldLoops: Point2D[][] = contours.map((loop) =>
          loop.map((p) => [cursorX + xOffset + p[0] * size, cursorY + advanceY + yOffset + p[1] * size]),
        );

        const shapes = classifyLoops(worldLoops);
        for (const shape of shapes) {
          extrudeShapeGeometry(
            shape.outer,
            shape.holes,
            options,
            capVertices,
            capNormals,
            capUVs,
            capIndices,
            wallVertices,
            wallNormals,
            wallUVs,
            wallIndices,
            bbox,
          );
        }
      }
      cursorX += advance;
      advanceY += yAdvance;
    }
    cursorY -= lineSpacing;
  }

  // Combine caps and walls
  const numCapVerts = capVertices.length / 3;
  const numWallVerts = wallVertices.length / 3;
  const totalVerts = numCapVerts + numWallVerts;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(capIndices.length + wallIndices.length);

  // Copy caps
  positions.set(capVertices, 0);
  normals.set(capNormals, 0);
  uvs.set(capUVs, 0);
  indices.set(capIndices, 0);

  // Copy walls with offset indices
  positions.set(wallVertices, numCapVerts * 3);
  normals.set(wallNormals, numCapVerts * 3);
  uvs.set(wallUVs, numCapVerts * 2);

  const wallOffset = capIndices.length;
  for (let i = 0; i < wallIndices.length; i++) {
    indices[wallOffset + i] = wallIndices[i] + numCapVerts;
  }

  const groups: GeometryGroup[] = [];
  if (capIndices.length > 0) {
    groups.push({ start: 0, count: capIndices.length, materialIndex: 0 });
  }
  if (wallIndices.length > 0) {
    groups.push({ start: capIndices.length, count: wallIndices.length, materialIndex: 1 });
  }

  if (totalVerts === 0) {
    bbox.min = [0, 0, 0];
    bbox.max = [0, 0, 0];
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    groups,
    boundingBox: bbox,
    toGeometry(GeometryClass?: any) {
      if (GeometryClass) return new GeometryClass(positions, normals, indices);
      return { positions, normals, uvs, indices, groups };
    },
  };
}

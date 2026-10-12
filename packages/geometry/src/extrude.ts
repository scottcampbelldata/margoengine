import {geometryData, sequentialIndices, type GeometryData} from './data.js';
import type {Curve} from './curve.js';
import type {Vec2, Vec3} from './math.js';
import type {Shape} from './path.js';
import {isClockWise, mergeOverlappingPoints, triangulateShape} from './triangulate.js';

/** Three.js `ShapeGeometry`: flat, front-facing +z, UVs are the raw shape coordinates. One group per shape when given an array. */
export function shapeGeometry(shapes: Shape | readonly Shape[], curveSegments = 12): GeometryData {
  const list = (Array.isArray(shapes) ? shapes : [shapes]) as readonly Shape[];
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [], groups = [];
  for (let s = 0; s < list.length; s++) {
    const {shape, holes} = list[s].extractPoints(curveSegments), start = idx.length, base = p.length / 3;
    const result = triangulateShape(isClockWise(shape) ? shape : shape.slice().reverse(), holes.map(h => isClockWise(h) ? h.slice().reverse() : h));
    for (const v of [result.contour, ...result.holes].flat()) {p.push(v[0], v[1], 0); n.push(0, 0, 1); uv.push(v[0], v[1]);}
    for (const i of result.indices) idx.push(base + i);
    groups.push({start, count: idx.length - start, materialIndex: s});
  }
  // Like Three.js, a single shape (not an array) gets no groups.
  return geometryData(p, n, uv, idx, Array.isArray(shapes) ? groups : undefined);
}

export interface ExtrudeOptions {
  /** Points per curve segment of the shape. Default 12. */
  curveSegments?: number;
  /** Subdivisions along the depth or the path. Default 1. */
  steps?: number;
  /** Extrusion depth along +z. Default 1. Ignored with `extrudePath`. */
  depth?: number;
  /** Default true. Forced off with `extrudePath`, like Three.js. */
  bevelEnabled?: boolean;
  /** How deep the bevel goes into the shape. Default 0.2. */
  bevelThickness?: number;
  /** Distance from the shape outline the bevel extends. Default `bevelThickness - 0.1`. */
  bevelSize?: number;
  /** Distance from the outline the bevel starts. Default 0. */
  bevelOffset?: number;
  /** Bevel layers. Default 3. */
  bevelSegments?: number;
  /** 3D curve to sweep the shape along. Shape x follows the frame normal, y the binormal. */
  extrudePath?: Curve<Vec3>;
}

/** Three.js bevel offset direction for a contour vertex (`getBevelVec`). */
function bevelVector(pt: Vec2, prev: Vec2, next: Vec2): Vec2 {
  let tx: number, ty: number, shrink: number;
  const px = pt[0] - prev[0], py = pt[1] - prev[1], nx = next[0] - pt[0], ny = next[1] - pt[1], prevLenSq = px * px + py * py;
  const collinear = px * ny - py * nx;
  if (Math.abs(collinear) > Number.EPSILON) {
    const pl = Math.sqrt(prevLenSq), nl = Math.sqrt(nx * nx + ny * ny);
    const psx = prev[0] - py / pl, psy = prev[1] + px / pl, nsx = next[0] - ny / nl, nsy = next[1] + nx / nl;
    const sf = ((nsx - psx) * ny - (nsy - psy) * nx) / (px * ny - py * nx);
    tx = psx + px * sf - pt[0]; ty = psy + py * sf - pt[1];
    const lsq = tx * tx + ty * ty;
    if (lsq <= 2) return [tx, ty];
    shrink = Math.sqrt(lsq / 2);
  } else {
    const same = px > Number.EPSILON ? nx > Number.EPSILON : px < -Number.EPSILON ? nx < -Number.EPSILON : Math.sign(py) === Math.sign(ny);
    if (same) {tx = -py; ty = px; shrink = Math.sqrt(prevLenSq);}
    else {tx = px; ty = py; shrink = Math.sqrt(prevLenSq / 2);}
  }
  return [tx / shrink, ty / shrink];
}

const movements = (ring: Vec2[]) => ring.map((p, i) => bevelVector(p, ring[(i + ring.length - 1) % ring.length], ring[(i + 1) % ring.length]));

/**
 * Three.js `ExtrudeGeometry`: extrudes shapes (with holes) along +z or along a 3D path, with an optional rounded
 * bevel. Non-indexed like Three.js with flat normals. Groups: 0 for the caps, 1 for the side walls, per shape.
 * UVs follow Three.js `WorldUVGenerator` (raw coordinates).
 */
export function extrudeGeometry(shapes: Shape | readonly Shape[], options: ExtrudeOptions = {}): GeometryData {
  const list = (Array.isArray(shapes) ? shapes : [shapes]) as readonly Shape[];
  const pos: number[] = [], uv: number[] = [], groups: {start: number; count: number; materialIndex: number}[] = [];
  for (const shape of list) build(shape, options, pos, uv, groups);
  const count = pos.length / 3, normals = new Float32Array(pos.length);
  for (let t = 0; t < count; t += 3) {
    const o = t * 3, e1 = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]], e2 = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0], l = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) normals.set([nx / l, ny / l, nz / l], o + k * 3);
  }
  return geometryData(pos, normals, uv, sequentialIndices(count), groups);
}

function build(shape: Shape, options: ExtrudeOptions, out: number[], uvOut: number[], groups: {start: number; count: number; materialIndex: number}[]): void {
  const curveSegments = options.curveSegments ?? 12, steps = Math.max(1, Math.floor(options.steps ?? 1)), depth = options.depth ?? 1;
  let bevelEnabled = options.bevelEnabled ?? true;
  const bevelThickness = options.bevelThickness ?? 0.2, bevelSize = options.bevelSize ?? bevelThickness - 0.1, bevelOffset = options.bevelOffset ?? 0;
  let bevelSegments = Math.floor(options.bevelSegments ?? 3);
  const path = options.extrudePath;
  let pathPoints: Vec3[] = [], frames: ReturnType<Curve<Vec3>['computeFrenetFrames']> | null = null;
  if (path) {pathPoints = path.getSpacedPoints(steps); frames = path.computeFrenetFrames(steps, false); bevelEnabled = false;}
  if (!bevelEnabled) bevelSegments = 0;

  const extracted = shape.extractPoints(curveSegments);
  // Three.js convention: outer contour clockwise, holes counter-clockwise. Normalized for any input orientation.
  // Orient first, then merge overlapping points, in the same order as Three.js so the vertex order matches.
  const outer = mergeOverlappingPoints(isClockWise(extracted.shape) ? extracted.shape : extracted.shape.slice().reverse());
  const tri = triangulateShape(outer, extracted.holes.map(h => mergeOverlappingPoints(isClockWise(h) ? h.slice().reverse() : h)));
  const contour = tri.contour, holes = tri.holes, faces = tri.indices, vertices = [contour, ...holes].flat(), vlen = vertices.length;
  const contourMoves = movements(contour), holeMoves = holes.map(movements), allMoves = [contourMoves, ...holeMoves].flat();
  const layers: number[] = [];
  const v = (x: number, y: number, z: number) => layers.push(x, y, z);
  const scaled = (p: Vec2, m: Vec2, s: number): Vec2 => [p[0] + m[0] * s, p[1] + m[1] * s];
  const bevelLayer = (b: number, zFor: (z: number) => number) => {
    const t = b / bevelSegments, z = bevelThickness * Math.cos(t * Math.PI / 2), bs = bevelSize * Math.sin(t * Math.PI / 2) + bevelOffset;
    contour.forEach((p, i) => {const q = scaled(p, contourMoves[i], bs); v(q[0], q[1], zFor(z));});
    holes.forEach((h, k) => h.forEach((p, i) => {const q = scaled(p, holeMoves[k][i], bs); v(q[0], q[1], zFor(z));}));
  };
  for (let b = 0; b < bevelSegments; b++) bevelLayer(b, z => -z);
  const bs = bevelSize + bevelOffset;
  for (let s = 0; s <= steps; s++) {
    for (let i = 0; i < vlen; i++) {
      const p = bevelEnabled ? scaled(vertices[i], allMoves[i], bs) : vertices[i];
      if (!frames) v(p[0], p[1], depth / steps * s);
      else {
        const n = frames.normals[s], bn = frames.binormals[s], c = pathPoints[s];
        v(c[0] + n[0] * p[0] + bn[0] * p[1], c[1] + n[1] * p[0] + bn[1] * p[1], c[2] + n[2] * p[0] + bn[2] * p[1]);
      }
    }
  }
  for (let b = bevelSegments - 1; b >= 0; b--) bevelLayer(b, z => depth + z);

  const at = (i: number): Vec3 => [layers[i * 3], layers[i * 3 + 1], layers[i * 3 + 2]];
  const push = (i: number) => {const p = at(i); out.push(p[0], p[1], p[2]);};
  // Caps.
  let start = out.length / 3;
  const top = vlen * (steps + bevelSegments * 2);
  for (let f = 0; f < faces.length; f += 3) {
    for (const i of [faces[f + 2], faces[f + 1], faces[f]]) {push(i); uvOut.push(layers[i * 3], layers[i * 3 + 1]);}
  }
  for (let f = 0; f < faces.length; f += 3) {
    for (const i of [faces[f], faces[f + 1], faces[f + 2]]) {push(i + top); uvOut.push(layers[(i + top) * 3], layers[(i + top) * 3 + 1]);}
  }
  groups.push({start, count: out.length / 3 - start, materialIndex: 0});
  // Side walls, Three.js `sidewalls`: quad (a, b, c, d) as triangles (a, b, d) and (b, c, d).
  start = out.length / 3;
  let offset = 0;
  for (const ring of [contour, ...holes]) {
    for (let i = ring.length - 1; i >= 0; i--) {
      const j = i, k = i - 1 < 0 ? ring.length - 1 : i - 1;
      for (let s = 0; s < steps + bevelSegments * 2; s++) {
        const a = offset + j + vlen * s, b = offset + k + vlen * s, c = offset + k + vlen * (s + 1), d = offset + j + vlen * (s + 1);
        const pa = at(a), pb = at(b), pc = at(c), pd = at(d);
        const useX = Math.abs(pa[1] - pb[1]) < Math.abs(pa[0] - pb[0]);
        const wallUV = (p: Vec3) => [useX ? p[0] : p[1], 1 - p[2]];
        for (const [i2, p] of [[a, pa], [b, pb], [d, pd], [b, pb], [c, pc], [d, pd]] as [number, Vec3][]) {push(i2); uvOut.push(...wallUV(p));}
      }
    }
    offset += ring.length;
  }
  groups.push({start, count: out.length / 3 - start, materialIndex: 1});
}

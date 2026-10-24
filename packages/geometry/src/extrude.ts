import { geometryData, sequentialIndices, type GeometryData, type GeometryGroup } from './data.js';
import type { Curve } from './curve.js';
import { finiteNumber, type MutableVec2, type MutableVec3 } from './math.js';
import type { Shape } from './path.js';
import { isClockWise, mergeOverlappingPoints, triangulateShape } from './triangulate.js';

/**
 * Longest bevel direction, in bevel sizes, at a sharp corner. Same ratio as the SVG default `stroke-miterlimit` of 4
 * (miter length over the offset distance), so spikes at needle-sharp corners stay bounded.
 */
const MITER_LIMIT = 4;

/** Outer ring clockwise and holes counter-clockwise, whatever the input winding. */
function orientRings(outer: MutableVec2[], holes: MutableVec2[][]): void {
  if (!isClockWise(outer)) outer.reverse();
  for (const hole of holes) if (isClockWise(hole)) hole.reverse();
}

/**
 * Fills shapes flat in the plane z = 0, facing +z. Vertices are each shape's outer ring then its holes, with
 * normals (0, 0, 1) and UVs equal to the shape coordinates (x, y). With an array of shapes, `groups` holds one entry
 * per shape (material index = position in the array); a single shape gives no groups.
 *
 * @param shapes - One shape or an array of shapes.
 * @param curveSegments - Divisions per curve passed to `Shape.extractPoints` (default 12).
 * @throws RangeError when `curveSegments` is not finite.
 */
export function shapeGeometry(shapes: Shape | readonly Shape[], curveSegments = 12): GeometryData {
  finiteNumber(curveSegments);
  const list: readonly Shape[] = Array.isArray(shapes) ? shapes : [shapes as Shape],
    positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    groups: GeometryGroup[] = [];
  list.forEach((shape, materialIndex) => {
    const { shape: outer, holes } = shape.extractPoints(curveSegments);
    orientRings(outer, holes);
    const fill = triangulateShape(outer, holes),
      base = positions.length / 3,
      start = indices.length;
    for (const p of [fill.contour, ...fill.holes].flat()) {
      positions.push(p[0], p[1], 0);
      normals.push(0, 0, 1);
      uvs.push(p[0], p[1]);
    }
    for (const i of fill.indices) indices.push(base + i);
    groups.push({ start, count: indices.length - start, materialIndex });
  });
  return geometryData(positions, normals, uvs, indices, Array.isArray(shapes) ? groups : undefined);
}

/** Options of {@link extrudeGeometry}. */
export interface ExtrudeOptions {
  /** Divisions per curve passed to `Shape.extractPoints`. Default 12. */
  curveSegments?: number;
  /** Layers along the depth (or along the path); floored, at least 1. Default 1. */
  steps?: number;
  /** Extrusion length along +z; ignored with `extrudePath`. Default 1. */
  depth?: number;
  /** Rounded bevel at both ends. Default true; always off with `extrudePath`. */
  bevelEnabled?: boolean;
  /** How far the bevel extends beyond each end along z. Default 0.2. */
  bevelThickness?: number;
  /** How far the bevel widens the outline. Default `bevelThickness - 0.1`. */
  bevelSize?: number;
  /** Outline offset where the bevel starts. Default 0. */
  bevelOffset?: number;
  /** Layers in each bevel; floored, values below 0 count as 0. Default 3. */
  bevelSegments?: number;
  /** Sweep along this 3D curve instead of +z: shape x follows the frame normal, y the binormal. */
  extrudePath?: Curve<MutableVec3>;
}

/**
 * Outward miter direction at each vertex of a ring (outer clockwise, holes counter-clockwise, so outward is to the
 * left of travel): offsetting a vertex by k along it moves both adjacent edges outward by k.
 */
function bevelDirections(ring: readonly MutableVec2[]): MutableVec2[] {
  const n = ring.length,
    out: MutableVec2[] = [];
  for (let k = 0; k < n; k++) {
    const p = ring[(k + n - 1) % n],
      c = ring[k],
      q = ring[(k + 1) % n];
    let ix = c[0] - p[0],
      iy = c[1] - p[1],
      ox = q[0] - c[0],
      oy = q[1] - c[1];
    const il = Math.hypot(ix, iy),
      ol = Math.hypot(ox, oy);
    if (il > 0) {
      ix /= il;
      iy /= il;
    }
    if (ol > 0) {
      ox /= ol;
      oy /= ol;
    }
    if (!(il > 0)) [ix, iy] = [ox, oy];
    if (!(ol > 0)) [ox, oy] = [ix, iy];
    // Left normals of the incoming and outgoing edges.
    const ax = -iy,
      ay = ix,
      bx = -oy,
      by = ox,
      denominator = 1 + ax * bx + ay * by;
    if (denominator < 1e-12) {
      // The ring doubles back on itself: push the tip forward along the incoming edge.
      out.push([ix, iy]);
      continue;
    }
    let mx = (ax + bx) / denominator,
      my = (ay + by) / denominator;
    const length = Math.hypot(mx, my);
    if (length > MITER_LIMIT) {
      mx *= MITER_LIMIT / length;
      my *= MITER_LIMIT / length;
    }
    out.push([mx, my]);
  }
  return out;
}

/**
 * Extrudes shapes into closed solids along +z (from z = 0 to z = `depth`), or sweeps them along `extrudePath`. Each
 * shape gives a watertight, outward-wound solid: a front cap facing -z, a back cap facing +z (group material 0) and
 * walls (group material 1), with an optional quarter-round bevel adding `bevelThickness` beyond both ends and
 * widening the outline by `bevelSize`. Output is non-indexed with flat normals (zero for zero-area triangles). Cap
 * UVs are the cap vertex (x, y); wall UVs run along the ring perimeter (u) and the extrusion (v), in shape units.
 *
 * @param shapes - One shape or an array of shapes (independent solids, concatenated).
 * @param options - See {@link ExtrudeOptions}.
 * @throws RangeError when `steps`, `curveSegments` or (with the bevel on) `bevelSegments` is not finite.
 */
export function extrudeGeometry(shapes: Shape | readonly Shape[], options: ExtrudeOptions = {}): GeometryData {
  const curveSegments = finiteNumber(options.curveSegments ?? 12),
    steps = Math.max(1, Math.floor(finiteNumber(options.steps ?? 1))),
    depth = options.depth ?? 1,
    path = options.extrudePath,
    bevel = path ? false : (options.bevelEnabled ?? true),
    thickness = options.bevelThickness ?? 0.2,
    size = options.bevelSize ?? thickness - 0.1,
    offset = options.bevelOffset ?? 0,
    segments = bevel ? Math.max(0, Math.floor(finiteNumber(options.bevelSegments ?? 3))) : 0;

  // Layers as (z, outline offset) for a straight extrusion: front bevel, body, back bevel (mirrored).
  const layers: [number, number][] = [];
  const quarter = (b: number): [number, number] => {
    const a = (b / segments) * (Math.PI / 2);
    return [thickness * Math.cos(a), size * Math.sin(a) + offset];
  };
  for (let b = 0; b < segments; b++) {
    const [dz, off] = quarter(b);
    layers.push([-dz, off]);
  }
  for (let s = 0; s <= steps; s++) layers.push([(depth * s) / steps, bevel ? size + offset : 0]);
  for (let b = segments - 1; b >= 0; b--) {
    const [dz, off] = quarter(b);
    layers.push([depth + dz, off]);
  }

  // Path frames, and v along the path (distance between layer centres).
  let centres: MutableVec3[] = [],
    frameN: MutableVec3[] = [],
    frameB: MutableVec3[] = [];
  const along: number[] = [];
  if (path) {
    centres = path.getSpacedPoints(steps);
    const frames = path.computeFrenetFrames(steps, false);
    frameN = frames.normals;
    frameB = frames.binormals;
    let run = 0;
    for (let s = 0; s <= steps; s++) {
      if (s > 0) run += Math.hypot(...(centres[s].map((v, i) => v - centres[s - 1][i]) as MutableVec3));
      along.push(run);
    }
  }
  const layerCount = path ? steps + 1 : layers.length;

  const list: readonly Shape[] = Array.isArray(shapes) ? shapes : [shapes as Shape],
    positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    groups: GeometryGroup[] = [];

  /** Appends one triangle with its flat normal. */
  const triangle = (
    a: MutableVec3,
    b: MutableVec3,
    c: MutableVec3,
    ua: MutableVec2,
    ub: MutableVec2,
    uc: MutableVec2,
  ) => {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else nx = ny = nz = 0;
    positions.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) normals.push(nx, ny, nz);
    uvs.push(...ua, ...ub, ...uc);
  };

  for (const shape of list) {
    const extracted = shape.extractPoints(curveSegments);
    orientRings(extracted.shape, extracted.holes);
    const fill = triangulateShape(
      mergeOverlappingPoints(extracted.shape),
      extracted.holes.map((h) => mergeOverlappingPoints(h)),
    );
    const rings = [fill.contour, ...fill.holes],
      flat = rings.flat(),
      directions = rings.flatMap(bevelDirections);

    // Vertex positions per layer, in ring order.
    const grid: MutableVec3[][] = [];
    for (let l = 0; l < layerCount; l++) {
      const row: MutableVec3[] = [];
      for (let k = 0; k < flat.length; k++) {
        const [x, y] = flat[k];
        if (path) {
          const c = centres[l],
            n = frameN[l],
            b = frameB[l];
          row.push([c[0] + x * n[0] + y * b[0], c[1] + x * n[1] + y * b[1], c[2] + x * n[2] + y * b[2]]);
        } else {
          const [z, off] = layers[l],
            d = directions[k];
          row.push([x + d[0] * off, y + d[1] * off, z]);
        }
      }
      grid.push(row);
    }

    // Caps: front (first layer) reversed to face -z, back (last layer) as triangulated, facing +z.
    const capStart = positions.length / 3,
      front = grid[0],
      back = grid[layerCount - 1],
      xy = (p: MutableVec3): MutableVec2 => [p[0], p[1]];
    for (let t = 0; t < fill.indices.length; t += 3) {
      const a = front[fill.indices[t]],
        b = front[fill.indices[t + 1]],
        c = front[fill.indices[t + 2]];
      triangle(a, c, b, xy(a), xy(c), xy(b));
    }
    for (let t = 0; t < fill.indices.length; t += 3) {
      const a = back[fill.indices[t]],
        b = back[fill.indices[t + 1]],
        c = back[fill.indices[t + 2]];
      triangle(a, b, c, xy(a), xy(b), xy(c));
    }
    const wallStart = positions.length / 3;
    groups.push({ start: capStart, count: wallStart - capStart, materialIndex: 0 });

    // Walls: per ring edge and per band between layers, a quad wound outward (outward is left of travel).
    let first = 0;
    for (const ring of rings) {
      let u = 0;
      for (let k = 0; k < ring.length; k++) {
        const i = first + k,
          j = first + ((k + 1) % ring.length),
          u1 = u + Math.hypot(ring[(k + 1) % ring.length][0] - ring[k][0], ring[(k + 1) % ring.length][1] - ring[k][1]);
        for (let l = 0; l + 1 < layerCount; l++) {
          const v0 = path ? along[l] : layers[l][0],
            v1 = path ? along[l + 1] : layers[l + 1][0],
            A = grid[l][i],
            B = grid[l][j],
            C = grid[l + 1][j],
            D = grid[l + 1][i];
          triangle(A, D, B, [u, v0], [u, v1], [u1, v0]);
          triangle(B, D, C, [u1, v0], [u, v1], [u1, v1]);
        }
        u = u1;
      }
      first += ring.length;
    }
    groups.push({ start: wallStart, count: positions.length / 3 - wallStart, materialIndex: 1 });
  }

  const data = geometryData(positions, normals, uvs, [], groups);
  data.indices = sequentialIndices(positions.length / 3);
  return data;
}

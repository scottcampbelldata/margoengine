// Chamfer a voxel surface. The greedy mesher's quads stay on the block grid, so a fractional bevel cannot live in that
// format: this builds a triangle mesh. The chamfer follows the cells, not the quads: every unit edge of a quad's
// outline is classified by the faces around it (convex, concave, or flat where the surface goes on in the same plane),
// so a merged quad and the split faces beside it chamfer the same line and two coplanar quads stay one flat surface.
// The surface is the face-edge-vertex construction of Doo and Sabin (1978): each face keeps a panel inset by `bevel`
// from its creased edges, each crease becomes a 45 degree strip between the two panels, and each lattice point where
// creases meet becomes a polygon closing the gap between the strips. Every new vertex lies on a face plane at `bevel`
// from a crease, so the pieces meet exactly, and a vertex that lies inside another piece's edge (the T-junctions of a
// greedy mesh, Lysenko 2012) is inserted into that edge, so the mesh has no cracks.
import { tile } from './faces.js';

/** A cube face {@link bevelQuads} can chamfer. A decoded chunk quad satisfies this. */
export interface CubeFace {
  /** Cell x of the face's origin. */
  x: number;
  /** Cell y of the face's origin. */
  y: number;
  /** Cell z of the face's origin. */
  z: number;
  /** 0-5: +x, −x, +y, −y, +z, −z. Faces 6 and 7 (crosses) are skipped. */
  face: number;
  /** Width in cells along the face's u axis: z on x faces, x on y and z faces. */
  w: number;
  /** Height in cells along the face's v axis: y on x and z faces, z on y faces. */
  h: number;
  /** Id copied onto every vertex of this face. Default 0. */
  material?: number;
  /** Mesher corner AO (0-3) in the corner order (0,0), (w,0), (w,h), (0,h). Default 3 (open). */
  ao?: readonly number[];
  /** Mesher corner sky light (0-15), same order. Default 15. */
  sky?: readonly number[];
  /** Mesher corner block light (0-15), same order. Default 0. */
  block?: readonly number[];
}

/** Triangle mesh from {@link bevelQuads}. Positions are in blocks, the same space as the input cells. */
export interface BevelMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit normal per vertex: the face's on its panel, the slope's on a chamfer strip or corner. */
  normals: Float32Array;
  /** Three vertex indices per triangle, counterclockwise seen from outside. */
  indices: Uint32Array;
  /** `CubeFace.material` per vertex. */
  materials: Uint32Array;
  /** Face tile coordinates per vertex, the same (u, v) as the chunk shader's `voxelTile`. */
  uv: Float32Array;
  /** AO, sky and block light per vertex, bilinear over the face's corners, in the mesher's units. */
  lighting: Float32Array;
}

type Vec = [number, number, number];

const NORMALS: readonly Vec[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const OPEN = [3, 3, 3, 3],
  SKY = [15, 15, 15, 15],
  DARK = [0, 0, 0, 0];
// The face's u and v axes: (z, y) on ±x, (x, z) on ±y, (x, y) on ±z, as the chunk mesher lays them out.
const AXES = [
  [2, 1],
  [0, 2],
  [0, 1],
];

const faceOf = (d: readonly number[]): number => (d[0] ? +(d[0] < 0) : d[1] ? 2 + +(d[1] < 0) : 4 + +(d[2] < 0));
const add = (a: readonly number[], b: readonly number[], s = 1): Vec => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a: readonly number[], b: readonly number[]): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const same = (a: readonly number[], b: readonly number[]): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const mid = (a: readonly number[], b: readonly number[]): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const axis = (a: number, s: number): Vec => {
  const v: Vec = [0, 0, 0];
  v[a] = s;
  return v;
};
// Unit face id: cell and face packed into one exact integer (cells within ±1024 of the origin).
const idOf = (c: readonly number[], f: number): number => (((c[0] + 1024) * 2048 + c[1] + 1024) * 2048 + c[2] + 1024) * 8 + f;
const cellOf = (id: number): Vec => {
  const f = Math.floor(id / 8);
  return [Math.floor(f / 4194304) - 1024, (Math.floor(f / 2048) % 2048) - 1024, (f % 2048) - 1024];
};
const round = (v: number): number => Math.round(v * 65536);

// A piece of the surface before triangulation: a loop counterclockwise from outside, the quad (index into the
// faces, then the context) that owns each edge's triangles, and a fan centre (corner polygons) or none (convex
// panels and strips).
interface Piece {
  points: Vec[];
  owners: number[];
  normal: Vec;
  center?: Vec;
}

/**
 * Bevels cube faces by `bevel` blocks. `0` returns each face as two flat triangles. Faces 6 and 7 are skipped. Pass
 * only faces of full cubes: a lowered liquid top is not a cube. Each unit edge of a face's outline is chamfered when
 * the faces around it make a convex or concave crease (a 45 degree strip `bevel` deep into both faces), and left flat
 * where a face goes on in the same plane or where no face is found across it, whatever quads the surface was merged
 * into. `context` lists faces that are not meshed but border these, such as a neighbouring chunk's: they decide the
 * creases and corners along the shared seam, so two chunks meshed with each other's faces as context meet exactly.
 * Corner AO and light are interpolated over panels, strips and corners from the face each triangle belongs to.
 * @throws RangeError when `bevel` is not in [0, 0.5).
 */
export function bevelQuads(quads: readonly CubeFace[], bevel: number, context: readonly CubeFace[] = []): BevelMesh {
  if (!(bevel >= 0 && bevel < 0.5)) throw new RangeError(`Voxel bevel ${bevel} must be in [0, 0.5) blocks`);
  const faces = quads.filter((quad) => quad.face < 6),
    all = [...faces, ...context.filter((quad) => quad.face < 6)],
    meshed = faces.length,
    // The cell of a quad's unit face (i, j) and the 3D point of its face coordinates (u, v).
    cellAt = (q: CubeFace, i: number, j: number): Vec => {
      const c: Vec = [q.x, q.y, q.z],
        [a, b] = AXES[q.face >> 1];
      c[a] += i;
      c[b] += j;
      return c;
    },
    pointAt = (q: CubeFace, u: number, v: number): Vec => {
      const p: Vec = [q.x, q.y, q.z],
        [a, b] = AXES[q.face >> 1];
      p[q.face >> 1] += +!(q.face & 1);
      p[a] += u;
      p[b] += v;
      return p;
    },
    // Unit face id -> owning quad.
    owner = new Map<number, number>();
  all.forEach((q, index) => {
    for (let i = 0; i < q.w; i++) for (let j = 0; j < q.h; j++) owner.set(idOf(cellAt(q, i, j), q.face), index);
  });
  // The face across side `o` (an in-plane unit vector) of unit face (c, f): the cell's own face that way (convex),
  // the next cell's face in the same plane (flat), or the face of the cell diagonally out and across (concave), in that
  // order, as [cell, face, its side toward the edge]. Kept only when that face picks this one back, so both sides of an
  // edge always agree; a pair never forms through a missing face.
  const across = (c: Vec, f: number, o: Vec): [Vec, number, Vec] | undefined => {
    const n = NORMALS[f],
      out = add(c, o),
      diagonal = add(out, n);
    if (owner.has(idOf(c, faceOf(o)))) return [c, faceOf(o), n];
    if (owner.has(idOf(out, f))) return [out, f, [-o[0], -o[1], -o[2]]];
    if (owner.has(idOf(diagonal, faceOf([-o[0], -o[1], -o[2]])))) return [diagonal, faceOf([-o[0], -o[1], -o[2]]), [-n[0], -n[1], -n[2]]];
  };
  const pairs = new Map<number, [Vec, number, Vec] | null>(),
    partner = (c: Vec, f: number, o: Vec): [Vec, number, Vec] | undefined => {
      const k = idOf(c, f) * 6 + faceOf(o);
      let p = pairs.get(k);
      if (p === undefined) {
        const found = across(c, f, o),
          back = found && across(...found);
        p = found && back && same(back[0], c) && back[1] === f ? found : null;
        pairs.set(k, p);
      }
      return p ?? undefined;
    },
    crease = (c: Vec, f: number, o: Vec): boolean => (partner(c, f, o)?.[1] ?? f) !== f,
    // The panel corner of unit face (c, f) at its corner point p: p moved `bevel` into the face from each crease there.
    inset = (c: Vec, f: number, p: Vec): Vec => {
      const q: Vec = [...p];
      for (let a = 0; a < 3; a++) {
        if (NORMALS[f][a]) continue;
        const o = axis(a, p[a] === c[a] + 1 ? 1 : -1);
        if (crease(c, f, o)) q[a] -= bevel * o[a];
      }
      return q;
    };
  const pieces: Piece[] = [],
    newell = (points: readonly Vec[]): Vec => {
      const n: Vec = [0, 0, 0];
      points.forEach((p, i) => {
        const q = points[(i + 1) % points.length];
        n[0] += (p[1] - q[1]) * (p[2] + q[2]);
        n[1] += (p[2] - q[2]) * (p[0] + q[0]);
        n[2] += (p[0] - q[0]) * (p[1] + q[1]);
      });
      const length = Math.hypot(...n);
      return length > 1e-9 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 0];
    },
    // Counterclockwise from outside: u x v points inward on +x, +y and -z, so those loops run the other way.
    piece = (points: Vec[], index: number, normal = newell(points)): void => {
      const f = all[index].face;
      if (f === 0 || f === 2 || f === 5) points.reverse();
      pieces.push({ points, owners: points.map(() => index), normal });
    },
    lattice = new Set<string>(),
    seams: Vec[] = [];
  faces.forEach((q, index) => {
    const f = q.face,
      [ua, va] = AXES[f >> 1],
      // Crease flags of the outline's unit edges: bottom and top per column, left and right per row.
      bottom: boolean[] = [],
      top: boolean[] = [],
      left: boolean[] = [],
      right: boolean[] = [];
    for (let i = 0; i < q.w; i++) {
      bottom.push(bevel > 0 && crease(cellAt(q, i, 0), f, axis(va, -1)));
      top.push(bevel > 0 && crease(cellAt(q, i, q.h - 1), f, axis(va, 1)));
    }
    for (let j = 0; j < q.h; j++) {
      left.push(bevel > 0 && crease(cellAt(q, 0, j), f, axis(ua, -1)));
      right.push(bevel > 0 && crease(cellAt(q, q.w - 1, j), f, axis(ua, 1)));
    }
    // The panel: rectangles split where an edge's crease flag changes, each inset from its creased sides. Their
    // corners on shared sides go into each other's edges later, so the panel stays one closed surface.
    const cuts = (a: boolean[], b: boolean[]) => [0, ...a.flatMap((x, i) => (i && (x !== a[i - 1] || b[i] !== b[i - 1]) ? [i] : [])), a.length];
    const columns = cuts(bottom, top),
      rows = cuts(left, right);
    for (let c = 1; c < columns.length; c++)
      for (let r = 1; r < rows.length; r++) {
        const u0 = columns[c - 1],
          u1 = columns[c],
          v0 = rows[r - 1],
          v1 = rows[r],
          l = u0 === 0 && left[v0] ? bevel : 0,
          rr = u1 === q.w && right[v0] ? bevel : 0,
          b = v0 === 0 && bottom[u0] ? bevel : 0,
          t = v1 === q.h && top[u0] ? bevel : 0;
        piece(
          [pointAt(q, u0 + l, v0 + b), pointAt(q, u1 - rr, v0 + b), pointAt(q, u1 - rr, v1 - t), pointAt(q, u0 + l, v1 - t)],
          index,
          NORMALS[f],
        );
      }
    if (!bevel) return;
    for (let i = 0; i <= q.w; i++)
      for (let j = 0; j <= q.h; j++)
        if (!i || !j || i === q.w || j === q.h) lattice.add(pointAt(q, i, j).join());
    // Chamfer strips: on each creased unit edge, the half between this face's panel and the strip's middle line,
    // merged along a run while both lines go on straight.
    const sides: [number, number, number, number, Vec][] = [
      [q.w, 0, 1, 0, axis(va, -1)],
      [q.w, q.h - 1, 1, 0, axis(va, 1)],
      [q.h, 0, 0, 1, axis(ua, -1)],
      [q.h, q.w - 1, 0, 1, axis(ua, 1)],
    ];
    for (const [count, fixed, di, dj, o] of sides) {
      const n = NORMALS[f],
        t = cross(n, o),
        along = di ? ua : va,
        forward = t[along] > 0;
      let run: [Vec, Vec, Vec, Vec] | undefined;
      const flush = () => {
        if (!run) return;
        const [qLow, qHigh, mLow, mHigh] = run;
        pieces.push({
          points: forward ? [qHigh, qLow, mLow, mHigh] : [qLow, qHigh, mHigh, mLow],
          owners: [index, index, index, index],
          normal: [0, 0, 0],
        });
        pieces[pieces.length - 1].normal = newell(pieces[pieces.length - 1].points);
        run = undefined;
      };
      for (let k = 0; k < count; k++) {
        const c = di ? cellAt(q, k, fixed) : cellAt(q, fixed, k),
          other = partner(c, f, o);
        if (!other || other[1] === f) {
          flush();
          continue;
        }
        const low = pointAt(q, di ? k : fixed + +(o[ua] > 0), di ? fixed + +(o[va] > 0) : k),
          high = add(low, axis(along, 1)),
          ql = inset(c, f, low),
          qh = inset(c, f, high),
          ml = mid(ql, inset(other[0], other[1], low)),
          mh = mid(qh, inset(other[0], other[1], high));
        if (run && same(run[1], ql) && same(run[3], ml)) {
          run[1] = qh;
          run[3] = mh;
        } else {
          flush();
          run = [ql, qh, ml, mh];
        }
      }
      flush();
    }
  });
  // Corner polygons: at each lattice point on an outline, walk the faces around it from one to the face across its
  // incoming edge, joining their panel corners (and the strip middles between creased pairs). A walk that ends at a
  // face with nothing across closes through the lattice point itself, where the missing faces meet it.
  for (const text of lattice) {
    const p = text.split(',').map(Number) as Vec,
      around: number[] = [],
      next = new Map<number, number | undefined>(),
      prev = new Map<number, number | undefined>(),
      sideOf = new Map<number, [Vec, Vec]>();
    for (let k = 0; k < 8; k++) {
      const c: Vec = [p[0] - (k & 1), p[1] - ((k >> 1) & 1), p[2] - ((k >> 2) & 1)];
      for (let a = 0; a < 3; a++) {
        const f = faceOf(axis(a, p[a] === c[a] + 1 ? 1 : -1)),
          id = idOf(c, f);
        if (!owner.has(id)) continue;
        const [b1, b2] = [0, 1, 2].filter((x) => x !== a),
          o1 = axis(b1, p[b1] === c[b1] + 1 ? 1 : -1),
          o2 = axis(b2, p[b2] === c[b2] + 1 ? 1 : -1),
          // The side whose edge ends at p in the face's counterclockwise loop comes in; the other goes out.
          [incoming, outgoing] = dot(cross(NORMALS[f], o1), o2) > 0 ? [o1, o2] : [o2, o1];
        around.push(id);
        sideOf.set(id, [incoming, outgoing]);
      }
    }
    for (const id of around) {
      const c = cellOf(id),
        f = id % 8,
        [incoming, outgoing] = sideOf.get(id)!,
        a = partner(c, f, incoming),
        b = partner(c, f, outgoing);
      next.set(id, a && idOf(a[0], a[1]));
      prev.set(id, b && idOf(b[0], b[1]));
    }
    const seen = new Set<number>(),
      seam = around.some((id) => owner.get(id)! >= meshed);
    for (const first of around) {
      if (seen.has(first)) continue;
      let start = first;
      for (let s = prev.get(start), steps = 0; s !== undefined && s !== first && steps < around.length; s = prev.get(s), steps++) start = s;
      const chain: number[] = [];
      for (let id: number | undefined = start; id !== undefined && !seen.has(id); id = next.get(id)) {
        seen.add(id);
        chain.push(id);
      }
      const closed = next.get(chain[chain.length - 1]) === chain[0],
        points: Vec[] = [],
        owners: number[] = [];
      chain.forEach((id, i) => {
        const c = cellOf(id),
          f = id % 8,
          q = inset(c, f, p),
          to = chain[(i + 1) % chain.length];
        points.push(q);
        owners.push(owner.get(id)!);
        if (i === chain.length - 1 && !closed) {
          points.push(p);
          owners.push(owner.get(chain[0])!);
        } else if (crease(c, f, sideOf.get(id)![0])) {
          points.push(mid(q, inset(cellOf(to), to % 8, p)));
          owners.push(owner.get(to)!);
        }
      });
      // On a seam (a context face meets p) the other side's mesh has its vertices here too, wherever its quads were
      // split: every point of the walk goes into the edges through p below, as it does on that side.
      if (seam) seams.push(...points.map((q): Vec => [...q]));
      // Drop repeated points and there-and-back spikes; what remains with area is the corner. Removing point j
      // joins its neighbours with the edge of the given owner.
      const remove = (j: number, keep: number) => {
        owners[(j - 1 + points.length) % points.length] = keep;
        points.splice(j, 1);
        owners.splice(j, 1);
      };
      for (let i = 0; points.length > 2 && i < points.length * 4; i++) {
        const at = i % points.length,
          j = (at + 1) % points.length,
          k = (at + 2) % points.length;
        if (same(points[at], points[j])) remove(j, owners[j]);
        else if (same(points[at], points[k])) remove(j, owners[at]);
        else continue;
        i = -1;
      }
      const normal = newell(points);
      if (points.length < 3 || !normal.some(Boolean)) continue;
      const center: Vec = [0, 1, 2].map((a) => points.reduce((s, q) => s + q[a], 0) / points.length) as Vec;
      pieces.push({ points, owners, normal, center });
    }
  }
  // T-junctions: insert into every axis-aligned edge the piece corners and seam points that lie inside it.
  const lines = new Map<string, number[]>(),
    lineKey = (p: readonly number[], a: number) => `${a},${round(p[(a + 1) % 3])},${round(p[(a + 2) % 3])}`;
  for (const points of [...pieces.map((item) => item.points), seams])
    for (const p of points)
      for (let a = 0; a < 3; a++) {
        const key = lineKey(p, a),
          line = lines.get(key) ?? [];
        line.push(p[a]);
        lines.set(key, line);
      }
  for (const line of lines.values()) line.sort((a, b) => a - b);
  for (const item of pieces) {
    const points: Vec[] = [],
      owners: number[] = [];
    item.points.forEach((p, i) => {
      const q = item.points[(i + 1) % item.points.length];
      points.push(p);
      owners.push(item.owners[i]);
      const differ = [0, 1, 2].filter((a) => round(p[a]) !== round(q[a]));
      if (differ.length !== 1) return;
      const a = differ[0],
        line = lines.get(lineKey(p, a))!,
        lo = Math.min(p[a], q[a]),
        hi = Math.max(p[a], q[a]),
        inside = line.filter((x, k) => round(x) > round(lo) && round(x) < round(hi) && (!k || round(line[k - 1]) !== round(x)));
      if (q[a] < p[a]) inside.reverse();
      for (const x of inside) {
        const r: Vec = [...p];
        r[a] = x;
        points.push(r);
        owners.push(item.owners[i]);
      }
    });
    item.points = points;
    item.owners = owners;
  }
  const positions: number[] = [],
    normals: number[] = [],
    materials: number[] = [],
    lighting: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  // A vertex of quad `index`'s triangles: texture and light from the point's place on that quad's face.
  const vertex = (point: readonly number[], index: number, normal: readonly number[]): number => {
    const q = all[index],
      [ua, va] = AXES[q.face >> 1],
      origin = pointAt(q, 0, 0),
      u = Math.min(Math.max((point[ua] - origin[ua]) / q.w, 0), 1),
      v = Math.min(Math.max((point[va] - origin[va]) / q.h, 0), 1),
      at = pointAt(q, u * q.w, v * q.h),
      mix = (c: readonly number[]) => (c[0] * (1 - u) + c[1] * u) * (1 - v) + (c[3] * (1 - u) + c[2] * u) * v;
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
    materials.push(q.material ?? 0);
    uv.push(...tile(q.face, at));
    lighting.push(mix(q.ao ?? OPEN), mix(q.sky ?? SKY), mix(q.block ?? DARK));
    return positions.length / 3 - 1;
  };
  for (const { points, owners, normal, center } of pieces) {
    if (!center && points.length === 4) {
      const [a, b, c, d] = points.map((p) => vertex(p, owners[0], normal));
      indices.push(a, b, c, a, c, d);
      continue;
    }
    const middle = center ?? ([0, 1, 2].map((a) => points.reduce((s, q) => s + q[a], 0) / points.length) as Vec),
      made = new Map<string, number>(),
      shared = (p: readonly number[], index: number) => {
        const key = `${p.join()}|${index}`;
        let i = made.get(key);
        if (i === undefined) made.set(key, (i = vertex(p, index, normal)));
        return i;
      };
    points.forEach((p, i) => {
      const index = owners[i];
      if (index < meshed) indices.push(shared(p, index), shared(points[(i + 1) % points.length], index), shared(middle, index));
    });
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    materials: Uint32Array.from(materials),
    uv: Float32Array.from(uv),
    lighting: Float32Array.from(lighting),
  };
}

/** A bevel for `VoxelRendererOptions.bevel`, from {@link voxelBevel}. */
export interface VoxelBevel {
  /** Blocks the cube faces are chamfered by, in (0, 0.5). */
  readonly amount: number;
  /**
   * @internal The chunk mesh: interleaved vertices (`layout`, blocks from `origin`), indices, and triangle centres in
   * chunk blocks. The renderer passes origin [0, 0, 0] and adds the chunk's origin per draw (`origins`), and the
   * neighbours' faces on the seams (`ChunkMesh.border`) as `context`.
   */
  mesh(
    faces: readonly CubeFace[],
    origin: readonly number[],
    context?: readonly CubeFace[],
  ): { vertices: Float32Array; indices: Uint32Array; centers: Float32Array };
  /** @internal The vertex layout: position, normal, uv, light, then material | face << 12. */
  readonly layout: GPUVertexBufferLayout;
  /** @internal The second vertex buffer: the chunk's origin in the renderer's integer frame, one per instance. */
  readonly origins: GPUVertexBufferLayout;
  /** @internal WGSL of the bevel beauty shader between the shared lit part and the shared shading end. */
  readonly shader: string;
  /** @internal WGSL of the bevel shadow casters (bevelVertex, bevelCutout). */
  readonly shadow: string;
}

const WORDS = 12;
const BEVEL = {
  layout: {
    arrayStride: WORDS * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32x3' },
      { shaderLocation: 4, offset: 44, format: 'uint32' },
    ],
  } as GPUVertexBufferLayout,
  origins: {
    arrayStride: 16,
    stepMode: 'instance',
    attributes: [{ shaderLocation: 5, offset: 0, format: 'float32x3' }],
  } as GPUVertexBufferLayout,
  // The fragment reads its material by id and its face's tangent from the material word; the rest is the quads' end.
  shader: /* wgsl */ `
struct In {@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) lighting:vec3f,@location(4) material:u32,@location(5) chunk:vec3f}
struct Out {@builtin(position) clip:vec4f,@location(0) n:vec3f,@location(1) @interpolate(flat) material:u32,@location(2) uv:vec2f,@location(3) world:vec3f,@location(4) lighting:vec3f}
@vertex fn vertex(v:In)->Out {var o:Out;let p=v.p+v.chunk;o.clip=f.camera*vec4f(p,1.0);o.n=v.n;o.material=v.material;o.uv=v.uv;o.world=p;o.lighting=v.lighting;return o;}
@fragment fn fragment(o:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
 let id=(o.material&4095u)*2u;let m=voxelMaterials[id];let maps=voxelMaterials[id+1u];
 let uv=o.uv;let dx=dpdx(uv);let dy=dpdy(uv);let lit=o.lighting;
 var i:VoxelPixel;i.clip=o.clip;i.position=o.world;
 let outward=normalize(o.n);let normal=outward*select(-1.0,1.0,front);let tangent=voxelTangent(o.material>>12u);`,
  shadow: /* wgsl */ `
struct BevelOut {@builtin(position) @invariant clip:vec4f,@location(0) @interpolate(flat) material:u32,@location(1) uv:vec2f}
@vertex fn bevelVertex(@location(0) v:vec3f,@location(2) uv:vec2f,@location(4) material:u32,@location(5) chunk:vec3f)->BevelOut {let p=v+chunk;return BevelOut(shadow.matrix*vec4f(p,1.0),material,uv);}
@fragment fn bevelCutout(o:BevelOut) {if(!voxelOpaque(voxelMaterials[(o.material&4095u)*2u],o.uv,shadow.time)){discard;}}
`,
};

/**
 * A bevel of `amount` blocks for `VoxelRenderer.attach(engine, { bevel: voxelBevel(0.15) })`: each chunk's cube faces
 * become a chamfered triangle mesh ({@link bevelQuads}), lit, shadowed and replayed like the quads. Its own entry, so
 * worlds without a bevel carry none of it.
 * @throws RangeError when `amount` is not in (0, 0.5).
 */
export function voxelBevel(amount: number): VoxelBevel {
  if (!(amount > 0 && amount < 0.5)) throw new RangeError(`voxelBevel ${amount} must be in (0, 0.5) blocks`);
  return {
    amount,
    ...BEVEL,
    mesh(faces, origin, context) {
      const built = bevelQuads(faces, amount, context),
        { positions: p, indices } = built,
        n = built.materials.length,
        vertices = new Float32Array(n * WORDS),
        words = new Uint32Array(vertices.buffer),
        centers = new Float32Array(indices.length);
      for (let v = 0, o = 0; v < n; v++, o += WORDS) {
        for (let a = 0; a < 3; a++) {
          vertices[o + a] = p[v * 3 + a] + origin[a];
          vertices[o + 3 + a] = built.normals[v * 3 + a];
          vertices[o + 8 + a] = built.lighting[v * 3 + a];
        }
        vertices[o + 6] = built.uv[v * 2];
        vertices[o + 7] = built.uv[v * 2 + 1];
        words[o + 11] = built.materials[v];
      }
      for (let i = 0; i < indices.length; i++)
        for (let a = 0; a < 3; a++) centers[i - (i % 3) + a] += p[indices[i] * 3 + a] / 3;
      return { vertices, indices, centers };
    },
  };
}

// Tangents the way MikkTSpace defines them (M. Mikkelsen, "Simulation of Wrinkled Surfaces Revisited", 2008): corners at
// one vertex share a tangent only when they belong to the same fan of connected triangles with the same UV orientation.
// Where a vertex holds two such fans, as on a mirror line, it is split, because one tangent frame cannot serve both.
import type { GeometryData } from './data.js';

/** Result of {@link splitTangents}. */
export interface SplitTangents {
  /** The mesh with tangents; vertices are added where the tangent frame breaks. */
  data: GeometryData;
  /** For each output vertex, the input vertex it came from, so attributes outside `GeometryData` can follow. */
  source: Uint32Array;
}

/** Ids shared by vertices with equal position, normal and UV: MikkTSpace treats those as one vertex. */
function weld(data: GeometryData): Uint32Array {
  const { positions: P, normals: N, uvs: UV } = data,
    count = P.length / 3,
    ids = new Map<string, number>(),
    out = new Uint32Array(count);
  for (let v = 0; v < count; v++) {
    const p = v * 3,
      t = v * 2,
      key = `${P[p]},${P[p + 1]},${P[p + 2]},${N[p]},${N[p + 1]},${N[p + 2]},${UV[t]},${UV[t + 1]}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    out[v] = id;
  }
  return out;
}

/**
 * Computes tangents and splits vertices where the tangent frame breaks, so a normal map baked against MikkTSpace (as
 * Blender and Substance do) shades without seams on any mesh, split at UV seams or not. Corners are grouped per vertex
 * by shared edges and UV orientation; a group's tangent is the angle-weighted sum of its triangles' tangents projected
 * onto the vertex normal's plane, and `w` is +1 for triangles that keep their UV orientation and -1 for mirrored ones.
 * Triangles with no UV area take the orientation of a neighbour and add no direction. The first group at a vertex keeps
 * the vertex index; others are appended. Triangles keep their order and winding.
 *
 * @param data - The mesh, with normals and UVs.
 * @throws RangeError when normals or UVs do not match the positions, or an index is out of range.
 */
export function splitTangents(data: GeometryData): SplitTangents {
  const { positions: P, normals: N, uvs: UV, indices: I } = data,
    count = P.length / 3,
    triangles = I.length / 3;
  if (N.length !== P.length || UV.length !== count * 2 || !Number.isInteger(triangles))
    throw new RangeError('splitTangents needs normals, UVs and whole triangles; pass matching attribute arrays');
  for (let i = 0; i < I.length; i++)
    if (I[i] >= count) throw new RangeError(`splitTangents index ${I[i]} is past ${count} vertices; fix the indices`);
  const welded = weld(data),
    span = count + 1,
    // Triangle tangent directions (the UV gradient of position) and orientation: 1, -1, or 0 for no UV area.
    faceTangent = new Float64Array(triangles * 3),
    orientation = new Int8Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const a = I[t * 3],
      b = I[t * 3 + 1],
      c = I[t * 3 + 2],
      du1 = UV[b * 2] - UV[a * 2],
      dv1 = UV[b * 2 + 1] - UV[a * 2 + 1],
      du2 = UV[c * 2] - UV[a * 2],
      dv2 = UV[c * 2 + 1] - UV[a * 2 + 1],
      area = du1 * dv2 - du2 * dv1;
    if (!area || !Number.isFinite(area)) continue;
    orientation[t] = area > 0 ? 1 : -1;
    for (let k = 0; k < 3; k++)
      faceTangent[t * 3 + k] = ((P[b * 3 + k] - P[a * 3 + k]) * dv2 - (P[c * 3 + k] - P[a * 3 + k]) * dv1) / area;
  }

  // Pair each directed edge with its opposite, between welded vertices.
  const open = new Map<number, number>(),
    pairs: number[] = [];
  for (let e = 0; e < I.length; e++) {
    const t = (e / 3) | 0,
      from = welded[I[e]],
      to = welded[I[t * 3 + ((e + 1) % 3)]];
    if (from === to) continue;
    const opposite = to * span + from,
      twin = open.get(opposite);
    if (twin === undefined) open.set(from * span + to, e);
    else {
      open.delete(opposite);
      pairs.push(e, twin);
    }
  }
  // Triangles with no UV area join the orientation of a neighbour across shared edges, spreading until settled.
  for (let changed = true; changed; ) {
    changed = false;
    for (let p = 0; p < pairs.length; p += 2) {
      const a = (pairs[p] / 3) | 0,
        b = (pairs[p + 1] / 3) | 0;
      if (orientation[a] === 0 && orientation[b] !== 0) orientation[a] = orientation[b];
      else if (orientation[b] === 0 && orientation[a] !== 0) orientation[b] = orientation[a];
      else continue;
      changed = true;
    }
  }

  // Corners in one fan join: across a shared edge both end corners of the edge pair up, when orientations agree.
  const parent = new Uint32Array(I.length);
  for (let c = 0; c < parent.length; c++) parent[c] = c;
  const find = (c: number): number => {
    while (parent[c] !== c) c = parent[c] = parent[parent[c]];
    return c;
  };
  const join = (a: number, b: number): void => {
    const x = find(a),
      y = find(b);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const next = (c: number): number => ((c / 3) | 0) * 3 + ((c + 1) % 3);
  for (let p = 0; p < pairs.length; p += 2) {
    const e = pairs[p],
      f = pairs[p + 1];
    if (orientation[(e / 3) | 0] !== orientation[(f / 3) | 0]) continue;
    join(e, next(f));
    join(next(e), f);
  }

  // Sum each group: the triangle's tangent on the plane of the vertex normal, weighted by the corner's angle there.
  const sum = new Float64Array(I.length * 3);
  for (let c = 0; c < I.length; c++) {
    const t = (c / 3) | 0;
    const fx = faceTangent[t * 3],
      fy = faceTangent[t * 3 + 1],
      fz = faceTangent[t * 3 + 2];
    if (!fx && !fy && !fz) continue;
    const v = I[c] * 3,
      nx = N[v],
      ny = N[v + 1],
      nz = N[v + 2],
      along = fx * nx + fy * ny + fz * nz;
    let px = fx - nx * along,
      py = fy - ny * along,
      pz = fz - nz * along;
    const size = Math.hypot(px, py, pz);
    if (!size) continue;
    px /= size;
    py /= size;
    pz /= size;
    // The corner's two edges, flattened onto the same plane.
    const b = I[next(c)] * 3,
      d = I[next(next(c))] * 3,
      ax = P[b] - P[v],
      ay = P[b + 1] - P[v + 1],
      az = P[b + 2] - P[v + 2],
      cx = P[d] - P[v],
      cy = P[d + 1] - P[v + 1],
      cz = P[d + 2] - P[v + 2],
      da = ax * nx + ay * ny + az * nz,
      dc = cx * nx + cy * ny + cz * nz,
      ex = ax - nx * da,
      ey = ay - ny * da,
      ez = az - nz * da,
      gx = cx - nx * dc,
      gy = cy - ny * dc,
      gz = cz - nz * dc,
      lengths = Math.hypot(ex, ey, ez) * Math.hypot(gx, gy, gz);
    if (!lengths) continue;
    const angle = Math.acos(Math.min(1, Math.max(-1, (ex * gx + ey * gy + ez * gz) / lengths))),
      root = find(c) * 3;
    sum[root] += px * angle;
    sum[root + 1] += py * angle;
    sum[root + 2] += pz * angle;
  }

  // One output vertex per input vertex and group result; equal frames share a vertex.
  const variants = new Map<string, number>(),
    claimed = new Uint8Array(count),
    source: number[] = Array.from({ length: count }, (_, v) => v),
    tangents: number[] = new Array(count * 4).fill(0),
    indices = new Uint32Array(I.length),
    frame = new Float32Array(4);
  for (let c = 0; c < I.length; c++) {
    const v = I[c],
      root = find(c) * 3;
    writeTangent(sum[root], sum[root + 1], sum[root + 2], N[v * 3], N[v * 3 + 1], N[v * 3 + 2], frame);
    frame[3] = orientation[(c / 3) | 0] < 0 ? -1 : 1;
    const key = `${v},${frame[0]},${frame[1]},${frame[2]},${frame[3]}`;
    let out = variants.get(key);
    if (out === undefined) {
      if (claimed[v]) {
        out = source.length;
        source.push(v);
      } else {
        out = v;
        claimed[v] = 1;
      }
      variants.set(key, out);
      for (let k = 0; k < 4; k++) tangents[out * 4 + k] = frame[k];
    }
    indices[c] = out;
  }
  // Vertices no triangle uses still get a unit tangent.
  for (let v = 0; v < count; v++) {
    if (claimed[v]) continue;
    writeTangent(0, 0, 0, N[v * 3], N[v * 3 + 1], N[v * 3 + 2], frame);
    tangents[v * 4] = frame[0];
    tangents[v * 4 + 1] = frame[1];
    tangents[v * 4 + 2] = frame[2];
    tangents[v * 4 + 3] = 1;
  }
  const size = source.length,
    positions = new Float32Array(size * 3),
    normals = new Float32Array(size * 3),
    uvs = new Float32Array(size * 2);
  for (let v = 0; v < size; v++) {
    const s = source[v];
    for (let k = 0; k < 3; k++) {
      positions[v * 3 + k] = P[s * 3 + k];
      normals[v * 3 + k] = N[s * 3 + k];
    }
    uvs[v * 2] = UV[s * 2];
    uvs[v * 2 + 1] = UV[s * 2 + 1];
  }
  const out: GeometryData = { positions, normals, uvs, indices, tangents: Float32Array.from(tangents) };
  if (data.groups) out.groups = data.groups.map((g) => ({ ...g }));
  return { data: out, source: Uint32Array.from(source) };
}

/** A unit vector from (x, y, z) on the plane of the normal; any vector on that plane when there is none. */
function writeTangent(x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array): void {
  let along = x * nx + y * ny + z * nz,
    tx = x - nx * along,
    ty = y - ny * along,
    tz = z - nz * along,
    size = Math.hypot(tx, ty, tz);
  if (size < 1e-12) {
    // The same pick as computeTangents, so a vertex no triangle uses gets the same frame from both.
    if (Math.abs(nx) < 0.9) [tx, ty, tz] = [0, nz, -ny];
    else [tx, ty, tz] = [-nz, 0, nx];
    along = tx * nx + ty * ny + tz * nz;
    tx -= nx * along;
    ty -= ny * along;
    tz -= nz * along;
    size = Math.hypot(tx, ty, tz) || 1;
  }
  out[0] = tx / size;
  out[1] = ty / size;
  out[2] = tz / size;
}

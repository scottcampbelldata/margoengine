// Weight transfer: skin weights from a rigged mesh to clothing or any other mesh. Each target vertex takes the weights
// at the closest point of the source's surface, interpolated over the source triangle. A match only counts when it is
// near and the surfaces face alike, so a sleeve vertex that lies closest to the torso does not take the torso's weights;
// the rest are filled in from the matched vertices around them over the target's own surface, after R. Abdrashitov,
// K. Raichstat, J. Monsen and D. Hill, "Robust skin weights transfer via weight inpainting", SIGGRAPH Asia 2023
// Technical Communications. The fill is a weighted average of neighbours, so weights stay at 0 or more and sum to 1.
import { MargoError } from '@margoengine/math/errors';
import { components, neighbours, weld, type WeightMesh, type Welded } from './mesh.js';
import { WeightMap, type VertexInfluences } from './weight-map.js';

/** A skinned mesh to copy from. */
export interface WeightSource extends WeightMesh {
  /** One row per vertex: a {@link WeightMap}, or JOINTS_0 / WEIGHTS_0 style influences. */
  readonly weights: WeightMap | VertexInfluences;
}

/** Options for {@link transferWeights}. */
export interface TransferOptions {
  /** Bones in the result, for influences that do not use the last ones. Default the source's. */
  boneCount?: number;
  /** Farthest a match may be, as a fraction of the source's size (default 0.05). */
  maxDistance?: number;
  /** Largest angle between the two surfaces at a match, degrees, 0 to 90 (default 60); either facing counts. */
  maxAngle?: number;
  /** Most sweeps of the fill (default 1,000); it stops sooner once weights settle. */
  iterations?: number;
  /** Weights below this are dropped before renormalising (default 1e-4). */
  threshold?: number;
  /** Welding tolerance of the target as a fraction of its size (default 1e-6: coincident vertices). */
  weld?: number;
  /** Cancels the transfer; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** {@link transferWeights}'s result. */
export interface TransferResult {
  /** Weights over the target's vertices. */
  readonly weights: WeightMap;
  /** Target points that matched the source. */
  readonly matched: number;
  /** Target points filled from their neighbours. */
  readonly filled: number;
}

const YIELD_MS = 30;
const SETTLED = 1e-5;

/** Area-weighted normal per welded point, unit length, or zero for a point on no triangle. */
function pointNormals(welded: Welded): Float64Array {
  const p = welded.positions,
    t = welded.triangles,
    out = new Float64Array(p.length);
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3,
      ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      out[o] += nx;
      out[o + 1] += ny;
      out[o + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const length = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (length > 0) {
      out[i] /= length;
      out[i + 1] /= length;
      out[i + 2] /= length;
    }
  }
  return out;
}

/**
 * Copies skin weights from `source` to `target` by proximity. Both meshes share one space. Vertices at one position get
 * the same weights. Resolves to a {@link WeightMap} over the target's vertices, with how many points matched and how
 * many were filled in. A part of the target with no match at all, such as a hat far from the body, takes the closest
 * weights as they are.
 * @throws TypeError or RangeError for invalid input.
 */
export async function transferWeights(
  source: WeightSource,
  target: WeightMesh,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const { maxDistance = 0.05, maxAngle = 60, iterations = 1000, threshold = 1e-4, signal } = options;
  if (!(maxDistance > 0 && maxDistance < Infinity)) throw new RangeError('Transfer maxDistance must be above 0');
  if (!(maxAngle >= 0 && maxAngle <= 90)) throw new RangeError('Transfer maxAngle must be from 0 to 90 degrees');
  if (!Number.isInteger(iterations) || iterations < 0) throw new RangeError('Transfer iterations must be 0 or more');
  if (!(threshold >= 0 && threshold < 0.5)) throw new RangeError('Transfer threshold must be from 0 to below 0.5');
  signal?.throwIfAborted();
  const weights =
      source?.weights instanceof WeightMap
        ? source.weights
        : WeightMap.fromInfluences(source?.weights as VertexInfluences, options.boneCount),
    bones = options.boneCount ?? weights.boneCount,
    positions = source?.positions,
    vertices = positions?.length / 3;
  if (bones < weights.boneCount)
    throw new RangeError(`Transfer boneCount ${bones} is under the source's ${weights.boneCount}; raise it`);
  if (weights.vertexCount !== vertices)
    throw new RangeError(`Transfer source has ${vertices} vertices and ${weights.vertexCount} rows; give one row each`);
  const from = weld({ positions, indices: source.indices }, 0),
    to = weld(target, options.weld);
  if (!from.triangles.length) throw new RangeError('Transfer source needs triangles; pass a mesh with faces');
  let module: typeof import('@margoengine/bvh');
  try {
    module = await import('@margoengine/bvh');
  } catch (cause) {
    throw new MargoError('unsupported', `Weight transfer needs @margoengine/bvh (${String(cause)}); install it`);
  }
  signal?.throwIfAborted();
  // Rows per unique source point: the first input vertex at it stands for all (weld at 0 joins only exact repeats).
  const stand = new Int32Array(from.positions.length / 3).fill(-1);
  for (let v = vertices - 1; v >= 0; v--) stand[from.point[v]] = v;
  const bvh = module.MeshBVH.build({ positions: from.positions, indices: from.triangles }),
    m = to.positions.length / 3,
    rows = new Float32Array(m * bones),
    matched = new Uint8Array(m),
    normals = pointNormals(to),
    reach = maxDistance * from.size,
    limit = Math.cos((maxAngle * Math.PI) / 180) - 1e-9,
    src = from.positions,
    tri = from.triangles,
    width = weights.boneCount,
    values = weights.values;
  const here = [0, 0, 0];
  let yielded = performance.now();
  for (let i = 0; i < m; i++) {
    here[0] = to.positions[i * 3];
    here[1] = to.positions[i * 3 + 1];
    here[2] = to.positions[i * 3 + 2];
    const hit = bvh.closestPointToPoint(here)!,
      a = tri[hit.faceIndex * 3],
      b = tri[hit.faceIndex * 3 + 1],
      c = tri[hit.faceIndex * 3 + 2],
      [wa, wb, wc] = hit.barycoord,
      ra = stand[a] * width,
      rb = stand[b] * width,
      rc = stand[c] * width;
    for (let j = 0; j < width; j++)
      rows[i * bones + j] = values[ra + j] * wa + values[rb + j] * wb + values[rc + j] * wc;
    const ux = src[b * 3] - src[a * 3],
      uy = src[b * 3 + 1] - src[a * 3 + 1],
      uz = src[b * 3 + 2] - src[a * 3 + 2],
      vx = src[c * 3] - src[a * 3],
      vy = src[c * 3 + 1] - src[a * 3 + 1],
      vz = src[c * 3 + 2] - src[a * 3 + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz) || 1,
      facing = Math.abs(nx * normals[i * 3] + ny * normals[i * 3 + 1] + nz * normals[i * 3 + 2]) / length,
      hasNormal = normals[i * 3] || normals[i * 3 + 1] || normals[i * 3 + 2];
    if (hit.distance <= reach && (!hasNormal || facing >= limit)) matched[i] = 1;
    if (performance.now() - yielded > YIELD_MS) {
      await new Promise((resolve) => setTimeout(resolve));
      yielded = performance.now();
      signal?.throwIfAborted();
    }
  }
  // A part with no match keeps what it found.
  const parts = components(to),
    anchored = new Set<number>();
  for (let i = 0; i < m; i++) if (matched[i]) anchored.add(parts[i]);
  for (let i = 0; i < m; i++) if (!anchored.has(parts[i])) matched[i] = 1;
  const { offsets, columns } = neighbours(to),
    open: number[] = [];
  for (let i = 0; i < m; i++) if (!matched[i]) open.push(i);
  // Edge weights fall with length, so a dense stitch line does not outvote the next panel.
  const reachOf = new Float32Array(columns.length),
    p = to.positions;
  for (const i of open)
    for (let e = offsets[i]; e < offsets[i + 1]; e++) {
      const j = columns[e];
      reachOf[e] =
        1 / Math.max(1e-12, Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]));
    }
  const row = new Float64Array(bones);
  for (let sweep = 0; sweep < iterations && open.length; sweep++) {
    let moved = 0;
    for (const i of open) {
      let total = 0;
      row.fill(0);
      for (let e = offsets[i]; e < offsets[i + 1]; e++) {
        const j = columns[e] * bones,
          w = reachOf[e];
        total += w;
        for (let k = 0; k < bones; k++) row[k] += rows[j + k] * w;
      }
      if (!(total > 0)) continue;
      for (let k = 0; k < bones; k++) {
        const next = row[k] / total,
          change = Math.abs(next - rows[i * bones + k]);
        if (change > moved) moved = change;
        rows[i * bones + k] = next;
      }
    }
    if (moved < SETTLED) break;
    if (performance.now() - yielded > YIELD_MS) {
      await new Promise((resolve) => setTimeout(resolve));
      yielded = performance.now();
      signal?.throwIfAborted();
    }
  }
  const result = new WeightMap(to.vertexCount, bones);
  for (let i = 0; i < m; i++) {
    let total = 0;
    for (let k = 0; k < bones; k++) {
      const at = i * bones + k;
      if (rows[at] < threshold) rows[at] = 0;
      total += rows[at];
    }
    if (total > 0) for (let k = 0; k < bones; k++) rows[i * bones + k] /= total;
  }
  for (let v = 0; v < to.vertexCount; v++)
    result.values.set(rows.subarray(to.point[v] * bones, (to.point[v] + 1) * bones), v * bones);
  return { weights: result, matched: m - open.length, filled: open.length };
}

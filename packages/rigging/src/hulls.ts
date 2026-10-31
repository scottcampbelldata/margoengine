// Per-joint convex hulls from a skinned mesh: the volume each joint carries, as data a collision or clearance test
// can read. A vertex belongs to the joint that dominates its skin weights; the hull of a joint's vertices is found
// with quickhull (@margoengine/geometry's convexGeometry) and, when the inverse bind matrices are given, expressed in
// the joint's own space so a hull follows its bone by the bone's world matrix alone.
import { convexGeometry } from '@margoengine/geometry/extras';
import { WeightMap, type VertexInfluences } from './weight-map.js';

/** A skinned mesh in its bind pose: vertex positions, and the skin weights that bind each vertex to joints. */
export interface JointHullModel {
  /** Bind-pose vertex positions, xyz per vertex, in the space the inverse bind matrices start from (mesh space). */
  readonly positions: ArrayLike<number>;
  /** Per-vertex influences (glTF JOINTS_0 / WEIGHTS_0, or wider) or a dense {@link WeightMap}; one row per vertex. */
  readonly skin: VertexInfluences | WeightMap;
}

/** Settings for {@link jointHulls}. */
export interface JointHullOptions {
  /**
   * A vertex counts toward a joint when that joint's weight on it is at least this (above 0, at most 1). The
   * default 0.5 gives each vertex to the joint that carries most of it, so the hulls of neighbouring joints meet
   * instead of overlapping; lower it to let blended vertices (an elbow) reach into both joints.
   */
  minWeight?: number;
  /** Most corners a hull keeps (8 to 1,024, default 64). A larger hull keeps the corners that stick out farthest. */
  maxPoints?: number;
  /**
   * Inverse bind matrices, 16 numbers per joint, column-major (glTF's `inverseBindMatrices`). When given, hull
   * corners are returned in each joint's own space (mesh space to joint space), so the hull moves with the joint by
   * its world matrix. Without it they stay in the space of `positions`.
   */
  inverseBindMatrices?: ArrayLike<number>;
}

/** One joint's hull. */
export interface JointHull {
  /** Index of the joint in the skin. */
  readonly joint: number;
  /** Vertices that counted toward this joint. */
  readonly vertexCount: number;
  /** The hull's corners, xyz each (at most `maxPoints`). */
  readonly points: Float32Array;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Keeps at most `limit` corners by taking the corner farthest along each of `limit` directions spread over the
 * sphere (the six axes first). Every kept point is a corner of the full hull, so the reduced hull sits inside it.
 */
function reduce(corners: Float32Array, limit: number): Float32Array {
  const count = corners.length / 3,
    chosen = new Set<number>(),
    extreme = (x: number, y: number, z: number): void => {
      let best = 0,
        bestDot = -Infinity;
      for (let i = 0; i < count; i++) {
        const dot = corners[i * 3] * x + corners[i * 3 + 1] * y + corners[i * 3 + 2] * z;
        if (dot > bestDot) {
          bestDot = dot;
          best = i;
        }
      }
      chosen.add(best);
    };
  for (const [x, y, z] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ])
    extreme(x, y, z);
  const rest = limit - 6;
  for (let i = 0; i < rest; i++) {
    const y = 1 - (2 * (i + 0.5)) / rest,
      r = Math.sqrt(1 - y * y),
      angle = i * GOLDEN_ANGLE;
    extreme(r * Math.cos(angle), y, r * Math.sin(angle));
  }
  const kept = chosen.size >= 4 ? [...chosen] : Array.from({ length: limit }, (_, i) => i);
  const out = new Float32Array(kept.length * 3);
  kept.forEach((corner, i) => out.set(corners.subarray(corner * 3, corner * 3 + 3), i * 3));
  return out;
}

/**
 * The convex hull of the vertices each joint dominates, from a skinned mesh in its bind pose. Joints that no vertex
 * dominates, or whose vertices do not span a volume (fewer than four, or all on a line or plane), have no hull and
 * are left out. Hulls come back in joint order. Run it once at load; it is not meant for a frame loop.
 *
 * ```ts
 * import {jointHulls} from 'margoengine/rigging/hulls';
 * // A 1 m box skinned to two joints: the lower half to joint 0, the upper half to joint 1.
 * const corners = [-0.5, 0.5].flatMap((x) => [0, 1].flatMap((y) => [-0.5, 0.5].flatMap((z) => [x, y, z])));
 * const joints = new Uint16Array([0, 0, 0, 0, 1, 1, 1, 1]);
 * const hulls = jointHulls({positions: corners, skin: {joints, weights: new Float32Array(8).fill(1), influences: 1}});
 * hulls.length; // 2 (hulls[1].joint === 1)
 * ```
 *
 * @throws TypeError when `model` has no positions or skin.
 * @throws RangeError for positions that are not xyz triples or are not finite, a skin whose vertex count differs from
 * the positions, a joint index outside `inverseBindMatrices`, a weight that is not finite, or an option out of range.
 */
export function jointHulls(model: JointHullModel, options: JointHullOptions = {}): JointHull[] {
  const positions = model?.positions,
    skin = model?.skin;
  if (!positions || typeof positions.length !== 'number' || !skin)
    throw new TypeError('jointHulls needs a model {positions, skin}: bind-pose xyz positions and skin weights');
  const { minWeight = 0.5, maxPoints = 64, inverseBindMatrices } = options;
  if (!(minWeight > 0 && minWeight <= 1)) throw new RangeError('jointHulls minWeight must be above 0 and at most 1');
  if (!Number.isInteger(maxPoints) || maxPoints < 8 || maxPoints > 1024)
    throw new RangeError('jointHulls maxPoints must be an integer from 8 to 1024');
  if (positions.length % 3 || positions.length < 12)
    throw new RangeError('jointHulls positions need xyz per vertex, at least four vertices');
  const vertexCount = positions.length / 3;
  for (let i = 0; i < positions.length; i++)
    if (!Number.isFinite(positions[i])) throw new RangeError(`jointHulls position ${i} is not finite; repair the mesh`);
  let jointLimit = 65536;
  if (inverseBindMatrices !== undefined) {
    if (!inverseBindMatrices || inverseBindMatrices.length % 16 || inverseBindMatrices.length < 16)
      throw new RangeError('jointHulls inverseBindMatrices need 16 numbers per joint');
    for (let i = 0; i < inverseBindMatrices.length; i++)
      if (!Number.isFinite(inverseBindMatrices[i]))
        throw new RangeError(`jointHulls inverseBindMatrices[${i}] is not finite; repair the skin`);
    jointLimit = inverseBindMatrices.length / 16;
  }

  const members = new Map<number, number[]>(),
    claim = (joint: number, vertex: number): void => {
      if (joint >= jointLimit)
        throw new RangeError(`jointHulls joint ${joint} has no inverse bind matrix; pass 16 numbers per joint`);
      let list = members.get(joint);
      if (!list) members.set(joint, (list = []));
      list.push(vertex);
    };
  if (skin instanceof WeightMap) {
    if (skin.vertexCount !== vertexCount)
      throw new RangeError(
        `jointHulls skin has ${skin.vertexCount} vertices but positions have ${vertexCount}; pass one skin row per vertex`,
      );
    const bones = skin.boneCount;
    for (let v = 0; v < vertexCount; v++)
      for (let b = 0; b < bones; b++) {
        const w = skin.values[v * bones + b];
        if (!Number.isFinite(w))
          throw new RangeError(
            `jointHulls weight of vertex ${v} on bone ${b} is not finite; repaint or normalize the skin`,
          );
        if (w >= minWeight) claim(b, v);
      }
  } else {
    const { joints, weights } = skin,
      slots = skin.influences ?? 4;
    if (!joints || !weights || !Number.isInteger(slots) || slots < 1 || joints.length !== weights.length)
      throw new TypeError('jointHulls skin needs joints and weights arrays of one length, `influences` per vertex');
    if (joints.length !== vertexCount * slots)
      throw new RangeError(
        `jointHulls skin has ${joints.length / slots} vertices but positions have ${vertexCount}; check influences`,
      );
    for (let v = 0; v < vertexCount; v++)
      for (let s = 0; s < slots; s++) {
        const joint = joints[v * slots + s],
          w = weights[v * slots + s];
        if (!Number.isFinite(w))
          throw new RangeError(
            `jointHulls weight of vertex ${v} slot ${s} is not finite; repaint or normalize the skin`,
          );
        if (w <= 0) continue;
        // A joint can fill several slots of one vertex: count their weights together, once per vertex.
        let total = w,
          first = true;
        for (let t = 0; t < slots; t++) {
          if (t === s || joints[v * slots + t] !== joint || !(weights[v * slots + t] > 0)) continue;
          if (t < s) first = false;
          total += weights[v * slots + t];
        }
        if (first && total >= minWeight) claim(joint, v);
      }
  }

  const hulls: JointHull[] = [];
  for (const joint of [...members.keys()].sort((a, b) => a - b)) {
    const vertices = members.get(joint)!;
    if (vertices.length < 4) continue;
    const cloud = new Float64Array(vertices.length * 3);
    vertices.forEach((v, i) => cloud.set([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]], i * 3));
    let shape: ArrayLike<number>;
    try {
      shape = convexGeometry(cloud).positions;
    } catch (error) {
      // quickhull rejects point sets without volume (all on a line or plane): those joints have no hull.
      if (error instanceof RangeError && error.message.startsWith('convexGeometry')) continue;
      throw error;
    }
    // The hull lists a corner once per flat face it touches: keep each corner once.
    const seen = new Set<string>(),
      corners: number[] = [];
    for (let i = 0; i < shape.length; i += 3) {
      const key = `${shape[i]},${shape[i + 1]},${shape[i + 2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      corners.push(shape[i], shape[i + 1], shape[i + 2]);
    }
    let points: Float32Array = Float32Array.from(corners);
    if (points.length / 3 > maxPoints) points = reduce(points, maxPoints);
    if (inverseBindMatrices) {
      const m = inverseBindMatrices,
        o = joint * 16;
      for (let i = 0; i < points.length; i += 3) {
        const x = points[i],
          y = points[i + 1],
          z = points[i + 2];
        points[i] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
        points[i + 1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
        points[i + 2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
      }
    }
    hulls.push({ joint, vertexCount: vertices.length, points });
  }
  return hulls;
}

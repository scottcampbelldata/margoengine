// Automatic skin weights by bone heat: I. Baran and J. Popovic, "Automatic rigging and animation of 3D characters",
// ACM SIGGRAPH 2007. Each bone's weight is the equilibrium temperature of the surface when that bone is held at 1 and
// the others at 0, heat flowing from a bone to the vertices that can see it: (-Laplacian + H) w_j = H p_j, with
// H_ii = c / d_i^2 for the distance d_i to the nearest visible bone and p_j(i) = 1 where bone j is that bone. With the
// cotangent stiffness matrix L and barycentric areas A this is the symmetric positive definite system
// (L + A H) w_j = A H p_j, solved per bone by Jacobi-preconditioned conjugate gradients (M. R. Hestenes and E. Stiefel,
// 1952). The p_j sum to 1 at every heated vertex and the rows of L sum to 0, so the exact weights sum to 1.
import { MargoError } from '@margoengine/math/errors';
import { boneSegments, checkRig, resolveJoints, segmentDistance2, type RigJoint } from './rig.js';
import { components, cotangentLaplacian, weld, type Sparse, type WeightMesh, type Welded } from './mesh.js';
import { WeightMap } from './weight-map.js';

/** Options for {@link boneHeatWeights}. */
export interface BoneHeatOptions {
  /**
   * Joints that move no vertices (indices or names), such as a root or armature joint at the feet. Default none.
   */
  readonly skip?: readonly (number | string)[];
  /**
   * Whether heat reaches a vertex only from bones it can see (the segment to the bone's closest point stays inside the
   * mesh). `true` (default) builds a BVH with `@margoengine/bvh`, loaded on first use; `false` uses the nearest bone
   * whatever lies between (faster, for convex parts and voxel blocks); or pass your own test, true when the segment
   * from `from` to `to` crosses no surface.
   */
  readonly visibility?: boolean | ((from: readonly number[], to: readonly number[]) => boolean);
  /** Heat constant c (default 1): larger keeps each vertex closer to its nearest bone, smaller blends wider. */
  readonly heat?: number;
  /** Welding tolerance as a fraction of the mesh's size (default 1e-6: coincident vertices). */
  readonly weld?: number;
  /** Largest weight correction (Jacobi-scaled residual) that ends a bone's solve (default 1e-6). */
  readonly tolerance?: number;
  /** Most conjugate-gradient iterations per bone (default 2,000). */
  readonly maxIterations?: number;
  /** Weights below this are dropped before renormalising (default 1e-4). */
  readonly threshold?: number;
  /** Cancels the solve between iterations; the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * Smooth automatic skin weights for `mesh` from the joints of a rest skeleton, by bone heat diffusion (Baran and
 * Popovic 2007). Joint positions and vertices share one space. Each joint moves the vertices around its bone
 * segments (from the joint to each child; a point at a leaf); weights fall off smoothly across joints, sum to 1 per
 * vertex and are 0 or more. Resolves to a {@link WeightMap} over the input vertices (duplicates at one position get
 * the same weights); `toInfluences()` gives JOINTS_0 / WEIGHTS_0.
 * @throws TypeError or RangeError for invalid input (thrown synchronously from the returned promise's start).
 */
export async function boneHeatWeights(
  mesh: WeightMesh,
  joints: readonly RigJoint[],
  options: BoneHeatOptions = {},
): Promise<WeightMap> {
  checkRig(joints);
  const {
    skip = [],
    visibility = true,
    heat = 1,
    tolerance = 1e-6,
    maxIterations = 2000,
    threshold = 1e-4,
    signal,
  } = options;
  if (!(heat > 0 && heat < Infinity)) throw new RangeError(`Bone heat ${heat} must be finite and above 0`);
  if (!(tolerance > 0 && tolerance < 1)) throw new RangeError('Bone heat tolerance must be above 0 and below 1');
  if (!Number.isInteger(maxIterations) || maxIterations < 1)
    throw new RangeError('Bone heat maxIterations must be a positive integer');
  if (!(threshold >= 0 && threshold < 0.5)) throw new RangeError('Bone heat threshold must be from 0 to below 0.5');
  if (typeof visibility !== 'boolean' && typeof visibility !== 'function')
    throw new TypeError('Bone heat visibility must be true, false or a function(from, to)');
  signal?.throwIfAborted();
  const skipped = new Set(resolveJoints(joints, skip, 'Bone heat skip'));
  if (skipped.size === joints.length) throw new RangeError('Bone heat skips every joint; leave at least one to move');
  const welded = weld(mesh, options.weld),
    segments = boneSegments(joints, (j) => !skipped.has(j)),
    visible = typeof visibility === 'function' ? visibility : visibility ? await bvhVisibility(welded) : null;
  signal?.throwIfAborted();
  const { nearest, heatDiagonal } = nearestBones(welded, joints.length, segments, visible, heat);
  const { matrix, area } = cotangentLaplacian(welded),
    m = area.length;
  // System diagonal (L + A H) and right-hand side scale A H.
  const scaled = new Float64Array(m);
  for (let i = 0; i < m; i++) scaled[i] = area[i] * heatDiagonal[i];
  // A point on no triangle (a stray vertex) has no stiffness: pin it to its nearest bone.
  for (let i = 0; i < m; i++) if (!(matrix.diagonal[i] + scaled[i] > 0)) scaled[i] = 1;
  const result = new WeightMap(welded.vertexCount, joints.length),
    perPoint = new Float64Array(m * joints.length),
    bones = [...new Set(nearest.owners)].sort((a, b) => a - b),
    rhs = new Float64Array(m),
    x = new Float64Array(m),
    work = solverWork(m);
  let yielded = performance.now();
  for (const bone of bones) {
    for (let i = 0; i < m; i++) {
      const p = nearest.share(i, bone);
      rhs[i] = scaled[i] * p;
      x[i] = p;
    }
    await conjugateGradient(matrix, scaled, rhs, x, work, tolerance, maxIterations, async () => {
      if (performance.now() - yielded > 30) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        yielded = performance.now();
      }
      signal?.throwIfAborted();
    });
    for (let i = 0; i < m; i++) perPoint[i * joints.length + bone] = x[i];
  }
  // Clamp, threshold and renormalise per point, then copy to every input vertex.
  const b = joints.length;
  for (let i = 0; i < m; i++) {
    let sum = 0;
    for (let k = 0; k < b; k++) {
      const w = perPoint[i * b + k];
      perPoint[i * b + k] = w > 0 ? w : 0;
      sum += perPoint[i * b + k];
    }
    for (let k = 0; k < b; k++) if (perPoint[i * b + k] < threshold * sum) perPoint[i * b + k] = 0;
    sum = 0;
    for (let k = 0; k < b; k++) sum += perPoint[i * b + k];
    if (sum > 0) for (let k = 0; k < b; k++) perPoint[i * b + k] /= sum;
    else perPoint[i * b + nearest.first[i]] = 1;
  }
  for (let v = 0; v < welded.vertexCount; v++)
    result.values.set(perPoint.subarray(welded.point[v] * b, welded.point[v] * b + b), v * b);
  return result;
}

/** A visibility test backed by a BVH of the welded mesh. */
async function bvhVisibility(welded: Welded): Promise<(from: readonly number[], to: readonly number[]) => boolean> {
  if (!welded.triangles.length) return () => true;
  let module: typeof import('@margoengine/bvh');
  try {
    module = await import('@margoengine/bvh');
  } catch (cause) {
    throw new MargoError(
      'unsupported',
      `Bone heat visibility needs @margoengine/bvh (${String(cause)}); install it, or pass visibility: false`,
    );
  }
  const bvh = module.MeshBVH.build({ positions: welded.positions, indices: welded.triangles }),
    start = [0, 0, 0];
  return (from, to) => {
    // Start a hair inside the surface so the triangles at the vertex itself are not counted.
    for (let c = 0; c < 3; c++) start[c] = from[c] + (to[c] - from[c]) * 1e-3;
    if (start[0] === to[0] && start[1] === to[1] && start[2] === to[2]) return true;
    return !bvh.intersectsSegment(start, to);
  };
}

/** Per point: the nearest (visible) bone set and the heat H_ii. */
function nearestBones(
  welded: Welded,
  jointCount: number,
  segments: { points: Float64Array; owners: Int32Array },
  visible: ((from: readonly number[], to: readonly number[]) => boolean) | null,
  heat: number,
) {
  const p = welded.positions,
    m = p.length / 3,
    count = segments.owners.length,
    heatDiagonal = new Float64Array(m),
    first = new Int32Array(m),
    // Up to a few equidistant bones share a vertex's heat; stored as (bone, share) pairs per point.
    ties = new Int32Array(m * 4).fill(-1),
    order = new Int32Array(count),
    distances = new Float64Array(count),
    closest = new Float64Array(3),
    from = [0, 0, 0],
    to = [0, 0, 0],
    // A vertex on a bone (a cap centre on the axis) is held at that bone, without an unbounded heat.
    floor = (1e-3 * welded.size) ** 2,
    comp = components(welded),
    heated = new Set<number>();
  const assign = (i: number, useVisibility: boolean): boolean => {
    const x = p[i * 3],
      y = p[i * 3 + 1],
      z = p[i * 3 + 2];
    for (let s = 0; s < count; s++) {
      order[s] = s;
      distances[s] = segmentDistance2(segments.points, s, x, y, z);
    }
    order.sort((a, b) => distances[a] - distances[b]);
    let best = -1;
    for (let k = 0; k < count; k++) {
      const s = order[k];
      if (useVisibility && visible) {
        segmentDistance2(segments.points, s, x, y, z, closest);
        from[0] = x;
        from[1] = y;
        from[2] = z;
        to[0] = closest[0];
        to[1] = closest[1];
        to[2] = closest[2];
        if (!visible(from, to)) continue;
      }
      best = s;
      break;
    }
    if (best < 0) return false;
    const d2 = Math.max(distances[best], floor);
    heatDiagonal[i] = heat / d2;
    first[i] = segments.owners[best];
    // Bones within 0.1% of the nearest distance share the vertex (a joint where segments meet).
    let tie = 0;
    for (let k = 0; k < count && tie < 4; k++) {
      const s = order[k];
      if (distances[s] > distances[best] * 1.002 + floor) break;
      const owner = segments.owners[s];
      let seen = false;
      for (let t = 0; t < tie; t++) if (ties[i * 4 + t] === owner) seen = true;
      if (seen) continue;
      if (useVisibility && visible && s !== best) {
        segmentDistance2(segments.points, s, x, y, z, closest);
        to[0] = closest[0];
        to[1] = closest[1];
        to[2] = closest[2];
        if (!visible(from, to)) continue;
      }
      ties[i * 4 + tie++] = owner;
    }
    return true;
  };
  for (let i = 0; i < m; i++) if (assign(i, true)) heated.add(comp[i]);
  // A component no bone can see gets heat from the nearest bones regardless (an open shell, a separate prop).
  for (let i = 0; i < m; i++) if (!heated.has(comp[i])) assign(i, false);
  const owners: number[] = [];
  for (let i = 0; i < ties.length; i++) if (ties[i] >= 0) owners.push(ties[i]);
  return {
    heatDiagonal,
    nearest: {
      owners,
      first,
      /** p_bone at point i: 1/k when bone is one of the k bones tied nearest. */
      share(i: number, bone: number): number {
        if (!heatDiagonal[i]) return 0;
        let k = 0,
          hit = false;
        for (let t = 0; t < 4; t++) {
          const owner = ties[i * 4 + t];
          if (owner < 0) break;
          k++;
          if (owner === bone) hit = true;
        }
        return hit ? 1 / k : 0;
      },
    },
    jointCount,
  };
}

function solverWork(m: number) {
  return {
    r: new Float64Array(m),
    z: new Float64Array(m),
    p: new Float64Array(m),
    q: new Float64Array(m),
    inverse: new Float64Array(m),
  };
}

/** y = (L + diag(extra)) x. */
function multiply(matrix: Sparse, extra: Float64Array, x: Float64Array, y: Float64Array): void {
  const { offsets, columns, values, diagonal } = matrix;
  for (let i = 0; i < x.length; i++) {
    let sum = (diagonal[i] + extra[i]) * x[i];
    for (let k = offsets[i]; k < offsets[i + 1]; k++) sum += values[k] * x[columns[k]];
    y[i] = sum;
  }
}

/**
 * Jacobi-preconditioned conjugate gradients on (L + diag(extra)) x = b, from the guess in `x` (Y. Saad, "Iterative
 * Methods for Sparse Linear Systems", 2nd ed., 2003, algorithm 9.1), until no vertex's Jacobi-scaled residual exceeds
 * `tolerance` (weights are 0-1, so this is an absolute weight error). `tick` runs every 32 iterations.
 */
async function conjugateGradient(
  matrix: Sparse,
  extra: Float64Array,
  b: Float64Array,
  x: Float64Array,
  work: ReturnType<typeof solverWork>,
  tolerance: number,
  maxIterations: number,
  tick: () => Promise<void>,
): Promise<void> {
  const { r, z, p, q, inverse } = work,
    m = x.length;
  for (let i = 0; i < m; i++) inverse[i] = 1 / (matrix.diagonal[i] + extra[i]);
  multiply(matrix, extra, x, q);
  let bNorm = 0,
    rz = 0;
  for (let i = 0; i < m; i++) {
    r[i] = b[i] - q[i];
    z[i] = r[i] * inverse[i];
    p[i] = z[i];
    rz += r[i] * z[i];
    bNorm += b[i] * b[i];
  }
  bNorm = Math.sqrt(bNorm);
  if (!(bNorm > 0)) {
    x.fill(0);
    return;
  }
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Stop when the Jacobi-scaled residual, a weight correction per vertex, is below the tolerance everywhere.
    let largest = 0;
    for (let i = 0; i < m; i++) largest = Math.max(largest, Math.abs(z[i]));
    if (largest <= tolerance) return;
    if (iteration % 32 === 31) await tick();
    multiply(matrix, extra, p, q);
    let pq = 0;
    for (let i = 0; i < m; i++) pq += p[i] * q[i];
    if (!(pq > 0)) return; // the residual is already at rounding level
    const alpha = rz / pq;
    let next = 0;
    for (let i = 0; i < m; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * q[i];
      z[i] = r[i] * inverse[i];
      next += r[i] * z[i];
    }
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < m; i++) p[i] = z[i] + beta * p[i];
  }
  throw new MargoError(
    'failed',
    `Bone heat did not converge in ${maxIterations} iterations; raise maxIterations or tolerance, or remesh slivers`,
  );
}

// Skin weights that survive bad meshes, after O. Dionne and M. de Lasa, "Geodesic voxel binding for production character
// meshes", SCA 2013. The mesh is voxelized, not solved on: triangles mark a surface shell, a flood from outside finds
// what is not inside, and the bones are burned into the grid. Where a hole lets the flood in, the fill grows from the
// bones through voxels that surface blocks on at least four of the six axis directions. Distances to each bone are then
// geodesic through that solid, so holes, flipped or doubled faces, loose parts and intersecting shells all give weights,
// and an arm beside a hip does not bind to it unless the grid says they touch. Each vertex reads its bones' distances
// from the grid and turns them into weights with the paper's falloff.
import { boneSegments, checkRig, resolveJoints, segmentDistance2, type RigJoint } from './rig.js';
import { weld, type WeightMesh, type Welded } from './mesh.js';
import { WeightMap } from './weight-map.js';

/** Options for {@link voxelWeights}. */
export interface VoxelWeightsOptions {
  /** Voxels along the mesh's longest side, 8 to 512 (default 96). Finer parts apart need more. */
  resolution?: number;
  /** Joints that move no vertices (indices or names), such as a root at the feet. Default none. */
  skip?: readonly (number | string)[];
  /** Falloff power: larger keeps vertices closer to their nearest bone (default 4). */
  falloff?: number;
  /** Blend from distance (0) to distance squared (1) in the falloff (default 0.75). */
  curve?: number;
  /** Most bones per vertex before renormalising, 1 or more (default 4). */
  influences?: number;
  /** Closes gaps up to this many voxels before filling; parts closer than twice this fuse (default 0). */
  closing?: number;
  /** Welding tolerance as a fraction of the mesh's size (default 1e-6: coincident vertices). */
  weld?: number;
  /** Cancels the solve between bones; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link voxelWeights} found, beside the weights. */
export interface VoxelWeightsResult {
  /** Weights over the input vertices. */
  readonly weights: WeightMap;
  /** Grid size. */
  readonly grid: readonly [number, number, number];
  /** Solid voxels. */
  readonly voxels: number;
  /** Vertices no bone reached through the solid: they took the straight-line nearest bones. */
  readonly unreached: number;
}

const YIELD_MS = 30;
/** Axis directions of the six a voxel inside an open mesh must find surface on. */
const INSIDE_VOTES = 4;
const OUTSIDE = 0;
const SHELL = 1;
const SOLID = 2;

/** The grid over a mesh, one voxel of margin all round so the outside is connected. */
interface Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cell: number;
  readonly origin: readonly [number, number, number];
  readonly state: Uint8Array;
}

function makeGrid(welded: Welded, joints: readonly RigJoint[], resolution: number): Grid {
  const p = welded.positions,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const c = i % 3;
    if (p[i] < min[c]) min[c] = p[i];
    if (p[i] > max[c]) max[c] = p[i];
  }
  for (const joint of joints)
    for (let c = 0; c < 3; c++) {
      if (joint.position[c] < min[c]) min[c] = joint.position[c];
      if (joint.position[c] > max[c]) max[c] = joint.position[c];
    }
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(longest > 0)) throw new RangeError('Voxel weights need a mesh with some size; every point is the same');
  const cell = longest / resolution,
    n = [0, 1, 2].map((c) => Math.ceil((max[c] - min[c]) / cell) + 3);
  return {
    nx: n[0],
    ny: n[1],
    nz: n[2],
    cell,
    origin: [min[0] - cell * 1.5, min[1] - cell * 1.5, min[2] - cell * 1.5],
    state: new Uint8Array(n[0] * n[1] * n[2]),
  };
}

/** Marks every voxel a triangle passes through, by walking the triangle at under one voxel's spacing. */
function markTriangles(grid: Grid, welded: Welded): void {
  const { nx, ny, cell, origin, state } = grid,
    p = welded.positions,
    t = welded.triangles;
  const mark = (x: number, y: number, z: number): void => {
    state[
      Math.floor((x - origin[0]) / cell) +
        nx * (Math.floor((y - origin[1]) / cell) + ny * Math.floor((z - origin[2]) / cell))
    ] = SHELL;
  };
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3,
      longest = Math.max(
        Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]),
        Math.hypot(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]),
        Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1], p[c + 2] - p[b + 2]),
      ),
      steps = Math.max(1, Math.ceil((longest / cell) * 2));
    for (let u = 0; u <= steps; u++)
      for (let v = 0; v <= steps - u; v++) {
        const s = u / steps,
          r = v / steps,
          q = 1 - s - r;
        mark(
          p[a] * q + p[b] * s + p[c] * r,
          p[a + 1] * q + p[b + 1] * s + p[c + 1] * r,
          p[a + 2] * q + p[b + 2] * s + p[c + 2] * r,
        );
      }
  }
}

/** Dilates the shell `size` voxels, floods the outside, then erodes the dilation back: gaps close, parts keep their size. */
function fill(grid: Grid, closing: number): void {
  const { nx, ny, nz, state } = grid,
    count = state.length,
    grown = state.slice();
  const each = (from: Uint8Array, to: Uint8Array, value: number, test: (s: number) => boolean): void => {
    for (let z = 1; z < nz - 1; z++)
      for (let y = 1; y < ny - 1; y++)
        for (let x = 1; x < nx - 1; x++) {
          const i = x + nx * (y + ny * z);
          if (from[i] !== OUTSIDE && !test(from[i])) continue;
          if (
            test(from[i - 1]) ||
            test(from[i + 1]) ||
            test(from[i - nx]) ||
            test(from[i + nx]) ||
            test(from[i - nx * ny]) ||
            test(from[i + nx * ny])
          )
            to[i] = value;
        }
  };
  for (let pass = 0; pass < closing; pass++) {
    const copy = grown.slice();
    each(copy, grown, SHELL, (s) => s === SHELL);
  }
  // The outside: every voxel a flood from the corner reaches past the thickened shell.
  const outside = new Uint8Array(count),
    stack = new Int32Array(count);
  let top = 0;
  stack[top++] = 0;
  outside[0] = 1;
  while (top) {
    const i = stack[--top],
      x = i % nx,
      y = ((i / nx) | 0) % ny,
      z = (i / (nx * ny)) | 0;
    const visit = (j: number): void => {
      if (!outside[j] && grown[j] === OUTSIDE) {
        outside[j] = 1;
        stack[top++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < nx - 1) visit(i + 1);
    if (y > 0) visit(i - nx);
    if (y < ny - 1) visit(i + nx);
    if (z > 0) visit(i - nx * ny);
    if (z < nz - 1) visit(i + nx * ny);
  }
  // Erode the outside back in by the closing size, never past the true shell.
  for (let pass = 0; pass < closing; pass++) {
    const copy = outside.slice();
    for (let z = 1; z < nz - 1; z++)
      for (let y = 1; y < ny - 1; y++)
        for (let x = 1; x < nx - 1; x++) {
          const i = x + nx * (y + ny * z);
          if (copy[i] || state[i] === SHELL) continue;
          if (
            copy[i - 1] ||
            copy[i + 1] ||
            copy[i - nx] ||
            copy[i + nx] ||
            copy[i - nx * ny] ||
            copy[i + nx * ny]
          )
            outside[i] = 1;
        }
  }
  for (let i = 0; i < count; i++) if (!outside[i] && state[i] !== SHELL) state[i] = SOLID;
}

/** How many of the six axis directions find surface or solid from each voxel. */
function votes(grid: Grid): Uint8Array {
  const { nx, ny, nz, state } = grid,
    count = new Uint8Array(state.length);
  const sweep = (start: number, stride: number, length: number): void => {
    for (let seen = false, k = 0, i = start; k < length; k++, i += stride)
      if (state[i] !== OUTSIDE) seen = true;
      else if (seen) count[i]++;
    for (let seen = false, k = 0, i = start + stride * (length - 1); k < length; k++, i -= stride)
      if (state[i] !== OUTSIDE) seen = true;
      else if (seen) count[i]++;
  };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) sweep(nx * (y + ny * z), 1, nx);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) sweep(x + nx * ny * z, nx, ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) sweep(x + nx * y, nx * ny, nz);
  return count;
}

/** Fills from bone voxels the flood took for outside: the mesh leaks there, so the grid's `votes` say what is inside. */
function fillLeaks(grid: Grid, leaked: readonly number[], inside: Uint8Array): void {
  const { nx, ny, nz, state } = grid,
    stack = leaked.slice();
  while (stack.length) {
    const i = stack.pop()!,
      x = i % nx,
      y = ((i / nx) | 0) % ny,
      z = (i / (nx * ny)) | 0;
    const visit = (j: number): void => {
      if (state[j] === OUTSIDE && inside[j] >= INSIDE_VOTES) {
        state[j] = SOLID;
        stack.push(j);
      }
    };
    if (x > 0) visit(i - 1);
    if (x < nx - 1) visit(i + 1);
    if (y > 0) visit(i - nx);
    if (y < ny - 1) visit(i + nx);
    if (z > 0) visit(i - nx * ny);
    if (z < nz - 1) visit(i + nx * ny);
  }
}

/** Burns the bones into the grid. Returns each joint's voxels and the bone voxels the flood had called outside. */
function burnBones(
  grid: Grid,
  segments: { points: Float64Array; owners: Int32Array },
  jointCount: number,
): { seeds: Set<number>[]; leaked: number[] } {
  const { nx, ny, nz, cell, origin, state } = grid,
    seeds: Set<number>[] = Array.from({ length: jointCount }, () => new Set()),
    leaked: number[] = [],
    { points, owners } = segments,
    at = (v: number, c: number): number => Math.floor((v - origin[c]) / cell);
  for (let s = 0; s < owners.length; s++) {
    const o = s * 6,
      length = Math.hypot(points[o + 3] - points[o], points[o + 4] - points[o + 1], points[o + 5] - points[o + 2]),
      steps = Math.max(1, Math.ceil((length / cell) * 2));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps,
        x = at(points[o] + (points[o + 3] - points[o]) * t, 0),
        y = at(points[o + 1] + (points[o + 4] - points[o + 1]) * t, 1),
        z = at(points[o + 2] + (points[o + 5] - points[o + 2]) * t, 2);
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      const i = x + nx * (y + ny * z);
      if (state[i] === OUTSIDE) {
        state[i] = SOLID;
        leaked.push(i);
      }
      seeds[owners[s]].add(i);
    }
  }
  return { seeds, leaked };
}

/** A binary heap of voxels by distance, with lazy deletion. */
class Heap {
  private keys = new Float64Array(1024);
  private items = new Int32Array(1024);
  size = 0;
  push(key: number, item: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2),
        items = new Int32Array(this.size * 2);
      keys.set(this.keys);
      items.set(this.items);
      this.keys = keys;
      this.items = items;
    }
    let i = this.size++;
    const { keys, items } = this;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      items[i] = items[parent];
      i = parent;
    }
    keys[i] = key;
    items[i] = item;
  }
  /** Removes the least; its item and key are left in `item` and `key`. */
  item = 0;
  key = 0;
  pop(): void {
    const { keys, items } = this;
    this.item = items[0];
    this.key = keys[0];
    const size = --this.size,
      lastKey = keys[size],
      lastItem = items[size];
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= size) break;
      if (child + 1 < size && keys[child + 1] < keys[child]) child++;
      if (keys[child] >= lastKey) break;
      keys[i] = keys[child];
      items[i] = items[child];
      i = child;
    }
    keys[i] = lastKey;
    items[i] = lastItem;
  }
}

/** The 26 neighbours of a voxel: offset and length in voxels. */
const NEIGHBOURS: readonly (readonly [number, number, number, number])[] = Array.from({ length: 27 }, (_, i) => {
  const dx = (i % 3) - 1,
    dy = (((i / 3) | 0) % 3) - 1,
    dz = ((i / 9) | 0) - 1;
  return [dx, dy, dz, Math.hypot(dx, dy, dz)] as const;
}).filter((n) => n[3] > 0);

/** Dijkstra over the solid's 26 neighbours from `seeds`, into `distance` (Infinity where nothing reaches). */
function geodesic(grid: Grid, seeds: ReadonlySet<number>, distance: Float64Array, heap: Heap): void {
  const { nx, ny, nz, cell, state } = grid;
  distance.fill(Infinity);
  heap.size = 0;
  for (const voxel of seeds) {
    distance[voxel] = 0;
    heap.push(0, voxel);
  }
  while (heap.size) {
    heap.pop();
    const i = heap.item,
      d = heap.key;
    if (d > distance[i]) continue;
    const x = i % nx,
      y = ((i / nx) | 0) % ny,
      z = (i / (nx * ny)) | 0;
    for (const [dx, dy, dz, length] of NEIGHBOURS) {
      const px = x + dx,
        py = y + dy,
        pz = z + dz;
      if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) continue;
      const j = px + nx * (py + ny * pz);
      if (state[j] === OUTSIDE) continue;
      const next = d + length * cell;
      if (next < distance[j]) {
        distance[j] = next;
        heap.push(next, j);
      }
    }
  }
}

/**
 * Skin weights for a mesh that bone heat cannot solve: holes, doubled or flipped faces, non-manifold edges, several
 * parts, intersecting shells. Geodesic voxel binding (Dionne and de Lasa 2013): voxelizes the mesh and bones, measures
 * each bone's distance through the solid, and gives each vertex the falloff of its nearest bones. Resolves to the
 * weights with what the grid held. Joints and vertices share one space. A part no bone reaches, such as a loose
 * accessory, takes the same falloff from straight-line distances and is counted in `unreached`.
 * @throws TypeError or RangeError for invalid input.
 */
export async function voxelWeights(
  mesh: WeightMesh,
  joints: readonly RigJoint[],
  options: VoxelWeightsOptions = {},
): Promise<VoxelWeightsResult> {
  checkRig(joints);
  const { resolution = 96, skip = [], falloff = 4, curve = 0.75, influences = 4, closing = 0, signal } = options;
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 512)
    throw new RangeError('Voxel resolution must be an integer from 8 to 512');
  if (!(falloff > 0 && falloff < Infinity)) throw new RangeError('Voxel falloff must be finite and above 0');
  if (!(curve >= 0 && curve <= 1)) throw new RangeError('Voxel curve must be from 0 to 1');
  if (!Number.isInteger(influences) || influences < 1) throw new RangeError('Voxel influences must be 1 or more');
  if (!Number.isInteger(closing) || closing < 0 || closing > 8)
    throw new RangeError('Voxel closing must be an integer from 0 to 8');
  signal?.throwIfAborted();
  const skipped = new Set(resolveJoints(joints, skip, 'Voxel weights skip'));
  if (skipped.size === joints.length) throw new RangeError('Voxel weights skip every joint; leave at least one to move');
  const welded = weld(mesh, options.weld),
    grid = makeGrid(welded, joints, resolution),
    { nx, ny, nz, cell, origin, state } = grid;
  markTriangles(grid, welded);
  fill(grid, closing);
  const inside = votes(grid),
    segments = boneSegments(joints, (j) => !skipped.has(j)),
    { seeds, leaked } = burnBones(grid, segments, joints.length);
  fillLeaks(grid, leaked, inside);
  const p = welded.positions,
    m = p.length / 3,
    // Each point's strongest bones so far: `influences` slots of (distance, joint), a little over to blend ties.
    slots = Math.min(influences, joints.length),
    bestDistance = new Float32Array(m * slots).fill(Infinity),
    bestJoint = new Int32Array(m * slots).fill(-1),
    distance = new Float64Array(state.length),
    heap = new Heap();
  // Keeps a point's `slots` nearest joints, sorted.
  const keep = (point: number, joint: number, d: number): void => {
    const base = point * slots;
    let at = slots;
    while (at > 0 && d < bestDistance[base + at - 1]) at--;
    if (at === slots) return;
    for (let s = slots - 1; s > at; s--) {
      bestDistance[base + s] = bestDistance[base + s - 1];
      bestJoint[base + s] = bestJoint[base + s - 1];
    }
    bestDistance[base + at] = d;
    bestJoint[base + at] = joint;
  };
  // Corner voxels and their trilinear shares per point: distances are read smoothly, not by the voxel a vertex is in.
  const corner = new Int32Array(m * 8),
    share = new Float32Array(m * 8);
  for (let i = 0; i < m; i++) {
    const fx = (p[i * 3] - origin[0]) / cell - 0.5,
      fy = (p[i * 3 + 1] - origin[1]) / cell - 0.5,
      fz = (p[i * 3 + 2] - origin[2]) / cell - 0.5,
      x = Math.min(nx - 2, Math.max(0, Math.floor(fx))),
      y = Math.min(ny - 2, Math.max(0, Math.floor(fy))),
      z = Math.min(nz - 2, Math.max(0, Math.floor(fz))),
      tx = fx - x,
      ty = fy - y,
      tz = fz - z;
    for (let k = 0; k < 8; k++) {
      const a = k & 1,
        b = (k >> 1) & 1,
        c = k >> 2;
      corner[i * 8 + k] = x + a + nx * (y + b + ny * (z + c));
      share[i * 8 + k] = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz);
    }
  }
  let yielded = performance.now();
  for (let joint = 0; joint < joints.length; joint++) {
    if (!seeds[joint].size) continue;
    geodesic(grid, seeds[joint], distance, heap);
    for (let i = 0; i < m; i++) {
      let sum = 0,
        total = 0;
      for (let k = 0; k < 8; k++) {
        const d = distance[corner[i * 8 + k]];
        if (d === Infinity) continue;
        sum += d * share[i * 8 + k];
        total += share[i * 8 + k];
      }
      if (total > 0) keep(i, joint, sum / total);
    }
    if (performance.now() - yielded > YIELD_MS) {
      await new Promise((resolve) => setTimeout(resolve));
      yielded = performance.now();
      signal?.throwIfAborted();
    }
  }
  // The input vertices of each point, as linked lists.
  const first = new Int32Array(m).fill(-1),
    next = new Int32Array(welded.vertexCount);
  for (let v = welded.vertexCount - 1; v >= 0; v--) {
    next[v] = first[welded.point[v]];
    first[welded.point[v]] = v;
  }
  const result = new WeightMap(welded.vertexCount, joints.length),
    row = new Float32Array(joints.length),
    straight = new Float64Array(joints.length);
  let unreached = 0;
  for (let i = 0; i < m; i++) {
    const base = i * slots;
    if (bestJoint[base] === -1) {
      // Nothing reached this point: a loose part. Straight lines to the bones stand in.
      unreached++;
      straight.fill(Infinity);
      for (let s = 0; s < segments.owners.length; s++) {
        const owner = segments.owners[s],
          d2 = segmentDistance2(segments.points, s, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        if (d2 < straight[owner]) straight[owner] = d2;
      }
      for (let j = 0; j < joints.length; j++) if (straight[j] < Infinity) keep(i, j, Math.sqrt(straight[j]));
    }
    // A vertex on a bone has distance 0: a floor of half a voxel keeps the falloff finite and smooth.
    let total = 0;
    row.fill(0);
    for (let s = 0; s < slots; s++) {
      const joint = bestJoint[base + s];
      if (joint === -1) break;
      const d = Math.max(bestDistance[base + s], cell * 0.5) / cell,
        w = ((1 - curve) * d + curve * d * d) ** -falloff;
      row[joint] = w;
      total += w;
    }
    for (let j = 0; j < joints.length; j++) row[j] /= total;
    for (let v = first[i]; v !== -1; v = next[v]) result.values.set(row, v * joints.length);
  }
  let voxels = 0;
  for (let i = 0; i < state.length; i++) if (state[i] !== OUTSIDE) voxels++;
  return { weights: result, grid: [nx, ny, nz], voxels, unreached };
}

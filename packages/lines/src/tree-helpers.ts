// Debug helpers for spatial queries: the boxes of a BVH or an octree down to a chosen depth, and a ray with its hits.
// Each is a `Line` of segments. The tree shapes are structural, so this entry imports neither @margoengine/bvh nor
// @margoengine/points; a `MeshBVH` and an `OctreeSource` (or `MemoryOctree`) fit as they are.
import type { Vec3 } from '@margoengine/core';
import type { ColorInput } from './color.js';
import type { HelperOptions } from './helpers.js';
import { Line } from './line.js';

const style = (options: HelperOptions) => ({ cap: 'butt' as const, join: 'miter' as const, ...options });

/** Pushes the 12 edges of a box (24 points) onto `out`. */
function pushBox(out: number[], lo: ArrayLike<number>, hi: ArrayLike<number>): void {
  for (let c = 0; c < 8; c++)
    for (const bit of [1, 2, 4])
      if (!(c & bit))
        for (const k of [c, c | bit]) out.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
}

function checkDepth(depth: unknown): number {
  if (!Number.isInteger(depth) || (depth as number) < 0 || (depth as number) > 64)
    throw new RangeError('Invalid tree helper depth; pass a whole number from 0 to 64');
  return depth as number;
}

/** The fields of a `MeshBVH` the helper reads: 8 words a node, bounds first (see `BVHData`). */
export interface BVHShape {
  readonly nodeBounds: Float32Array;
  readonly nodeData: Uint32Array;
}

/** Options for {@link BVHHelper} and {@link OctreeHelper}. */
export type TreeHelperOptions = {
  /** Depth drawn: the nodes at this level (the root is level 0) and every leaf above it, so the boxes cover the tree. Default 3. */
  depth?: number;
  /** Colour. Default a sky blue. */
  color?: ColorInput;
} & HelperOptions;

/** The boxes of a BVH at one depth, plus the leaves above it. `setDepth` rebuilds in place; `maxDepth` is the deepest level. */
export class BVHHelper extends Line {
  private level: number;
  readonly maxDepth: number;
  constructor(
    private readonly bvh: BVHShape,
    { depth = 3, color = [0.35, 0.75, 1], ...options }: TreeHelperOptions = {},
  ) {
    super({ ...style(options), color, mode: 'segments' });
    this.level = checkDepth(depth);
    const words = bvh.nodeData.length / 8;
    if (!Number.isInteger(words) || words < 1 || bvh.nodeBounds.length < words * 8)
      throw new RangeError('Invalid BVH shape; pass a MeshBVH or its nodeBounds and nodeData');
    let deepest = 0;
    this.walk((_node, level) => {
      deepest = Math.max(deepest, level);
      return false;
    });
    this.maxDepth = deepest;
    this.rebuild();
  }
  /** The level drawn. */
  get depth(): number {
    return this.level;
  }
  /** Draws another level, reusing the line's buffers when the box count is unchanged. */
  setDepth(depth: number): this {
    this.level = checkDepth(depth);
    return this.rebuild();
  }
  /** Depth first from the root; `visit(node, level)` returns true to stop descending. Left child is node + 1. */
  private walk(visit: (node: number, level: number) => boolean): void {
    const data = this.bvh.nodeData,
      count = data.length / 8,
      stack: number[] = [0, 0];
    let visited = 0;
    while (stack.length) {
      const level = stack.pop()!,
        node = stack.pop()!;
      // A right child lies after the left subtree's first node and inside the storage; every node is reached once.
      if (++visited > count || level > 64 || node >= count)
        throw new RangeError('Invalid BVH node links; pass the unmodified nodeBounds and nodeData of a MeshBVH');
      if (visit(node, level)) continue;
      if (data[node * 8 + 7] & 0x80000000) {
        const right = data[node * 8 + 6];
        if (!(right > node + 1 && right < count))
          throw new RangeError('Invalid BVH node links; pass the unmodified nodeBounds and nodeData of a MeshBVH');
        stack.push(right, level + 1, node + 1, level + 1);
      }
    }
  }
  private rebuild(): this {
    const out: number[] = [],
      f = this.bvh.nodeBounds,
      data = this.bvh.nodeData,
      want = this.level;
    this.walk((node, level) => {
      const leaf = !(data[node * 8 + 7] & 0x80000000);
      if (level === want || leaf) {
        const w = node * 8;
        pushBox(out, [f[w], f[w + 1], f[w + 2]], [f[w + 3], f[w + 4], f[w + 5]]);
        return true;
      }
      return false;
    });
    return this.setPositions(new Float32Array(out));
  }
}

/** The fields of an octree node the helper reads (`OctreeNode` fits). */
export interface OctreeNodeShape {
  /** minX, minY, minZ, maxX, maxY, maxZ. */
  readonly bounds: ArrayLike<number>;
  readonly children: readonly (OctreeNodeShape | null)[];
}

/** The boxes of an octree at one depth, plus the leaves above it. Takes a `MemoryOctree`, any `OctreeSource` or a root node. */
export class OctreeHelper extends Line {
  private level: number;
  readonly maxDepth: number;
  private readonly root: OctreeNodeShape;
  constructor(
    octree: OctreeNodeShape | { readonly root: OctreeNodeShape },
    { depth = 3, color = [0.55, 0.9, 0.45], ...options }: TreeHelperOptions = {},
  ) {
    super({ ...style(options), color, mode: 'segments' });
    this.level = checkDepth(depth);
    this.root = 'root' in octree ? octree.root : octree;
    if (!this.root?.bounds || this.root.bounds.length < 6)
      throw new TypeError('Invalid octree; pass a MemoryOctree, an OctreeSource or an octree node with bounds');
    let deepest = 0;
    this.walk((_node, level) => {
      deepest = Math.max(deepest, level);
      return false;
    });
    this.maxDepth = deepest;
    this.rebuild();
  }
  get depth(): number {
    return this.level;
  }
  /** Draws another level. */
  setDepth(depth: number): this {
    this.level = checkDepth(depth);
    return this.rebuild();
  }
  private walk(visit: (node: OctreeNodeShape, level: number) => boolean): void {
    const stack: [OctreeNodeShape, number][] = [[this.root, 0]],
      seen = new Set<OctreeNodeShape>();
    while (stack.length) {
      const [node, level] = stack.pop()!;
      if (level > 64 || seen.has(node))
        throw new RangeError(
          'Invalid octree: a node repeats or the tree is deeper than 64 levels; pass an octree whose children form a tree',
        );
      seen.add(node);
      if (visit(node, level)) continue;
      for (const child of node.children) if (child) stack.push([child, level + 1]);
    }
  }
  private rebuild(): this {
    const out: number[] = [],
      want = this.level;
    this.walk((node, level) => {
      const leaf = !node.children.some(Boolean);
      if (level === want || leaf) {
        const b = node.bounds;
        pushBox(out, [b[0], b[1], b[2]], [b[3], b[4], b[5]]);
        return true;
      }
      return false;
    });
    return this.setPositions(new Float32Array(out));
  }
}

/** A ray as a `Raycaster` keeps it. */
export interface RayShape {
  readonly origin: ArrayLike<number>;
  /** Unit length. */
  readonly direction: ArrayLike<number>;
  readonly near?: number;
  readonly far?: number;
}
/** What a hit needs: where it is and, optionally, its surface normal. */
export interface RayHitShape {
  readonly point: ArrayLike<number>;
  readonly normal?: ArrayLike<number>;
}

/** Options for {@link RaycasterHelper}. */
export type RaycasterHelperOptions = {
  /** Length drawn when the ray has no hit and an infinite `far`, world units. Default 10. */
  length?: number;
  /** Half-size of the cross drawn at each hit, and the length of its normal tick. Default 0.1. */
  markSize?: number;
  /** Colour. Default yellow-green. */
  color?: ColorInput;
} & HelperOptions;

/**
 * A ray and its hits: a segment from `origin + direction * near` to the farthest hit (or to `far`, or `length`), a cross
 * at every hit point and a tick along its normal. `set(ray, hits)` redraws in place.
 * @throws RangeError when a vector is not 3 finite numbers.
 */
export class RaycasterHelper extends Line {
  private readonly length: number;
  private readonly mark: number;
  constructor(ray?: RayShape, hits: readonly RayHitShape[] = [], options: RaycasterHelperOptions = {}) {
    const { length = 10, markSize = 0.1, color = [0.85, 0.95, 0.2], ...rest } = options;
    if (!(length > 0) || !Number.isFinite(length) || !(markSize > 0) || !Number.isFinite(markSize))
      throw new RangeError('Invalid raycaster helper size; pass a finite length and markSize above 0');
    super({ ...style(rest), color, mode: 'segments' });
    this.length = length;
    this.mark = markSize;
    if (ray) this.set(ray, hits);
  }
  /** Redraws the ray and its hits. */
  set(ray: RayShape, hits: readonly RayHitShape[] = []): this {
    const v = (a: ArrayLike<number>, what: string): Vec3 => {
      if (!a || a.length < 3 || !(Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2])))
        throw new RangeError(`Invalid ${what}; pass 3 finite numbers`);
      return [a[0], a[1], a[2]];
    };
    const o = v(ray.origin, 'ray origin'),
      d = v(ray.direction, 'ray direction'),
      near = ray.near ?? 0;
    let far = ray.far ?? Infinity;
    if (!Number.isFinite(far)) far = this.length;
    const out: number[] = [],
      at = (t: number) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    let reach = far;
    const points = hits.map((h) => v(h.point, 'hit point'));
    if (points.length)
      reach = Math.max(...points.map((p) => (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2]));
    out.push(...at(near), ...at(Math.max(near, reach)));
    const s = this.mark;
    hits.forEach((h, i) => {
      const [x, y, z] = points[i];
      out.push(x - s, y, z, x + s, y, z, x, y - s, z, x, y + s, z, x, y, z - s, x, y, z + s);
      if (h.normal) {
        const n = v(h.normal, 'hit normal');
        out.push(x, y, z, x + n[0] * 2 * s, y + n[1] * 2 * s, z + n[2] * 2 * s);
      }
    });
    return this.setPositions(new Float32Array(out));
  }
}

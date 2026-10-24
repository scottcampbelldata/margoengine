import { slabAny } from './bvh.js';

const LEAF = 4;

/**
 * @internal Top-level median-split tree over world bounding spheres, in Float64 so local geometry never gets rebaked
 * into world Float32 positions. Node n has bounds at `bounds[n * 6]` (min xyz, max xyz); a leaf covers
 * `order[begin, end)`, an internal node has its left child at n + 1 and its right child at `right[n]`.
 */
export class SnapshotTree {
  private readonly order: Int32Array;
  private readonly bounds: number[] = [];
  private readonly begin: number[] = [];
  private readonly end: number[] = [];
  private readonly right: number[] = [];
  private readonly stack: number[] = [];

  constructor(spheres: readonly ArrayLike<number>[]) {
    const n = spheres.length,
      boxes = new Float64Array(n * 6);
    this.order = Int32Array.from(spheres, (_, i) => i);
    for (let i = 0; i < n; i++) {
      const [x, y, z, radius] = spheres[i] as [number, number, number, number],
        pad = radius + 1e-8 * (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) + radius + 1);
      boxes.set([x - pad, y - pad, z - pad, x + pad, y + pad, z + pad], i * 6);
    }
    if (n) this.build(boxes, 0, n);
  }

  private build(boxes: Float64Array, begin: number, end: number): void {
    const node = this.begin.length,
      o = node * 6,
      order = this.order,
      b = this.bounds;
    b.push(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    this.begin.push(begin);
    this.end.push(end);
    this.right.push(-1);
    for (let i = begin; i < end; i++)
      for (let k = 0, w = order[i] * 6; k < 3; k++) {
        b[o + k] = Math.min(b[o + k], boxes[w + k]);
        b[o + k + 3] = Math.max(b[o + k + 3], boxes[w + k + 3]);
      }
    if (end - begin <= LEAF) return;
    let axis = 0;
    for (let k = 1; k < 3; k++) if (b[o + k + 3] - b[o + k] > b[o + axis + 3] - b[o + axis]) axis = k;
    const centre = (i: number) => boxes[i * 6 + axis] + boxes[i * 6 + axis + 3];
    order.subarray(begin, end).sort((p, q) => centre(p) - centre(q) || p - q);
    const middle = (begin + end) >>> 1;
    this.build(boxes, begin, middle);
    this.right[node] = this.begin.length;
    this.build(boxes, middle, end);
  }

  /** @internal Indices of the spheres whose boxes the ray (t >= 0) crosses, ascending (capture source order). */
  candidates(origin: ArrayLike<number>, direction: ArrayLike<number>): number[] {
    const out: number[] = [],
      stack = this.stack,
      ox = origin[0],
      oy = origin[1],
      oz = origin[2],
      dx = direction[0],
      dy = direction[1],
      dz = direction[2],
      ix = 1 / dx,
      iy = 1 / dy,
      iz = 1 / dz,
      b = this.bounds;
    if (this.begin.length) stack.push(0);
    while (stack.length) {
      const node = stack.pop()!;
      if (slabAny(b, node * 6, ox, oy, oz, dx, dy, dz, ix, iy, iz, 0, Infinity) === Infinity) continue;
      if (this.right[node] < 0) for (let i = this.begin[node]; i < this.end[node]; i++) out.push(this.order[i]);
      else stack.push(this.right[node], node + 1);
    }
    return out.sort((p, q) => p - q);
  }
}

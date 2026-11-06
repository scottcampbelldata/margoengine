import { slabAny } from './bvh.js';

const LEAF = 4;

function sphereBoxes(spheres: readonly ArrayLike<number>[]): Float64Array {
  const boxes = new Float64Array(spheres.length * 6);
  for (let i = 0; i < spheres.length; i++) {
    const [x, y, z, radius] = spheres[i] as [number, number, number, number],
      pad = radius + 1e-8 * (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) + radius + 1);
    boxes.set([x - pad, y - pad, z - pad, x + pad, y + pad, z + pad], i * 6);
  }
  return boxes;
}

function grow(b: number[], o: number, from: ArrayLike<number>, w: number): void {
  for (let k = 0; k < 3; k++) {
    b[o + k] = Math.min(b[o + k], from[w + k]);
    b[o + k + 3] = Math.max(b[o + k + 3], from[w + k + 3]);
  }
}

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
    this.order = Int32Array.from(spheres, (_, i) => i);
    if (spheres.length) this.build(sphereBoxes(spheres), 0, spheres.length);
  }

  /** @internal Fits the bounds to moved spheres, one per sphere given at construction, keeping the tree's shape. */
  refit(spheres: readonly ArrayLike<number>[]): void {
    const boxes = sphereBoxes(spheres),
      b = this.bounds,
      order = this.order;
    for (let node = this.begin.length - 1; node >= 0; node--) {
      const o = node * 6,
        right = this.right[node];
      b.fill(Infinity, o, o + 3);
      b.fill(-Infinity, o + 3, o + 6);
      if (right < 0) {
        for (let i = this.begin[node]; i < this.end[node]; i++) grow(b, o, boxes, order[i] * 6);
      } else {
        grow(b, o, b, (node + 1) * 6);
        grow(b, o, b, right * 6);
      }
    }
  }

  /** @internal Surface area of every inner node over the root's: the rays a tree of this shape costs, relatively. */
  cost(): number {
    const b = this.bounds,
      area = (o: number): number => {
        const x = b[o + 3] - b[o],
          y = b[o + 4] - b[o + 1],
          z = b[o + 5] - b[o + 2];
        return x * y + y * z + z * x;
      };
    let total = 0;
    for (let node = 1; node < this.begin.length; node++) total += area(node * 6);
    return this.begin.length ? total / (area(0) || 1) : 0;
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
    for (let i = begin; i < end; i++) grow(b, o, boxes, order[i] * 6);
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

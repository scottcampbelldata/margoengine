import { buildBVH, INTERNAL_FLAG, NODE_WORDS, type BVHBuildOptions } from './build.js';

/**
 * @internal One query of a {@link SegmentTree}: a local-space ray, and a hit radius that may grow with depth, so a radius
 * measured in screen pixels widens with distance. World radius at a point P is `radius + spread * depth(P)`, where
 * depth(P) is the linear form `depth[0] x + depth[1] y + depth[2] z + depth[3]`.
 */
interface SegmentQuery {
  origin: ArrayLike<number>;
  /** Not normalized: a ray parameter t is a world distance. */
  direction: ArrayLike<number>;
  near: number;
  far: number;
  radius: number;
  spread: number;
  depth: ArrayLike<number>;
  /** Most local units one world unit can span under the object's matrix. */
  scale: number;
}

const STACK = new Uint32Array(128);

/**
 * @internal BVH over line segments. It reuses the triangle builder: a segment (a, b) is the degenerate triangle
 * (a, b, b), whose box is the segment's box.
 */
export class SegmentTree {
  private readonly floats: Float32Array;
  private readonly words: Uint32Array;
  private readonly order: Uint32Array;

  /** `pairs` holds two point indices per segment; segment i is `pairs[2 i]`, `pairs[2 i + 1]`. */
  constructor(positions: ArrayLike<number>, stride: number, pairs: ArrayLike<number>, options?: BVHBuildOptions) {
    const count = pairs.length >> 1,
      triples = new Uint32Array(count * 3);
    for (let i = 0; i < count; i++) {
      triples[i * 3] = pairs[i * 2];
      triples[i * 3 + 1] = triples[i * 3 + 2] = pairs[i * 2 + 1];
    }
    const { nodes, triangles } = buildBVH(positions, stride, triples, options);
    this.floats = new Float32Array(nodes);
    this.words = new Uint32Array(nodes);
    this.order = triangles;
  }

  /** Calls `visit` with every segment whose box, grown by the radius at that box, the ray crosses. Unordered; returns how many. */
  query(q: SegmentQuery, visit: (segment: number) => void): number {
    const { floats: f, words: u, order } = this,
      { origin: o, direction: d, depth, radius, spread, scale, near, far } = q,
      slack = 1 + 1e-5;
    let sp = 0,
      visited = 0;
    STACK[sp++] = 0;
    while (sp) {
      const node = STACK[--sp],
        w = node * NODE_WORDS;
      // Deepest point of the box, for the radius: a linear form peaks at a corner picked per axis by its sign.
      const deepest =
        depth[3] +
        (depth[0] > 0 ? depth[0] * f[w + 3] : depth[0] * f[w]) +
        (depth[1] > 0 ? depth[1] * f[w + 4] : depth[1] * f[w + 1]) +
        (depth[2] > 0 ? depth[2] * f[w + 5] : depth[2] * f[w + 2]);
      const world = (radius + spread * Math.max(deepest, 0)) * slack,
        pad = world * scale;
      let t0 = near - world,
        t1 = far + world,
        hit = true;
      for (let k = 0; k < 3; k++) {
        const low = f[w + k] - pad,
          high = f[w + k + 3] + pad;
        if (d[k] === 0) {
          if (o[k] < low || o[k] > high) hit = false;
          continue;
        }
        const a = (low - o[k]) / d[k],
          b = (high - o[k]) / d[k];
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      }
      if (!hit || t0 > t1) continue;
      const word = u[w + 7];
      if (word & INTERNAL_FLAG) {
        STACK[sp++] = u[w + 6];
        STACK[sp++] = node + 1;
      } else
        for (let k = u[w + 6], end = k + word; k < end; k++) {
          visited++;
          visit(order[k]);
        }
    }
    return visited;
  }
}

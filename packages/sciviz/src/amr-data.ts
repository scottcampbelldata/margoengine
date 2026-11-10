// Clean-room block AMR and boundary partitioning, Berger/Oliger (1984), Turk et al. (2011), Skillman (2012).
import { rangeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';

/** Cell-centred Cartesian block, x fastest, physical outer cell faces as bounds. */
export interface AMRBlock {
  readonly id?: string;
  readonly level: number;
  readonly dims: readonly [number, number, number];
  readonly bounds: Bounds;
  readonly values: ArrayLike<number>;
}
/** Nonoverlapping k-d partition leaf. Empty regions use block = -1. */
export interface AMRNode {
  readonly bounds: Bounds;
  readonly block: number;
  /** Split axis, or -1 for a leaf. */
  readonly axis: number;
  readonly split: number;
  readonly left: number;
  readonly right: number;
  /** First node after this subtree in preorder. */
  readonly end: number;
}
/** Owned scalar snapshots, coverage masks and the finest-block spatial partition. */
export interface AMRData {
  readonly blocks: readonly AMRBlock[];
  /** One byte per cell: 1 visible, 0 completely covered by a finer block. */
  readonly masks: readonly Uint8Array[];
  readonly bounds: Bounds;
  readonly range: readonly [number, number];
  readonly nodes: readonly AMRNode[];
}
/** Limits bound the construction before publishing any data. */
export interface AMROptions {
  /** Default 1,000,000 k-d nodes. */
  readonly maxNodes?: number;
  readonly signal?: AbortSignal;
}
export function amrError(message: string): never {
  throw rangeError(`AMR: ${message}; correct the blocks or loading options`, 'sciviz');
}
const overlap = (a: Bounds, b: Bounds) => [0, 1, 2].every((k) => a[2 * k] < b[2 * k + 1] && b[2 * k] < a[2 * k + 1]);
const contains = (b: Bounds, p: readonly number[]) => p.every((v, k) => v >= b[2 * k] && v <= b[2 * k + 1]);
/** Validate and snapshot a block hierarchy. Refined faces must align to the coarser cells they cover. */
export function createAMR(input: readonly AMRBlock[], options: AMROptions = {}): AMRData {
  options.signal?.throwIfAborted();
  if (!input.length) amrError('at least one block is required');
  const max = options.maxNodes ?? 1_000_000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 2 ** 23) amrError('maxNodes must be 1..8388608');
  const blocks = input.map((b) => {
    if (
      !Number.isSafeInteger(b.level) ||
      b.level < 0 ||
      b.dims.length !== 3 ||
      b.bounds.length !== 6 ||
      b.dims.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      b.bounds.some((v) => !Number.isFinite(v)) ||
      [0, 1, 2].some((k) => !(b.bounds[2 * k + 1] > b.bounds[2 * k])) ||
      b.values.length !== b.dims.reduce((a, v) => a * v, 1)
    )
      amrError('invalid block level, shape, bounds or sample count');
    const values = Float64Array.from(b.values);
    if (values.some((v) => !Number.isFinite(v) && !Number.isNaN(v)))
      amrError('infinite samples are not supported; use NaN for missing cells');
    return { ...b, dims: [...b.dims] as [number, number, number], bounds: [...b.bounds] as Bounds, values };
  });
  for (let i = 0; i < blocks.length; i++) {
    options.signal?.throwIfAborted();
    for (let j = i + 1; j < blocks.length; j++) {
      let a = blocks[i],
        b = blocks[j];
      if (!overlap(a.bounds, b.bounds)) continue;
      if (a.level === b.level) amrError('blocks at the same level overlap');
      if (a.level > b.level) [a, b] = [b, a];
      for (let k = 0; k < 3; k++) {
        const dx = (a.bounds[k * 2 + 1] - a.bounds[k * 2]) / a.dims[k],
          fine = (b.bounds[k * 2 + 1] - b.bounds[k * 2]) / b.dims[k];
        if (fine > dx * (1 + 1e-10) || Math.abs(dx / fine - Math.round(dx / fine)) > 1e-8)
          amrError('refinement must be an integer cell ratio');
        for (const face of [b.bounds[k * 2], b.bounds[k * 2 + 1]]) {
          if (face <= a.bounds[k * 2] || face >= a.bounds[k * 2 + 1]) continue;
          const q = (face - a.bounds[k * 2]) / dx;
          if (Math.abs(q - Math.round(q)) > 1e-8) amrError('a refined face cuts a coarse cell');
        }
      }
    }
  }
  const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity] as unknown as number[];
  for (const b of blocks)
    for (let k = 0; k < 3; k++) {
      bounds[2 * k] = Math.min(bounds[2 * k], b.bounds[2 * k]);
      bounds[2 * k + 1] = Math.max(bounds[2 * k + 1], b.bounds[2 * k + 1]);
    }
  const masks = blocks.map((b) => new Uint8Array(b.values.length).fill(1));
  let low = Infinity,
    high = -Infinity;
  blocks.forEach((b, bi) => {
    const finer = blocks.filter((f) => f.level > b.level && overlap(f.bounds, b.bounds));
    for (let i = 0; i < b.values.length; i++) {
      if (i % 4096 === 0) options.signal?.throwIfAborted();
      const p = [i % b.dims[0], Math.floor(i / b.dims[0]) % b.dims[1], Math.floor(i / b.dims[0] / b.dims[1])].map(
        (v, k) => b.bounds[2 * k] + ((v + 0.5) * (b.bounds[2 * k + 1] - b.bounds[2 * k])) / b.dims[k],
      );
      if (finer.some((f) => contains(f.bounds, p))) masks[bi][i] = 0;
      else if (Number.isFinite(b.values[i])) {
        low = Math.min(low, b.values[i]);
        high = Math.max(high, b.values[i]);
      }
    }
  });
  if (!Number.isFinite(low)) amrError('the visible hierarchy has no finite samples');
  const nodes: AMRNode[] = [];
  function partition(region: Bounds, ids: number[], depth: number): number {
    options.signal?.throwIfAborted();
    if (nodes.length >= max || depth > 128) amrError('k-d partition exceeds maxNodes or depth 128');
    const index = nodes.length,
      ordered = ids.sort((a, b) => blocks[b].level - blocks[a].level);
    const winner = ordered[0] ?? -1;
    const node = { bounds: region, block: -1, axis: -1, split: 0, left: -1, right: -1, end: 0 };
    nodes.push(node);
    const edges: { axis: number; value: number }[] = [];
    // Only blocks above the first whole-region owner can change ownership here.
    for (const id of ordered) {
      const b = blocks[id];
      let whole = true;
      for (let k = 0; k < 3; k++)
        for (const v of [b.bounds[2 * k], b.bounds[2 * k + 1]])
          if (v > region[2 * k] && v < region[2 * k + 1]) {
            edges.push({ axis: k, value: v });
            whole = false;
          }
      if (whole) break;
    }
    if (!edges.length) node.block = winner;
    else {
      const axis = [0, 1, 2].sort(
        (a, b) => edges.filter((e) => e.axis === b).length - edges.filter((e) => e.axis === a).length,
      )[0];
      const values = [...new Set(edges.filter((e) => e.axis === axis).map((e) => e.value))].sort((a, b) => a - b);
      const split = values[Math.floor(values.length / 2)],
        l = [...region],
        r = [...region];
      l[axis * 2 + 1] = split;
      r[axis * 2] = split;
      node.axis = axis;
      node.split = split;
      node.left = partition(
        l as unknown as Bounds,
        ids.filter((id) => overlap(blocks[id].bounds, l as unknown as Bounds)),
        depth + 1,
      );
      node.right = partition(
        r as unknown as Bounds,
        ids.filter((id) => overlap(blocks[id].bounds, r as unknown as Bounds)),
        depth + 1,
      );
    }
    node.end = nodes.length;
    return index;
  }
  partition(
    bounds as unknown as Bounds,
    blocks.map((_, i) => i),
    0,
  );
  return { blocks, masks, bounds: bounds as unknown as Bounds, range: [low, high], nodes };
}
/** Finest owner at a physical position; outside the hierarchy or a missing cell returns NaN. */
export function sampleAMR(
  data: AMRData,
  position: readonly [number, number, number],
  interpolation: 'nearest' | 'linear' = 'nearest',
): number {
  if (position.length !== 3 || position.some((v) => !Number.isFinite(v)))
    amrError('sample positions must contain three finite coordinates');
  if (interpolation !== 'nearest' && interpolation !== 'linear') amrError('interpolation must be nearest or linear');
  if (!contains(data.bounds, position)) return NaN;
  let node = data.nodes[0];
  while (node.axis >= 0) node = data.nodes[position[node.axis] < node.split ? node.left : node.right];
  if (node.block < 0) return NaN;
  const b = data.blocks[node.block],
    q = position.map((v, k) => ((v - b.bounds[k * 2]) / (b.bounds[k * 2 + 1] - b.bounds[k * 2])) * b.dims[k] - 0.5);
  const at = (p: number[]) =>
    b.values[
      (Math.min(b.dims[2] - 1, Math.max(0, p[2])) * b.dims[1] + Math.min(b.dims[1] - 1, Math.max(0, p[1]))) *
        b.dims[0] +
        Math.min(b.dims[0] - 1, Math.max(0, p[0]))
    ];
  if (interpolation === 'nearest') return at(q.map((v) => Math.floor(v + 0.5)));
  const lo = q.map(Math.floor),
    t = q.map((v, k) => v - lo[k]);
  let sum = 0;
  for (let c = 0; c < 8; c++) {
    const bits = [c & 1, (c >> 1) & 1, c >> 2],
      weight = bits.reduce((w, v, k) => w * (v ? t[k] : 1 - t[k]), 1);
    if (weight) sum += at(lo.map((v, k) => v + bits[k])) * weight;
  }
  return sum;
}

/** Ordered, disjoint ray intervals from a stackless traversal; zero direction components are valid. */
export function traceAMR(
  data: AMRData,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
): readonly { block: number; enter: number; exit: number }[] {
  if (
    origin.length !== 3 ||
    direction.length !== 3 ||
    [...origin, ...direction].some((v) => !Number.isFinite(v)) ||
    !direction.some((v) => v !== 0)
  )
    amrError('a ray requires finite origin and nonzero direction');
  const result: { block: number; enter: number; exit: number }[] = [];
  for (let i = 0; i < data.nodes.length; ) {
    const n = data.nodes[i];
    let enter = 0,
      exit = Infinity;
    for (let k = 0; k < 3; k++) {
      if (direction[k] === 0) {
        if (origin[k] < n.bounds[2 * k] || origin[k] >= n.bounds[2 * k + 1]) exit = -1;
      } else {
        const a = (n.bounds[2 * k] - origin[k]) / direction[k],
          b = (n.bounds[2 * k + 1] - origin[k]) / direction[k];
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (exit <= enter) {
      i = n.end;
      continue;
    }
    if (n.axis < 0 && n.block >= 0) result.push({ block: n.block, enter, exit });
    i++;
  }
  return result.sort((a, b) => a.enter - b.enter);
}

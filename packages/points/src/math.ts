/**
 * CPU side of the point renderer: spatial chunking into blocks, frustum culling, point budget allocation,
 * color packing and nearest-point picking. Everything here is pure and runs in Node.
 */
import {multiplyMatrices} from '@margoengine/math/mat4';
import {createRandom} from '@margoengine/math/mathutils';

/** Marks a point that belongs to no block (non-finite position at build time). */
export const NO_BLOCK = 0xffffffff;

/** Blocks of a chunked point cloud. Block `b` draws slots `starts[b] .. starts[b] + counts[b]` of `order`. */
export interface PointBlocks {
  /** Slot to point index. Within each block the slots are shuffled, so any prefix is a uniform random sample. */
  readonly order: Uint32Array;
  /** First slot of each block. */
  readonly starts: Uint32Array;
  /** Points in each block. */
  readonly counts: Uint32Array;
  /** Local-space axis-aligned bounds, six floats per block: min xyz, max xyz. */
  readonly bounds: Float32Array;
  /** Block of each point, or `NO_BLOCK`. */
  readonly blockOf: Uint32Array;
  /** Number of blocks. */
  readonly length: number;
  /** Points that are in a block (finite positions). */
  readonly finite: number;
}

/** Small, fast, seedable PRNG (mulberry32, `@margoengine/math/mathutils` createRandom). Returns floats in [0, 1). */
export const random: (seed: number) => () => number = createRandom;

function select(index: Uint32Array, lo: number, hi: number, k: number, positions: ArrayLike<number>, axis: number): void {
  // Hoare quickselect with a median-of-three pivot; leaves index[k] in sorted position, smaller keys before it.
  while (hi > lo) {
    const mid = (lo + hi) >>> 1;
    const a = positions[index[lo] * 3 + axis], b = positions[index[mid] * 3 + axis], c = positions[index[hi] * 3 + axis];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
    let i = lo, j = hi;
    while (i <= j) {
      while (positions[index[i] * 3 + axis] < pivot) i++;
      while (positions[index[j] * 3 + axis] > pivot) j--;
      if (i <= j) {const t = index[i]; index[i] = index[j]; index[j] = t; i++; j--;}
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

/**
 * Splits points into spatially compact blocks of at most `blockSize` points (median split along the longest
 * axis, like a kd-tree), then shuffles each block with a seeded PRNG so that drawing the first `n` slots of a
 * block gives an even random subsample (Potree-style progressive level of detail).
 */
export function buildBlocks(positions: ArrayLike<number>, count: number, blockSize = 16384, seed = 1): PointBlocks {
  if (!Number.isInteger(count) || count < 0 || positions.length < count * 3) throw new RangeError('positions holds fewer than count points');
  if (!Number.isInteger(blockSize) || blockSize < 1) throw new RangeError('blockSize must be a positive integer');
  const index = new Uint32Array(count);
  let finite = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) index[finite++] = i;
  }
  const leaves: number[] = [];
  const stack: number[] = finite ? [0, finite] : [];
  while (stack.length) {
    const end = stack.pop()!, start = stack.pop()!;
    if (end - start <= blockSize) {leaves.push(start, end); continue;}
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let s = start; s < end; s++) {
      const o = index[s] * 3, x = positions[o], y = positions[o + 1], z = positions[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const middle = (start + end) >>> 1;
    select(index, start, end - 1, middle, positions, axis);
    // Push the upper half first so the lower half is processed first: blocks come out in depth-first order.
    stack.push(middle, end, start, middle);
  }
  const length = leaves.length / 2;
  const starts = new Uint32Array(length), counts = new Uint32Array(length), bounds = new Float32Array(length * 6);
  const blockOf = new Uint32Array(count).fill(NO_BLOCK);
  for (let b = 0; b < length; b++) {
    const start = leaves[b * 2], end = leaves[b * 2 + 1];
    starts[b] = start; counts[b] = end - start;
    const next = random((seed ^ Math.imul(b + 1, 0x9e3779b1)) >>> 0);
    for (let s = end - 1; s > start; s--) {
      const r = start + Math.floor(next() * (s - start + 1));
      const t = index[s]; index[s] = index[r]; index[r] = t;
    }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let s = start; s < end; s++) {
      const p = index[s], o = p * 3, x = positions[o], y = positions[o + 1], z = positions[o + 2];
      blockOf[p] = b;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    bounds[b * 6] = x0; bounds[b * 6 + 1] = y0; bounds[b * 6 + 2] = z0; bounds[b * 6 + 3] = x1; bounds[b * 6 + 4] = y1; bounds[b * 6 + 5] = z1;
  }
  return {order: index, starts, counts, bounds, blockOf, length, finite};
}

/**
 * Grows the bounds of the blocks that hold points `start .. start + count` so they contain the new positions.
 * Bounds only grow; call `buildBlocks` again (PointCloud.rebuild) to tighten them. Returns how many blocks grew.
 */
export function expandBlockBounds(blocks: PointBlocks, positions: ArrayLike<number>, start: number, count: number): number {
  const {bounds, blockOf} = blocks;
  let grown = 0;
  for (let i = start; i < start + count; i++) {
    const b = blockOf[i];
    if (b === NO_BLOCK) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
    const o = b * 6;
    let changed = false;
    if (x < bounds[o]) {bounds[o] = x; changed = true;} if (x > bounds[o + 3]) {bounds[o + 3] = x; changed = true;}
    if (y < bounds[o + 1]) {bounds[o + 1] = y; changed = true;} if (y > bounds[o + 4]) {bounds[o + 4] = y; changed = true;}
    if (z < bounds[o + 2]) {bounds[o + 2] = z; changed = true;} if (z > bounds[o + 5]) {bounds[o + 5] = z; changed = true;}
    if (changed) grown++;
  }
  return grown;
}

/**
 * Transforms local block bounds by a column-major model matrix into a world-space center and half extent
 * (the box that encloses the transformed box). Writes six floats to `out`: center xyz, extent xyz.
 */
export function worldBox(bounds: ArrayLike<number>, block: number, model: ArrayLike<number>, out: Float64Array | number[]): void {
  const o = block * 6;
  const cx = (bounds[o] + bounds[o + 3]) / 2, cy = (bounds[o + 1] + bounds[o + 4]) / 2, cz = (bounds[o + 2] + bounds[o + 5]) / 2;
  const ex = (bounds[o + 3] - bounds[o]) / 2, ey = (bounds[o + 4] - bounds[o + 1]) / 2, ez = (bounds[o + 5] - bounds[o + 2]) / 2;
  const m = model;
  for (let r = 0; r < 3; r++) {
    out[r] = m[r] * cx + m[4 + r] * cy + m[8 + r] * cz + m[12 + r];
    out[3 + r] = Math.abs(m[r]) * ex + Math.abs(m[4 + r]) * ey + Math.abs(m[8 + r]) * ez;
  }
}

/** True when a world box (center, half extent) is at least partly inside all six planes (`n.p + d >= 0` inside). */
export function boxInFrustum(box: ArrayLike<number>, planes: ArrayLike<number>, margin = 0): boolean {
  for (let p = 0; p < 6; p++) {
    const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2], d = planes[p * 4 + 3];
    const distance = a * box[0] + b * box[1] + c * box[2] + d;
    const reach = Math.abs(a) * box[3] + Math.abs(b) * box[4] + Math.abs(c) * box[5];
    if (distance + reach + margin < 0) return false;
  }
  return true;
}

/**
 * Frustum-culls every non-empty block against `planes` (the 24 floats of `camera.planes`, world space) after
 * transforming its bounds by `model`. Writes visible block ids to `out` and returns how many there are.
 */
export function cullBlocks(blocks: Pick<PointBlocks, 'bounds' | 'counts' | 'length'>, model: ArrayLike<number>, planes: ArrayLike<number>, out: Uint32Array, margin = 0): number {
  const box = new Float64Array(6);
  let visible = 0;
  for (let b = 0; b < blocks.length; b++) {
    if (!blocks.counts[b]) continue;
    worldBox(blocks.bounds, b, model, box);
    if (boxInFrustum(box, planes, margin)) out[visible++] = b;
  }
  return visible;
}

/**
 * Approximate screen area in pixels of a world box seen from `eye`: the projected disc of its bounding sphere,
 * capped at the viewport. `projScale` is pixels per world unit at distance 1 (`0.5 * height / tan(fov / 2)`).
 */
export function screenArea(box: ArrayLike<number>, eye: ArrayLike<number>, projScale: number, width: number, height: number, orthographic = false): number {
  const radius = Math.hypot(box[3], box[4], box[5]);
  if (orthographic) return Math.min(width * height, Math.PI * (radius * projScale) ** 2);
  const distance = Math.hypot(box[0] - eye[0], box[1] - eye[1], box[2] - eye[2]);
  const viewport = width * height;
  if (distance <= radius) return viewport;
  const pixels = radius * projScale / Math.sqrt(distance * distance - radius * radius);
  return Math.min(viewport, Math.PI * pixels * pixels);
}

/**
 * Shares a point budget between blocks. Each block gets at most its own count; the rest is split in proportion
 * to `weights` (screen area), and whatever a small block cannot use flows to the others (water filling).
 * When the counts fit in the budget every block is drawn in full. Writes per-block allotments to `out` and
 * returns their sum, which equals `min(budget, sum of counts)`.
 */
export function allocateBudget(counts: ArrayLike<number>, weights: ArrayLike<number>, length: number, budget: number, out: Uint32Array | number[]): number {
  if (!(budget >= 0)) throw new RangeError('budget must be non-negative');
  budget = Math.floor(budget);
  let total = 0;
  for (let i = 0; i < length; i++) total += counts[i];
  if (total <= budget) {for (let i = 0; i < length; i++) out[i] = counts[i]; return total;}
  // Clamped weights and the sort key (points per unit weight) are computed once, not per comparison.
  const weight = new Float64Array(length), key = new Float64Array(length), sorted = new Array<number>(length);
  for (let i = 0; i < length; i++) {weight[i] = Math.max(1e-9, weights[i] || 0); key[i] = counts[i] / weight[i]; sorted[i] = i;}
  sorted.sort((a, b) => key[a] - key[b]);
  // Suffix sums of the weights in sorted order avoid cancellation when large and tiny weights mix.
  const suffix = new Float64Array(length + 1);
  for (let k = length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] + weight[sorted[k]];
  let remaining = budget, k = 0;
  for (; k < length; k++) {
    const i = sorted[k], share = remaining * weight[i] / suffix[k];
    if (counts[i] > share) break;
    out[i] = counts[i]; remaining -= counts[i];
  }
  const weightSum = suffix[k];
  // Every block left over wants more than its share; give each the floor of its share, then hand the
  // rounding remainder to the largest fractions. floor(share) + 1 <= count holds because share < count.
  let used = 0;
  const fractions: Array<[number, number]> = [];
  for (let j = k; j < length; j++) {
    const i = sorted[j], share = remaining * weight[i] / weightSum, whole = Math.min(counts[i] - 1, Math.floor(share));
    out[i] = whole; used += whole; fractions.push([share - whole, i]);
  }
  let left = remaining - used;
  fractions.sort((a, b) => b[0] - a[0]);
  for (let f = 0; left > 0 && fractions.length; f = (f + 1) % fractions.length) {
    const i = fractions[f][1];
    if (out[i] < counts[i]) {out[i]++; left--;}
    else if (fractions.every(([, j]) => out[j] >= counts[j])) break;
  }
  let sum = 0;
  for (let i = 0; i < length; i++) sum += out[i];
  return sum;
}

/** Multiplies two column-major 4x4 matrices: `a * b` (`@margoengine/math/mat4` multiplyMatrices). */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array | Float32Array | number[] = new Float64Array(16)): Float64Array | Float32Array | number[] {
  return multiplyMatrices(a, b, out);
}

/**
 * Projects a local point through a column-major model-view-projection matrix to device pixels (origin top left,
 * y down). Writes x, y and clip w to `out`; returns false when the point is behind the camera or outside the
 * near/far range (reversed-Z clip z in 0..w).
 */
export function projectPoint(mvp: ArrayLike<number>, x: number, y: number, z: number, width: number, height: number, out: Float64Array | number[]): boolean {
  const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (!(w > 0)) return false;
  const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
  if (cz < 0 || cz > w) return false;
  const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12], cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
  // Orthographic (w is 1 everywhere): depth is the reversed-Z distance from the near plane in NDC units.
  out[0] = (cx / w * 0.5 + 0.5) * width; out[1] = (0.5 - cy / w * 0.5) * height; out[2] = mvp[3] || mvp[7] || mvp[11] ? w : 1 - cz;
  return true;
}

/** Candidate slots for picking: `count` slots starting at `start` in `order` (or point indices directly when `order` is null). */
export interface PickRange {start: number; count: number}

export interface PickHit {
  /** Point index in the cloud's arrays. */
  index: number;
  /** Distance from the pick position in device pixels. */
  distance: number;
  /** Clip w (view depth) of the point. */
  depth: number;
  /** Device-pixel position of the point. */
  screen: [number, number];
}

/**
 * Nearest point to the device-pixel position (x, y) among the given slot ranges, within `radius` pixels.
 * Points within half a pixel of the best distance are tie-broken by depth, so the front point wins.
 */
export function pickPoint(positions: ArrayLike<number>, order: ArrayLike<number> | null, ranges: readonly PickRange[], mvp: ArrayLike<number>,
  width: number, height: number, x: number, y: number, radius: number): PickHit | null {
  const screen = new Float64Array(3), candidates: number[] = [];
  // Squared limits a hair beyond `radius` and `nearest + 0.5` reject far points without Math.hypot; anything
  // close to a limit still takes the exact comparisons below, so the result is the same.
  const slack = 1 + 1e-9, reach = radius * radius * slack;
  let nearest = Infinity, near = Infinity;
  for (const range of ranges) {
    for (let s = range.start; s < range.start + range.count; s++) {
      const p = order ? order[s] : s;
      if (!projectPoint(mvp, positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2], width, height, screen)) continue;
      const dx = screen[0] - x, dy = screen[1] - y, squared = dx * dx + dy * dy;
      if (squared > reach || squared > near) continue;
      const distance = Math.hypot(dx, dy);
      if (distance > radius || distance > nearest + 0.5) continue;
      if (distance < nearest) {nearest = distance; near = (nearest + 0.5) * (nearest + 0.5) * slack;}
      candidates.push(p, distance, screen[2], screen[0], screen[1]);
    }
  }
  let best: PickHit | null = null;
  for (let c = 0; c < candidates.length; c += 5) {
    if (candidates[c + 1] > nearest + 0.5) continue;
    if (!best || candidates[c + 2] < best.depth) best = {index: candidates[c], distance: candidates[c + 1], depth: candidates[c + 2], screen: [candidates[c + 3], candidates[c + 4]]};
  }
  return best;
}

/** Screen rectangle [x0, y0, x1, y1] in device pixels of a world box, or null if any corner is behind the camera. */
export function boxScreenRect(box: ArrayLike<number>, viewProj: ArrayLike<number>, width: number, height: number): [number, number, number, number] | null {
  const point = new Float64Array(3), rect: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = box[0] + (corner & 1 ? box[3] : -box[3]), y = box[1] + (corner & 2 ? box[4] : -box[4]), z = box[2] + (corner & 4 ? box[5] : -box[5]);
    const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (!(w > 1e-6)) return null;
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12], cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    point[0] = (cx / w * 0.5 + 0.5) * width; point[1] = (0.5 - cy / w * 0.5) * height;
    rect[0] = Math.min(rect[0], point[0]); rect[1] = Math.min(rect[1], point[1]); rect[2] = Math.max(rect[2], point[0]); rect[3] = Math.max(rect[3], point[1]);
  }
  return rect;
}

/**
 * Packs per-point colors into RGBA8 words (r in the low byte), the layout WGSL `unpack4x8unorm` reads.
 * `source` holds `components` (3 or 4) values per point: floats in 0..1, or 0..255 bytes for Uint8 arrays.
 * Missing alpha becomes 255.
 */
export function packColors(source: ArrayLike<number>, components: number, count: number, out: Uint32Array, offset = 0): Uint32Array {
  if (components !== 3 && components !== 4) throw new RangeError('Colors need 3 (RGB) or 4 (RGBA) components');
  if (source.length < count * components) throw new RangeError('Too few color values');
  if (offset + count > out.length) throw new RangeError('Color range exceeds the cloud');
  const bytes = source instanceof Uint8Array || source instanceof Uint8ClampedArray;
  const byte = bytes ? (v: number) => v : (v: number) => (v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0);
  for (let i = 0; i < count; i++) {
    const o = i * components;
    const r = byte(source[o]), g = byte(source[o + 1]), b = byte(source[o + 2]), a = components === 4 ? byte(source[o + 3]) : 255;
    out[offset + i] = (r | g << 8 | b << 16 | a << 24) >>> 0;
  }
  return out;
}

/** Merges `[start, end)` ranges in place (sorted, overlapping or touching ranges joined) and returns them. */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((a, b) => a[0] - b[0]);
  let w = 0;
  for (const range of ranges) {
    if (w && range[0] <= ranges[w - 1][1]) ranges[w - 1][1] = Math.max(ranges[w - 1][1], range[1]);
    else ranges[w++] = [range[0], range[1]];
  }
  ranges.length = w;
  return ranges;
}

/** Atlas rectangle `[u0, v0, u1, v1]` (origin top left) of cell `index` in a grid of `columns` x `rows`, read row by row. */
export function atlasRect(index: number, columns: number, rows: number, padding = 0): [number, number, number, number] {
  if (![index, columns, rows].every(Number.isInteger) || columns < 1 || rows < 1 || index < 0 || index >= columns * rows) throw new RangeError('Atlas cell out of range');
  const column = index % columns, row = Math.floor(index / columns), w = 1 / columns, h = 1 / rows;
  return [column * w + padding, row * h + padding, (column + 1) * w - padding, (row + 1) * h - padding];
}

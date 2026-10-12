// Binned SAH builder. Pure functions with no DOM or engine access so the worker can run it unchanged.

/** Build options. */
export interface BVHBuildOptions {
  /** Leaf size target. Larger leaves build faster and use less memory; smaller leaves query faster. Default 8. */
  maxLeafTriangles?: number;
  /** Maximum tree depth (1..64). Ranges still above `maxLeafTriangles` at this depth become larger leaves. Default 40. */
  maxDepth?: number;
  /** SAH bins per axis (4..256). Default 32. */
  bins?: number;
  /** 'sah' (default) or 'center' (split at the middle of the centroid bounds, faster build, slower queries). */
  strategy?: 'sah' | 'center';
}

/**
 * Flat BVH storage. `nodes` holds 8 32-bit words per node in depth-first order: min xyz and max xyz as float32,
 * then for a leaf the triangle offset and count, and for an internal node the right child index and
 * 0x80000000 | split axis. The left child of node i is always i + 1.
 * `index` holds the three vertex indices of every triangle in leaf order, `triangles` the original face index.
 */
export interface BVHData {
  nodes: ArrayBuffer;
  index: Uint32Array;
  triangles: Uint32Array;
}

export const NODE_WORDS = 8;
export const INTERNAL_FLAG = 0x80000000;

export function resolveOptions(options: BVHBuildOptions = {}): Required<BVHBuildOptions> {
  const {maxLeafTriangles = 8, maxDepth = 40, bins = 32, strategy = 'sah'} = options;
  if (!Number.isInteger(maxLeafTriangles) || maxLeafTriangles < 1 || maxLeafTriangles > 65536) throw new RangeError('maxLeafTriangles must be an integer in 1..65536');
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) throw new RangeError('maxDepth must be an integer in 1..64');
  if (!Number.isInteger(bins) || bins < 4 || bins > 256) throw new RangeError('bins must be an integer in 4..256');
  if (strategy !== 'sah' && strategy !== 'center') throw new TypeError('strategy must be sah or center');
  return {maxLeafTriangles, maxDepth, bins, strategy};
}

/** Validates vertex data and returns the triangle count. */
export function checkSource(positions: ArrayLike<number>, stride: number, indices: ArrayLike<number> | null): number {
  if (!Number.isInteger(stride) || stride < 3) throw new RangeError('stride must be an integer >= 3');
  const vertexCount = positions.length >= 3 ? Math.floor((positions.length - 3) / stride) + 1 : 0;
  const count = indices ? indices.length : vertexCount;
  if (!count || count % 3) throw new RangeError('Expected at least one triangle');
  if (indices) for (let i = 0; i < indices.length; i++) { const v = indices[i]; if (!(v >= 0 && v < vertexCount) || v !== Math.floor(v)) throw new RangeError('Index exceeds vertices'); }
  return count / 3;
}

export function buildBVH(positions: ArrayLike<number>, stride: number, indices: ArrayLike<number> | null, options: BVHBuildOptions = {}): BVHData {
  const {maxLeafTriangles, maxDepth, bins, strategy} = resolveOptions(options);
  const n = checkSource(positions, stride, indices);
  // Triangle boxes live in slot order and move with `order` during partitioning, so every pass streams memory.
  const boxes = new Float32Array(n * 6), order = new Uint32Array(n);
  for (let t = 0; t < n; t++) {
    const a = (indices ? indices[t * 3] : t * 3) * stride, b = (indices ? indices[t * 3 + 1] : t * 3 + 1) * stride, c = (indices ? indices[t * 3 + 2] : t * 3 + 2) * stride;
    for (let k = 0; k < 3; k++) {
      const pa = positions[a + k], pb = positions[b + k], pc = positions[c + k];
      if (!Number.isFinite(pa) || !Number.isFinite(pb) || !Number.isFinite(pc)) throw new RangeError('Positions must be finite');
      boxes[t * 6 + k] = pa < pb ? (pa < pc ? pa : pc) : (pb < pc ? pb : pc);
      boxes[t * 6 + 3 + k] = pa > pb ? (pa > pc ? pa : pc) : (pb > pc ? pb : pc);
    }
    order[t] = t;
  }

  // Feedback lives on the shared Builder prototype, so repeated builds run optimized code from the start.
  const builder = new Builder(boxes, order, bins, maxLeafTriangles, maxDepth, strategy);
  builder.measure(0, n, 0);
  builder.subdivide(builder.allocate(), 0, n, 0, 0);
  const index = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const t = order[k];
    if (indices) { index[k * 3] = indices[t * 3]; index[k * 3 + 1] = indices[t * 3 + 1]; index[k * 3 + 2] = indices[t * 3 + 2]; }
    else { index[k * 3] = t * 3; index[k * 3 + 1] = t * 3 + 1; index[k * 3 + 2] = t * 3 + 2; }
  }
  return {nodes: builder.buffer.slice(0, builder.count * NODE_WORDS * 4), index, triangles: order};
}

class Builder {
  capacity: number;
  count = 0;
  buffer: ArrayBuffer;
  f32: Float32Array;
  u32: Uint32Array;
  readonly binBoxes: Float64Array;
  readonly binCounts: Int32Array;
  readonly rightArea: Float64Array;
  readonly rightCount: Int32Array;
  readonly last: number;
  readonly sah: boolean;
  /** Per-depth bounds records: node box min/max then doubled-centroid min/max, 12 values for each of two children. */
  readonly stack: Float64Array;
  constructor(readonly boxes: Float32Array, readonly order: Uint32Array, readonly bins: number, readonly maxLeafTriangles: number, readonly maxDepth: number, strategy: string) {
    const n = order.length;
    this.capacity = Math.max(1, Math.ceil(n / Math.max(1, maxLeafTriangles >> 1)) * 2);
    this.buffer = new ArrayBuffer(this.capacity * NODE_WORDS * 4); this.f32 = new Float32Array(this.buffer); this.u32 = new Uint32Array(this.buffer);
    this.binBoxes = new Float64Array(3 * bins * 6); this.binCounts = new Int32Array(3 * bins);
    this.rightArea = new Float64Array(bins); this.rightCount = new Int32Array(bins);
    this.last = bins - 1; this.sah = strategy === 'sah';
    this.stack = new Float64Array((maxDepth + 2) * 24);
  }
  allocate(): number {
    if (this.count === this.capacity) {
      this.capacity *= 2;
      const next = new ArrayBuffer(this.capacity * NODE_WORDS * 4);
      new Uint32Array(next).set(this.u32); this.buffer = next; this.f32 = new Float32Array(next); this.u32 = new Uint32Array(next);
    }
    return this.count++;
  }
  measure(start: number, end: number, out: number): void {
    const boxes = this.boxes, stack = this.stack;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let o = start * 6, e = end * 6; o < e; o += 6) {
      const b0 = boxes[o], b1 = boxes[o + 1], b2 = boxes[o + 2], b3 = boxes[o + 3], b4 = boxes[o + 4], b5 = boxes[o + 5];
      if (b0 < x0) x0 = b0; if (b1 < y0) y0 = b1; if (b2 < z0) z0 = b2; if (b3 > x1) x1 = b3; if (b4 > y1) y1 = b4; if (b5 > z1) z1 = b5;
      const px = b0 + b3, py = b1 + b4, pz = b2 + b5;
      if (px < cx0) cx0 = px; if (px > cx1) cx1 = px; if (py < cy0) cy0 = py; if (py > cy1) cy1 = py; if (pz < cz0) cz0 = pz; if (pz > cz1) cz1 = pz;
    }
    stack[out] = x0; stack[out + 1] = y0; stack[out + 2] = z0; stack[out + 3] = x1; stack[out + 4] = y1; stack[out + 5] = z1;
    stack[out + 6] = cx0; stack[out + 7] = cy0; stack[out + 8] = cz0; stack[out + 9] = cx1; stack[out + 10] = cy1; stack[out + 11] = cz1;
  }

  subdivide(node: number, start: number, end: number, depth: number, record: number): void {
    const {boxes, stack, binBoxes, binCounts, rightArea, rightCount, order, maxLeafTriangles, maxDepth, sah, f32, u32} = this;
    const x0 = stack[record], y0 = stack[record + 1], z0 = stack[record + 2], x1 = stack[record + 3], y1 = stack[record + 4], z1 = stack[record + 5];
    const cx0 = stack[record + 6], cy0 = stack[record + 7], cz0 = stack[record + 8], cx1 = stack[record + 9], cy1 = stack[record + 10], cz1 = stack[record + 11];
    const w = node * NODE_WORDS, size = end - start;
    f32[w] = x0; f32[w + 1] = y0; f32[w + 2] = z0; f32[w + 3] = x1; f32[w + 4] = y1; f32[w + 5] = z1;
    if (size <= maxLeafTriangles || depth >= maxDepth) { u32[w + 6] = start; u32[w + 7] = size; return; }
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    // Small ranges use fewer bins: the sweep cost then stays proportional to the triangles binned.
    const bins = size < this.bins ? Math.max(4, size) : this.bins, last = bins - 1;
    let axis = -1, lo = 0, k = 0, splitBin = 0;
    if (sah) {
      binCounts.fill(0, 0, bins * 3);
      for (let i = 0, e = bins * 18; i < e; i += 6) { binBoxes[i] = binBoxes[i + 1] = binBoxes[i + 2] = Infinity; binBoxes[i + 3] = binBoxes[i + 4] = binBoxes[i + 5] = -Infinity; }
      const kx = ex > 0 ? bins / ex : 0, ky = ey > 0 ? bins / ey : 0, kz = ez > 0 ? bins / ez : 0, yBase = bins * 6, zBase = bins * 12;
      for (let o = start * 6, e = end * 6; o < e; o += 6) {
        const b0 = boxes[o], b1 = boxes[o + 1], b2 = boxes[o + 2], b3 = boxes[o + 3], b4 = boxes[o + 4], b5 = boxes[o + 5];
        let bin: number, s: number;
        if (kx) {
          bin = ((b0 + b3 - cx0) * kx) | 0; if (bin > last) bin = last; s = bin * 6; binCounts[bin]++;
          if (b0 < binBoxes[s]) binBoxes[s] = b0; if (b1 < binBoxes[s + 1]) binBoxes[s + 1] = b1; if (b2 < binBoxes[s + 2]) binBoxes[s + 2] = b2;
          if (b3 > binBoxes[s + 3]) binBoxes[s + 3] = b3; if (b4 > binBoxes[s + 4]) binBoxes[s + 4] = b4; if (b5 > binBoxes[s + 5]) binBoxes[s + 5] = b5;
        }
        if (ky) {
          bin = ((b1 + b4 - cy0) * ky) | 0; if (bin > last) bin = last; s = yBase + bin * 6; binCounts[bins + bin]++;
          if (b0 < binBoxes[s]) binBoxes[s] = b0; if (b1 < binBoxes[s + 1]) binBoxes[s + 1] = b1; if (b2 < binBoxes[s + 2]) binBoxes[s + 2] = b2;
          if (b3 > binBoxes[s + 3]) binBoxes[s + 3] = b3; if (b4 > binBoxes[s + 4]) binBoxes[s + 4] = b4; if (b5 > binBoxes[s + 5]) binBoxes[s + 5] = b5;
        }
        if (kz) {
          bin = ((b2 + b5 - cz0) * kz) | 0; if (bin > last) bin = last; s = zBase + bin * 6; binCounts[2 * bins + bin]++;
          if (b0 < binBoxes[s]) binBoxes[s] = b0; if (b1 < binBoxes[s + 1]) binBoxes[s + 1] = b1; if (b2 < binBoxes[s + 2]) binBoxes[s + 2] = b2;
          if (b3 > binBoxes[s + 3]) binBoxes[s + 3] = b3; if (b4 > binBoxes[s + 4]) binBoxes[s + 4] = b4; if (b5 > binBoxes[s + 5]) binBoxes[s + 5] = b5;
        }
      }
      let bestCost = Infinity;
      for (let a = 0; a < 3; a++) {
        if ((a === 0 ? kx : a === 1 ? ky : kz) === 0) continue;
        let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity, acc = 0;
        for (let bin = last; bin > 0; bin--) {
          const slot = a * bins + bin, s = slot * 6;
          if (binCounts[slot]) {
            acc += binCounts[slot];
            if (binBoxes[s] < ax0) ax0 = binBoxes[s]; if (binBoxes[s + 1] < ay0) ay0 = binBoxes[s + 1]; if (binBoxes[s + 2] < az0) az0 = binBoxes[s + 2];
            if (binBoxes[s + 3] > ax1) ax1 = binBoxes[s + 3]; if (binBoxes[s + 4] > ay1) ay1 = binBoxes[s + 4]; if (binBoxes[s + 5] > az1) az1 = binBoxes[s + 5];
          }
          rightCount[bin] = acc; rightArea[bin] = acc ? area(ax0, ay0, az0, ax1, ay1, az1) : 0;
        }
        ax0 = ay0 = az0 = Infinity; ax1 = ay1 = az1 = -Infinity; acc = 0;
        for (let bin = 1; bin < bins; bin++) {
          const slot = a * bins + bin - 1, s = slot * 6;
          if (binCounts[slot]) {
            acc += binCounts[slot];
            if (binBoxes[s] < ax0) ax0 = binBoxes[s]; if (binBoxes[s + 1] < ay0) ay0 = binBoxes[s + 1]; if (binBoxes[s + 2] < az0) az0 = binBoxes[s + 2];
            if (binBoxes[s + 3] > ax1) ax1 = binBoxes[s + 3]; if (binBoxes[s + 4] > ay1) ay1 = binBoxes[s + 4]; if (binBoxes[s + 5] > az1) az1 = binBoxes[s + 5];
          }
          if (!acc || !rightCount[bin]) continue;
          const cost = area(ax0, ay0, az0, ax1, ay1, az1) * acc + rightArea[bin] * rightCount[bin];
          if (cost < bestCost) { bestCost = cost; axis = a; splitBin = bin; }
        }
      }
      if (axis >= 0) { lo = axis === 0 ? cx0 : axis === 1 ? cy0 : cz0; k = axis === 0 ? kx : axis === 1 ? ky : kz; }
    }
    if (axis < 0) {
      // Center split on the widest centroid axis (the 'center' strategy, or SAH with no usable bin boundary).
      axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const extent = axis === 0 ? ex : axis === 1 ? ey : ez;
      lo = axis === 0 ? cx0 : axis === 1 ? cy0 : cz0; k = extent > 0 ? 2 / extent : 0; splitBin = 1;
    }
    // Partition slots whose centroid bin is below splitBin to the front, swapping boxes with the ids, and measure
    // both children on the way so they need no separate bounds pass.
    const leftRecord = (depth + 1) * 24, rightRecord = leftRecord + 12;
    let mid = start;
    if (k > 0) {
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
      let lcx0 = Infinity, lcy0 = Infinity, lcz0 = Infinity, lcx1 = -Infinity, lcy1 = -Infinity, lcz1 = -Infinity;
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity;
      let rcx0 = Infinity, rcy0 = Infinity, rcz0 = Infinity, rcx1 = -Infinity, rcy1 = -Infinity, rcz1 = -Infinity;
      let i = start, j = end - 1;
      while (i <= j) {
        const o = i * 6;
        const b0 = boxes[o], b1 = boxes[o + 1], b2 = boxes[o + 2], b3 = boxes[o + 3], b4 = boxes[o + 4], b5 = boxes[o + 5];
        const px = b0 + b3, py = b1 + b4, pz = b2 + b5;
        let bin = (((axis === 0 ? px : axis === 1 ? py : pz) - lo) * k) | 0; if (bin > last) bin = last;
        if (bin < splitBin) {
          if (b0 < lx0) lx0 = b0; if (b1 < ly0) ly0 = b1; if (b2 < lz0) lz0 = b2; if (b3 > lx1) lx1 = b3; if (b4 > ly1) ly1 = b4; if (b5 > lz1) lz1 = b5;
          if (px < lcx0) lcx0 = px; if (px > lcx1) lcx1 = px; if (py < lcy0) lcy0 = py; if (py > lcy1) lcy1 = py; if (pz < lcz0) lcz0 = pz; if (pz > lcz1) lcz1 = pz;
          i++; continue;
        }
        if (b0 < rx0) rx0 = b0; if (b1 < ry0) ry0 = b1; if (b2 < rz0) rz0 = b2; if (b3 > rx1) rx1 = b3; if (b4 > ry1) ry1 = b4; if (b5 > rz1) rz1 = b5;
        if (px < rcx0) rcx0 = px; if (px > rcx1) rcx1 = px; if (py < rcy0) rcy0 = py; if (py > rcy1) rcy1 = py; if (pz < rcz0) rcz0 = pz; if (pz > rcz1) rcz1 = pz;
        const q = j * 6, id = order[i]; order[i] = order[j]; order[j] = id;
        boxes[o] = boxes[q]; boxes[o + 1] = boxes[q + 1]; boxes[o + 2] = boxes[q + 2]; boxes[o + 3] = boxes[q + 3]; boxes[o + 4] = boxes[q + 4]; boxes[o + 5] = boxes[q + 5];
        boxes[q] = b0; boxes[q + 1] = b1; boxes[q + 2] = b2; boxes[q + 3] = b3; boxes[q + 4] = b4; boxes[q + 5] = b5;
        j--;
      }
      mid = i;
      stack[leftRecord] = lx0; stack[leftRecord + 1] = ly0; stack[leftRecord + 2] = lz0; stack[leftRecord + 3] = lx1; stack[leftRecord + 4] = ly1; stack[leftRecord + 5] = lz1;
      stack[leftRecord + 6] = lcx0; stack[leftRecord + 7] = lcy0; stack[leftRecord + 8] = lcz0; stack[leftRecord + 9] = lcx1; stack[leftRecord + 10] = lcy1; stack[leftRecord + 11] = lcz1;
      stack[rightRecord] = rx0; stack[rightRecord + 1] = ry0; stack[rightRecord + 2] = rz0; stack[rightRecord + 3] = rx1; stack[rightRecord + 4] = ry1; stack[rightRecord + 5] = rz1;
      stack[rightRecord + 6] = rcx0; stack[rightRecord + 7] = rcy0; stack[rightRecord + 8] = rcz0; stack[rightRecord + 9] = rcx1; stack[rightRecord + 10] = rcy1; stack[rightRecord + 11] = rcz1;
    }
    if (mid === start || mid === end) {
      // Coincident centroids: split the range in half and measure both halves directly.
      mid = start + (size >> 1);
      this.measure(start, mid, leftRecord); this.measure(mid, end, rightRecord);
    }
    const left = this.allocate();
    this.subdivide(left, start, mid, depth + 1, leftRecord);
    const right = this.allocate();
    this.subdivide(right, mid, end, depth + 1, rightRecord);
    this.u32[w + 6] = right; this.u32[w + 7] = INTERNAL_FLAG | axis;
  }
}

function area(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  return dx * dy + dy * dz + dz * dx;
}

import { rangeError } from '../../shared/errors.js';
import type { FlowGrid } from './flow.js';

/** Reproducible seed layout. Region uses a uniform lattice inside its sub-box. */
export type FlowSeeding =
  | { readonly kind: 'uniform' }
  | { readonly kind: 'random'; readonly seed?: number }
  | { readonly kind: 'rake'; readonly start: readonly [number, number, number]; readonly end: readonly [number, number, number] }
  | { readonly kind: 'region'; readonly bounds: FlowGrid['bounds'] };

/** @internal Grid shape validation shared by CPU transport, seed placement and GPU transport. */
export function validateFlowGrid(grid: FlowGrid): number {
  const fail = (message: string): never => { throw rangeError(message, 'sciviz'); };
  const dims = grid?.dims, bounds = grid?.bounds, frames = grid?.frames;
  if (!dims || dims.length !== 3 || dims.some((n, i) => !Number.isSafeInteger(n) || n < (i === 2 ? 1 : 2)))
    fail('Flow dims need integer x/y counts of at least 2 and z of at least 1');
  if (!bounds || bounds.length !== 6 || bounds.some((x) => !Number.isFinite(x)))
    fail('Flow bounds need six finite first/last sample coordinates');
  for (let i = 0; i < 3; i++) {
    const width = bounds[i * 2 + 1] - bounds[i * 2];
    if (!Number.isFinite(width) || (dims[i] === 1 ? width !== 0 : width <= 0))
      fail('Flow bounds must ascend on sampled axes and be equal on the singleton z axis');
  }
  if (!frames?.length || frames.length > 4096) fail('Flow needs 1 to 4096 velocity frames');
  const size = dims[0] * dims[1] * dims[2];
  if (!Number.isSafeInteger(size) || size * frames.length * 12 > 128 * 1024 * 1024)
    fail('Flow input and output exceed the 128 MiB working budget; reduce the grid, frames or maxSteps');
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f || !Number.isFinite(f.time) || (i > 0 && (!(f.time > frames[i - 1].time) || !Number.isFinite(f.time - frames[i - 1].time))))
      fail('Flow frame times must be finite, strictly increasing, with finite differences');
    for (const a of [f.u, f.v, f.w])
      if (a !== undefined && (!(a instanceof Float32Array) || a.length !== size))
        fail('Flow components must be Float32Arrays with one value per grid sample');
    if (!f.u || !f.v) fail('Flow frames need both u and v components');
  }
  return size;
}

/**
 * Places `count` xyz seeds (1..1000000, default 1024). Uniform/region sample cell centres on an
 * axis-balanced lattice, rake includes its endpoints, random uses an unsigned 32-bit seed (default 0).
 * Returns independent float64 coordinates. No GPU or Wasm load. Missing velocities do not affect placement.
 */
export function flowSeeds(grid: FlowGrid, count = 1024, seeding: FlowSeeding = { kind: 'uniform' }): Float64Array {
  validateFlowGrid(grid);
  const fail = (): never => { throw rangeError('Flow seeding needs a valid kind, count, seed and in-grid bounds or endpoints', 'sciviz'); };
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) fail();
  if (!seeding || !['uniform', 'random', 'rake', 'region'].includes(seeding.kind)) fail();
  const b = seeding.kind === 'region' ? seeding.bounds : grid.bounds;
  const inside = (p: readonly number[]) => p?.length === 3 && p.every((x, c) => Number.isFinite(x) && x >= grid.bounds[2 * c] && x <= grid.bounds[2 * c + 1]);
  if (!b || b.length !== 6 || !inside([b[0], b[2], b[4]]) || !inside([b[1], b[3], b[5]]) || [0, 2, 4].some((i) => b[i] > b[i + 1])) fail();
  if (seeding.kind === 'rake' && (!inside(seeding.start) || !inside(seeding.end))) fail();
  let state = seeding.kind === 'random' ? seeding.seed ?? 0 : 0;
  if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) fail();
  // Full-period 32-bit LCG. Integer multiplication is specified modulo 2^32 by Math.imul.
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
  const cells = [1, 1, 1], active = [0, 1, 2].filter((c) => b[2 * c] < b[2 * c + 1]);
  while (cells[0] * cells[1] * cells[2] < count) {
    let axis = active[0];
    for (const c of active) if (cells[c] < cells[axis]) axis = c;
    if (axis === undefined) break;
    cells[axis]++;
  }
  const out = new Float64Array(count * 3);
  const total = cells[0] * cells[1] * cells[2];
  for (let i = 0; i < count; i++) {
    // Spread a non-factorable count over the entire lattice instead of truncating one edge.
    const index = Math.floor((i + 0.5) * total / count);
    const cell = [index % cells[0], Math.floor(index / cells[0]) % cells[1], Math.floor(index / (cells[0] * cells[1]))];
    for (let c = 0; c < 3; c++) {
      const t = seeding.kind === 'random' ? random() : (cell[c] + 0.5) / cells[c];
      out[3 * i + c] = seeding.kind === 'rake'
        ? seeding.start[c] + (seeding.end[c] - seeding.start[c]) * (count === 1 ? 0.5 : i / (count - 1))
        : b[c * 2] + (b[c * 2 + 1] - b[c * 2]) * t;
    }
  }
  return out;
}

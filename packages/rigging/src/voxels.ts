// The voxel grid of geodesic voxel binding, shared by the weights and the automatic rig. Internal to the package.
import type { RigJoint } from './rig.js';
import type { Welded } from './mesh.js';

/** Axis directions of the six a voxel inside an open mesh must find surface on. */
export const INSIDE_VOTES = 4;
export const OUTSIDE = 0;
export const SHELL = 1;
export const SOLID = 2;

/** The grid over a mesh, one voxel of margin all round so the outside is connected. */
export interface Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cell: number;
  readonly origin: readonly [number, number, number];
  readonly state: Uint8Array;
}

export function makeGrid(welded: Welded, joints: readonly RigJoint[], resolution: number): Grid {
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
export function markTriangles(grid: Grid, welded: Welded): void {
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
export function fill(grid: Grid, closing: number): void {
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
export function votes(grid: Grid): Uint8Array {
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

/** A binary heap of voxels by distance, with lazy deletion. */
export class Heap {
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
export const NEIGHBOURS: readonly (readonly [number, number, number, number])[] = Array.from({ length: 27 }, (_, i) => {
  const dx = (i % 3) - 1,
    dy = (((i / 3) | 0) % 3) - 1,
    dz = ((i / 9) | 0) - 1;
  return [dx, dy, dz, Math.hypot(dx, dy, dz)] as const;
}).filter((n) => n[3] > 0);


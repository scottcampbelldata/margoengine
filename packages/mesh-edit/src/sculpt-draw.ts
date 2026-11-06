// Draw buffers that follow a sculpted surface. One draw vertex for each distinct UV a vertex has, in the 20-float layout
// gltf-pro's prepared geometry uses, so a dab rewrites the few floats it changed instead of the whole mesh.
import type { SculptIndex } from './sculpt-index.js';
import { triNormal, type SurfaceTri, type TriSurface } from './tri-surface.js';

const STRIDE = 20;
/** Draw vertices closer than this in a buffer upload together: one call costs more than a few extra bytes. */
const GAP = 32;

/** A run of draw vertices to upload, in vertex units. */
export interface SculptDrawRange {
  start: number;
  count: number;
}

/** Draw buffers for a {@link MeshSculptSession}, from its `drawing()` method. Triangles are `indices`. */
export class SculptDrawing {
  /** Twenty floats a vertex: position and 1, normal and 0, tangent and sign 0, two UV pairs, RGBA 1. */
  vertices = new Float32Array(0);
  /** Three draw vertices a triangle. */
  indices = new Uint32Array(0);

  #surface: TriSurface;
  #index: SculptIndex;
  /** Draw vertices of each surface vertex. */
  #slots: number[][] = [];
  #moved = new Set<number>();
  #stale = true;

  /** @internal */
  constructor(surface: TriSurface, index: SculptIndex) {
    this.#surface = surface;
    this.#index = index;
  }

  /** @internal A vertex moved. */
  moved(v: number): void {
    this.#moved.add(v);
  }

  /** @internal Triangles changed: indices and draw vertices no longer match. */
  rebuild(): void {
    this.#stale = true;
  }

  /**
   * Brings the buffers up to date. Returns the runs of `vertices` that changed, or `'all'` when triangles changed and
   * both arrays are new. An empty list means nothing changed.
   */
  update(): readonly SculptDrawRange[] | 'all' {
    if (this.#stale) {
      this.#build();
      return 'all';
    }
    if (!this.#moved.size) return [];
    // A vertex's normal follows its neighbors, so they change too.
    const { tris } = this.#surface,
      around = this.#index.around,
      touched = new Set(this.#moved);
    for (const v of this.#moved) for (const f of around[v]) for (const w of tris[f].v) touched.add(w);
    this.#moved.clear();
    const slots: number[] = [];
    for (const v of touched) {
      this.#write(v);
      slots.push(...this.#slots[v]);
    }
    slots.sort((a, b) => a - b);
    const out: SculptDrawRange[] = [];
    for (const slot of slots) {
      const last = out[out.length - 1];
      if (last && slot - (last.start + last.count) < GAP) last.count = slot - last.start + 1;
      else out.push({ start: slot, count: 1 });
    }
    return out;
  }

  #build(): void {
    const tris = (this.#surface.tris as (SurfaceTri | null)[]).filter((tri) => tri !== null),
      slots: number[][] = [],
      uvs: number[] = [],
      indices = new Uint32Array(tris.length * 3);
    tris.forEach((tri, f) => {
      for (let c = 0; c < 3; c++) {
        const v = tri.v[c],
          [u, w] = tri.uv[c],
          mine = (slots[v] ??= []);
        let slot = mine.find((s) => uvs[s * 2] === u && uvs[s * 2 + 1] === w);
        if (slot === undefined) {
          slot = uvs.length / 2;
          uvs.push(u, w);
          mine.push(slot);
        }
        indices[f * 3 + c] = slot;
      }
    });
    const vertices = new Float32Array((uvs.length / 2) * STRIDE);
    for (let slot = 0; slot < uvs.length / 2; slot++) {
      const o = slot * STRIDE;
      vertices[o + 3] = 1;
      vertices[o + 12] = vertices[o + 14] = uvs[slot * 2];
      vertices[o + 13] = vertices[o + 15] = uvs[slot * 2 + 1];
      vertices.fill(1, o + 16, o + 20);
    }
    this.vertices = vertices;
    this.indices = indices;
    this.#slots = slots;
    slots.forEach((_, v) => this.#write(v));
    this.#moved.clear();
    this.#stale = false;
  }

  /** Writes a vertex's position and area-weighted normal into each of its draw vertices. */
  #write(v: number): void {
    const { points, tris } = this.#surface,
      p = points[v],
      n = [0, 0, 0];
    for (const f of this.#index.around[v]) {
      const corners = tris[f].v,
        m = triNormal(points[corners[0]], points[corners[1]], points[corners[2]]);
      for (let k = 0; k < 3; k++) n[k] += m[k];
    }
    const size = Math.hypot(n[0], n[1], n[2]);
    for (const slot of this.#slots[v]) {
      const o = slot * STRIDE,
        out = this.vertices;
      out[o] = p[0];
      out[o + 1] = p[1];
      out[o + 2] = p[2];
      out[o + 4] = size ? n[0] / size : 0;
      out[o + 5] = size ? n[1] / size : 0;
      out[o + 6] = size ? n[2] / size : 1;
    }
  }
}

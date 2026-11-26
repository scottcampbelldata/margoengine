import { hypot, ln } from '@margoengine/math/pinned';
import type { HullMesh } from './wetted.js';

interface WaterlineEdge {
  readonly nx: number;
  readonly nz: number;
  readonly projected: number;
}

export interface ReflectingWaterline {
  readonly edges: readonly WaterlineEdge[];
  readonly draft: number;
  readonly beam: number;
  readonly length: number;
}

/** Cut the triangle mesh at its mean waterline. The half-open test owns an edge coincident with the cut once. */
export function reflectingWaterline({ vertices, indices }: HullMesh, height: number): ReflectingWaterline {
  const edges: WaterlineEdge[] = [];
  let aft = Infinity;
  let fore = -Infinity;
  let port = Infinity;
  let starboard = -Infinity;
  let keel = height;
  for (let i = 1; i < vertices.length; i += 3) keel = Math.min(keel, vertices[i]!);
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i]!;
    const b = 3 * indices[i + 1]!;
    const c = 3 * indices[i + 2]!;
    const cuts: [number, number][] = [];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const dy = vertices[p + 1]! - height;
      const other = vertices[q + 1]! - height;
      if (dy < 0 === other < 0) continue;
      const t = dy / (dy - other);
      const x = vertices[p]! + t * (vertices[q]! - vertices[p]!);
      const z = vertices[p + 2]! + t * (vertices[q + 2]! - vertices[p + 2]!);
      cuts.push([x, z]);
    }
    if (cuts.length !== 2) continue;
    const [p, q] = cuts as [[number, number], [number, number]];
    aft = Math.min(aft, p[0], q[0]);
    fore = Math.max(fore, p[0], q[0]);
    port = Math.min(port, p[1], q[1]);
    starboard = Math.max(starboard, p[1], q[1]);
    const ux = vertices[b]! - vertices[a]!;
    const uy = vertices[b + 1]! - vertices[a + 1]!;
    const uz = vertices[b + 2]! - vertices[a + 2]!;
    const vx = vertices[c]! - vertices[a]!;
    const vy = vertices[c + 1]! - vertices[a + 1]!;
    const vz = vertices[c + 2]! - vertices[a + 2]!;
    const nx = uy * vz - uz * vy;
    const nz = ux * vy - uy * vx;
    if (nx === 0) continue;
    const norm = hypot(nx, nz);
    edges.push({ nx: nx / norm, nz: nz / norm, projected: Math.sign(nx) * Math.abs(q[1] - p[1]) });
  }
  return { edges, draft: height - keel, beam: starboard - port, length: fore - aft };
}

/** Ursell's squared wall reflectance in Kuroda et al. (2008), with x = encounter wavenumber times draft. */
export function wallReflectance(x: number): number {
  if (x < 1e-6) return (Math.PI * Math.PI * x ** 4) / 4;
  if (x >= 12) return 1;
  const xSquared = 0.25 * x * x;
  // DLMF 10.25.2 and 10.31.1 share the I1 terms. The integer arguments of
  // psi(k + 1) and psi(k + 2) advance by the harmonic increments.
  let psi = 1 - 2 * 0.5772156649015329;
  let term = 0.5 * x;
  let i1 = term;
  let series = psi * term;
  for (let m = 1; m <= 32; m++) {
    term *= xSquared / (m * (m + 1));
    psi += 1 / m + 1 / (m + 1);
    i1 += term;
    series += psi * term;
    if (term <= Number.EPSILON * i1) break;
  }
  const ratio = (1 / (x * i1) + ln(0.5 * x) - (0.5 * series) / i1) / Math.PI;
  return 1 / (1 + ratio * ratio);
}

/** Effective incident waterline breadth in Fujii–Takahashi's oblique-wave integral. */
export function interceptedBreadth(waterline: ReflectingWaterline, kx: number, kz: number): number {
  let width = 0;
  for (const { nx, nz, projected } of waterline.edges) {
    const hit = -(kx * nx + kz * nz);
    if (hit > 0) width += hit * hit * projected;
  }
  return width;
}

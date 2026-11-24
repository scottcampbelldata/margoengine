import { Geometry } from '@margoengine/core';
import { fault } from '../../shared/errors.js';

export type Point3 = readonly [number, number, number];
export const designError = (message: string) => fault('failed', message, 'geometry');
export const bounded = (v: number, min: number, max: number): boolean => Number.isFinite(v) && v >= min && v <= max;

/** Independent face corners keep sidewalk, curb and structure creases hard. */
export class DesignMesh {
  private positions: number[] = [];
  private normals: number[] = [];
  triangle(a: Point3, b: Point3, c: Point3): void {
    const p = [a, b, c].map(v => v.map(Math.fround));
    if (p.some(v => v.some(x => !bounded(x, -1_000_000, 1_000_000))))
      throw designError('Road design positions must stay within +/-1000000 metres');
    const u = p[1].map((v, k) => v - p[0][k]), w = p[2].map((v, k) => v - p[0][k]);
    const n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]], length = Math.hypot(...n);
    if (!length) throw designError('Road design triangle collapsed in float32; increase dimensions or use a local origin');
    if (this.positions.length >= 9_000_000) throw designError('Road design exceeds one million triangles; reduce tessellation');
    for (const v of p) { this.positions.push(...v); this.normals.push(...n.map(x => x / length)); }
  }
  quad(a: Point3, b: Point3, c: Point3, d: Point3): void { this.triangle(a,b,c); this.triangle(a,c,d); }
  finish(uvMeters = 1): {geometry: Geometry; uvs: Float32Array} {
    const positions = Float32Array.from(this.positions), uvs = new Float32Array(positions.length / 3 * 2);
    for (let i=0; i<positions.length/3; i++) { uvs[i*2] = positions[i*3]/uvMeters; uvs[i*2+1] = -positions[i*3+2]/uvMeters; }
    if (!uvs.every(Number.isFinite)) throw designError('Road design UVs overflow float32; increase uvMeters');
    return {geometry: new Geometry(positions, Float32Array.from(this.normals), Uint32Array.from({length:positions.length/3}, (_,i)=>i)), uvs};
  }
}

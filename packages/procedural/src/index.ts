import {Geometry} from '@margoengine/core';
import {marchingCubes as extract} from 'isosurface';
import {createNoise3D} from 'simplex-noise';
export {generateTreeMesh, generateShrubMesh, generateRockMesh, generateFernMesh, generateGrassMesh, contactAO, radialAO} from './foliage.js';
export {generateCabinMesh, ROOF_PITCH, type HeightField} from './cabin.js';
export {createHumanoid, poseHumanoid} from './humanoid.js';
export type DensityField = (x: number, y: number, z: number) => number;
export interface SurfaceOptions {resolution?: readonly [number, number, number]; bounds?: readonly [readonly [number, number, number], readonly [number, number, number]]; level?: number}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function hash(x: number, y: number, z: number, seed: number): number {let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041) ^ seed; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0;}
function gradient(h: number, x: number, y: number, z: number): number {h &= 15; const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return (h & 1 ? -u : u) + (h & 2 ? -v : v);}
const coordinates = (x: number, y: number, z: number): void => {if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1e7) throw new RangeError('Noise coordinates exceed finite bounds');};

export class Noise {
  private readonly simplexField: DensityField;
  constructor(readonly seed = 1) {
    if (!Number.isSafeInteger(seed)) throw new RangeError('Invalid noise seed');
    let state = seed >>> 0 || 1;
    this.simplexField = createNoise3D(() => {state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296;});
  }
  simplex(x: number, y: number, z: number): number {coordinates(x, y, z); return this.simplexField(x, y, z);}
  perlin(x: number, y: number, z: number): number {
    coordinates(x, y, z); const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z); x -= ix; y -= iy; z -= iz;
    const u = fade(x), v = fade(y), w = fade(z); let value = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) value += gradient(hash(ix + a, iy + b, iz + c, this.seed), x - a, y - b, z - c) * (a ? u : 1 - u) * (b ? v : 1 - v) * (c ? w : 1 - w);
    return value;
  }
  /** F1 cellular distance; each integer cell has one seeded feature point. */
  worley(x: number, y: number, z: number): number {
    coordinates(x, y, z); const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z); let distance = Infinity;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
      const cx = ix + a, cy = iy + b, cz = iz + c;
      const dx = cx + hash(cx, cy, cz, this.seed) / 4294967296 - x;
      const dy = cy + hash(cx, cy, cz, this.seed ^ 0x9e3779b9) / 4294967296 - y;
      const dz = cz + hash(cx, cy, cz, this.seed ^ 0x85ebca6b) / 4294967296 - z;
      distance = Math.min(distance, dx * dx + dy * dy + dz * dz);
    }
    return Math.sqrt(distance);
  }
}

/** Seeded coastal island preset; returns an allocation-free world-height sampler. */
export function createIslandHeight(seed = 731): (x: number, z: number) => number {
  const noise = new Noise(seed);
  return (x,z) => {
    const radius = Math.hypot(x,z);
    const shelf = 5.5*Math.exp(-((radius/57)**4))-3.4;
    const east = 21*Math.exp(-(((x-30)/18)**2)-((z+25)/24)**2);
    const west = 13*Math.exp(-(((x+34)/19)**2)-((z+35)/20)**2);
    const ridge = noise.perlin(x*0.045,0.3,z*0.045)*2.8+noise.perlin(x*0.14,2,z*0.14)*0.55;
    return shelf+east+west+ridge*Math.exp(-((radius/67)**4));
  };
}

/** Marching Cubes output with gradient normals and outward triangle winding. */
export function marchingCubes(field: DensityField, {resolution = [32, 32, 32], bounds = [[-1, -1, -1], [1, 1, 1]], level = 0}: SurfaceOptions = {}): Geometry | null {
  if (typeof field !== 'function' || !Number.isFinite(level) || resolution.length !== 3 || resolution.some(n => !Number.isInteger(n) || n < 3 || n > 128) ||
    bounds.length !== 2 || bounds.some(p => p.length !== 3 || p.some(v => !Number.isFinite(Math.fround(v)))) || bounds[0].some((v, i) => v >= bounds[1][i])) throw new RangeError('Invalid voxel surface');
  const evaluate: DensityField = (x, y, z) => {const value = field(x, y, z) - level; if (!Number.isFinite(value)) throw new RangeError('Density must be finite'); return value;};
  const upper = bounds[1].map((v, i) => bounds[0][i] + (v - bounds[0][i]) * resolution[i] / (resolution[i] - 1));
  const mesh = extract(resolution, evaluate, [bounds[0], upper]);
  if (!mesh.cells.length) return null;
  if (mesh.positions.length > 1_000_000 || mesh.cells.length > 1_000_000) throw new RangeError('Voxel output exceeds geometry budget');
  const positions = new Float32Array(mesh.positions.length * 3), normals = new Float32Array(positions.length), indices = new Uint32Array(mesh.cells.length * 3);
  const epsilon = Math.min(...bounds[0].map((v, i) => (bounds[1][i] - v) / resolution[i])) * 0.01;
  for (let i = 0; i < mesh.positions.length; i++) {
    const [x, y, z] = mesh.positions[i], nx = evaluate(x + epsilon, y, z) - evaluate(x - epsilon, y, z), ny = evaluate(x, y + epsilon, z) - evaluate(x, y - epsilon, z), nz = evaluate(x, y, z + epsilon) - evaluate(x, y, z - epsilon), length = Math.hypot(nx, ny, nz);
    positions.set([x, y, z], i * 3); normals.set(length ? [nx / length, ny / length, nz / length] : [0, 1, 0], i * 3);
  }
  for (let i = 0; i < mesh.cells.length; i++) {
    const [a, b, c] = mesh.cells[i], p = a * 3, q = b * 3, r = c * 3;
    const ux = positions[q] - positions[p], uy = positions[q + 1] - positions[p + 1], uz = positions[q + 2] - positions[p + 2], vx = positions[r] - positions[p], vy = positions[r + 1] - positions[p + 1], vz = positions[r + 2] - positions[p + 2];
    const outward = (uy * vz - uz * vy) * normals[p] + (uz * vx - ux * vz) * normals[p + 1] + (ux * vy - uy * vx) * normals[p + 2];
    indices.set(outward >= 0 ? [a, b, c] : [a, c, b], i * 3);
  }
  return new Geometry(positions, normals, indices);
}

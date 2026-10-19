// Scene snapshots of @margoengine/voxel-pathtracer: validation of a VoxelTraceScene, models packed into 8^3 bricks, a
// bounding volume hierarchy over the visible instances, the material table, emissive faces for light sampling and the
// environment map's sampling tables. Everything is checked and built before the tracer swaps snapshots, so an invalid
// scene leaves the current one untouched (README, "Scenes"). Pure CPU code; the GPU layout is in layout.ts.
import type {
  TraceAreaLight,
  TraceEnvironment,
  TraceEnvironmentMap,
  TraceInstance,
  TraceMaterial,
  TraceMaterialType,
  TraceModel,
  TraceVec3,
  VoxelTraceScene,
} from './types.js';
import { bakeSky, SKY_HEIGHT, SKY_WIDTH } from './sky.js';
import { cauchyB } from './spectrum.js';

/** Voxels per brick edge. Bricks are the coarse traversal level. */
const BRICK = 8;
/** u32 words of a mixed brick (one byte per voxel). */
export const BRICK_WORDS = (BRICK * BRICK * BRICK) / 4;
/** Grid entry flag of a brick whose voxels are all one non-zero palette index (index in the low byte). */
export const UNIFORM = 0x80000000;
/** Instances at most: ids AOVs store `(instance + 1) * 256 + palette` exactly in a float. */
const MAX_INSTANCES = 65535;
/** Area lights at most. */
const MAX_LIGHTS = 256;
/** Material flags (float 15 of a packed material). */
export const MEDIA = 1,
  EMISSIVE = 4,
  SMOOTH = 8;
/** Glass and mirror instances whose deflection of distant light is light-sampled, each (README, "Lighting"). */
const MAX_DEFLECTORS = 8;
const VOLUME = 2,
  PRESENT = 16;
/** Roughness squared below which reflection and refraction are perfectly specular. */
export const DELTA_ALPHA = 1e-3;
/** Floats per packed material (5 vec4), 256 materials. */
export const MATERIAL_FLOATS = 20;

const TYPES: readonly TraceMaterialType[] = ['diffuse', 'plastic', 'metal', 'glass', 'emit', 'blend', 'media'];
const where = 'VoxelPathTracer';

/** A model in bricks: what the GPU traverses and `raycast` reads. */
export interface PackedModel {
  readonly id: string;
  readonly revision: number;
  readonly size: readonly [number, number, number];
  /** Bricks per axis. */
  readonly bricks: readonly [number, number, number];
  /** Per brick (`bx + Bx * (bz + Bz * by)`): 0 empty, `UNIFORM | index`, or 1 + the payload brick number. */
  readonly grid: Uint32Array;
  /** 128 words (512 bytes, `lx + 8 * (lz + 8 * ly)`) per mixed brick. */
  readonly payload: Uint32Array;
  /** Voxel count per palette index. */
  readonly counts: Uint32Array;
}

/** Emissive faces of one model for one material set. */
interface ModelEmitters {
  key: string;
  /** Packed `x | y << 8 | z << 16 | face << 24` (face 0..5 = +x -x +y -y +z -z). */
  faces: Uint32Array;
  /** Palette index of each face's voxel. */
  ids: Uint8Array;
}

/** An instance as traced: rows of its affine transforms (3 x 4, row-major). */
interface SnapshotInstance {
  readonly id: string;
  /** Index in the caller's `scene.instances`. */
  readonly source: number;
  /** Index in `SceneSnapshot.models`. */
  readonly model: number;
  readonly toWorld: Float64Array;
  readonly toLocal: Float64Array;
  /** Shutter-open transform rows, when the instance moves. */
  readonly previous?: Float64Array;
  /** World bounds `[minX, minY, minZ, maxX, maxY, maxZ]` over both transforms. */
  readonly box: Float64Array;
  /** Probability that light sampling picks this instance (0 without emissive faces). */
  lightPick: number;
  /** Whether light sampling follows distant light through this instance's glass (one smooth glass material). */
  prism: boolean;
  /** Whether light sampling follows distant light reflected by this instance's smooth pure metal faces. */
  mirror: boolean;
}

/** Environment with defaults applied. */
interface ResolvedEnvironment {
  readonly sky: TraceVec3;
  readonly sunDirection: TraceVec3;
  /** Sun irradiance colour (colour times intensity). */
  readonly sun: TraceVec3;
  readonly sunAngularSize: number;
  readonly ground?: TraceVec3;
  readonly groundHeight: number;
  readonly map?: PackedEnvironment;
  /** A newly baked physical sky, kept in the cache when the snapshot succeeds. */
  readonly skyCache?: { key: string; data: Float32Array };
}

/** An environment map with its sampling tables. */
export interface PackedEnvironment {
  readonly source: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly intensity: number;
  readonly rotation: number;
  /** RGB radiance and sampling weight (luminance x sin theta) per texel. */
  readonly texels: Float32Array;
  /** Cumulative row weights, normalised, `height` floats. */
  readonly marginal: Float32Array;
  /** Cumulative weights within each row, normalised, `width * height` floats. */
  readonly conditional: Float32Array;
  /** Mean texel weight: the density of texel weight w is w / integral over the unit square. */
  readonly integral: number;
}

/** A validated, immutable copy of a scene in the tracer's form. */
export interface SceneSnapshot {
  readonly revision: number;
  readonly models: readonly PackedModel[];
  readonly modelIndex: ReadonlyMap<string, number>;
  /** Visible instances in BVH leaf order (the GPU instance order). */
  readonly instances: readonly SnapshotInstance[];
  /** BVH nodes, 8 words each: min xyz (f32), first child or first instance, max xyz (f32), instance count (0 inner). */
  readonly nodes: Uint32Array;
  readonly materials: Float32Array;
  readonly environment: ResolvedEnvironment;
  /** Area lights, 16 floats each: corner, cdf, edge u, two-sided, edge v, area, radiance, pad. */
  readonly lights: Float32Array;
  readonly lightCount: number;
  readonly lightPower: number;
  /** Emissive faces per model (same order as `models`), empty for models without any. */
  readonly emitters: readonly { faces: Uint32Array; cdf: Float32Array; total: number }[];
  /** Instances with emissive faces, by GPU instance index, and their cumulative pick probabilities. */
  readonly emissiveInstances: Uint32Array;
  readonly emissiveCdf: Float32Array;
  /** Whether any instance has a previous transform (motion blur). */
  readonly moving: boolean;
  /**
   * Instances whose deflection of distant light is light-sampled, pairs of GPU index and IOR: up to MAX_DEFLECTORS
   * glass instances (IOR) and as many mirror instances (IOR 0).
   */
  readonly deflectors: Float32Array;
  /** Mixed bricks plus grid words: the voxel buffer's words without padding. */
  readonly voxelWords: number;
}

/** Caches of the previous snapshot, reused by id and revision. */
export interface SceneCache {
  models: Map<string, PackedModel>;
  emitters: WeakMap<PackedModel, ModelEmitters>;
  environment?: PackedEnvironment;
  /** The last baked physical sky and the parameters it was baked for. */
  sky?: { key: string; data: Float32Array };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Throws TypeError unless `value` is a number; RangeError unless it lies in [min, max]. */
export function checkNumber(value: unknown, name: string, min: number, max: number, fix: string): number {
  if (typeof value !== 'number' || Number.isNaN(value))
    throw new TypeError(`${where} ${name} must be a number; ${fix}`);
  if (!(value >= min && value <= max))
    throw new RangeError(`${where} ${name} ${value} is outside ${min} to ${max}; ${fix}`);
  return value;
}
const optional = (value: unknown, fallback: number, name: string, min: number, max: number, fix: string) =>
  value === undefined ? fallback : checkNumber(value, name, min, max, fix);

/** Throws TypeError unless `value` is three finite numbers; RangeError when `nonNegative` and one is negative. */
export function checkVec3(value: unknown, name: string, nonNegative: boolean, fix: string): TraceVec3 {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value))
    throw new TypeError(`${where} ${name} must be an array of 3 numbers; ${fix}`);
  const v = value as ArrayLike<unknown>;
  if (v.length !== 3 || ![0, 1, 2].every((i) => typeof v[i] === 'number'))
    throw new TypeError(`${where} ${name} must be an array of 3 numbers; ${fix}`);
  const out: [number, number, number] = [v[0] as number, v[1] as number, v[2] as number];
  if (!out.every(Number.isFinite) || (nonNegative && out.some((x) => x < 0)))
    throw new RangeError(`${where} ${name} [${out}] must be finite${nonNegative ? ' and 0 or more' : ''}; ${fix}`);
  return out;
}

const checkId = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new TypeError(`${where} ${name} must be a non-empty string id`);
  return value;
};
const checkList = <T>(value: unknown, name: string): readonly T[] => {
  if (!Array.isArray(value)) throw new TypeError(`${where} scene.${name} must be an array`);
  return value as readonly T[];
};

/** Rows (3 x 4, row-major) of a column-major affine matrix; throws for a wrong shape, non-affine or singular matrix. */
function affineRows(matrix: unknown, name: string): Float64Array {
  if ((!Array.isArray(matrix) && !ArrayBuffer.isView(matrix)) || (matrix as ArrayLike<unknown>).length !== 16)
    throw new TypeError(`${where} ${name} must be 16 numbers (a column-major 4x4 matrix)`);
  const m = matrix as ArrayLike<unknown>;
  for (let i = 0; i < 16; i++)
    if (typeof m[i] !== 'number')
      throw new TypeError(`${where} ${name} must be 16 numbers (a column-major 4x4 matrix)`);
  const n = m as ArrayLike<number>;
  for (let i = 0; i < 16; i++)
    if (!Number.isFinite(n[i]))
      throw new RangeError(`${where} ${name}[${i}] ${n[i]} is not finite; pass finite numbers`);
  if (Math.abs(n[3]) > 1e-9 || Math.abs(n[7]) > 1e-9 || Math.abs(n[11]) > 1e-9 || Math.abs(n[15] - 1) > 1e-9)
    throw new RangeError(
      `${where} ${name} is not affine (its last row must be 0, 0, 0, 1); pass a model-to-world transform`,
    );
  const rows = new Float64Array(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) rows[r * 4 + c] = n[c * 4 + r];
  const det = det3(rows),
    scale = Math.max(...[0, 1, 2].map((c) => Math.hypot(rows[c], rows[4 + c], rows[8 + c])));
  if (!(Math.abs(det) > 1e-12 * scale * scale * scale) || !Number.isFinite(det))
    throw new RangeError(`${where} ${name} is singular (determinant ${det}); pass an invertible transform`);
  return rows;
}
const det3 = (r: ArrayLike<number>) =>
  r[0] * (r[5] * r[10] - r[6] * r[9]) - r[1] * (r[4] * r[10] - r[6] * r[8]) + r[2] * (r[4] * r[9] - r[5] * r[8]);

/** Inverse of affine rows (3 x 4, row-major). */
function invertRows(r: ArrayLike<number>): Float64Array {
  const det = det3(r),
    out = new Float64Array(12);
  // Inverse 3x3: columns are the cross products of the rows over the determinant.
  const a = [r[0], r[1], r[2]],
    b = [r[4], r[5], r[6]],
    c = [r[8], r[9], r[10]];
  const cross = (u: number[], v: number[]) => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const c0 = cross(b, c),
    c1 = cross(c, a),
    c2 = cross(a, b);
  for (let i = 0; i < 3; i++) {
    out[i * 4] = c0[i] / det;
    out[i * 4 + 1] = c1[i] / det;
    out[i * 4 + 2] = c2[i] / det;
  }
  for (let i = 0; i < 3; i++) out[i * 4 + 3] = -(out[i * 4] * r[3] + out[i * 4 + 1] * r[7] + out[i * 4 + 2] * r[11]);
  return out;
}

/** Packs a dense model into bricks (throws for a wrong shape before reading voxels). */
function packModel(model: TraceModel, name: string): PackedModel {
  const size = checkVec3(model.size, `${name}.size`, true, 'pass integer dimensions 1 to 256');
  if (!size.every((v) => Number.isInteger(v) && v >= 1 && v <= 256))
    throw new RangeError(
      `${where} ${name}.size [${size}] must be integers 1 to 256; pass the model's voxel dimensions`,
    );
  if (typeof model.revision !== 'number' || !Number.isFinite(model.revision))
    throw new TypeError(`${where} ${name}.revision must be a finite number; bump it when the voxels change`);
  const voxels = model.voxels;
  if (!(voxels instanceof Uint8Array))
    throw new TypeError(`${where} ${name}.voxels must be a Uint8Array of palette indices`);
  const [sx, sy, sz] = size;
  if (voxels.length !== sx * sy * sz)
    throw new TypeError(
      `${where} ${name}.voxels has ${voxels.length} entries; a ${sx}x${sy}x${sz} model needs ${sx * sy * sz} (index = x + sx * (z + sz * y))`,
    );
  const bx = Math.ceil(sx / BRICK),
    by = Math.ceil(sy / BRICK),
    bz = Math.ceil(sz / BRICK),
    grid = new Uint32Array(bx * by * bz),
    counts = new Uint32Array(256),
    scratch = new Uint8Array(BRICK * BRICK * BRICK);
  let payload = new Uint32Array(BRICK_WORDS * Math.min(grid.length, 64)),
    bricks = 0;
  for (let cy = 0; cy < by; cy++)
    for (let cz = 0; cz < bz; cz++)
      for (let cx = 0; cx < bx; cx++) {
        const x0 = cx * BRICK,
          y0 = cy * BRICK,
          z0 = cz * BRICK,
          nx = Math.min(BRICK, sx - x0),
          ny = Math.min(BRICK, sy - y0),
          nz = Math.min(BRICK, sz - z0);
        // Cells past the model's edge stay 0, so a partial brick is uniform only when it is empty.
        const partial = nx < BRICK || ny < BRICK || nz < BRICK;
        if (partial) scratch.fill(0);
        let first = -1,
          uniform = !partial;
        for (let ly = 0; ly < ny; ly++)
          for (let lz = 0; lz < nz; lz++) {
            const row = x0 + sx * (z0 + lz + sz * (y0 + ly)),
              at = 8 * (lz + 8 * ly);
            for (let lx = 0; lx < nx; lx++) {
              const v = voxels[row + lx];
              scratch[at + lx] = v;
              counts[v]++;
              if (first < 0) first = v;
              else if (v !== first) uniform = false;
            }
          }
        const index = cx + bx * (cz + bz * cy);
        if (partial && first === 0) {
          let empty = true;
          for (let i = 0; i < scratch.length && empty; i++) empty = scratch[i] === 0;
          if (empty) continue;
        }
        if (uniform) {
          grid[index] = first === 0 ? 0 : (UNIFORM | first) >>> 0;
          continue;
        }
        if ((bricks + 1) * BRICK_WORDS > payload.length) {
          const grown = new Uint32Array(Math.min(grid.length, bricks * 2 + 1) * BRICK_WORDS);
          grown.set(payload);
          payload = grown;
        }
        new Uint8Array(payload.buffer, bricks * BRICK_WORDS * 4, 512).set(scratch);
        grid[index] = ++bricks;
      }
  counts[0] = 0;
  return {
    id: model.id,
    revision: model.revision,
    size: [sx, sy, sz],
    bricks: [bx, by, bz],
    grid,
    payload: payload.slice(0, bricks * BRICK_WORDS),
    counts,
  };
}

/** Palette index of a model cell, 0 outside the model. */
function voxelAt(m: PackedModel, x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= m.size[0] || y >= m.size[1] || z >= m.size[2]) return 0;
  const [bx, , bz] = m.bricks,
    entry = m.grid[(x >> 3) + bx * ((z >> 3) + bz * (y >> 3))];
  if (entry === 0) return 0;
  if (entry >= UNIFORM) return entry & 255;
  const b = (x & 7) + 8 * ((z & 7) + 8 * (y & 7)),
    word = m.payload[(entry - 1) * BRICK_WORDS + (b >> 2)];
  return (word >>> ((b & 3) * 8)) & 255;
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Packs one material (MATERIAL_FLOATS floats) after validating it; returns its flags. */
function packMaterial(m: TraceMaterial, name: string, out: Float32Array): void {
  if (!isObject(m)) throw new TypeError(`${where} ${name} must be an object {id, color, type}`);
  if (!TYPES.includes(m.type as TraceMaterialType))
    throw new TypeError(`${where} ${name}.type ${String(m.type)} is unknown; pass one of ${TYPES.join(', ')}`);
  const color = checkVec3(m.color, `${name}.color`, true, 'pass linear RGB, 0 or more'),
    glow =
      m.emissionColor === undefined
        ? color
        : checkVec3(m.emissionColor, `${name}.emissionColor`, true, 'pass linear RGB, 0 or more'),
    type = m.type,
    unit = (value: unknown, fallback: number, field: string) =>
      optional(value, fallback, `${name}.${field}`, 0, 1, 'pass 0 to 1'),
    roughness = unit(m.roughness, type === 'glass' ? 0 : 0.2, 'roughness'),
    metalness = unit(m.metalness, type === 'metal' ? 1 : 0, 'metalness'),
    transmission = unit(m.transmission, type === 'glass' ? 1 : 0, 'transmission'),
    specular = unit(m.specular, type === 'diffuse' || type === 'emit' ? 0 : 1, 'specular'),
    emission = optional(m.emission, type === 'emit' ? 1 : 0, `${name}.emission`, 0, 1e6, 'pass 0 or more'),
    ior = optional(m.ior, 1.5, `${name}.ior`, 1, 3, 'pass 1 to 3 (glass is about 1.5)'),
    density = optional(m.density, type === 'media' ? 1 : 0, `${name}.density`, 0, 1e6, 'pass 0 or more per world unit'),
    scatter = optional(m.scatter, 0, `${name}.scatter`, 0, 1e6, 'pass 0 or more per world unit'),
    anisotropy = optional(m.anisotropy, 0, `${name}.anisotropy`, -0.95, 0.95, 'pass -0.95 to 0.95'),
    abbe = optional(m.abbe, 0, `${name}.abbe`, 0, 200, 'pass 0 (no dispersion) or an Abbe number of 5 to 200');
  if (abbe > 0 && abbe < 5)
    throw new RangeError(`${where} ${name}.abbe ${abbe} is out of range; pass 0 (no dispersion) or 5 to 200`);
  const base = m.id * MATERIAL_FLOATS,
    alpha = roughness * roughness,
    media = type === 'media',
    pMetal = media ? 0 : metalness,
    pGlass = media ? 0 : (1 - metalness) * transmission;
  let flags = PRESENT;
  if (media) flags |= MEDIA;
  if (pGlass > 0) flags |= VOLUME;
  if (!media && emission > 0 && luminance(glow[0], glow[1], glow[2]) * emission > 0) flags |= EMISSIVE;
  if (alpha < DELTA_ALPHA) flags |= SMOOTH;
  out.set(
    [
      Math.min(color[0], 1),
      Math.min(color[1], 1),
      Math.min(color[2], 1),
      alpha,
      pMetal,
      pGlass,
      media ? 0 : specular,
      ((ior - 1) / (ior + 1)) ** 2,
      // Surfaces: emitted radiance; media: emitted radiance per world unit (not a light-sampled emitter).
      glow[0] * emission,
      glow[1] * emission,
      glow[2] * emission,
      ior,
      density,
      scatter,
      anisotropy,
      flags,
      // Cauchy coefficient (square micrometres) of the glass lobe's dispersion.
      pGlass > 0 ? cauchyB(ior, abbe) : 0,
      0,
      0,
      0,
    ],
    base,
  );
}

/** Emissive faces of a model under a material table (reused while the emissive and see-through sets are unchanged). */
function modelEmitters(m: PackedModel, materials: Float32Array, cache: SceneCache): ModelEmitters | undefined {
  let emissive = '',
    clear = '';
  for (let id = 1; id < 256; id++) {
    const flags = materials[id * MATERIAL_FLOATS + 15];
    if (m.counts[id] && flags & EMISSIVE) emissive += `${id},`;
    if (flags & (MEDIA | VOLUME)) clear += `${id},`;
  }
  if (!emissive) return undefined;
  const key = `${emissive}|${clear}`,
    cached = cache.emitters.get(m);
  if (cached?.key === key) return cached;
  const see = new Uint8Array(256),
    glow = new Uint8Array(256);
  see[0] = 1;
  for (let id = 1; id < 256; id++) {
    const flags = materials[id * MATERIAL_FLOATS + 15];
    if (flags & (MEDIA | VOLUME)) see[id] = 1;
    if (flags & EMISSIVE) glow[id] = 1;
  }
  const faces: number[] = [],
    ids: number[] = [],
    [sx, sy, sz] = m.size,
    [bx, by, bz] = m.bricks,
    steps = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
  for (let cy = 0; cy < by; cy++)
    for (let cz = 0; cz < bz; cz++)
      for (let cx = 0; cx < bx; cx++) {
        const entry = m.grid[cx + bx * (cz + bz * cy)];
        if (!entry || (entry >= UNIFORM && !glow[entry & 255])) continue;
        for (let y = cy * 8; y < Math.min(cy * 8 + 8, sy); y++)
          for (let z = cz * 8; z < Math.min(cz * 8 + 8, sz); z++)
            for (let x = cx * 8; x < Math.min(cx * 8 + 8, sx); x++) {
              const v = voxelAt(m, x, y, z);
              if (!glow[v]) continue;
              for (let f = 0; f < 6; f++) {
                const s = steps[f];
                if (!see[voxelAt(m, x + s[0], y + s[1], z + s[2])]) continue;
                faces.push((x | (y << 8) | (z << 16) | (f << 24)) >>> 0);
                ids.push(v);
              }
            }
      }
  const result = { key, faces: Uint32Array.from(faces), ids: Uint8Array.from(ids) };
  cache.emitters.set(m, result);
  return result;
}

/** Mean world area of a unit face under affine rows (for picking emissive instances). */
function faceAreas(rows: ArrayLike<number>): [number, number, number] {
  const col = (c: number) => [rows[c], rows[4 + c], rows[8 + c]];
  const area = (a: number[], b: number[]) =>
    Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  const x = col(0),
    y = col(1),
    z = col(2);
  return [area(y, z), area(z, x), area(x, y)];
}

// World bounds of the box [0, size] under affine rows, grown into `box`.
function growBox(box: Float64Array, rows: ArrayLike<number>, size: readonly number[]): void {
  for (let corner = 0; corner < 8; corner++) {
    const p = [corner & 1 ? size[0] : 0, corner & 2 ? size[1] : 0, corner & 4 ? size[2] : 0];
    for (let r = 0; r < 3; r++) {
      const v = rows[r * 4] * p[0] + rows[r * 4 + 1] * p[1] + rows[r * 4 + 2] * p[2] + rows[r * 4 + 3];
      box[r] = Math.min(box[r], v);
      box[r + 3] = Math.max(box[r + 3], v);
    }
  }
}

/**
 * Bounding volume hierarchy over boxes (6 floats each): binned surface-area splits to depth 12, median splits below
 * (so depth stays under 12 + log2(count) + 1, at most 29 for 65,535 boxes), at most 2 boxes per leaf. Returns the
 * nodes and the leaf order of the boxes.
 */
function buildHierarchy(boxes: Float64Array, count: number): { nodes: Uint32Array; order: Int32Array } {
  const order = new Int32Array(count).map((_, i) => i),
    nodes: number[] = [],
    f32 = new Float32Array(1),
    u32 = new Uint32Array(f32.buffer),
    bits = (v: number) => {
      f32[0] = v;
      return u32[0];
    };
  if (!count) return { nodes: new Uint32Array(0), order };
  const BINS = 12,
    centre = (i: number, a: number) => (boxes[i * 6 + a] + boxes[i * 6 + a + 3]) / 2,
    area = (b: number[]) => {
      const dx = b[3] - b[0],
        dy = b[4] - b[1],
        dz = b[5] - b[2];
      return dx > 0 || dy > 0 || dz > 0 ? 2 * (dx * dy + dy * dz + dz * dx) : 0;
    },
    empty = () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    grow = (b: number[], i: number) => {
      for (let a = 0; a < 3; a++) {
        b[a] = Math.min(b[a], boxes[i * 6 + a]);
        b[a + 3] = Math.max(b[a + 3], boxes[i * 6 + a + 3]);
      }
    };
  // Each task: node index to fill, range [start, end), depth.
  const tasks: number[][] = [[0, 0, count, 0]];
  nodes.push(0, 0, 0, 0, 0, 0, 0, 0);
  while (tasks.length) {
    const [node, start, end, depth] = tasks.pop()!,
      bounds = empty();
    for (let i = start; i < end; i++) grow(bounds, order[i]);
    const write = (first: number, n: number) => {
      const at = node * 8;
      nodes[at] = bits(bounds[0]);
      nodes[at + 1] = bits(bounds[1]);
      nodes[at + 2] = bits(bounds[2]);
      nodes[at + 3] = first;
      nodes[at + 4] = bits(bounds[3]);
      nodes[at + 5] = bits(bounds[4]);
      nodes[at + 6] = bits(bounds[5]);
      nodes[at + 7] = n;
    };
    const n = end - start;
    if (n <= 2) {
      write(start, n);
      continue;
    }
    // Split axis and position: binned SAH over centroids, or the median of the widest centroid axis.
    const cb = empty();
    for (let i = start; i < end; i++)
      for (let a = 0; a < 3; a++) {
        const c = centre(order[i], a);
        cb[a] = Math.min(cb[a], c);
        cb[a + 3] = Math.max(cb[a + 3], c);
      }
    let axis = 0;
    for (let a = 1; a < 3; a++) if (cb[a + 3] - cb[a] > cb[axis + 3] - cb[axis]) axis = a;
    let mid = start + (n >> 1);
    const extent = cb[axis + 3] - cb[axis];
    const sortRange = () => {
      const part = Array.from(order.subarray(start, end)).sort((a, b) => centre(a, axis) - centre(b, axis));
      order.set(part, start);
    };
    if (extent > 0 && depth < 12) {
      let best = Infinity,
        bestAxis = -1,
        bestBin = -1;
      for (let a = 0; a < 3; a++) {
        const lo = cb[a],
          span = cb[a + 3] - lo;
        if (!(span > 0)) continue;
        const bins = Array.from({ length: BINS }, () => ({ box: empty(), n: 0 }));
        for (let i = start; i < end; i++) {
          const k = Math.min(BINS - 1, Math.floor(((centre(order[i], a) - lo) / span) * BINS));
          bins[k].n++;
          grow(bins[k].box, order[i]);
        }
        for (let s = 1; s < BINS; s++) {
          const left = empty(),
            right = empty();
          let nl = 0,
            nr = 0;
          for (let k = 0; k < s; k++)
            if (bins[k].n) {
              nl += bins[k].n;
              for (let c = 0; c < 3; c++) {
                left[c] = Math.min(left[c], bins[k].box[c]);
                left[c + 3] = Math.max(left[c + 3], bins[k].box[c + 3]);
              }
            }
          for (let k = s; k < BINS; k++)
            if (bins[k].n) {
              nr += bins[k].n;
              for (let c = 0; c < 3; c++) {
                right[c] = Math.min(right[c], bins[k].box[c]);
                right[c + 3] = Math.max(right[c + 3], bins[k].box[c + 3]);
              }
            }
          if (!nl || !nr) continue;
          const cost = nl * area(left) + nr * area(right);
          if (cost < best) {
            best = cost;
            bestAxis = a;
            bestBin = s;
          }
        }
      }
      if (bestAxis >= 0) {
        axis = bestAxis;
        const lo = cb[axis],
          span = cb[axis + 3] - lo,
          threshold = lo + (span * bestBin) / BINS;
        sortRange();
        mid = start;
        while (mid < end && centre(order[mid], axis) < threshold) mid++;
        if (mid === start || mid === end) mid = start + (n >> 1);
      } else sortRange();
    } else sortRange();
    const left = nodes.length / 8;
    nodes.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    write(left, 0);
    tasks.push([left + 1, mid, end, depth + 1], [left, start, mid, depth + 1]);
  }
  return { nodes: Uint32Array.from(nodes), order };
}

/** Builds the sampling tables of an environment map (validated). */
function packEnvironment(map: TraceEnvironmentMap, cache: SceneCache): PackedEnvironment {
  const name = 'scene.environment.map';
  if (!isObject(map)) throw new TypeError(`${where} ${name} must be {width, height, data}`);
  const width = checkNumber(map.width, `${name}.width`, 1, 8192, 'pass the image width in texels'),
    height = checkNumber(map.height, `${name}.height`, 1, 4096, 'pass the image height in texels');
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new RangeError(`${where} ${name} size ${width}x${height} must be whole texels`);
  const data = map.data;
  if (!(data instanceof Float32Array))
    throw new TypeError(`${where} ${name}.data must be a Float32Array of linear RGB(A)`);
  const channels = data.length === width * height * 3 ? 3 : data.length === width * height * 4 ? 4 : 0;
  if (!channels)
    throw new TypeError(`${where} ${name}.data has ${data.length} floats; pass width * height * 3 (RGB) or * 4 (RGBA)`);
  const intensity = optional(map.intensity, 1, `${name}.intensity`, 0, 1e6, 'pass 0 or more'),
    rotation = optional(map.rotation, 0, `${name}.rotation`, -1e6, 1e6, 'pass radians');
  const previous = cache.environment;
  if (previous && previous.width === width && previous.height === height) {
    let same = previous.source.length === data.length;
    for (let i = 0; same && i < data.length; i++) same = Object.is(previous.source[i], data[i]);
    if (same) return { ...previous, intensity, rotation };
  }
  const texels = new Float32Array(width * height * 4),
    marginal = new Float32Array(height),
    conditional = new Float32Array(width * height);
  let total = 0;
  for (let y = 0; y < height; y++) {
    const sin = Math.sin((Math.PI * (y + 0.5)) / height);
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        r = data[i * channels],
        g = data[i * channels + 1],
        b = data[i * channels + 2];
      if (!(r >= 0 && g >= 0 && b >= 0 && r < Infinity && g < Infinity && b < Infinity))
        throw new RangeError(`${where} ${name}.data texel ${x},${y} is negative or not finite; pass linear radiance`);
      const w = luminance(r, g, b) * sin;
      texels.set([r, g, b, w], i * 4);
      row += w;
      conditional[i] = row;
    }
    for (let x = 0; x < width; x++)
      conditional[y * width + x] = row > 0 ? conditional[y * width + x] / row : (x + 1) / width;
    total += row;
    marginal[y] = total;
  }
  for (let y = 0; y < height; y++) marginal[y] = total > 0 ? marginal[y] / total : (y + 1) / height;
  return {
    source: data.slice(),
    width,
    height,
    intensity,
    rotation,
    texels,
    marginal,
    conditional,
    integral: total / (width * height),
  };
}

function resolveEnvironment(environment: TraceEnvironment | undefined, cache: SceneCache): ResolvedEnvironment {
  const name = 'scene.environment';
  if (environment !== undefined && !isObject(environment)) throw new TypeError(`${where} ${name} must be an object`);
  const e: TraceEnvironment = environment ?? {},
    color = (value: unknown, field: string) =>
      value === undefined ? ([1, 1, 1] as TraceVec3) : checkVec3(value, `${name}.${field}`, true, 'pass linear RGB'),
    sky = color(e.skyColor, 'skyColor'),
    skyIntensity = optional(e.skyIntensity, 1, `${name}.skyIntensity`, 0, 1e6, 'pass 0 or more'),
    direction =
      e.sunDirection === undefined
        ? ([0.4, 0.8, 0.3] as TraceVec3)
        : checkVec3(e.sunDirection, `${name}.sunDirection`, false, 'pass a direction toward the sun'),
    length = Math.hypot(...direction);
  if (!(length > 1e-12)) throw new RangeError(`${where} ${name}.sunDirection is zero; pass a direction toward the sun`);
  const sunColor = color(e.sunColor, 'sunColor'),
    sunIntensity = optional(e.sunIntensity, 0, `${name}.sunIntensity`, 0, 1e6, 'pass 0 (no sun) or more'),
    sunAngularSize = optional(e.sunAngularSize, 0.0093, `${name}.sunAngularSize`, 0, 0.5, 'pass 0 to 0.5 radians'),
    ground =
      e.groundColor === undefined
        ? undefined
        : checkVec3(e.groundColor, `${name}.groundColor`, true, 'pass linear RGB'),
    groundHeight = optional(e.groundHeight, 0, `${name}.groundHeight`, -1e9, 1e9, 'pass a finite height');
  const sun = [direction[0] / length, direction[1] / length, direction[2] / length] as TraceVec3;
  let map = e.map === undefined ? undefined : packEnvironment(e.map, cache),
    skyCache: SceneCache['sky'];
  if (e.physicalSky !== undefined) {
    if (e.map !== undefined) throw new TypeError(`${where} ${name} has both map and physicalSky; pass one of them`);
    const p = e.physicalSky;
    if (!isObject(p)) throw new TypeError(`${where} ${name}.physicalSky must be {turbidity?, intensity?}`);
    const turbidity = optional(
        p.turbidity,
        3,
        `${name}.physicalSky.turbidity`,
        1.7,
        10,
        'pass 1.7 (clear) to 10 (hazy)',
      ),
      intensity = optional(p.intensity, 0.1, `${name}.physicalSky.intensity`, 0, 1e6, 'pass 0 or more'),
      key = `${turbidity},${intensity},${sun.join(',')}`;
    skyCache = cache.sky?.key === key ? cache.sky : { key, data: bakeSky(turbidity, sun, intensity) };
    map = packEnvironment({ width: SKY_WIDTH, height: SKY_HEIGHT, data: skyCache.data }, cache);
  }
  return {
    sky: [sky[0] * skyIntensity, sky[1] * skyIntensity, sky[2] * skyIntensity],
    sunDirection: sun,
    sun: [sunColor[0] * sunIntensity, sunColor[1] * sunIntensity, sunColor[2] * sunIntensity],
    sunAngularSize,
    ground: ground && [Math.min(ground[0], 1), Math.min(ground[1], 1), Math.min(ground[2], 1)],
    groundHeight,
    map,
    skyCache,
  };
}

function packLights(list: unknown): { lights: Float32Array; count: number; power: number } {
  if (list === undefined) return { lights: new Float32Array(0), count: 0, power: 0 };
  const lights = checkList<TraceAreaLight>(list, 'lights');
  if (lights.length > MAX_LIGHTS)
    throw new RangeError(`${where} scene.lights has ${lights.length} lights; at most ${MAX_LIGHTS} are supported`);
  const out: number[] = [],
    ids = new Set<string>(),
    weights: number[] = [];
  for (const [i, light] of lights.entries()) {
    const name = `scene.lights[${i}]`;
    if (!isObject(light)) throw new TypeError(`${where} ${name} must be {id, position, edgeU, edgeV}`);
    const id = checkId(light.id, `${name}.id`);
    if (ids.has(id)) throw new TypeError(`${where} ${name}.id '${id}' is used twice; give every light its own id`);
    ids.add(id);
    const p = checkVec3(light.position, `${name}.position`, false, 'pass a world point'),
      u = checkVec3(light.edgeU, `${name}.edgeU`, false, 'pass an edge vector'),
      v = checkVec3(light.edgeV, `${name}.edgeV`, false, 'pass an edge vector'),
      color = light.color === undefined ? [1, 1, 1] : checkVec3(light.color, `${name}.color`, true, 'pass linear RGB'),
      intensity = optional(light.intensity, 1, `${name}.intensity`, 0, 1e6, 'pass 0 or more');
    if (light.twoSided !== undefined && typeof light.twoSided !== 'boolean')
      throw new TypeError(`${where} ${name}.twoSided must be true or false`);
    if (light.visible !== undefined && typeof light.visible !== 'boolean')
      throw new TypeError(`${where} ${name}.visible must be true or false`);
    if (light.opaque !== undefined && typeof light.opaque !== 'boolean')
      throw new TypeError(`${where} ${name}.opaque must be true or false`);
    const opaque = light.opaque !== false;
    const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (!(area > 1e-12)) throw new RangeError(`${where} ${name} has no area (edges zero or parallel); pass two edges`);
    if (light.visible === false) continue;
    const radiance = [color[0] * intensity, color[1] * intensity, color[2] * intensity],
      power = luminance(radiance[0], radiance[1], radiance[2]) * area * (light.twoSided ? 2 : 1);
    // Dark lights stay when they cast shadows (never picked by light sampling).
    if (!(power > 0) && !opaque) continue;
    weights.push(power > 0 ? power : 0);
    out.push(p[0], p[1], p[2], 0, u[0], u[1], u[2], light.twoSided ? 1 : 0, v[0], v[1], v[2], area, ...radiance);
    out.push(opaque ? 1 : 0);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let sum = 0;
  for (let k = 0; k < weights.length; k++) {
    sum += weights[k];
    out[k * 16 + 3] = k === weights.length - 1 || !(total > 0) ? 1 : sum / total;
  }
  return { lights: Float32Array.from(out), count: weights.length, power: total };
}

// Whether the face normals of an instance (rows of its world-to-model transform) are orthogonal, as the shader's
// per-axis mirror and Snell candidates assume (rotation and scale; not shear).
function orthogonalFaces(r: Float64Array): boolean {
  const row = (k: number) => {
    const l = Math.hypot(r[k * 4], r[k * 4 + 1], r[k * 4 + 2]);
    return [r[k * 4] / l, r[k * 4 + 1] / l, r[k * 4 + 2] / l];
  };
  const [a, b, c] = [row(0), row(1), row(2)];
  const dot = (u: number[], v: number[]) => Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
  return dot(a, b) < 1e-6 && dot(b, c) < 1e-6 && dot(a, c) < 1e-6;
}

// Light-sampled deflectors, first MAX_DEFLECTORS of each kind in GPU order: glass instances whose model uses exactly
// one refracting palette index, that one smooth pure glass, that do not move and have orthogonal faces (entry: GPU
// index, IOR); mirror instances whose model has smooth voxels of metalness 1 (entry: GPU index, 0).
function deflectorTable(
  instances: SnapshotInstance[],
  models: readonly PackedModel[],
  table: Float32Array,
): Float32Array {
  const iorOf = models.map((m) => {
    let ior = 0;
    for (let id = 1; id < 256; id++) {
      if (!m.counts[id]) continue;
      const b = id * MATERIAL_FLOATS,
        flags = table[b + 15];
      if (!(flags & VOLUME)) continue; // opaque surfaces and index-matched media do not refract
      if (!(flags & SMOOTH) || table[b + 5] < 0.999 || table[b + 16] > 0 || ior) return 0;
      ior = table[b + 11];
    }
    return ior;
  });
  const mirrors = models.map((m) => {
    for (let id = 1; id < 256; id++) {
      const b = id * MATERIAL_FLOATS;
      if (m.counts[id] && table[b + 15] & SMOOTH && table[b + 4] === 1) return true;
    }
    return false;
  });
  const out: number[] = [];
  let glass = 0,
    mirror = 0;
  for (const [g, v] of instances.entries()) {
    const ior = iorOf[v.model];
    if (ior && !v.previous && orthogonalFaces(v.toLocal) && glass < MAX_DEFLECTORS) {
      v.prism = true;
      glass++;
      out.push(g, ior);
    }
    if (mirrors[v.model] && mirror < MAX_DEFLECTORS) {
      v.mirror = true;
      mirror++;
      out.push(g, 0);
    }
  }
  return Float32Array.from(out);
}

/**
 * Validates `scene` and builds its snapshot. Throws TypeError/RangeError naming the first problem; never changes
 * `cache` unless it succeeds. `maxWords` is the voxel buffer's word limit (the device's storage binding size / 4).
 */
export function buildSnapshot(scene: VoxelTraceScene, cache: SceneCache, maxWords: number): SceneSnapshot {
  if (!isObject(scene)) throw new TypeError(`${where} scene must be {revision, models, instances, materials}`);
  if (typeof scene.revision !== 'number' || !Number.isFinite(scene.revision))
    throw new TypeError(`${where} scene.revision must be a finite number`);
  const models = checkList<TraceModel>(scene.models, 'models'),
    instances = checkList<TraceInstance>(scene.instances, 'instances'),
    materials = checkList<TraceMaterial>(scene.materials, 'materials');
  if (instances.length > MAX_INSTANCES)
    throw new RangeError(`${where} scene.instances has ${instances.length}; at most ${MAX_INSTANCES} are supported`);
  // Materials.
  const table = new Float32Array(256 * MATERIAL_FLOATS);
  for (const [i, m] of materials.entries()) {
    const name = `scene.materials[${i}]`;
    if (!isObject(m)) throw new TypeError(`${where} ${name} must be an object {id, color, type}`);
    if (typeof m.id !== 'number' || !Number.isInteger(m.id))
      throw new TypeError(`${where} ${name}.id must be an integer palette index 1 to 255`);
    if (m.id < 1 || m.id > 255) throw new RangeError(`${where} ${name}.id ${m.id} is outside 1 to 255 (0 is empty)`);
    if (table[m.id * MATERIAL_FLOATS + 15])
      throw new TypeError(`${where} ${name}.id ${m.id} is used twice; give each palette index one material`);
    packMaterial(m, name, table);
  }
  // Models (packed or reused by id, revision and size).
  const packed: PackedModel[] = [],
    modelIndex = new Map<string, number>(),
    reused = new Map<string, PackedModel>();
  for (const [i, model] of models.entries()) {
    const name = `scene.models[${i}]`;
    if (!isObject(model)) throw new TypeError(`${where} ${name} must be {id, revision, size, voxels}`);
    const id = checkId(model.id, `${name}.id`);
    if (modelIndex.has(id))
      throw new TypeError(`${where} ${name}.id '${id}' is used twice; give every model its own id`);
    const previous = cache.models.get(id),
      size = model.size as ArrayLike<number> | undefined;
    let p: PackedModel;
    if (
      previous &&
      previous.revision === model.revision &&
      size?.length === 3 &&
      previous.size.every((v, k) => v === size[k]) &&
      model.voxels instanceof Uint8Array &&
      model.voxels.length === previous.size[0] * previous.size[1] * previous.size[2]
    )
      p = previous;
    else p = packModel(model, name);
    modelIndex.set(id, packed.length);
    packed.push(p);
    reused.set(id, p);
  }
  // Instances.
  const visible: SnapshotInstance[] = [],
    instanceIds = new Set<string>();
  let moving = false;
  for (const [i, instance] of instances.entries()) {
    const name = `scene.instances[${i}]`;
    if (!isObject(instance)) throw new TypeError(`${where} ${name} must be {id, modelId, matrix}`);
    const id = checkId(instance.id, `${name}.id`);
    if (instanceIds.has(id))
      throw new TypeError(`${where} ${name}.id '${id}' is used twice; give every instance its own id`);
    instanceIds.add(id);
    const modelId = checkId(instance.modelId, `${name}.modelId`),
      model = modelIndex.get(modelId);
    if (model === undefined)
      throw new TypeError(
        `${where} ${name}.modelId '${modelId}' names no model of this scene; add the model or fix the id`,
      );
    const toWorld = affineRows(instance.matrix, `${name}.matrix`),
      previous =
        instance.previousMatrix === undefined
          ? undefined
          : affineRows(instance.previousMatrix, `${name}.previousMatrix`);
    if (instance.visible !== undefined && typeof instance.visible !== 'boolean')
      throw new TypeError(`${where} ${name}.visible must be true or false`);
    if (instance.visible === false) continue;
    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]),
      size = packed[model].size;
    growBox(box, toWorld, size);
    if (previous) {
      growBox(box, previous, size);
      moving = true;
    }
    visible.push({
      id,
      source: i,
      model,
      toWorld,
      toLocal: invertRows(toWorld),
      previous,
      box,
      lightPick: 0,
      prism: false,
      mirror: false,
    });
  }
  // Every palette index a model uses needs a material.
  for (const [id, index] of modelIndex) {
    const m = packed[index];
    for (let v = 1; v < 256; v++)
      if (m.counts[v] && !table[v * MATERIAL_FLOATS + 15])
        throw new TypeError(
          `${where} model '${id}' uses palette index ${v} (${m.counts[v]} voxels) but scene.materials has no material with id ${v}; add one`,
        );
  }
  const environment = resolveEnvironment(scene.environment, cache),
    { lights, count: lightCount, power: lightPower } = packLights(scene.lights);
  // Memory: grids and mixed bricks must fit one storage binding.
  let voxelWords = 4;
  for (const m of packed) voxelWords += m.grid.length + m.payload.length;
  if (voxelWords > maxWords)
    throw new RangeError(
      `${where} scene needs ${voxelWords * 4} bytes of voxel bricks; this device binds at most ${maxWords * 4}; use fewer or smaller models`,
    );
  // Hierarchy over the visible instances; GPU order = leaf order.
  const boxes = new Float64Array(visible.length * 6);
  for (const [i, v] of visible.entries()) boxes.set(v.box, i * 6);
  const { nodes, order } = buildHierarchy(boxes, visible.length),
    ordered = Array.from(order, (i) => visible[i]);
  // Emissive faces per model, then instances picked by emitted power times face area.
  const emitters = packed.map((m) => {
    const e = modelEmitters(m, table, cache);
    if (!e) return { faces: new Uint32Array(0), cdf: new Float32Array(0), total: 0 };
    const cdf = new Float32Array(e.faces.length);
    let total = 0;
    for (let k = 0; k < e.faces.length; k++) {
      const b = e.ids[k] * MATERIAL_FLOATS + 8;
      total += luminance(table[b], table[b + 1], table[b + 2]);
      cdf[k] = total;
    }
    for (let k = 0; k < cdf.length; k++) cdf[k] = k === cdf.length - 1 ? 1 : cdf[k] / total;
    return { faces: e.faces, cdf, total };
  });
  const picks: number[] = [],
    weights: number[] = [];
  for (const [g, v] of ordered.entries()) {
    const total = emitters[v.model].total;
    if (!(total > 0)) continue;
    const [ax, ay, az] = faceAreas(v.toWorld);
    picks.push(g);
    weights.push((total * (ax + ay + az)) / 3);
  }
  const sum = weights.reduce((a, b) => a + b, 0),
    emissiveCdf = new Float32Array(weights.length);
  let run = 0;
  for (let k = 0; k < weights.length; k++) {
    run += weights[k];
    emissiveCdf[k] = k === weights.length - 1 ? 1 : run / sum;
    ordered[picks[k]].lightPick = weights[k] / sum;
  }
  // The environment texels and the lights buffer (emissive tables, area lights, environment CDFs) must fit too.
  const env = environment.map,
    faces = emitters.reduce((n, e) => n + e.faces.length, 0),
    lightWords = 4 + picks.length * 2 + faces * 2 + lightCount * 16 + (env ? env.height + env.width * env.height : 0);
  if (env && env.width * env.height * 4 > maxWords)
    throw new RangeError(
      `${where} scene.environment.map ${env.width}x${env.height} needs ${env.width * env.height * 16} bytes; this device binds at most ${maxWords * 4}; pass a smaller map`,
    );
  if (lightWords > maxWords)
    throw new RangeError(
      `${where} scene has ${faces} emissive voxel faces; their tables need ${lightWords * 4} bytes and this device binds at most ${maxWords * 4}; use fewer emissive voxels`,
    );
  // Success: keep the packed models (and only those) and the environment tables for the next scene.
  cache.models = reused;
  if (environment.map) cache.environment = environment.map;
  if (environment.skyCache) cache.sky = environment.skyCache;
  return {
    revision: scene.revision,
    models: packed,
    modelIndex,
    instances: ordered,
    nodes,
    materials: table,
    environment,
    lights,
    lightCount,
    lightPower,
    emitters,
    emissiveInstances: Uint32Array.from(picks),
    emissiveCdf,
    moving,
    deflectors: deflectorTable(ordered, packed, table),
    voxelWords,
  };
}

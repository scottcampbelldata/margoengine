import { trackSpecLayer } from './spec-hooks.js';
import { Geometry, PbrMaterial, type Mesh, type PbrMaterialOptions } from '@margoengine/core';
import { boxGeometry, coneGeometry, cylinderGeometry, sphereGeometry } from '@margoengine/geometry/primitives';
import { decomposeAffine } from '@margoengine/math/affine';
import { fault, rangeError } from '../../shared/errors.js';
import { imageGrid, type AnalysisGrid, type AnalysisImage } from './clip.js';
import type { Figure } from './figure.js';
import type { TriangleSet } from './grids.js';
import type { Bounds } from './layer.js';
import type { PipelineOperator } from './pipeline.js';
import { checkComplex } from './cell-complex.js';

/** Point table; column arrays contain flat interleaved tuples. Grids additionally support cell association. */
export interface GlyphTable {
  readonly points: ArrayLike<number>;
  readonly pointArrays?: Readonly<Record<string, ArrayLike<number>>>;
  readonly pointData?: ArrayLike<number>;
}
/** Explicit grid, regular/curvilinear image or point table. */
export type GlyphInput = GlyphTable | AnalysisImage;
/** Named associated array or a directly supplied tuple array. Empty name selects the default scalar. */
export type GlyphArray = string | ArrayLike<number>;
/** Reusable glyph source. Built-ins point along +X; a custom Geometry uses its own origin and +X axis. */
export type GlyphShape = 'arrow' | 'cone' | 'sphere' | 'cube' | 'line' | Geometry;
/** Selection, orientation and scaling; all defaults are independent of dataset size. */
export interface GlyphOptions {
  readonly association?: 'point' | 'cell';
  readonly vectors?: GlyphArray;
  readonly scalars?: GlyphArray;
  /** none by default; scalar uses scalars, magnitude/components use vectors. */
  readonly scaleMode?: 'none' | 'scalar' | 'magnitude' | 'components';
  readonly scaleFactor?: number;
  readonly stride?: number;
  /** Zero excludes a sample; nonzero includes it. Applied after stride in original sample order. */
  readonly mask?: ArrayLike<number>;
  readonly shape?: GlyphShape;
  readonly material?: PbrMaterialOptions;
  readonly signal?: AbortSignal;
}
/** Owned compact instance attributes. ids map each rendered instance to its original point/cell row. */
export interface GlyphInstances {
  readonly positions: Float32Array;
  readonly quaternions: Float32Array;
  readonly scales: Float32Array;
  readonly ids: Uint32Array;
}
/** Warp preserves caller topology/attributes and replaces coordinates; scaleFactor defaults to 1. */
export interface WarpOptions {
  readonly scaleFactor?: number;
  readonly signal?: AbortSignal;
  /** Scalar warp uses these normals, otherwise surface normals, otherwise direction. */
  readonly normals?: GlyphArray;
  /** Constant scalar-warp direction, used without normals. Default [0,0,1]. Not normalized. */
  readonly direction?: readonly [number, number, number];
}
/** Grids use points; triangulated surfaces use positions and retain values/cell provenance. */
export type WarpInput = AnalysisGrid | AnalysisImage | TriangleSet;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const finite = (v: number) => typeof v === 'number' && Number.isFinite(v) && Number.isFinite(Math.fround(v));
const bad = (message: string): never => {
  throw rangeError(`Glyphs and warp: ${message}`, 'sciviz');
};
const grid = (input: GlyphTable): input is AnalysisGrid => 'types' in input;
function data(
  input: GlyphTable,
  selection: GlyphArray | undefined,
  cell: boolean,
  width: number,
  count: number,
): ArrayLike<number> | undefined {
  if (selection === undefined) return undefined;
  const array =
    typeof selection === 'string'
      ? selection === ''
        ? cell
          ? (input as AnalysisGrid).cellData
          : input.pointData
        : (cell ? (input as AnalysisGrid).cellArrays : input.pointArrays)?.[selection]
      : selection;
  if (!array || array.length !== count * width || Array.from(array).some((v) => !finite(v)))
    bad(`select a finite ${width}-component ${cell ? 'cell' : 'point'} array`);
  return array;
}
function validate(input: GlyphTable): void {
  if (
    !input?.points ||
    input.points.length % 3 ||
    input.points.length / 3 > 1_000_000 ||
    Array.from(input.points).some((v) => !finite(v))
  )
    bad('provide finite xyz points, up to 1000000 rows');
  if (grid(input)) checkComplex(input, true);
}

/** Snapshot selected rows, orient +X along vectors and produce compact instance tuples without allocating GPU resources. */
export async function prepareGlyphs(raw: GlyphInput, options: GlyphOptions = {}): Promise<GlyphInstances> {
  options.signal?.throwIfAborted();
  const input = 'dims' in raw ? imageGrid(raw) : raw;
  validate(input);
  const cell = options.association === 'cell';
  if ((options.association !== undefined && !['point', 'cell'].includes(options.association)) || (cell && !grid(input)))
    bad('cell association needs a grid');
  const count = cell ? (input as AnalysisGrid).types.length : input.points.length / 3,
    stride = options.stride ?? 1,
    factor = options.scaleFactor ?? 1,
    mode = options.scaleMode ?? 'none';
  if (
    !Number.isSafeInteger(stride) ||
    stride < 1 ||
    !finite(factor) ||
    !['none', 'scalar', 'magnitude', 'components'].includes(mode)
  )
    bad('stride must be a positive integer, scaleFactor finite and scaleMode valid');
  if (options.mask && (options.mask.length !== count || Array.from(options.mask).some((v) => !finite(v))))
    bad('mask must contain one finite value per associated row');
  const vectors = data(input, options.vectors, cell, 3, count),
    scalars = data(input, options.scalars, cell, 1, count);
  if (((mode === 'magnitude' || mode === 'components') && !vectors) || (mode === 'scalar' && !scalars))
    bad('the selected scale mode needs its vector or scalar array');
  // Snapshot before the first yield, including directly supplied arrays and masks.
  const points = Float32Array.from(input.points),
    v = vectors ? Float32Array.from(vectors) : undefined,
    s = scalars ? Float32Array.from(scalars) : undefined,
    mask = options.mask ? Float32Array.from(options.mask) : undefined;
  const connectivity = cell ? Uint32Array.from((input as AnalysisGrid).connectivity) : undefined,
    offsets = cell ? Uint32Array.from((input as AnalysisGrid).offsets) : undefined;
  const positions: number[] = [],
    quaternions: number[] = [],
    scales: number[] = [],
    ids: number[] = [];
  for (let start = 0; start < count; start += 4096) {
    await pause();
    options.signal?.throwIfAborted();
    for (let i = Math.ceil(start / stride) * stride; i < Math.min(count, start + 4096); i += stride) {
      if (mask && mask[i] === 0) continue;
      const vector = v ? Array.from(v.subarray(i * 3, i * 3 + 3)) : [1, 0, 0],
        length = Math.hypot(...vector),
        scale = [0, 1, 2].map(
          (k) =>
            factor *
            (mode === 'scalar' ? s![i] : mode === 'magnitude' ? length : mode === 'components' ? vector[k] : 1),
        );
      if (scale.some((x) => x === 0)) continue;
      if (scale.some((x) => !finite(x))) bad('scaled glyph exceeds finite float32');
      let q = [0, 0, 0, 1];
      if (length) {
        const [x, y, z] = vector.map((x) => x / length),
          perp = Math.hypot(y, z),
          angle = Math.atan2(perp, x) / 2;
        q = perp
          ? [0, (-z / perp) * Math.sin(angle), (y / perp) * Math.sin(angle), Math.cos(angle)]
          : x < 0
            ? [0, 1, 0, 0]
            : q;
      }
      const position = [0, 0, 0];
      if (cell) {
        const a = i ? offsets![i - 1] : 0,
          b = offsets![i];
        for (let k = a; k < b; k++)
          for (let axis = 0; axis < 3; axis++) position[axis] += points[connectivity![k] * 3 + axis] / (b - a);
      } else for (let k = 0; k < 3; k++) position[k] = points[3 * i + k];
      positions.push(...position);
      quaternions.push(...q);
      scales.push(...scale);
      ids.push(i);
    }
  }
  return {
    positions: Float32Array.from(positions),
    quaternions: Float32Array.from(quaternions),
    scales: Float32Array.from(scales),
    ids: Uint32Array.from(ids),
  };
}

function geometry(shape: GlyphShape): Geometry {
  if (shape instanceof Geometry) return shape;
  if (!['arrow', 'cone', 'sphere', 'cube', 'line'].includes(shape))
    bad('unknown glyph shape; use a built-in or core Geometry');
  if (shape === 'sphere') {
    const s = sphereGeometry(0.5, 16, 8);
    return new Geometry(s.positions, s.normals, s.indices);
  }
  if (shape === 'cube') {
    const s = boxGeometry(1, 1, 1);
    return new Geometry(s.positions, s.normals, s.indices);
  }
  const parts =
    shape === 'arrow'
      ? [
          { g: cylinderGeometry(0.035, 0.035, 0.7, 12), at: 0.35 },
          { g: coneGeometry(0.12, 0.3, 12), at: 0.85 },
        ]
      : [{ g: shape === 'cone' ? coneGeometry(0.2, 1, 16) : cylinderGeometry(0.006, 0.006, 1, 6), at: 0.5 }];
  const p: number[] = [],
    n: number[] = [],
    indices: number[] = [];
  for (const { g, at } of parts) {
    const base = p.length / 3;
    for (let k = 0; k < g.positions.length; k += 3) {
      p.push(g.positions[k + 1] + at, -g.positions[k], g.positions[k + 2]);
      n.push(g.normals[k + 1], -g.normals[k], g.normals[k + 2]);
    }
    for (const id of g.indices) indices.push(base + id);
  }
  return new Geometry(p, n, indices);
}

/** Figure-owned, automatically batched core instances sharing one Geometry and material. */
export class GlyphLayer {
  readonly bounds: Bounds;
  readonly instances: GlyphInstances;
  readonly geometry: Geometry;
  readonly meshes: readonly Mesh[];
  #root: Mesh;
  #figure: Figure;
  #disposed = false;
  /** Prefer glyphLayer; constructor accepts a prepared snapshot for deterministic reuse. */
  constructor(figure: Figure, instances: GlyphInstances, options: GlyphOptions = {}) {
    this.#figure = figure;
    this.instances = instances;
    this.geometry = geometry(options.shape ?? 'arrow');
    const count = instances.ids.length;
    if (
      instances.positions.length !== count * 3 ||
      instances.quaternions.length !== count * 4 ||
      instances.scales.length !== count * 3 ||
      [instances.positions, instances.quaternions, instances.scales].some((a) =>
        Array.from(a).some((v) => !finite(v)),
      ) ||
      instances.scales.some((v) => v === 0)
    )
      bad('invalid prepared instance tuples');
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity],
      local = this.geometry.bounds;
    for (let i = 0; i < count; i++) {
      const radius =
        (Math.hypot(local[0], local[1], local[2]) + local[3]) *
        Math.max(...instances.scales.subarray(3 * i, 3 * i + 3).map(Math.abs));
      for (let k = 0; k < 3; k++) {
        const x = instances.positions[3 * i + k];
        b[k * 2] = Math.min(b[k * 2], x - radius);
        b[k * 2 + 1] = Math.max(b[k * 2 + 1], x + radius);
      }
    }
    this.bounds = (count ? b : [0, 0, 0, 0, 0, 0]) as Bounds;
    if (!this.bounds.every(finite)) bad('instance bounds exceed finite float32; rescale data or glyphs');
    const material = new PbrMaterial(options.material ?? { color: '#35c6d5', roughness: 0.65 }),
      owned: Mesh[] = [];
    this.#root = figure.engine.createMesh();
    try {
      for (let i = 0; i < count; i++) {
        const mesh = figure.engine.createMesh(this.#root);
        owned.push(mesh);
        mesh.name = `glyph:${instances.ids[i]}`;
        mesh.setPosition(Array.from(instances.positions.subarray(3 * i, 3 * i + 3)) as [number, number, number]);
        mesh.setQuaternion(Array.from(instances.quaternions.subarray(4 * i, 4 * i + 4)));
        mesh.setScale(Array.from(instances.scales.subarray(3 * i, 3 * i + 3)) as [number, number, number]);
        mesh.setMaterial(material);
        mesh.setGeometry(this.geometry);
      }
    } catch (error) {
      for (const mesh of owned.reverse()) mesh.dispose();
      this.#root.dispose();
      throw error;
    }
    this.meshes = owned;
  }
  /** Applies a lossless affine TRS, including reflections. Figure calls this whenever its bounds change. */
  setModel(model: Float32Array): void {
    if (this.#disposed) throw fault('disposed', 'Glyph layer disposed; create a new layer', 'sciviz');
    const trs = decomposeAffine(model);
    if (!trs.lossless || trs.scale.some((x) => x === 0)) bad('model must be a finite invertible affine TRS');
    this.#root.setPosition(trs.translation);
    this.#root.setQuaternion(trs.rotation);
    this.#root.setScale(trs.scale);
  }
  /** Idempotently removes only these instances; borrowed custom geometry and the figure stay usable. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const mesh of this.meshes) mesh.dispose();
    this.#root.dispose();
    this.#figure.remove(this);
  }
  /** Supports using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Create an instanced layer, with stride/masking and vector orientation, at grid points, cells or table rows. */
export async function glyphLayer(figure: Figure, input: GlyphInput, options: GlyphOptions = {}): Promise<GlyphLayer> {
  const instances = await prepareGlyphs(input, options);
  options.signal?.throwIfAborted();
  const layer = new GlyphLayer(figure, instances, options);
  try {
    return trackSpecLayer(figure, 'glyph', [input, options], figure.addLayer(layer));
  } catch (error) {
    layer.dispose();
    throw error;
  }
}

async function warp<T extends WarpInput>(
  input: T,
  array: GlyphArray,
  options: WarpOptions,
  scalar: boolean,
): Promise<T> {
  options.signal?.throwIfAborted();
  if ('dims' in input) {
    const result = await warp(imageGrid(input), array, options, scalar);
    return { ...input, points: result.points };
  }
  const isGrid = 'points' in input,
    coords = isGrid ? input.points : input.positions,
    np = coords.length / 3;
  const table: GlyphTable = isGrid ? input : { points: coords, pointData: input.values };
  validate(table);
  if (
    !isGrid &&
    (np % 3 || input.values.length !== np || input.normals.length !== coords.length || input.cells.length !== np / 3)
  )
    bad('surface needs xyz triangles, matching normals/values and one cell ID per triangle');
  const values = Float64Array.from(data(table, array, false, scalar ? 1 : 3, np)!),
    factor = options.scaleFactor ?? 1;
  if (!finite(factor)) bad('warp scaleFactor must be finite float32');
  const normal = scalar
      ? options.normals === undefined
        ? isGrid
          ? undefined
          : Float64Array.from(input.normals)
        : Float64Array.from(data(table, options.normals, false, 3, np)!)
      : undefined,
    direction = options.direction ?? [0, 0, 1];
  if (
    direction.length !== 3 ||
    !direction.every(finite) ||
    (normal && (normal.length !== coords.length || normal.some((x) => !finite(x))))
  )
    bad('scalar warp needs finite xyz normals or direction');
  const source = Float64Array.from(coords),
    positions = new Float64Array(coords.length);
  for (let start = 0; start < np; start += 4096) {
    await pause();
    options.signal?.throwIfAborted();
    for (let i = start; i < Math.min(np, start + 4096); i++)
      for (let k = 0; k < 3; k++) {
        const v =
          source[3 * i + k] +
          factor * (scalar ? values[i] * (normal ? normal[3 * i + k] : direction[k]) : values[3 * i + k]);
        if (!finite(v)) bad('warped position exceeds finite float32');
        positions[3 * i + k] = v;
      }
  }
  if (isGrid) return { ...input, points: positions };
  if (np % 3) bad('triangle surface must contain three vertices per triangle');
  const normals = new Float32Array(coords.length),
    bounds: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < np; i++) {
    for (let k = 0; k < 3; k++) {
      bounds[k * 2] = Math.min(bounds[k * 2], positions[3 * i + k]);
      bounds[k * 2 + 1] = Math.max(bounds[k * 2 + 1], positions[3 * i + k]);
    }
  }
  for (let i = 0; i < positions.length; i += 9) {
    const a = [0, 1, 2].map((k) => positions[i + 3 + k] - positions[i + k]),
      b = [0, 1, 2].map((k) => positions[i + 6 + k] - positions[i + k]),
      n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      length = Math.hypot(...n);
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) normals[i + 3 * v + k] = length ? n[k] / length : 0;
  }
  return { ...input, positions: Float32Array.from(positions), normals, bounds: np ? bounds : [0, 0, 0, 0, 0, 0] };
}
/** Displace each point by scaleFactor times its xyz vector, preserving topology and data arrays. */
export function warpByVector<T extends WarpInput>(
  input: T,
  vectors: GlyphArray,
  options: WarpOptions = {},
): Promise<T> {
  return warp(input, vectors, options, false);
}
/** Displace by scalar times point normal or constant direction; surface output normals are rebuilt. */
export function warpByScalar<T extends WarpInput>(
  input: T,
  scalars: GlyphArray,
  options: WarpOptions = {},
): Promise<T> {
  return warp(input, scalars, options, true);
}
/** Pipeline warp params: kind vector/scalar, array name, scaleFactor and optional direction. */
export function warpOperator(): PipelineOperator {
  return {
    kind: 'filter',
    execute: (context) => {
      const p = context.params as unknown as {
        kind: 'vector' | 'scalar';
        array: string;
        scaleFactor?: number;
        direction?: [number, number, number];
      };
      if (!p || !['vector', 'scalar'].includes(p.kind) || typeof p.array !== 'string')
        bad('warp pipeline params need kind and array');
      return warp(
        context.inputs[0] as WarpInput,
        p.array,
        { scaleFactor: p.scaleFactor, direction: p.direction, signal: context.signal },
        p.kind === 'scalar',
      );
    },
  };
}
/** Pipeline layer with figure ownership. Params are serializable GlyphOptions; custom Geometry can be a second input. */
export function glyphOperator(figure: Figure): PipelineOperator {
  return {
    kind: 'layer',
    execute: (context) =>
      glyphLayer(figure, context.inputs[0] as GlyphInput, {
        ...(context.params as GlyphOptions),
        shape: (context.inputs[1] as Geometry | undefined) ?? (context.params as GlyphOptions)?.shape,
        signal: context.signal,
      }),
    release: (output) => figure.remove(output as GlyphLayer),
  };
}

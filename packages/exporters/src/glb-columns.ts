// Accessor data on its way between a GLB and the passes that rewrite it (meshopt, optimize): read, reorder, pack, and the
// accessors nothing reads any more removed.
import { readAccessor, type AccessorValues, type GLBParts } from './glb.js';
import type { JSONObject } from './glb-pack.js';

export const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPES: Record<number, string> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 9: 'MAT3', 16: 'MAT4' };

/** One accessor's data on its way to a new buffer view. */
export interface Column {
  values: AccessorValues['values'];
  width: number;
  componentType: number;
  normalized: boolean;
  /** The accessor's type name, which a width alone cannot say for MAT2 and VEC4. */
  type: string;
  /** Keeps its min and max, which every POSITION and every animation input must have. */
  bounds: boolean;
}

export const columnOf = (parts: GLBParts, json: JSONObject, index: number, bounds: boolean): Column => {
  const { values, width, componentType, normalized } = readAccessor(parts, index);
  return { values, width, componentType, normalized, type: json.accessors[index].type ?? TYPES[width], bounds };
};

export const elementsOf = (column: Column): number => column.values.length / column.width;

/** Column `column` with vertex `v` at position `remap[v]`. */
export function reordered(column: Column, remap: Uint32Array): Column {
  const { values, width } = column,
    out = new (values.constructor as new (length: number) => Column['values'])(values.length);
  for (let v = 0; v < remap.length; v++)
    for (let c = 0; c < width; c++) out[remap[v] * width + c] = values[v * width + c];
  return { ...column, values: out };
}

/** The column's elements as bytes, each padded to `stride`. */
export function packed({ values, width, componentType }: Column, stride: number): Uint8Array {
  const element = width * SIZES[componentType],
    count = values.length / width,
    source = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  if (stride === element) return source;
  const out = new Uint8Array(count * stride);
  for (let i = 0; i < count; i++) out.set(source.subarray(i * element, (i + 1) * element), i * stride);
  return out;
}

/** Column `column` with only the elements `keep` names, in that order. */
export function gathered(column: Column, keep: readonly number[]): Column {
  const { values, width } = column,
    out = new (values.constructor as new (length: number) => Column['values'])(keep.length * width);
  keep.forEach((element, at) => {
    for (let c = 0; c < width; c++) out[at * width + c] = values[element * width + c];
  });
  return { ...column, values: out };
}

/** Keeps only the vertices `indices` uses and numbers them in order of first use. */
export function compacted(columns: Map<string, Column>, indices: Uint32Array): Uint32Array {
  const first = columns.values().next().value as Column,
    remap = new Uint32Array(elementsOf(first)).fill(0xffffffff),
    kept: number[] = [],
    out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    if (remap[indices[i]] === 0xffffffff) {
      remap[indices[i]] = kept.length;
      kept.push(indices[i]);
    }
    out[i] = remap[indices[i]];
  }
  for (const [name, column] of columns) columns.set(name, gathered(column, kept));
  return out;
}

/** Removes accessors nothing reads any more and renumbers the rest. */
export function dropUnreadAccessors(json: JSONObject): void {
  const used = new Set<number>(),
    references: [JSONObject, string][] = [],
    note = (holder: JSONObject, key: string): void => {
      if (!Number.isSafeInteger(holder?.[key])) return;
      used.add(holder[key]);
      references.push([holder, key]);
    };
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      note(primitive, 'indices');
      for (const key of Object.keys(primitive.attributes ?? {})) note(primitive.attributes, key);
      for (const target of primitive.targets ?? []) for (const key of Object.keys(target)) note(target, key);
    }
  for (const skin of json.skins ?? []) note(skin, 'inverseBindMatrices');
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      note(sampler, 'input');
      note(sampler, 'output');
    }
  // Any extension may hold an accessor, by the same rule the Draco pass reads: an `attributes` table or a field named for one.
  const scan = (value: unknown, inExtension: boolean): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, field] of Object.entries(value)) {
      if (key === 'KHR_draco_mesh_compression') continue;
      if (inExtension && key === 'attributes' && typeof field === 'object' && field)
        for (const name of Object.keys(field)) note(field, name);
      else if (inExtension && /accessor/i.test(key)) note(value as JSONObject, key);
      scan(field, inExtension || key === 'extensions');
    }
  };
  for (const name of Object.keys(json)) if (name !== 'accessors' && name !== 'bufferViews') scan(json[name], false);
  const renumbered = new Map<number, number>(),
    kept: JSONObject[] = [];
  (json.accessors as JSONObject[]).forEach((accessor, index) => {
    if (!used.has(index)) return;
    renumbered.set(index, kept.length);
    kept.push(accessor);
  });
  json.accessors = kept;
  for (const [holder, key] of references) holder[key] = renumbered.get(holder[key]);
}

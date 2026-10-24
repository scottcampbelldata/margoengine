// Shared COLLADA reading helpers: element lookup, number lists, sources, transform stacks and the Y-up meter
// conversion. Internal to the loaders package.
import { invertMatrix } from '@margoengine/math/mat4';
import { LoaderError } from './types.js';
import type { XMLElement } from './xml.js';

export const F = 'DAE';

export const kid = (e: XMLElement | undefined, name: string): XMLElement | undefined =>
  e?.children.find((c) => c.name === name);
export const kids = (e: XMLElement | undefined, name: string): XMLElement[] =>
  e?.children.filter((c) => c.name === name) ?? [];
export const ref = (url: string | undefined): string => (url?.startsWith('#') ? url.slice(1) : (url ?? ''));

export function numbers(text: string, what: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/),
    out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const value = Number(parts[i]);
    if (Number.isNaN(value) && !/^[+-]?nan$/i.test(parts[i]))
      throw new LoaderError(F, 'syntax', `${what} has the invalid number "${parts[i].slice(0, 32)}"`);
    out[i] = value;
  }
  return out;
}

export function integer(value: string | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new LoaderError(F, 'syntax', `${what} must be a non-negative integer, got "${value.slice(0, 32)}"`);
  return number;
}

/** A `<source>`: its float array (or name/IDREF tokens) read through the accessor. */
export interface Source {
  id: string;
  data: number[];
  /** Tokens of a `Name_array` or `IDREF_array`. */
  names?: string[];
  /** The array element: `float_array`, `Name_array`, `IDREF_array` or `int_array`. */
  kind: string;
  stride: number;
  offset: number;
  count: number;
  /** Offset inside a stride of each named `<param>`. */
  params: number[];
}

const ARRAYS = ['float_array', 'Name_array', 'IDREF_array', 'int_array'];

/** Reads a source; `names` allows `Name_array` and `IDREF_array` (else only number arrays are accepted). */
export function readSource(e: XMLElement, ids: Map<string, XMLElement>, names = false): Source {
  const id = e.attributes.id ?? '',
    accessor = kid(kid(e, 'technique_common'), 'accessor'),
    linked = ids.get(ref(accessor?.attributes.source)),
    array = linked && ARRAYS.includes(linked.name) ? linked : e.children.find((c) => ARRAYS.includes(c.name)),
    text = array?.name === 'Name_array' || array?.name === 'IDREF_array';
  if (!accessor || !array || (text && !names))
    throw new LoaderError(F, 'syntax', `source "${id}" has no ${names ? 'array' : 'float_array'} with an accessor`);
  const tokens = text ? array.text.trim().split(/\s+/).filter(Boolean) : undefined,
    data = text ? [] : numbers(array.text, `${array.name} of source "${id}"`),
    length = tokens ? tokens.length : data.length,
    count = integer(accessor.attributes.count, 0, `accessor count of source "${id}"`),
    stride = integer(accessor.attributes.stride, 1, `accessor stride of source "${id}"`),
    offset = integer(accessor.attributes.offset, 0, `accessor offset of source "${id}"`),
    declared = kids(accessor, 'param'),
    params: number[] = [];
  declared.forEach((p, i) => p.attributes.name !== undefined && params.push(i));
  if (!declared.length) for (let i = 0; i < stride; i++) params.push(i);
  if (count && offset + (count - 1) * stride + Math.max(1, ...params.map((p) => p + 1)) > length)
    throw new LoaderError(
      F,
      'truncated',
      `source "${id}" declares ${count} x ${stride} values but its array holds ${length}`,
    );
  const source: Source = { id, data, stride, offset, count, params, kind: array.name };
  if (tokens) source.names = tokens;
  return source;
}

/** `width` consecutive values of element `index` of a source, from the start of its stride. */
export function block(source: Source, index: number, width: number): number[] {
  const at = source.offset + index * source.stride;
  if (at + width > source.data.length)
    throw new LoaderError(F, 'truncated', `source "${source.id}" element ${index} needs ${width} values`);
  return source.data.slice(at, at + width);
}

/** The sources of a `<skin>`, `<morph>` or `<animation>` by id, read lazily. */
export function sourcesOf(
  e: XMLElement,
  ids: Map<string, XMLElement>,
  what: string,
): (url: string | undefined) => Source {
  const cache = new Map<string, Source>();
  return (url) => {
    const id = ref(url);
    let source = cache.get(id);
    if (!source) {
      const element = kids(e, 'source').find((s) => s.attributes.id === id) ?? ids.get(id);
      if (element?.name !== 'source') throw new LoaderError(F, 'syntax', `${what} input names no source "${id}"`);
      cache.set(id, (source = readSource(element, ids, true)));
    }
    return source;
  };
}

export type Matrix = number[];
export const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major a * b. */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Matrix {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  return out;
}

/** Column-major matrix from 16 row-major values (COLLADA writes matrices row by row). */
export const fromRows = (rows: ArrayLike<number>): Matrix =>
  Array.from({ length: 16 }, (_, i) => rows[(i % 4) * 4 + Math.floor(i / 4)]);

/** Column-major inverse, or undefined when singular. */
export function invert(m: ArrayLike<number>): Matrix | undefined {
  const out = invertMatrix(m, new Array<number>(16));
  return out ?? undefined;
}

/** One element of a node's transform stack, as written (the file's axes and units). */
export interface DAETransform {
  type: 'matrix' | 'translate' | 'rotate' | 'scale' | 'lookat' | 'skew';
  /** The element's `sid`, which animation channels address. */
  sid?: string;
  /** The numbers as written: 16 row-major for `matrix`, xyz for translate and scale, axis and degrees for rotate. */
  values: number[];
}

export const TRANSFORM_SIZES = { matrix: 16, translate: 3, rotate: 4, scale: 3, lookat: 9, skew: 7 } as const;

/** The stack in document order, each element post-multiplying; `lookat` and `skew` are skipped. */
export function stackMatrix(transforms: readonly DAETransform[]): Matrix {
  let m = IDENTITY;
  for (const { type, values: v } of transforms)
    if (type === 'matrix') m = multiply(m, fromRows(v));
    else if (type === 'translate') m = multiply(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1]);
    else if (type === 'scale') m = multiply(m, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]);
    else if (type === 'rotate') {
      const length = Math.hypot(v[0], v[1], v[2]);
      if (!length) continue;
      const x = v[0] / length,
        y = v[1] / length,
        z = v[2] / length,
        angle = (v[3] * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle),
        t = 1 - c;
      m = multiply(m, [
        t * x * x + c,
        t * x * y + s * z,
        t * x * z - s * y,
        0,
        t * x * y - s * z,
        t * y * y + c,
        t * y * z + s * x,
        0,
        t * x * z + s * y,
        t * y * z - s * x,
        t * z * z + c,
        0,
        0,
        0,
        0,
        1,
      ]);
    }
  return m;
}

export const AXES = {
  Y_UP: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  // Row-major rotations taking the file's axes to Y-up (COLLADA 1.4.1 up_axis table).
  Z_UP: [1, 0, 0, 0, 0, 1, 0, -1, 0],
  X_UP: [0, -1, 0, 1, 0, 0, 0, 0, 1],
} as const;

/**
 * M' = C M C^-1 with C = meter * R: rotations keep their axes in Y-up, translations scale to meters. The same
 * conversion serves node transforms, bind shape and inverse bind matrices, so skinning stays consistent.
 */
export function converter(upAxis: keyof typeof AXES, meter: number): (m: ArrayLike<number>) => Matrix {
  const axis = AXES[upAxis],
    C: Matrix = [...IDENTITY],
    inverse: Matrix = [...IDENTITY];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      C[c * 4 + r] = meter * axis[r * 3 + c];
      inverse[r * 4 + c] = axis[r * 3 + c] / meter;
    }
  return (m) => multiply(multiply(C, m), inverse);
}

/** Cofactors of a column-major matrix's 3x3 part (the inverse transpose times the determinant), and the determinant. */
export function cofactors(m: ArrayLike<number>): { n: number[]; determinant: number } {
  const n = [
    m[5] * m[10] - m[6] * m[9],
    m[6] * m[8] - m[4] * m[10],
    m[4] * m[9] - m[5] * m[8],
    m[2] * m[9] - m[1] * m[10],
    m[0] * m[10] - m[2] * m[8],
    m[1] * m[8] - m[0] * m[9],
    m[1] * m[6] - m[2] * m[5],
    m[2] * m[4] - m[0] * m[6],
    m[0] * m[5] - m[1] * m[4],
  ];
  return { n, determinant: m[0] * n[0] + m[1] * n[1] + m[2] * n[2] };
}

/**
 * Transforms xyz points (and normals) by a column-major matrix into `out` arrays at `at`; normals use the cofactor
 * matrix, renormalised, with the determinant's sign removed.
 */
export function transformInto(
  m: ArrayLike<number>,
  positions: ArrayLike<number>,
  normals: ArrayLike<number> | undefined,
  i: number,
  outPositions: Float32Array,
  outNormals: Float32Array | undefined,
  at: number,
  co = cofactors(m),
): void {
  const x = positions[i],
    y = positions[i + 1],
    z = positions[i + 2];
  for (let r = 0; r < 3; r++) outPositions[at + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
  if (!normals || !outNormals) return;
  const { n, determinant } = co,
    a = normals[i],
    b = normals[i + 1],
    c = normals[i + 2];
  let nx = n[0] * a + n[3] * b + n[6] * c,
    ny = n[1] * a + n[4] * b + n[7] * c,
    nz = n[2] * a + n[5] * b + n[8] * c;
  // Cofactors carry the determinant's sign; the normal transform (inverse transpose) does not.
  const length = (Math.hypot(nx, ny, nz) || 1) * Math.sign(determinant || 1);
  nx /= length;
  ny /= length;
  nz /= length;
  outNormals[at] = nx;
  outNormals[at + 1] = ny;
  outNormals[at + 2] = nz;
}

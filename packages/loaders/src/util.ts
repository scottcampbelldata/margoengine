import {LoaderError, type ParseLimits} from './types.js';

export const DEFAULT_MAX_VERTICES = 8_000_000;
export const DEFAULT_MAX_TRIANGLES = 16_000_000;

/** Input accepted by every parser. */
export type BinaryInput = ArrayBuffer | ArrayBufferView;

export function toBytes(input: BinaryInput, format: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new LoaderError(format, 'range', 'expected an ArrayBuffer or Uint8Array');
}

export interface Limits {maxVertices: number; maxTriangles: number}
export function limits(options: ParseLimits | undefined, format: string): Limits {
  const check = (value: number | undefined, fallback: number, label: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0) throw new LoaderError(format, 'range', `${label} must be a non-negative integer`);
    return value;
  };
  return {maxVertices: check(options?.maxVertices, DEFAULT_MAX_VERTICES, 'maxVertices'), maxTriangles: check(options?.maxTriangles, DEFAULT_MAX_TRIANGLES, 'maxTriangles')};
}

export function checkCount(value: number, max: number, format: string, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new LoaderError(format, 'header', `invalid ${label} count ${value}`);
  if (value > max) throw new LoaderError(format, 'limit', `${label} count ${value} exceeds the limit of ${max}`);
  return value;
}

/** Decodes bytes one-to-one into UTF-16 code units, so string offsets equal byte offsets. */
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let text = '';
  for (let i = start; i < end; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 0x8000)) as unknown as number[]);
  return text;
}

/** Returns the offset of the next line feed at or after `from`, searching up to `limit`, or -1. */
export function findLineEnd(bytes: Uint8Array, from: number, limit: number): number {
  const end = Math.min(bytes.length, limit);
  for (let i = from; i < end; i++) if (bytes[i] === 10) return i;
  return -1;
}

const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);

/** Whitespace token scanner over text decoded with `latin1`. */
export class TextScanner {
  pos: number;
  constructor(readonly text: string, readonly format: string, start = 0) {this.pos = start;}
  skipSpace(): void {
    const text = this.text;
    let pos = this.pos;
    while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
    this.pos = pos;
  }
  get done(): boolean {this.skipSpace(); return this.pos >= this.text.length;}
  token(): string | null {
    this.skipSpace();
    const text = this.text, start = this.pos;
    if (start >= text.length) return null;
    let pos = start;
    while (pos < text.length && !isSpace(text.charCodeAt(pos))) pos++;
    this.pos = pos;
    return text.slice(start, pos);
  }
  number(what: string): number {
    const token = this.token();
    if (token === null) throw new LoaderError(this.format, 'truncated', `unexpected end of data while reading ${what}`);
    const value = Number(token);
    if (Number.isNaN(value) && !/^[+-]?nan$/i.test(token)) throw new LoaderError(this.format, 'syntax', `invalid number "${token.slice(0, 32)}" in ${what}`);
    return value;
  }
  integer(what: string): number {
    const value = this.number(what);
    if (!Number.isSafeInteger(value)) throw new LoaderError(this.format, 'syntax', `expected an integer in ${what}, got ${value}`);
    return value;
  }
  /** Returns the rest of the current line (without the line break) and moves past it. */
  line(): string | null {
    const text = this.text;
    if (this.pos >= text.length) return null;
    let end = text.indexOf('\n', this.pos);
    if (end < 0) end = text.length;
    const line = text.slice(this.pos, end);
    this.pos = end + 1;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}

/** Splits a line into tokens on whitespace, commas and semicolons. */
export function splitFields(line: string): string[] {
  const fields = line.trim().split(/[\s,;]+/);
  return fields.length === 1 && fields[0] === '' ? [] : fields;
}

/** Parses a numeric field, rejecting garbage but allowing nan/inf spellings. */
export function parseNumber(token: string, format: string, where: string): number {
  const value = Number(token);
  if (Number.isNaN(value) && !/^[+-]?nan$/i.test(token)) throw new LoaderError(format, 'syntax', `invalid number "${token.slice(0, 32)}" ${where}`);
  return value;
}

/** Append-only typed array. */
export class Growable<T extends Float32Array | Uint32Array> {
  array: T;
  length = 0;
  constructor(private readonly make: (size: number) => T, capacity = 1024) {this.array = make(Math.max(16, capacity));}
  reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.array.length) return;
    let size = this.array.length * 2;
    while (size < needed) size *= 2;
    const next = this.make(size);
    next.set(this.array.subarray(0, this.length));
    this.array = next;
  }
  push(value: number): void {if (this.length === this.array.length) this.reserve(1); this.array[this.length++] = value;}
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.array.length) this.reserve(3);
    const array = this.array, length = this.length;
    array[length] = a; array[length + 1] = b; array[length + 2] = c;
    this.length = length + 3;
  }
  result(): T {return this.array.slice(0, this.length) as T;}
}
export const floats = (capacity?: number): Growable<Float32Array> => new Growable(size => new Float32Array(size), capacity);
export const uints = (capacity?: number): Growable<Uint32Array> => new Growable(size => new Uint32Array(size), capacity);

/**
 * Fan-triangulates a polygon of `corners` indices read through `at`, validating each index.
 * Returns the number of triangles written.
 */
export function triangulate(indices: Growable<Uint32Array>, corners: number, at: (corner: number) => number, vertexCount: number, format: string, triangleLimit: number): number {
  if (corners < 3) return 0;
  const first = at(0);
  if (!(first >= 0 && first < vertexCount && Number.isInteger(first))) throw new LoaderError(format, 'range', `face index ${first} is outside 0..${vertexCount - 1}`);
  let previous = at(1);
  if (!(previous >= 0 && previous < vertexCount && Number.isInteger(previous))) throw new LoaderError(format, 'range', `face index ${previous} is outside 0..${vertexCount - 1}`);
  if ((indices.length / 3) + corners - 2 > triangleLimit) throw new LoaderError(format, 'limit', `triangle count exceeds the limit of ${triangleLimit}`);
  for (let corner = 2; corner < corners; corner++) {
    const current = at(corner);
    if (!(current >= 0 && current < vertexCount && Number.isInteger(current))) throw new LoaderError(format, 'range', `face index ${current} is outside 0..${vertexCount - 1}`);
    indices.push3(first, previous, current);
    previous = current;
  }
  return corners - 2;
}

/** Normalizes 0..255 integer colors to [0,1] when any component exceeds 1. */
export function normalizeColors(colors: Float32Array): void {
  let max = 0;
  for (let i = 0; i < colors.length; i++) if (colors[i] > max) max = colors[i];
  if (max > 1) for (let i = 0; i < colors.length; i++) colors[i] /= 255;
}

export function throwIfAborted(signal: AbortSignal | undefined, format: string): void {
  if (signal?.aborted) throw new LoaderError(format, 'aborted', 'aborted');
}

import { rangeError } from '../../shared/errors.js';

export function hdfError(message: string): never {
  throw rangeError(`HDF5: ${message}; check the file and supported storage types`, 'sciviz');
}
export const text = (b: Uint8Array): string => new TextDecoder().decode(b).replace(/\0.*$/s, '');
export const product = (s: readonly number[]): number => {
  const n = s.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(n) || n < 0) hdfError('unsafe dimension product');
  return n;
};
/** Little-endian metadata cursor. Undefined addresses are represented by -1, never rounded. */
export class Cursor {
  at = 0;
  readonly bytes: Uint8Array;
  // A plain field, not a parameter property, so tests can import this file with Node's type stripping.
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.at + n > this.bytes.length) hdfError('truncated metadata');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  uint(n = 1, address = false): number {
    const b = this.take(n);
    if (address && b.every((v) => v === 255)) return -1;
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + b[i];
    if (!Number.isSafeInteger(v)) hdfError('integer exceeds JavaScript safe precision');
    return v;
  }
  signature(s: string): void {
    if (text(this.take(s.length)) !== s) hdfError(`missing ${s} signature`);
  }
}
export interface HDFType {
  readonly kind: number;
  readonly size: number;
  readonly little: boolean;
  readonly signed: boolean;
  readonly bits: number;
  readonly offset: number;
  readonly string: boolean;
}
export function datatype(b: Uint8Array): HDFType {
  const c = new Cursor(b),
    tag = c.uint(),
    flags = c.uint(3),
    size = c.uint(4),
    kind = tag & 15;
  if (tag >> 4 < 1 || tag >> 4 > 4 || size < 1) hdfError('invalid datatype');
  // An enumeration's class bits hold its member count; byte order and sign are its base type's, which follows.
  if (kind === 8) {
    const base = datatype(b.subarray(8));
    if (base.kind !== 0 || base.size !== size) hdfError('enumeration base type must be an integer of its size');
    return { ...base, kind };
  }
  let offset = 0,
    bits = size * 8;
  if (kind === 0 || kind === 1 || kind === 4) {
    offset = c.uint(2);
    bits = c.uint(2);
  }
  return {
    kind,
    size,
    little: !(flags & 1),
    signed: !!(flags & 8),
    bits,
    offset,
    string: kind === 3 || (kind === 9 && !!(flags & 1)),
  };
}
export function dataspace(b: Uint8Array, width: number): number[] {
  const c = new Cursor(b),
    v = c.uint(),
    rank = c.uint();
  c.uint();
  if (v === 1) c.take(5);
  else if (v === 2) {
    if (c.uint() === 2) return [0];
  } else hdfError('unknown dataspace version');
  if (rank > 32) hdfError('rank exceeds 32');
  return Array.from({ length: rank }, () => c.uint(width));
}
export function numeric(b: Uint8Array, t: HDFType): Float64Array {
  if (![0, 1, 4, 7, 8].includes(t.kind) || ![1, 2, 4, 8].includes(t.size) || t.offset || t.bits !== t.size * 8)
    hdfError('numeric datatype needs an aligned 8, 16, 32 or 64 bit representation');
  if (b.length % t.size) hdfError('partial numeric element');
  const v = new DataView(b.buffer, b.byteOffset, b.length),
    out = new Float64Array(b.length / t.size);
  for (let i = 0; i < out.length; i++) {
    const at = i * t.size;
    let x: number;
    if (t.kind === 1) {
      if (t.size !== 4 && t.size !== 8) hdfError('unsupported floating point width');
      x = t.size === 4 ? v.getFloat32(at, t.little) : v.getFloat64(at, t.little);
    } else if (t.size === 8) {
      const big = t.signed ? v.getBigInt64(at, t.little) : v.getBigUint64(at, t.little);
      x = Number(big);
      if (!Number.isSafeInteger(x)) hdfError('64 bit value exceeds safe precision');
    } else
      x =
        t.size === 1
          ? t.signed
            ? v.getInt8(at)
            : v.getUint8(at)
          : t.size === 2
            ? t.signed
              ? v.getInt16(at, t.little)
              : v.getUint16(at, t.little)
            : t.signed
              ? v.getInt32(at, t.little)
              : v.getUint32(at, t.little);
    out[i] = x;
  }
  return out;
}

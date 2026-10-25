// Element types: the WGSL scalar each one is, its size, its CPU TypedArray, and NumPy-style promotion.
import { typeError } from '../../shared/errors.js';

/** A scalar the compute arrays hold. `f16` needs a device with the `shader-f16` feature. */
export type DType = 'f32' | 'f16' | 'i32' | 'u32';

/** The TypedArray that holds each element type on the CPU (`f16` as Float16Array where the runtime has it). */
export interface TypedArrayFor {
  f32: Float32Array<ArrayBuffer>;
  f16: Float16ArrayLike;
  i32: Int32Array<ArrayBuffer>;
  u32: Uint32Array<ArrayBuffer>;
}

/** A Float16Array (ES2025) where the runtime has one. */
export type Float16ArrayLike = ArrayLike<number> & ArrayBufferView<ArrayBuffer> & { [index: number]: number };

/** Every element type. */
export const DTYPES: readonly DType[] = ['f32', 'f16', 'i32', 'u32'];

/** Bytes per element. */
export const bytesOf = (dtype: DType): number => (dtype === 'f16' ? 2 : 4);

/** True for the float types. */
export const isFloat = (dtype: DType): boolean => dtype === 'f32' || dtype === 'f16';

const Float16 = (globalThis as { Float16Array?: new (data: ArrayLike<number> | ArrayBuffer) => Float16ArrayLike })
  .Float16Array;

/** The CPU array constructor of `dtype`. Throws for `f16` on a runtime without Float16Array. */
export function arrayType(dtype: DType): new (data: ArrayLike<number> | ArrayBuffer) => ArrayLike<number> {
  switch (dtype) {
    case 'f32':
      return Float32Array;
    case 'i32':
      return Int32Array;
    case 'u32':
      return Uint32Array;
    case 'f16':
      if (!Float16) throw typeError('f16 data needs Float16Array; read it as f32 with astype("f32")', 'compute');
      return Float16;
  }
}

/** The element type a TypedArray maps to: floats to `f32` (Float16Array to `f16`), signed to `i32`, unsigned to `u32`. */
export function dtypeOf(data: ArrayLike<number> | ArrayBufferView): DType {
  if (Float16 && data instanceof Float16) return 'f16';
  if (data instanceof Float32Array || data instanceof Float64Array) return 'f32';
  if (data instanceof Int32Array || data instanceof Int16Array || data instanceof Int8Array) return 'i32';
  if (
    data instanceof Uint32Array ||
    data instanceof Uint16Array ||
    data instanceof Uint8Array ||
    data instanceof Uint8ClampedArray
  )
    return 'u32';
  if (ArrayBuffer.isView(data))
    throw typeError('Compute arrays take number TypedArrays, not BigInt arrays or DataView', 'compute');
  return 'f32';
}

/** `data` as the CPU array of `dtype` (a copy only when the type differs). */
export function toTyped(data: ArrayLike<number>, dtype: DType): ArrayBufferView<ArrayBuffer> {
  const Ctor = arrayType(dtype) as unknown as { from(d: ArrayLike<number>): ArrayBufferView<ArrayBuffer> } & Function;
  return (data instanceof Ctor && (data as unknown as ArrayBufferView).buffer instanceof ArrayBuffer
    ? data
    : Ctor.from(data)) as unknown as ArrayBufferView<ArrayBuffer>;
}

/**
 * The result type of combining two types: any float wins (f32 over f16), i32 with u32 gives i32. A plain number
 * adopts the array's type when it fits (an integer with an integer array), else f32, as NumPy 2 treats Python scalars.
 */
export function promote(a: DType, b: DType): DType {
  if (a === b) return a;
  if (a === 'f32' || b === 'f32') return 'f32';
  if (a === 'f16' || b === 'f16') return 'f16';
  return 'i32';
}

/** The type a JS number takes next to an array of `dtype`. */
export function scalarType(value: number, dtype: DType): DType {
  if (isFloat(dtype)) return dtype;
  if (!Number.isInteger(value)) return 'f32';
  if (dtype === 'u32' && value < 0) return 'i32';
  return dtype;
}

/** The raw 32-bit pattern of `value` as `dtype`, for passing scalars through a u32 uniform. */
export function bitsOf(value: number, dtype: DType): number {
  const view = new DataView(new ArrayBuffer(4));
  if (dtype === 'f32' || dtype === 'f16') view.setFloat32(0, value, true);
  else if (dtype === 'i32') view.setInt32(0, value, true);
  else view.setUint32(0, value >>> 0, true);
  return view.getUint32(0, true);
}

/** WGSL that reads a scalar of `dtype` from the u32 `bits`. */
export function fromBits(bits: string, dtype: DType): string {
  return dtype === 'u32' ? bits : dtype === 'f16' ? `f16(bitcast<f32>(${bits}))` : `bitcast<${dtype}>(${bits})`;
}

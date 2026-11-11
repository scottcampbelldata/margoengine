import { fault, rangeError, typeError } from '../../shared/errors.js';
import { Colormap, colorScale, type ColorScaleOptions } from './colormaps.js';
import { isGpuArray } from './layer.js';
import type { BrickSource } from './bricks-plan.js';
import { selectionValue } from './spec-hooks.js';

/** JSON values, including tagged binary data and resource references. */
export type SpecValue = null | boolean | number | string | readonly SpecValue[] | { readonly [key: string]: SpecValue };
/** Numeric storage types accepted by the portable figure format. */
export type SpecDType =
  | 'Float16Array'
  | 'Float32Array'
  | 'Float64Array'
  | 'Int8Array'
  | 'Uint8Array'
  | 'Uint8ClampedArray'
  | 'Int16Array'
  | 'Uint16Array'
  | 'Int32Array'
  | 'Uint32Array';
/** An immutable, hash-checked external binary array. Bytes use little-endian numeric storage. */
export interface SpecDataURL {
  readonly url: string;
  readonly sha256: string;
  readonly dtype: SpecDType;
  readonly length: number;
}
/** Cancellation and allocation limit. Default maxBytes is 256 MiB, across a whole spec. */
export interface SpecIOOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  /** Hash-checked binary comm attachments, addressed by an array value's $buffer key. Borrowed until loading settles. */
  readonly buffers?: ReadonlyMap<string, ArrayBufferView>;
}
const halfArray = (globalThis as unknown as { Float16Array?: typeof Float32Array }).Float16Array;
const arrays = {
  ...(halfArray ? { Float16Array: halfArray } : {}),
  Float32Array,
  Float64Array,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
};
const locations = new WeakMap<object, SpecDataURL>();
const endian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** @internal An owned snapshot of an input already consumed by an asynchronous layer factory. */
export class SavedGPUInput {
  constructor(
    readonly data: ArrayBufferView,
    readonly shape: readonly number[],
    readonly dtype: string,
  ) {}
}
/** @internal Snapshot borrowed GPU inputs before returning control to a caller who may dispose them. */
export async function snapshotConsumedInput(value: unknown): Promise<unknown> {
  if (isGpuArray(value)) return new SavedGPUInput(await value.read(), [...value.shape], value.dtype);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return copySpecArray(value);
  if (Array.isArray(value)) return Promise.all(value.map(snapshotConsumedInput));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = await snapshotConsumedInput(item);
    return result;
  }
  return value;
}

/** @internal Snapshot numeric inputs without losing their pinned source location. */
export function copySpecArray(value: ArrayBufferView): ArrayBufferView {
  const result = (value as Float32Array).slice();
  const source = locations.get(value);
  if (source) locations.set(result, source);
  return result;
}

/** SHA-256 of the exact bytes, lowercase hexadecimal. */
export async function specHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 without argument-spread limits, also available in browsers without Node globals. */
export function specBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}

/** Decode canonical base64; allocation is bounded before decoding. */
export function specUnbase64(value: string, maxBytes: number): Uint8Array {
  const padding = typeof value === 'string' ? (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) : 0;
  const badPadding =
    padding > 0 &&
    ('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value[value.length - padding - 1]) &
      (padding === 2 ? 15 : 3)) !==
      0;
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value) ||
    value.slice(0, value.length - padding).includes('=') ||
    badPadding
  )
    throw typeError('Invalid figure base64; supply canonical binary data', 'sciviz');
  if ((value.length / 4) * 3 - padding > maxBytes)
    throw rangeError('Figure data exceeds maxBytes; use a smaller dataset or raise the explicit limit', 'sciviz');
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** Read and verify an external array. Its source is retained for toJSON({ data: 'url' }). */
export async function loadSpecData(
  source: SpecDataURL,
  options: SpecIOOptions = {},
): Promise<ArrayBufferView & ArrayLike<number>> {
  const io = new ValueIO(options);
  return await io.external(source);
}

/** @internal One allocation budget and cancellation scope per save/load operation. */
export class ValueIO {
  readonly max: number;
  private used = 0;
  constructor(
    readonly options: SpecIOOptions = {},
    private readonly restoreGPU?: (data: ArrayBufferView, shape: readonly number[], dtype: string) => Promise<object>,
  ) {
    this.max = options.maxBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.max) || this.max < 1)
      throw rangeError('maxBytes must be a positive integer; supply a bounded allocation limit', 'sciviz');
  }
  check(bytes = 0): void {
    this.options.signal?.throwIfAborted();
    this.used += bytes;
    if (this.used > this.max)
      throw rangeError('Figure exceeds maxBytes; reduce data or raise the explicit limit', 'sciviz');
  }
  private constructorOf(
    dtype: string,
  ):
    | typeof Float32Array
    | typeof Uint8Array
    | typeof Float64Array
    | typeof Int8Array
    | typeof Uint8ClampedArray
    | typeof Int16Array
    | typeof Uint16Array
    | typeof Int32Array
    | typeof Uint32Array {
    if (!Object.hasOwn(arrays, dtype) || !arrays[dtype as SpecDType])
      throw typeError('Unsupported figure dtype; use a numeric TypedArray', 'sciviz');
    return arrays[dtype as SpecDType]!;
  }
  async external(source: SpecDataURL): Promise<ArrayBufferView & ArrayLike<number>> {
    const ctor = this.constructorOf(source.dtype);
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.length) || source.length < 0)
      throw typeError('Invalid binary source; supply a SHA-256 and nonnegative element count', 'sciviz');
    const size = source.length * ctor.BYTES_PER_ELEMENT;
    this.check(size);
    const url = new URL(source.url, typeof location === 'undefined' ? undefined : location.href);
    if (!['https:', 'http:', 'data:', 'blob:'].includes(url.protocol))
      throw typeError('Unsupported data URL; use HTTP, data or blob', 'sciviz');
    const response = await fetch(url, { signal: this.options.signal });
    if (!response.ok || !response.body)
      throw fault('failed', `Data HTTP ${response.status}; check the source URL`, 'sciviz');
    const bytes = new Uint8Array(size),
      reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        this.check();
        if (done) break;
        if (offset + value.length > size)
          throw rangeError('Data length differs from spec; provide the pinned source', 'sciviz');
        bytes.set(value, offset);
        offset += value.length;
      }
      if (offset !== size || (await specHash(bytes)) !== source.sha256)
        throw fault('failed', 'Data hash or length mismatch; provide the pinned source', 'sciviz');
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    this.check();
    const result = this.array(source.dtype, bytes);
    locations.set(result, { ...source });
    return result;
  }
  private array(dtype: string, bytes: Uint8Array): ArrayBufferView & ArrayLike<number> {
    const ctor = this.constructorOf(dtype),
      n = ctor.BYTES_PER_ELEMENT;
    if (bytes.byteLength % n) throw typeError('Misaligned binary data; correct the dtype and byte length', 'sciviz');
    if (!endian && n > 1) for (let i = 0; i < bytes.length; i += n) bytes.subarray(i, i + n).reverse();
    return new ctor(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length / n);
  }
  async encode(
    value: unknown,
    references: ReadonlyMap<object, string> = new Map(),
    external = false,
    stack = new Set<object>(),
  ): Promise<SpecValue> {
    this.check();
    if (value === undefined) return { $undefined: true };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
    if (typeof value !== 'object')
      throw typeError('Figure contains a callback; replace it with declarative data or register a codec', 'sciviz');
    const ref = references.get(value);
    if (ref) return { $ref: ref };
    const selection = selectionValue(value);
    if (selection) return { $selection: await this.encode(selection(), references, external, stack) };
    if (value instanceof SavedGPUInput)
      return { $gpu: await this.encode(value.data, references, external), shape: [...value.shape], dtype: value.dtype };
    if (isGpuArray(value))
      return {
        $gpu: await this.encode(await value.read({ signal: this.options.signal }), references, external),
        shape: [...value.shape],
        dtype: value.dtype,
      };
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const source = locations.get(value);
      const dtype = value.constructor.name;
      const ctor = this.constructorOf(dtype);
      this.check(value.byteLength);
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      if (!endian && ctor.BYTES_PER_ELEMENT > 1)
        for (let i = 0; i < bytes.length; i += ctor.BYTES_PER_ELEMENT)
          bytes.subarray(i, i + ctor.BYTES_PER_ELEMENT).reverse();
      const sha256 = await specHash(bytes);
      this.check();
      if (external && source) {
        if (sha256 !== source.sha256)
          throw fault('failed', 'Pinned array changed; save it inline or reload the pinned data', 'sciviz');
        return { $url: { ...source } };
      }
      return { $array: dtype, bytes: specBase64(bytes), sha256 };
    }
    if (value instanceof Colormap) {
      // Preserve the exact sampled table used by the GPU, without serializing executable closures.
      return {
        $colormap: value.name,
        kind: value.kind,
        table: await this.encode(value.unscaled().table(256)),
        ...(value.encoding ? { encoding: await this.encode(value.scaleOptions()) } : {}),
      };
    }
    if (value instanceof AbortSignal) return { $undefined: true };
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw typeError('Invalid saved date; supply a finite UTC date', 'sciviz');
      return { $date: value.toISOString() };
    }
    if ('read' in value && typeof value.read === 'function' && 'dims' in value && Array.isArray(value.dims)) {
      const source = value as BrickSource,
        frames: SpecValue[] = [];
      const count = source.frames ?? 1,
        size = source.dims.reduce((a, b) => a * b, 1);
      if (
        source.dims.length !== 3 ||
        source.dims.some((d) => !Number.isSafeInteger(d) || d < 2) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count * size * 8 > this.max - this.used
      )
        throw rangeError('Brick snapshot exceeds maxBytes or has invalid dimensions; use a bounded source', 'sciviz');
      for (let frame = 0; frame < count; frame++) {
        this.check();
        const data = await source.read({
          frame,
          level: 0,
          origin: [0, 0, 0],
          size: source.dims,
          signal: this.options.signal ?? new AbortController().signal,
        });
        if (data.length !== size)
          throw typeError('Brick source returned a different size; correct its read implementation', 'sciviz');
        frames.push(await this.encode(Float64Array.from(data)));
      }
      return { $bricks: frames, dims: [...source.dims], ...(source.range ? { range: [...source.range] } : {}) };
    }
    if (stack.has(value)) throw typeError('Figure data is cyclic; use acyclic data or layer references', 'sciviz');
    stack.add(value);
    try {
      if (Array.isArray(value)) {
        const out: SpecValue[] = [];
        for (const item of value) out.push(await this.encode(item, references, external, stack));
        return out;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw typeError('Figure data contains a live object; register a portable layer codec', 'sciviz');
      const out: Record<string, SpecValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (key.startsWith('$') || ['__proto__', 'constructor', 'prototype'].includes(key))
          throw typeError('Reserved figure data key; rename the field', 'sciviz');
        if (
          key === 'transfer' &&
          'range' in value &&
          (typeof item === 'function' ||
            (item && typeof item === 'object' && 'evaluate' in item && typeof item.evaluate === 'function'))
        ) {
          const range = (value as { range: number[] }).range;
          const evaluate =
            typeof item === 'function'
              ? item
              : (item as { evaluate: (x: number) => readonly number[] }).evaluate.bind(item);
          const table = new Float64Array(1024);
          for (let i = 0; i < 256; i++) table.set(evaluate(range[0] + ((range[1] - range[0]) * i) / 255), i * 4);
          out[key] = { $transfer: await this.encode(table), range: [...range] };
        } else if (item !== undefined) out[key] = await this.encode(item, references, external, stack);
      }
      return out;
    } finally {
      stack.delete(value);
    }
  }
  async decode(value: SpecValue, references: ReadonlyMap<string, object> = new Map(), depth = 0): Promise<unknown> {
    this.check();
    if (depth > 128) throw rangeError('Figure is too deeply nested; flatten the data', 'sciviz');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw typeError('Invalid JSON number; use tagged binary values', 'sciviz');
      return value;
    }
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await this.decode(item, references, depth + 1));
      return out;
    }
    if (!value || typeof value !== 'object') throw typeError('Invalid spec value; load finite JSON', 'sciviz');
    const v = value as Record<string, SpecValue>;
    if ('$undefined' in v) return undefined;
    if ('$number' in v) {
      if (!['NaN', 'Infinity', '-Infinity'].includes(v.$number as string))
        throw typeError('Invalid tagged number; use a standard nonfinite token', 'sciviz');
      return Number(v.$number);
    }
    if ('$ref' in v) {
      const ref = references.get(v.$ref as string);
      if (!ref) throw typeError('Unknown figure reference; put the dependency before its consumer', 'sciviz');
      return ref;
    }
    if ('$array' in v) {
      let bytes: Uint8Array;
      if ('$buffer' in v) {
        const buffer = this.options.buffers?.get(v.$buffer as string);
        if (typeof v.$buffer !== 'string' || !buffer || !ArrayBuffer.isView(buffer))
          throw typeError('Missing binary figure attachment; supply the named buffers with the spec', 'sciviz');
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const alignment = this.constructorOf(v.$array as string).BYTES_PER_ELEMENT;
        if (!endian || bytes.byteOffset % alignment) bytes = bytes.slice();
      } else bytes = specUnbase64(v.bytes as string, this.max - this.used);
      this.check(bytes.length);
      if ((await specHash(bytes)) !== v.sha256)
        throw fault('failed', 'Inline data hash mismatch; restore the original bytes', 'sciviz');
      return this.array(v.$array as string, bytes);
    }
    if ('$url' in v) return this.external(v.$url as unknown as SpecDataURL);
    if ('$selection' in v) {
      const { SelectionStore } = await import('@margoengine/sciviz/link');
      return SelectionStore.fromJSON(
        (await this.decode(v.$selection, references, depth + 1)) as import('./link.js').SelectionJSON,
      );
    }
    if ('$date' in v) {
      const date = new Date(v.$date as string);
      if (!Number.isFinite(date.getTime())) throw typeError('Invalid saved date; supply ISO UTC text', 'sciviz');
      return date;
    }
    if ('$transfer' in v) {
      const table = (await this.decode(v.$transfer, references, depth + 1)) as Float64Array;
      const range = v.range as number[];
      if (table.length !== 1024 || range.length !== 2 || !(range[1] > range[0]))
        throw typeError('Invalid component transfer; supply 256 RGBA values and an increasing range', 'sciviz');
      return {
        evaluate(value: number) {
          const x = Math.max(0, Math.min(255, ((value - range[0]) / (range[1] - range[0])) * 255)),
            i = Math.min(254, Math.floor(x)),
            f = x - i;
          return [0, 1, 2, 3].map((c) => table[i * 4 + c] * (1 - f) + table[(i + 1) * 4 + c] * f);
        },
      };
    }
    if ('$bricks' in v) {
      const { arraySource } = await import('@margoengine/sciviz/bricks');
      const frames = (await this.decode(v.$bricks, references, depth + 1)) as Float64Array[];
      const source = arraySource(frames, v.dims as unknown as [number, number, number]);
      return v.range ? { ...source, range: v.range } : source;
    }
    if ('$gpu' in v) {
      const data = (await this.decode(v.$gpu, references, depth + 1)) as ArrayBufferView;
      return this.restoreGPU ? this.restoreGPU(data, v.shape as readonly number[], v.dtype as string) : data;
    }
    if ('$colormap' in v) {
      const table = (await this.decode(v.table, references, depth + 1)) as Float32Array;
      if (!(table instanceof Float32Array) || table.length !== 1024)
        throw typeError('Invalid colormap table; supply 256 RGBA samples', 'sciviz');
      const base = new Colormap(v.$colormap as string, v.kind as 'sequential', (t) => {
        const x = Math.min(255, Math.max(0, (v.kind === 'cyclic' ? t - Math.floor(t) : t) * 255)),
          i = Math.min(254, Math.floor(x)),
          f = x - i;
        return [0, 1, 2].map((c) => table[i * 4 + c] * (1 - f) + table[(i + 1) * 4 + c] * f) as [
          number,
          number,
          number,
        ];
      });
      return v.encoding
        ? colorScale(base, (await this.decode(v.encoding, references, depth + 1)) as ColorScaleOptions)
        : base;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      if (key.startsWith('$') || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw typeError('Unknown or unsafe spec tag; use the versioned schema', 'sciviz');
      out[key] = await this.decode(item, references, depth + 1);
    }
    return out;
  }
}

// Clean room from Unidata NUG Appendix B (CDF-1/2) and CF 1.12 section 8.1.
import { rangeError } from '../../shared/errors.js';
import { byteLimit, fileSource, readBytes, type FileInput, type FileOptions, type FileSource } from './file-source.js';
import type { VolumeGrid } from './formats.js';
export type { FileInput, FileOptions, FileSource } from './file-source.js';

/** UTF-8 attribute text, or numeric values in the file's external type, promoted to float64. */
export type NetCDFAttribute = string | Float64Array;
/** Zero-based hyperslab, in file dimension order, last dimension fastest. */
export interface NetCDFSelection {
  start?: readonly number[];
  count?: readonly number[];
  stride?: readonly number[];
  /** Apply CF missing/valid-range and packing attributes. Default true. */
  unpack?: boolean;
  signal?: AbortSignal;
}
/** Metadata plus lazy hyperslab access. */
export interface NetCDFVariable {
  readonly name: string;
  readonly type: 'byte' | 'char' | 'short' | 'int' | 'float' | 'double';
  readonly dimensions: readonly string[];
  readonly shape: readonly number[];
  readonly attributes: Readonly<Record<string, NetCDFAttribute>>;
  read(selection?: NetCDFSelection): Promise<Float64Array>;
  /** A rank 1-3 selection, interpreted as z,y,x, with explicit physical bounds or index bounds. */
  volume(selection?: NetCDFSelection & { bounds?: VolumeGrid['bounds'] }): Promise<VolumeGrid>;
}
/** CDF metadata and lifetime. Disposing aborts pending and future reads. */
export interface NetCDFFile {
  readonly format: 'CDF-1' | 'CDF-2';
  readonly dimensions: Readonly<Record<string, number>>;
  readonly attributes: Readonly<Record<string, NetCDFAttribute>>;
  readonly variables: Readonly<Record<string, NetCDFVariable>>;
  dispose(): void;
  [Symbol.dispose](): void;
}

const sizes = [0, 1, 1, 2, 4, 4, 8];
const names = ['', 'byte', 'char', 'short', 'int', 'float', 'double'] as const;
const fills = [0, -127, 0, -32767, -2147483647, 9.969209968386869e36, 9.969209968386869e36];
const bad = (message: string) => rangeError(`NetCDF: ${message}`, 'sciviz');
function textOf(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw bad('text must be UTF-8; convert legacy text encoding before loading');
  }
}
const product = (shape: readonly number[]): number => {
  const n = shape.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(n)) throw bad('dimension product exceeds safe integer precision');
  return n;
};
function decode(bytes: Uint8Array, type: number): Float64Array {
  const size = sizes[type],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!size || bytes.length % size) throw bad('invalid external type or truncated value');
  const out = new Float64Array(bytes.length / size);
  for (let i = 0; i < out.length; i++) {
    const o = i * size;
    out[i] =
      type === 1
        ? view.getInt8(o)
        : type === 2
          ? view.getUint8(o)
          : type === 3
            ? view.getInt16(o)
            : type === 4
              ? view.getInt32(o)
              : type === 5
                ? view.getFloat32(o)
                : view.getFloat64(o);
  }
  return out;
}

/** Opens classic and 64-bit-offset NetCDF without reading variable payloads. NetCDF-4/HDF5 and CDF-5 reject explicitly. */
export async function openNetCDF(input: FileInput, options: FileOptions = {}): Promise<NetCDFFile> {
  const max = byteLimit(options.maxBytes),
    source = fileSource(input, max),
    lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  let at = 0,
    pageAt = -1,
    page: Uint8Array = new Uint8Array();
  const take = async (n: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(n) || n < 0 || at + n > max) throw bad('header exceeds maxBytes');
    if (at < pageAt || at + n > pageAt + page.length) {
      pageAt = at;
      page = await readBytes(source, at, Math.min(max - at, Math.max(n, 4096)), max, signal);
    }
    if (at + n > pageAt + page.length) throw bad('header ends early');
    const out = page.subarray(at - pageAt, at - pageAt + n);
    at += n;
    return out;
  };
  const u32 = async (): Promise<number> => {
    const b = await take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
  };
  const name = async (): Promise<string> => {
    const n = await u32(),
      b = await take(Math.ceil(n / 4) * 4),
      text = textOf(b.subarray(0, n));
    if (!text || /[\x00-\x1f/\x7f]/.test(text) || text.endsWith(' ')) throw bad('invalid name');
    return text;
  };
  const list = async (tag: number): Promise<number> => {
    const t = await u32(),
      n = await u32();
    if (t !== tag && !(t === 0 && n === 0)) throw bad(`invalid list tag ${t}`);
    if (n > max / 4) throw bad('list exceeds header bound');
    return n;
  };
  const attrs = async (): Promise<Record<string, NetCDFAttribute>> => {
    const out: Record<string, NetCDFAttribute> = Object.create(null),
      n = await list(12);
    for (let i = 0; i < n; i++) {
      const key = await name(),
        type = await u32(),
        count = await u32();
      if (!sizes[type] || Object.hasOwn(out, key)) throw bad('invalid attribute type or duplicate name');
      if (count * (type === 2 ? 1 : 8) > max) throw bad('attribute output exceeds maxBytes');
      const size = count * sizes[type],
        bytes = (await take(Math.ceil(size / 4) * 4)).subarray(0, size);
      out[key] = type === 2 ? textOf(bytes) : decode(bytes, type);
    }
    return out;
  };
  const magic = await take(4),
    version = magic[3];
  if (magic[0] !== 67 || magic[1] !== 68 || magic[2] !== 70 || (version !== 1 && version !== 2))
    throw bad('only CDF-1 and CDF-2 are supported; convert NetCDF-4/HDF5 or CDF-5 to classic first');
  const records = await u32();
  if (records === 0xffffffff)
    throw bad('indeterminate streaming record count is not supported; close the writer first');
  const dimensions: Record<string, number> = Object.create(null),
    dimNames: string[] = [],
    lengths: number[] = [];
  const nd = await list(10);
  let unlimited = -1;
  for (let i = 0; i < nd; i++) {
    const key = await name(),
      n = await u32();
    if (Object.hasOwn(dimensions, key) || (!n && unlimited >= 0))
      throw bad('duplicate dimension or multiple unlimited dimensions');
    if (!n) unlimited = i;
    dimNames.push(key);
    lengths.push(n || records);
    dimensions[key] = n || records;
  }
  const attributes = await attrs(),
    nv = await list(11);
  const metadata: {
    name: string;
    ids: number[];
    attrs: Record<string, NetCDFAttribute>;
    type: number;
    begin: number;
    bytes: number;
    record: boolean;
  }[] = [];
  for (let i = 0; i < nv; i++) {
    const key = await name(),
      rank = await u32(),
      ids: number[] = [];
    if (rank > max / 4) throw bad('variable rank exceeds header bound');
    for (let k = 0; k < rank; k++) {
      const id = await u32();
      if (id >= nd || (id === unlimited && k !== 0)) throw bad('invalid dimension reference');
      ids.push(id);
    }
    const a = await attrs(),
      type = await u32(),
      vsize = await u32();
    const wide = version === 2 ? await take(8) : undefined;
    const begin = wide ? Number(new DataView(wide.buffer, wide.byteOffset, 8).getBigUint64(0)) : await u32();
    if (!sizes[type] || !Number.isSafeInteger(begin) || begin % 4) throw bad('invalid type or variable offset');
    const record = ids.length > 0 && ids[0] === unlimited;
    const bytes = product(ids.slice(record ? 1 : 0).map((id) => lengths[id])) * sizes[type];
    if (!Number.isSafeInteger(bytes) || (vsize !== 0xffffffff && vsize !== Math.ceil(bytes / 4) * 4))
      throw bad('vsize does not match shape');
    metadata.push({ name: key, ids, attrs: a, type, begin, bytes, record });
  }
  const recordVars = metadata.filter((v) => v.record),
    recordSize = recordVars.reduce(
      (sum, v) => sum + (recordVars.length === 1 ? v.bytes : Math.ceil(v.bytes / 4) * 4),
      0,
    );
  const variables: Record<string, NetCDFVariable> = Object.create(null);
  for (const v of metadata) {
    if (Object.hasOwn(variables, v.name) || v.begin < at) throw bad('duplicate variable or data overlapping header');
    const shape = Object.freeze(v.ids.map((id) => lengths[id]));
    const select = (s: NetCDFSelection) => {
      const start = Array.from(s.start ?? shape.map(() => 0)),
        stride = Array.from(s.stride ?? shape.map(() => 1));
      const count = Array.from(s.count ?? shape.map((n, i) => Math.max(0, Math.ceil((n - start[i]) / stride[i]))));
      if ([start, stride, count].some((a) => a.length !== shape.length))
        throw bad('selection rank differs from variable');
      shape.forEach((n, i) => {
        if (
          ![start[i], count[i], stride[i]].every(Number.isSafeInteger) ||
          start[i] < 0 ||
          count[i] < 0 ||
          stride[i] < 1 ||
          start[i] > n ||
          (count[i] && start[i] + (count[i] - 1) * stride[i] >= n)
        )
          throw bad('hyperslab is outside variable');
      });
      if (product(count) * 8 > max) throw bad('selection output exceeds maxBytes');
      return { start, stride, count };
    };
    const read = async (s: NetCDFSelection = {}): Promise<Float64Array> => {
      const current = s.signal ? AbortSignal.any([signal, s.signal]) : signal;
      current.throwIfAborted();
      const { start, stride, count } = select(s),
        out = new Float64Array(product(count)),
        size = sizes[v.type];
      const multipliers = shape.map((_, i) => product(shape.slice(i + 1)) * size);
      if (v.record) multipliers[0] = recordSize;
      const offset = (index: number): number => {
        let address = v.begin;
        for (let i = shape.length - 1; i >= 0; i--) {
          const c = index % count[i];
          index = Math.floor(index / count[i]);
          address += (start[i] + c * stride[i]) * multipliers[i];
        }
        return address;
      };
      for (let i = 0; i < out.length; ) {
        current.throwIfAborted();
        const address = offset(i);
        let end = i + 1;
        while (
          end < out.length &&
          offset(end) === address + (end - i) * size &&
          (end - i + 1) * size <= Math.min(max, 65536)
        )
          end++;
        const bytes = await readBytes(source, address, (end - i) * size, max, current);
        if (bytes.length !== (end - i) * size) throw bad('variable data ends early');
        out.set(decode(bytes, v.type), i);
        i = end;
      }
      if (s.unpack !== false && v.type !== 2) {
        const a = v.attrs;
        const numeric = (key: string): Float64Array | undefined =>
          a[key] instanceof Float64Array ? (a[key] as Float64Array) : undefined;
        const fill = numeric('_FillValue') ?? [fills[v.type]],
          missing: ArrayLike<number> & { includes(value: number): boolean } =
            numeric('missing_value') ?? new Float64Array();
        const valid = numeric('valid_range'),
          low = valid?.[0] ?? numeric('valid_min')?.[0] ?? -Infinity,
          high = valid?.[1] ?? numeric('valid_max')?.[0] ?? Infinity;
        const scale = numeric('scale_factor')?.[0] ?? 1,
          add = numeric('add_offset')?.[0] ?? 0;
        for (let i = 0; i < out.length; i++) {
          if (!(i % 4096)) current.throwIfAborted();
          const x = out[i];
          out[i] = fill.includes(x) || missing.includes(x) || x < low || x > high ? NaN : x * scale + add;
        }
      }
      current.throwIfAborted();
      return out;
    };
    variables[v.name] = {
      name: v.name,
      type: names[v.type] as NetCDFVariable['type'],
      dimensions: v.ids.map((id) => dimNames[id]),
      shape,
      attributes: v.attrs,
      read,
      async volume(s = {}) {
        const { count } = select(s);
        const axes = count.filter((n) => n !== 1);
        if (axes.length > 3 || count.some((n) => !n)) throw bad('a volume needs one to three nonempty axes');
        const dims = [1, 1, 1] as [number, number, number];
        axes.reverse().forEach((n, i) => {
          dims[i] = n;
        });
        const data = await read(s);
        let lo = Infinity,
          hi = -Infinity;
        for (const x of data)
          if (Number.isFinite(x)) {
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
        return {
          data,
          dims,
          bounds: s.bounds ?? [0, Math.max(1, dims[0] - 1), 0, Math.max(1, dims[1] - 1), 0, Math.max(1, dims[2] - 1)],
          range: lo === Infinity ? [0, 0] : [lo, hi],
        };
      },
    };
  }
  const dispose = () => lifetime.abort();
  return {
    format: version === 1 ? 'CDF-1' : 'CDF-2',
    dimensions,
    attributes,
    variables,
    dispose,
    [Symbol.dispose]: dispose,
  };
}

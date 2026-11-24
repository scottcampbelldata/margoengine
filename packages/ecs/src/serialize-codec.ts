/// <reference lib="esnext.typedarrays" />
/** App-owned encoding for values that have no portable representation, such as asset references. */
export interface SnapshotValueCodec {
  /** Stable wire name, unique in one codec list. */
  name: string;
  /** True for values owned by this codec. */
  test(value: unknown): boolean;
  /** Return supported portable data, not executable source. */
  encode(value: unknown): unknown;
  /** Reconstruct a value from portable data. Custom cycles must use app keys. */
  decode(value: unknown): unknown;
}
/** Snapshot I/O limits and cancellation. */
export interface SnapshotOptions {
  /** Abort asynchronous compression, decompression and hashing. Default none. */
  signal?: AbortSignal;
  /** Maximum packet and expanded text bytes. Default 64 MiB. */
  maxBytes?: number;
  /** App reference codecs. Default none. */
  codecs?: readonly SnapshotValueCodec[];
}
const views: Record<string, new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};
/** Base64 text of `bytes`; uses the built-in encoder where the runtime has one (Node 26, current browsers). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
/** Bytes of canonical padded base64 `text`; throws SyntaxError on anything else, as the built-in strict decoder does. */
export function base64ToBytes(text: string): Uint8Array {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text, { lastChunkHandling: 'strict' });
  const clean = text.replace(/[\t\n\f\r ]+/g, '');
  if (clean.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new SyntaxError('Invalid base64 text');
  const binary = atob(clean);
  // Non-zero bits in the last chunk's padding are not canonical, which strict decoding refuses.
  if (btoa(binary) !== clean) throw new SyntaxError('Invalid base64 text');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** Lower-case hexadecimal text of `bytes`; uses the built-in encoder where the runtime has one. */
export function bytesToHex(bytes: Uint8Array): string {
  if (typeof bytes.toHex === 'function') return bytes.toHex();
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}
function invalid(): never {
  throw new TypeError('Invalid snapshot value; use portable data or register a named value codec');
}
function integer(v: unknown, max = 1_000_000): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}
/** Encode a portable identity graph, preserving cycles and shared buffers. */
export function encodeGraph(root: unknown, codecs: readonly SnapshotValueCodec[] = []): string {
  validateCodecs(codecs);
  const seen = new Map<unknown, number>(),
    nodes: unknown[][] = [];
  function token(value: unknown, depth = 0): unknown {
    if (depth > 256) throw new RangeError('Snapshot graph too deep; keep reference nesting below 257 levels');
    if (value === undefined) return [1];
    if (typeof value === 'bigint') return [2, String(value)];
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
      return [3, String(Object.is(value, -0) ? '-0' : value)];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value !== 'object' && typeof value !== 'function') return invalid();
    const old = seen.get(value);
    if (old !== undefined) return [0, old];
    if (nodes.length >= 1_000_000)
      throw new RangeError('Too many snapshot objects; keep the graph below 1000000 nodes');
    const id = nodes.length,
      node: unknown[] = [];
    seen.set(value, id);
    nodes.push(node);
    const read = (v: unknown) => token(v, depth + 1);
    const codec = codecs.find((c) => c.test(value));
    if (codec) node.push('x', codec.name, read(codec.encode(value)));
    else if (value instanceof ArrayBuffer) node.push('b', bytesToBase64(new Uint8Array(value)));
    else if (ArrayBuffer.isView(value)) {
      const name = value instanceof DataView ? 'DataView' : Object.getPrototypeOf(value).constructor.name;
      if (!Object.hasOwn(views, name)) return invalid();
      node.push(
        'v',
        name,
        read(value.buffer),
        value.byteOffset,
        value instanceof DataView ? value.byteLength : (value as Uint8Array).length,
      );
    } else if (value instanceof Date) node.push('d', read(value.getTime()));
    else if (value instanceof RegExp) node.push('r', value.source, value.flags, value.lastIndex);
    else if (value instanceof Map)
      node.push(
        'm',
        [...value].map(([k, v]) => [read(k), read(v)]),
      );
    else if (value instanceof Set) node.push('s', [...value].map(read));
    else {
      const proto = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return invalid();
      const pairs = Object.keys(value)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!('value' in descriptor)) return invalid();
          return [key, read(descriptor.value)];
        });
      if (Object.getOwnPropertySymbols(value).some((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable))
        return invalid();
      if (Array.isArray(value)) {
        if (!integer(value.length))
          throw new RangeError('Snapshot array too large; use at most 1000000 entries per JS array');
        node.push('a', value.length, pairs);
      } else node.push('o', proto === null, pairs);
    }
    return [0, id];
  }
  const value = token(root);
  return JSON.stringify({ value, nodes });
}
/** Decode a bounded graph without setting prototypes or evaluating code. */
export function decodeGraph(text: string, codecs: readonly SnapshotValueCodec[] = []): unknown {
  validateCodecs(codecs);
  const graph = JSON.parse(text) as { value?: unknown; nodes?: unknown };
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length > 1_000_000) return invalid();
  const nodes = graph.nodes,
    values: unknown[] = [],
    state: number[] = [];
  function read(t: unknown, depth = 0): unknown {
    if (depth > 256) throw new RangeError('Snapshot graph too deep; use a graph nested below 257 levels');
    if (t === null || typeof t === 'string' || typeof t === 'boolean' || (typeof t === 'number' && Number.isFinite(t)))
      return t;
    if (!Array.isArray(t)) return invalid();
    if (t.length === 1 && t[0] === 1) return undefined;
    if (t.length !== 2) return invalid();
    if (t[0] === 2 && typeof t[1] === 'string' && /^-?(0|[1-9][0-9]*)$/.test(t[1])) return BigInt(t[1]);
    if (t[0] === 3 && ['NaN', 'Infinity', '-Infinity', '-0'].includes(t[1])) return Number(t[1]);
    if (t[0] !== 0 || !integer(t[1], nodes.length - 1)) return invalid();
    const id = t[1];
    if (state[id]) {
      if (state[id] === 1 && values[id] === undefined) return invalid();
      return values[id];
    }
    const n: unknown = nodes[id];
    if (!Array.isArray(n)) return invalid();
    state[id] = 1;
    const next = (v: unknown) => read(v, depth + 1);
    let result: unknown;
    if (n[0] === 'b' && n.length === 2 && typeof n[1] === 'string')
      result = base64ToBytes(n[1]).buffer as ArrayBuffer;
    else if (
      n[0] === 'v' &&
      n.length === 5 &&
      typeof n[1] === 'string' &&
      Object.hasOwn(views, n[1]) &&
      integer(n[3], 64 * 1024 * 1024) &&
      integer(n[4], 64 * 1024 * 1024)
    ) {
      const buffer = next(n[2]);
      if (!(buffer instanceof ArrayBuffer)) return invalid();
      result = new views[n[1]](buffer, n[3], n[4]);
    } else if (n[0] === 'd' && n.length === 2) {
      const time = next(n[1]);
      if (typeof time !== 'number') return invalid();
      result = new Date(time);
    } else if (
      n[0] === 'r' &&
      n.length === 4 &&
      typeof n[1] === 'string' &&
      typeof n[2] === 'string' &&
      integer(n[3], 0xffffffff)
    ) {
      result = new RegExp(n[1], n[2]);
      (result as RegExp).lastIndex = n[3];
    } else if (n[0] === 'x' && n.length === 3 && typeof n[1] === 'string') {
      const codec = codecs.find((c) => c.name === n[1]);
      if (!codec) return invalid();
      result = codec.decode(next(n[2]));
    } else if (n[0] === 'm' && n.length === 2 && Array.isArray(n[1])) {
      const map = new Map();
      values[id] = map;
      for (const p of n[1]) {
        if (!Array.isArray(p) || p.length !== 2) return invalid();
        map.set(next(p[0]), next(p[1]));
      }
      result = map;
    } else if (n[0] === 's' && n.length === 2 && Array.isArray(n[1])) {
      const set = new Set();
      values[id] = set;
      for (const v of n[1]) set.add(next(v));
      result = set;
    } else if ((n[0] === 'a' || n[0] === 'o') && n.length === 3 && Array.isArray(n[2])) {
      if (n[0] === 'a' ? !integer(n[1]) : typeof n[1] !== 'boolean') return invalid();
      const object = n[0] === 'a' ? new Array(n[1] as number) : Object.create(n[1] ? null : Object.prototype);
      values[id] = object;
      const keys = new Set<string>();
      for (const pair of n[2]) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'string' ||
          keys.has(pair[0]) ||
          (n[0] === 'a' && pair[0] === 'length')
        )
          return invalid();
        keys.add(pair[0]);
        if (
          n[0] === 'a' &&
          /^(0|[1-9][0-9]*)$/.test(pair[0]) &&
          Number(pair[0]) < 0xffffffff &&
          Number(pair[0]) >= (n[1] as number)
        )
          return invalid();
        Object.defineProperty(object, pair[0], {
          value: next(pair[1]),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      result = object;
    } else return invalid();
    state[id] = 2;
    values[id] = result;
    return result;
  }
  return read(graph.value);
}
/** Validate I/O bounds before allocation. */
export function byteLimit(options: SnapshotOptions): number {
  const limit = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 0x7fffffff)
    throw new RangeError('Invalid snapshot byte limit; use 1 to 2147483647');
  return limit;
}
function validateCodecs(codecs: readonly SnapshotValueCodec[]): void {
  if (
    !Array.isArray(codecs) ||
    codecs.some(
      (c) =>
        !c ||
        typeof c.name !== 'string' ||
        !c.name.trim() ||
        typeof c.test !== 'function' ||
        typeof c.encode !== 'function' ||
        typeof c.decode !== 'function',
    ) ||
    new Set(codecs.map((c) => c.name)).size !== codecs.length
  )
    invalid();
}
/** Compress/decompress with native bounded streams; cancellation rejects without partial state. */
export async function transform(bytes: Uint8Array, decompress: boolean, options: SnapshotOptions): Promise<Uint8Array> {
  const limit = byteLimit(options),
    signal = options.signal;
  signal?.throwIfAborted();
  if (bytes.byteLength > limit) throw new RangeError('Snapshot exceeds byte limit; raise maxBytes deliberately');
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(decompress ? new DecompressionStream('deflate') : new CompressionStream('deflate'), { signal });
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new RangeError('Expanded snapshot exceeds byte limit; raise maxBytes deliberately');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

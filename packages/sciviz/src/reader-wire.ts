// Clean room: WHATWG HTML structured serialization and DOM cancellation.
import { rangeError } from '../../shared/errors.js';

export type WireNode =
  | { kind: 'value'; value: unknown }
  | { kind: 'signal' }
  | { kind: 'function'; id: number }
  | { kind: 'array'; items: WireNode[] }
  | { kind: 'object'; nullPrototype: boolean; entries: [string, WireNode][] };
export type RemoteFunction = (...args: unknown[]) => unknown;

/**
 * Run `visit` on a container with it on the ancestor path. The wire format is a tree: a shared object is copied, a
 * cycle (an object inside itself) is refused with a coded error instead of recursing until the stack overflows.
 */
export function nested<T>(value: object, path: Set<object>, visit: () => T): T {
  if (path.has(value))
    throw rangeError('Reader arguments and results must not contain themselves; pass a tree of values', 'sciviz');
  path.add(value);
  try {
    return visit();
  } finally {
    path.delete(value);
  }
}

export function encodeReader(
  value: unknown,
  functions: Map<number, RemoteFunction>,
  owner?: object,
  path = new Set<object>(),
): WireNode {
  if (typeof value === 'function') {
    const id = functions.size;
    functions.set(id, value.bind(owner) as RemoteFunction);
    return { kind: 'function', id };
  }
  if (value instanceof AbortSignal) return { kind: 'signal' };
  if (value instanceof URL) return { kind: 'value', value: value.href };
  if (value instanceof Headers) return { kind: 'value', value: [...value.entries()] };
  if (Array.isArray(value))
    return nested(value, path, () => ({
      kind: 'array',
      items: value.map((v) => encodeReader(v, functions, undefined, path)),
    }));
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null &&
    typeof (value as { read?: unknown }).read === 'function'
  ) {
    return {
      kind: 'object',
      nullPrototype: false,
      entries: [['read', encodeReader((value as { read: unknown }).read, functions, value)]],
    };
  }
  if (
    value &&
    typeof value === 'object' &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return nested(value, path, () => ({
      kind: 'object',
      nullPrototype: Object.getPrototypeOf(value) === null,
      entries: Object.entries(value).map(([k, v]) => [k, encodeReader(v, functions, value, path)]),
    }));
  }
  return { kind: 'value', value };
}

export function decodeReader(
  node: WireNode,
  method: (id: number, args: unknown[]) => Promise<unknown>,
  signal?: AbortSignal,
): unknown {
  switch (node.kind) {
    case 'value':
      return node.value;
    case 'signal':
      return signal;
    case 'function':
      return (...args: unknown[]) => method(node.id, args);
    case 'array':
      return node.items.map((v) => decodeReader(v, method, signal));
    case 'object': {
      const value = Object.fromEntries(node.entries.map(([k, v]) => [k, decodeReader(v, method, signal)]));
      return node.nullPrototype ? Object.assign(Object.create(null), value) : value;
    }
  }
}

/** Deduplicates backing buffers, including aliased views and nested metadata. */
export function readerBuffers(
  value: unknown,
  buffers = new Set<ArrayBuffer>(),
  path = new Set<object>(),
): ArrayBuffer[] {
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) {
    if (!(value.buffer instanceof ArrayBuffer))
      throw rangeError('Reader workers need owned ArrayBuffers, not shared memory', 'sciviz');
    buffers.add(value.buffer);
  } else if (value && typeof value === 'object')
    nested(value, path, () => Object.values(value).forEach((v) => readerBuffers(v, buffers, path)));
  return [...buffers];
}

export interface ReaderProtocol {
  open(reader: string, args: WireNode): Promise<WireNode>;
  invoke(id: number, args: WireNode): Promise<WireNode>;
}
export interface ReaderCallbacks {
  callback(id: number, args: WireNode): Promise<WireNode>;
}

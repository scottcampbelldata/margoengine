import { parseBinary, binaryMagic } from './binary.js';
import { parseASCII } from './ascii.js';

export type FBXValue = string | number | bigint | ArrayLike<number> | BigInt64Array;
export interface FBXNode {
  name: string;
  properties: FBXValue[];
  children: FBXNode[];
}
export interface FBXConnection {
  kind: 'OO' | 'OP';
  child: bigint;
  parent: bigint;
  property?: string;
}
export interface FBXDocument {
  roots: FBXNode[];
  objects: Map<bigint, FBXNode>;
  connections: FBXConnection[];
  version: number;
}

const INPUT_BYTES = 64 * 1024 * 1024;
const DECODED_BYTES = 128 * 1024 * 1024;
const ARRAY_BYTES = 64 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_PROPERTIES = 2_000_000;
const MAX_WORK = 128_000_000;

export function invalid(detail: string): never {
  throw new Error(`Invalid FBX: ${detail}`);
}

/** A single cumulative budget covers both front ends, including decoded arrays. */
export class ParseBudget {
  private bytes = 0;
  private arrays = 0;
  private nodes = 0;
  private properties = 0;
  private steps = 0;
  constructor(readonly signal?: AbortSignal) {
    this.check();
  }
  check(): void {
    this.signal?.throwIfAborted();
  }
  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > DECODED_BYTES - this.bytes)
      throw new RangeError('FBX decoded byte budget exceeded');
    this.bytes += bytes;
  }
  array(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ARRAY_BYTES - this.arrays)
      throw new RangeError('FBX decoded array byte budget exceeded');
    this.arrays += bytes;
    this.reserve(bytes);
  }
  node(depth: number): void {
    this.check();
    if (depth > 64 || ++this.nodes > MAX_NODES) throw new RangeError('FBX node budget exceeded');
    this.reserve(64);
  }
  property(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PROPERTIES - this.properties)
      throw new RangeError('FBX property budget exceeded');
    this.properties += count;
    this.reserve(count * 16);
    this.work(count);
  }
  work(count = 1): void {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_WORK - this.steps)
      throw new RangeError('FBX work budget exceeded');
    this.steps += count;
  }
}

export async function parseDocument(input: ArrayBuffer | ArrayBufferView, signal?: AbortSignal): Promise<FBXDocument> {
  const budget = new ParseBudget(signal);
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : invalid('expected bytes');
  if (bytes.byteLength < 32 || bytes.byteLength > INPUT_BYTES) throw new RangeError('FBX input budget exceeded');
  const binary = binaryMagic.every((value, index) => bytes[index] === value);
  const parsed = binary ? await parseBinary(bytes, budget) : parseASCII(bytes, budget);
  const { roots, version } = parsed;
  if (!Number.isInteger(version) || version < 7400 || version > 7700) invalid(`unsupported version ${version}`);
  const objects = new Map<bigint, FBXNode>(),
    connections: FBXConnection[] = [];
  for (const root of roots) {
    if (root.name !== 'Objects') continue;
    for (const node of root.children) {
      budget.work();
      const value = node.properties[0];
      if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isInteger(value))) continue;
      const key = id(value);
      if (key === 0n || objects.has(key)) invalid(`duplicate or reserved object id ${key}`);
      objects.set(key, node);
    }
  }
  for (const root of roots) {
    if (root.name !== 'Connections') continue;
    for (const node of root.children) {
      budget.work();
      if (node.name !== 'C' || (node.properties[0] !== 'OO' && node.properties[0] !== 'OP')) continue;
      const kind = node.properties[0],
        child = id(node.properties[1]),
        parent = id(node.properties[2]);
      if (!objects.has(child) || (parent !== 0n && !objects.has(parent)))
        invalid(`missing connection object ${child} -> ${parent}`);
      if (kind === 'OP' && typeof node.properties[3] !== 'string') invalid('missing connection property');
      connections.push({ kind, child, parent, ...(kind === 'OP' ? { property: node.properties[3] as string } : {}) });
    }
  }
  // References can form a much deeper graph than the nested document; use an
  // explicit stack so a hostile model chain never consumes the JS call stack.
  const parents = new Map<bigint, bigint[]>();
  for (const connection of connections) {
    if (
      connection.kind !== 'OO' ||
      objects.get(connection.child)?.name !== 'Model' ||
      objects.get(connection.parent)?.name !== 'Model'
    )
      continue;
    const list = parents.get(connection.child) ?? [];
    list.push(connection.parent);
    parents.set(connection.child, list);
  }
  const state = new Map<bigint, number>();
  for (const start of parents.keys()) {
    if (state.get(start) === 2) continue;
    const stack = [{ key: start, next: 0 }];
    state.set(start, 1);
    while (stack.length) {
      budget.work();
      const current = stack[stack.length - 1],
        list = parents.get(current.key) ?? [];
      if (current.next === list.length) {
        state.set(current.key, 2);
        stack.pop();
        continue;
      }
      const next = list[current.next++],
        color = state.get(next);
      if (color === 1) invalid('model hierarchy cycle');
      if (color !== 2) {
        state.set(next, 1);
        stack.push({ key: next, next: 0 });
      }
    }
  }
  budget.check();
  return { roots, objects, connections, version };
}

export function findChild(node: FBXNode, name: string): FBXNode | undefined {
  return node.children.find((child) => child.name === name);
}

export function array(node: FBXNode, name: string): ArrayLike<number> {
  const child = findChild(node, name),
    value = child?.properties[0];
  if (value && typeof value === 'object' && 'length' in value && !(value instanceof BigInt64Array))
    return value as ArrayLike<number>;
  if (child && child.properties.every((item) => typeof item === 'number')) return child.properties as number[];
  invalid(`missing numeric array ${name}`);
}

export function property(node: FBXNode, name: string, fallback?: unknown): unknown {
  const tuple = findChild(node, 'Properties70')?.children.find(
    (child) => child.name === 'P' && child.properties[0] === name,
  );
  const values = tuple ? tuple.properties.slice(4) : findChild(node, name)?.properties;
  return !values?.length ? fallback : values.length === 1 ? values[0] : values;
}

export function id(value: unknown): bigint {
  let result: bigint;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else invalid('object id must be an exact integer');
  if (result < -0x8000000000000000n || result > 0x7fffffffffffffffn) invalid('object id outside int64 range');
  return result;
}

export function objectName(node: FBXNode): string {
  const value = node.properties[1];
  if (typeof value !== 'string') return node.name;
  const name = value.split('\0', 1)[0],
    separator = name.indexOf('::');
  return separator < 0 ? name : name.slice(separator + 2);
}

import { defaultLimits, type FBXImportLimits } from './limits.js';
import { margoError } from '../../shared/errors.js';
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

export function invalid(detail: string): never {
  throw margoError('failed', `Invalid FBX: ${detail}; re-export the file from your 3D tool`);
}

/** A single cumulative budget covers both front ends, including decoded arrays. */
export class ParseBudget {
  private bytes = 0;
  private arrays = 0;
  private nodes = 0;
  private properties = 0;
  private steps = 0;
  constructor(
    readonly signal?: AbortSignal,
    readonly limits: Readonly<FBXImportLimits> = defaultLimits,
  ) {
    this.check();
  }
  check(): void {
    this.signal?.throwIfAborted();
  }
  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.decodedBytes - this.bytes)
      throw new RangeError(
        'FBX decoded byte budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    this.bytes += bytes;
  }
  array(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.arrayBytes - this.arrays)
      throw new RangeError(
        'FBX decoded array byte budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    this.arrays += bytes;
    this.reserve(bytes);
  }
  node(depth: number): void {
    this.check();
    if (depth > 64 || ++this.nodes > this.limits.nodes)
      throw new RangeError(
        'FBX node budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    this.reserve(64);
  }
  property(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits.properties - this.properties)
      throw new RangeError(
        'FBX property budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    this.properties += count;
    this.reserve(count * 16);
    this.work(count);
  }
  work(count = 1): void {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits.parseWork - this.steps)
      throw new RangeError(
        'FBX work budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    this.steps += count;
  }
}

export async function parseDocument(
  input: ArrayBuffer | ArrayBufferView,
  signal?: AbortSignal,
  limits: Readonly<FBXImportLimits> = defaultLimits,
): Promise<FBXDocument> {
  const budget = new ParseBudget(signal, limits);
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : invalid('expected bytes');
  if (bytes.byteLength < 32 || bytes.byteLength > limits.inputBytes)
    throw new RangeError(
      'FBX input budget exceeded; simplify or split the scene, the import limits are listed in the README',
    );
  const binary = binaryMagic.every((value, index) => bytes[index] === value);
  const parsed = binary ? await parseBinary(bytes, budget) : parseASCII(bytes, budget);
  const { roots, version } = parsed;
  if (!Number.isInteger(version) || version < 7100 || version > 7700) invalid(`unsupported version ${version}`);
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
      // The FBX SDK writes links to objects it left out of the file, such as curves on properties a plug-in owns: 27 of 195
      // real files here have them. Such a link joins nothing, so it goes, as the object it names never existed.
      if (!objects.has(child) || (parent !== 0n && !objects.has(parent))) continue;
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
  // Binary stores Name\0\x01Class, so all before the zero is the name, namespace included; ASCII stores Class::Name.
  return value.includes('\0') ? value.split('\0', 1)[0] : value.replace(/^.*?::/s, '');
}

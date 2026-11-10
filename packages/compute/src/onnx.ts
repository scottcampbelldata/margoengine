/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** ONNX's portable web tensor storage types. Half/bfloat16 use raw Uint16 bits; int4 uses packed low nibble first. */
export type OnnxDType =
  | 'float32'
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'string'
  | 'bool'
  | 'float16'
  | 'float64'
  | 'uint32'
  | 'uint64'
  | 'bfloat16'
  | 'uint4'
  | 'int4';
/** Host storage accepted and copied by an ONNX tensor. */
export type OnnxData =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | readonly string[];
const TYPES = [
  '',
  'float32',
  'uint8',
  'int8',
  'uint16',
  'int16',
  'int32',
  'int64',
  'string',
  'bool',
  'float16',
  'float64',
  'uint32',
  'uint64',
  '',
  '',
  'bfloat16',
  '',
  '',
  '',
  '',
  'uint4',
  'int4',
] as const;
const WIDTHS = [0, 4, 1, 1, 2, 2, 4, 8, 0, 1, 2, 8, 4, 8, 0, 0, 2, 0, 0, 0, 0, 0.5, 0.5];
const CONSTRUCTORS = [
  null,
  Float32Array,
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Int32Array,
  BigInt64Array,
  null,
  Uint8Array,
  Uint16Array,
  Float64Array,
  Uint32Array,
  BigUint64Array,
  null,
  null,
  Uint16Array,
  null,
  null,
  null,
  null,
  Uint8Array,
  Uint8Array,
];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(message: string): never {
  throw typeError(`ONNX: ${message}`, 'compute');
}
function count(shape: readonly number[]): number {
  if (shape.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 2147483647))
    invalid('dimensions must be integers in 0..2147483647');
  if (shape.includes(0)) return 0;
  const n = shape.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(n) || n > 16777216)
    throw rangeError('ONNX tensor exceeds 16777216 elements; split the tensor', 'compute');
  return n;
}
/** Owned host tensor. Construction copies the supplied data; returned inference tensors outlive their model. */
export class OnnxTensor {
  readonly dtype: OnnxDType;
  readonly shape: readonly number[];
  readonly data: OnnxData;
  constructor(dtype: OnnxDType, data: OnnxData, shape: readonly number[]) {
    const kind = TYPES.indexOf(dtype);
    const n = count(shape);
    if (kind < 1) invalid(`unknown tensor dtype ${String(dtype)}`);
    if (kind === 8) {
      if (!Array.isArray(data) || data.some((v) => typeof v !== 'string') || data.length !== n)
        invalid('string data must contain one string per element');
      this.data = Object.freeze([...data]);
    } else {
      const Type = CONSTRUCTORS[kind];
      if (!Type || !(data instanceof Type) || data.byteLength !== Math.ceil(n * WIDTHS[kind]))
        invalid(`${dtype} data has the wrong typed array or length`);
      this.data = (data as Exclude<OnnxData, readonly string[]>).slice();
      if (kind === 9 && (this.data as Uint8Array).some((v) => v > 1)) invalid('bool data must contain only 0 or 1');
    }
    this.dtype = dtype;
    this.shape = Object.freeze([...shape]);
  }
}
/** Sequences, maps and optional values retain their ONNX container structure. */
export type OnnxValue = OnnxTensor | readonly OnnxValue[] | ReadonlyMap<string | number | bigint, OnnxValue> | null;
/** Model-declared tensor or recursive container type, preserving symbolic and unknown dimensions. */
export interface OnnxType {
  readonly tag: 'tensor' | 'sparse' | 'sequence' | 'map' | 'optional';
  readonly kind?: number;
  readonly shape?: readonly (number | string | null)[] | null;
  readonly keyKind?: number;
  readonly element?: OnnxType;
}
/** Named graph input/output and its optional model-declared type. */
export interface OnnxValueInfo {
  readonly name: string;
  readonly type: OnnxType | null;
}
/** Exact external initializer byte range requested from the application's resolver. */
export interface OnnxExternalRequest {
  readonly location: string;
  readonly offset: number;
  readonly length: number;
  readonly checksum?: string;
  readonly signal?: AbortSignal;
}
/** Model loading, cancellation and persistent storage options. */
export interface OnnxLoadOptions {
  readonly signal?: AbortSignal;
  /** Persistent tensor storage budget, default 256 MiB; range 64 KiB..1 GiB. */
  readonly memoryLimit?: number;
  /** Resolve exactly the requested external byte range. URL sources otherwise use relative same-origin files. */
  readonly externalData?: (request: OnnxExternalRequest) => Promise<Uint8Array>;
}
/** Output selection, cancellation and bounded graph execution options. */
export interface OnnxRunOptions {
  readonly signal?: AbortSignal;
  /** Default: every graph output. Names must identify graph outputs. */
  readonly outputs?: readonly string[];
  /** Safety bound for each Loop/Scan, default 10000. */
  readonly maxIterations?: number;
  /** Maximum expanded node invocations per run, default 1000000. Function calls and loop bodies count. */
  readonly maxNodes?: number;
  /** Yield to the event loop every this many nodes, default 16. */
  readonly yieldEvery?: number;
}
interface Attribute {
  name: string;
  kind: number;
  reference: string;
  value: unknown;
}
interface Node {
  name: string;
  op: string;
  domain: string;
  overload: string;
  inputs: string[];
  outputs: string[];
  attributes: Attribute[];
  attributeSet: number;
  kernelIndex: number;
}
interface Initializer {
  name: string;
  id: number;
  kind: number;
  shape: number[];
  bytes: number;
  externalStorage?: boolean;
  external?: Record<string, string>;
  sparseValues?: Initializer;
  sparseIndices?: Initializer;
}
interface Graph {
  name: string;
  nodes: Node[];
  inputs: OnnxValueInfo[];
  outputs: OnnxValueInfo[];
  initializers: Initializer[];
}
interface FunctionDef {
  name: string;
  domain: string;
  overload: string;
  inputs: string[];
  outputs: string[];
  nodes: Node[];
  requiredAttributes: string[];
  defaults: Attribute[];
  defaultSet: number;
  opsets: Record<string, number>;
}
interface Metadata {
  irVersion: number;
  opsets: Record<string, number>;
  producer: string;
  producerVersion: string;
  domain: string;
  version: string;
  description: string;
  metadata: Record<string, string>;
  graph: Graph;
  functions: FunctionDef[];
}
interface Kernel {
  memory: WebAssembly.Memory;
  reserve(n: number): number;
  message_ptr(): number;
  message_len(): number;
  memory_limit(n: number): number;
  load_model(n: number): number;
  create_tensor(kind: number, rank: number, n: number): number;
  fill_external(id: number, n: number): number;
  fill_sparse(id: number, values: number, indices: number): number;
  resolve_attributes(id: number, n: number): number;
  supported(id: number, version: number): number;
  execute(id: number, attributes: number, version: number, n: number, nout: number): number;
  output(i: number): number;
  describe(id: number): number;
  data_ptr(id: number): number;
  data_len(id: number): number;
  scalar_bool(id: number): number;
  drop_tensor(id: number): number;
  live_bytes(): number;
  simd_groups(): bigint;
  random_seed(lo: number, hi: number): void;
  random_stream(id: number): void;
  release(): void;
  slice_tensor(id: number, axis: number, index: number, keep: number): number;
  concat_tensors(axis: number, newAxis: number, n: number): number;
}
type Value = number | readonly Value[] | ReadonlyMap<string | number | bigint, Value> | null;
function aborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
async function bytesFrom(url: URL, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  aborted(signal);
  if (url.protocol === 'file:') {
    const name = 'node:fs/promises';
    const fs = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
    return fs.readFile(url, { signal });
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw fault('failed', `ONNX load failed: HTTP ${response.status}`, 'compute');
  const bytes = new Uint8Array(await response.arrayBuffer());
  aborted(signal);
  return bytes;
}
function key(domain: string, name: string, overload: string): string {
  return JSON.stringify([domain === 'ai.onnx' ? '' : domain, name, overload]);
}
function graphs(attrs: readonly Attribute[]): Graph[] {
  return attrs.flatMap((a) => (a.kind === 5 ? [a.value as Graph] : a.kind === 10 ? (a.value as Graph[]) : []));
}
function dependencies(node: Node): Set<string> {
  const names = new Set(node.inputs.filter(Boolean));
  for (const graph of graphs(node.attributes)) {
    const defined = new Set([
      ...graph.inputs.map((v) => v.name),
      ...graph.initializers.map((v) => v.name),
      ...graph.nodes.flatMap((n) => n.outputs),
    ]);
    for (const child of graph.nodes) for (const name of dependencies(child)) if (!defined.has(name)) names.add(name);
    for (const output of graph.outputs) if (!defined.has(output.name)) names.add(output.name);
  }
  return names;
}

/** An isolated model session with lazy SIMD Wasm kernels and owned output snapshots. */
export class OnnxModel implements Disposable {
  readonly inputs: readonly OnnxValueInfo[];
  readonly outputs: readonly OnnxValueInfo[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly producer: string;
  readonly irVersion: number;
  #k: Kernel;
  #model: Metadata;
  #functions = new Map<string, FunctionDef>();
  #resolved = new Map<string, { id: number; attrs: Attribute[] }>();
  #streams = new Map<string, number>();
  #mapKinds = new WeakMap<object, number>();
  #sequenceKinds = new WeakMap<readonly Value[], number>();
  #validatedFunctions = new Map<string, number>();
  #dead = false;
  #busy = false;
  /** @internal Use loadOnnx. */
  constructor(kernel: Kernel, metadata: Metadata) {
    this.#k = kernel;
    this.#model = metadata;
    this.inputs = Object.freeze(metadata.graph.inputs);
    this.outputs = Object.freeze(metadata.graph.outputs);
    this.metadata = Object.freeze({ ...metadata.metadata });
    this.producer = metadata.producer;
    this.irVersion = metadata.irVersion;
    for (const fn of metadata.functions) {
      const id = key(fn.domain, fn.name, fn.overload);
      if (this.#functions.has(id)) invalid(`duplicate local function ${fn.domain}:${fn.name}`);
      this.#functions.set(id, fn);
    }
    this.#validate(metadata.graph, metadata.opsets, new Set(), new Set(), 0);
  }
  get work(): { readonly simdGroups: bigint; readonly liveBytes: number; readonly validatedFunctions: number } {
    this.#assert();
    return {
      simdGroups: this.#k.simd_groups(),
      liveBytes: this.#k.live_bytes(),
      validatedFunctions: this.#validatedFunctions.size,
    };
  }
  #assert(): void {
    if (this.#dead) throw fault('disposed', 'ONNX model is disposed; load a new session', 'compute');
  }
  #message(): string {
    return decoder.decode(new Uint8Array(this.#k.memory.buffer, this.#k.message_ptr(), this.#k.message_len()));
  }
  #check(n: number): number {
    if (n < 0) throw fault('failed', `ONNX: ${this.#message()}`, 'compute');
    return n;
  }
  #packet(bytes: Uint8Array): void {
    this.#assert();
    const ptr = this.#k.reserve(bytes.length);
    if (ptr === 0xffffffff) this.#check(-1);
    new Uint8Array(this.#k.memory.buffer, ptr, bytes.length).set(bytes);
  }
  #ids(ids: readonly number[]): void {
    this.#packet(new Uint8Array(Uint32Array.from(ids).buffer));
  }
  #attrs(node: Node, scopes: readonly number[]): { id: number; attrs: Attribute[] } {
    if (!node.attributes.some((a) => a.reference)) return { id: node.attributeSet, attrs: node.attributes };
    const cache = JSON.stringify([node.attributeSet, scopes]);
    let result = this.#resolved.get(cache);
    if (!result) {
      this.#ids(scopes);
      const id = this.#check(this.#k.resolve_attributes(node.attributeSet, scopes.length));
      result = { id, attrs: JSON.parse(this.#message()) as Attribute[] };
      this.#resolved.set(cache, result);
    }
    return result;
  }
  #validate(g: Graph, opsets: Record<string, number>, outer: Set<string>, active: Set<string>, depth: number): number {
    if (depth > 64) invalid('graph/function nesting exceeds 64');
    let height = 0;
    const names = new Set(outer);
    const local = new Set<string>();
    for (const info of g.inputs) {
      if (!info.name || local.has(info.name)) invalid(`duplicate graph input ${info.name}`);
      local.add(info.name);
      names.add(info.name);
    }
    const initializers = new Set<string>();
    for (const t of g.initializers) {
      if (!t.name || initializers.has(t.name)) invalid(`duplicate or unnamed initializer ${t.name}`);
      initializers.add(t.name);
      local.add(t.name);
      names.add(t.name);
    }
    for (const node of g.nodes) {
      for (const name of node.inputs)
        if (name && !names.has(name)) invalid(`${node.name || node.op} reads unavailable value ${name}`);
      const domain = node.domain === 'ai.onnx' ? '' : node.domain;
      const version = opsets[domain] ?? (this.irVersion < 3 && !domain ? 1 : undefined);
      if (version === undefined) invalid(`no opset import for domain ${domain}`);
      const fn = this.#functions.get(key(domain, node.op, node.overload));
      if (fn) {
        const id = key(domain, node.op, node.overload);
        if (active.has(id)) invalid(`recursive local function ${node.op}`);
        if (node.inputs.length !== fn.inputs.length || node.outputs.length !== fn.outputs.length)
          invalid(`function ${node.op} arity differs`);
        let fnHeight = this.#validatedFunctions.get(id);
        if (fnHeight === undefined) {
          const next = new Set(active);
          next.add(id);
          fnHeight =
            1 +
            this.#validate(
              {
                name: fn.name,
                nodes: fn.nodes,
                inputs: fn.inputs.map((name) => ({ name, type: null })),
                outputs: fn.outputs.map((name) => ({ name, type: null })),
                initializers: [],
              },
              fn.opsets,
              new Set(),
              next,
              depth + 1,
            );
          this.#validatedFunctions.set(id, fnHeight);
        }
        if (depth + fnHeight > 64) invalid('graph/function nesting exceeds 64');
        height = Math.max(height, fnHeight);
      } else if (
        !(
          (domain === 'ai.onnx.ml' && ['ZipMap', 'CastMap', 'DictVectorizer'].includes(node.op)) ||
          (!domain &&
            [
              'If',
              'Loop',
              'Scan',
              'SequenceEmpty',
              'SequenceConstruct',
              'SequenceAt',
              'SequenceErase',
              'SequenceInsert',
              'SequenceLength',
              'SplitToSequence',
              'ConcatFromSequence',
              'Optional',
              'OptionalGetElement',
              'OptionalHasElement',
              'SequenceMap',
              'StringNormalizer',
            ].includes(node.op))
        ) &&
        !this.#k.supported(node.kernelIndex, version)
      )
        throw fault(
          'unsupported',
          `ONNX operator ${domain || 'ai.onnx'}:${node.op} opset ${version} has no kernel or model-local function`,
          'compute',
        );
      for (const child of graphs(node.attributes))
        height = Math.max(height, 1 + this.#validate(child, opsets, names, active, depth + 1));
      for (const name of node.outputs) {
        if (!name) continue;
        if (local.has(name) || outer.has(name)) invalid(`value ${name} is assigned more than once`);
        local.add(name);
        names.add(name);
      }
    }
    const outputs = new Set<string>();
    for (const info of g.outputs) {
      if (!names.has(info.name) || outputs.has(info.name)) invalid(`missing or duplicate graph output ${info.name}`);
      outputs.add(info.name);
    }
    return height;
  }
  #upload(t: OnnxTensor, owned: Set<number>): number {
    const dims = new Uint8Array(Uint32Array.from(t.shape).buffer);
    let data: Uint8Array;
    if (t.dtype === 'string') {
      const strings = (t.data as readonly string[]).map((s) => encoder.encode(s));
      const length = 4 + strings.reduce((n, s) => n + 4 + s.length, 0);
      data = new Uint8Array(length);
      const view = new DataView(data.buffer);
      view.setUint32(0, strings.length, true);
      let at = 4;
      for (const s of strings) {
        view.setUint32(at, s.length, true);
        data.set(s, at + 4);
        at += 4 + s.length;
      }
    } else {
      const raw = t.data as Exclude<OnnxData, readonly string[]>;
      data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    const packet = new Uint8Array(dims.length + data.length);
    packet.set(dims);
    packet.set(data, dims.length);
    this.#packet(packet);
    const id = this.#check(this.#k.create_tensor(TYPES.indexOf(t.dtype), t.shape.length, packet.length));
    owned.add(id);
    return id;
  }
  #read(id: number): OnnxTensor {
    this.#check(this.#k.describe(id));
    const info = JSON.parse(this.#message()) as { kind: number; shape: number[]; strings: string[] | null };
    const dtype = TYPES[info.kind] as OnnxDType;
    if (info.kind === 8) return new OnnxTensor(dtype, info.strings!, info.shape);
    const ptr = this.#k.data_ptr(id);
    if (ptr === 0xffffffff) this.#check(-1);
    const length = this.#k.data_len(id);
    const Type = CONSTRUCTORS[info.kind]!;
    const data = new Type(this.#k.memory.buffer.slice(ptr, ptr + length));
    // Tensor<bool> host snapshots use canonical truth values. BitCast keeps the
    // original bits inside the graph, including a subsequent BitCast back.
    if (info.kind === 9)
      (data as Uint8Array).forEach((v, i) => {
        (data as Uint8Array)[i] = Number(v !== 0);
      });
    return new OnnxTensor(dtype, data, info.shape);
  }
  #input(
    v: OnnxValue,
    owned: Set<number>,
    depth = 0,
    active = new Set<OnnxValue>(),
    cache = new Map<OnnxValue, Value>(),
  ): Value {
    if (depth > 64) invalid('input container nesting exceeds 64');
    if (v === null) return null;
    if (cache.has(v)) return cache.get(v)!;
    if (active.has(v)) invalid('input containers must be acyclic');
    active.add(v);
    let value: Value;
    if (v instanceof OnnxTensor) value = this.#upload(v, owned);
    else if (Array.isArray(v)) value = v.map((t) => this.#input(t, owned, depth + 1, active, cache));
    else if (v instanceof Map) {
      const map = new Map<string | bigint, Value>();
      for (const [k, t] of v) {
        if (typeof k !== 'string' && typeof k !== 'bigint' && (typeof k !== 'number' || !Number.isSafeInteger(k)))
          invalid('map keys must be strings, bigint integers or safe integer numbers');
        const key = typeof k === 'number' ? BigInt(k) : k;
        if (typeof key === 'bigint' && (key < -(1n << 63n) || key >= 1n << 64n))
          invalid('map key is outside integer64 storage');
        if (map.has(key)) invalid('map contains duplicate integer keys represented as number and bigint');
        map.set(key, this.#input(t, owned, depth + 1, active, cache));
      }
      value = map;
    } else return invalid('feeds must contain OnnxTensor, sequences, maps or null');
    active.delete(v);
    cache.set(v, value);
    return value;
  }
  #output(v: Value, cache = new Map<Value, OnnxValue>()): OnnxValue {
    if (v === null) return null;
    if (cache.has(v)) return cache.get(v)!;
    let result: OnnxValue;
    if (typeof v === 'number') result = this.#read(v);
    else if (Array.isArray(v)) result = v.map((t) => this.#output(t, cache));
    else
      result = new Map(
        [...(v as ReadonlyMap<string | number | bigint, Value>)].map(([k, t]) => [k, this.#output(t, cache)]),
      );
    cache.set(v, result);
    return result;
  }
  #match(
    v: Value,
    type: OnnxType | null,
    symbols: Map<string, number>,
    cache = new WeakMap<object, Set<OnnxType>>(),
  ): void {
    if (!type) return;
    if (v !== null && typeof v === 'object') {
      const seen = cache.get(v) ?? new Set<OnnxType>();
      if (seen.has(type)) return;
      seen.add(type);
      cache.set(v, seen);
    }
    if (type.tag === 'optional') {
      if (v !== null) this.#match(v, type.element!, symbols, cache);
      return;
    }
    if (type.tag === 'sequence') {
      if (!Array.isArray(v)) invalid('sequence value expected');
      if (type.element?.tag === 'tensor') {
        const previous = this.#sequenceKinds.get(v);
        if (previous !== undefined && previous !== type.element.kind)
          invalid('sequence element type differs from its declaration');
        this.#sequenceKinds.set(v, type.element.kind!);
      }
      for (const item of v) this.#match(item, type.element!, symbols, cache);
      return;
    }
    if (type.tag === 'map') {
      if (!(v instanceof Map)) invalid('map value expected');
      if (type.element?.tag === 'tensor') this.#mapKinds.set(v, type.element.kind!);
      for (const [k, item] of v) {
        if (type.keyKind === 8 ? typeof k !== 'string' : typeof k !== 'bigint' && typeof k !== 'number')
          invalid('map key has the wrong type');
        if (type.keyKind !== 8) {
          const n = BigInt(k);
          const bits = type.keyKind === 6 || type.keyKind === 12 ? 32n : 64n;
          const unsigned = type.keyKind === 12 || type.keyKind === 13;
          const lower = unsigned ? 0n : -(1n << (bits - 1n));
          const upper = unsigned ? 1n << bits : 1n << (bits - 1n);
          if (n < lower || n >= upper) invalid('map key is outside its declared integer dtype');
        }
        this.#match(item, type.element!, symbols, cache);
      }
      return;
    }
    if (typeof v !== 'number') invalid('tensor value expected');
    this.#check(this.#k.describe(v));
    const info = JSON.parse(this.#message()) as { kind: number; shape: number[] };
    if (info.kind !== type.kind) invalid(`tensor type ${TYPES[info.kind]} differs from declared ${TYPES[type.kind!]}`);
    if (type.shape) {
      if (info.shape.length !== type.shape.length) invalid('tensor rank differs from declared shape');
      type.shape.forEach((d, i) => {
        if (typeof d === 'number' && d !== info.shape[i]) invalid(`tensor dimension ${i} differs from declared shape`);
        if (typeof d === 'string' && d) {
          const old = symbols.get(d);
          if (old !== undefined && old !== info.shape[i]) invalid(`symbolic dimension ${d} is inconsistent`);
          symbols.set(d, info.shape[i]);
        }
      });
    }
  }
  #tensor(v: Value | undefined): number {
    if (typeof v !== 'number') invalid('tensor input expected');
    return v;
  }
  #sequence(values: readonly Value[], kind?: number): readonly Value[] {
    if (kind !== undefined) this.#sequenceKinds.set(values, kind);
    return values;
  }
  #scalar(v: Value | undefined): number {
    const t = this.#read(this.#tensor(v));
    if (count(t.shape) !== 1 || t.dtype === 'string') invalid('numeric scalar input expected');
    const value = t.data[0];
    const n = Number(value);
    if (!Number.isSafeInteger(n)) invalid('control/index scalar must be a safe integer');
    return n;
  }
  #shape(v: Value | undefined): { kind: number; shape: number[] } {
    this.#check(this.#k.describe(this.#tensor(v)));
    return JSON.parse(this.#message()) as { kind: number; shape: number[] };
  }
  #slice(v: Value, axis: number, index: number, keep: boolean, state: RunState): number {
    const id = this.#check(this.#k.slice_tensor(this.#tensor(v), axis, index, Number(keep)));
    state.owned.add(id);
    return id;
  }
  #concat(values: readonly Value[], axis: number, newAxis: boolean, state: RunState): number {
    this.#ids(values.map((v) => this.#tensor(v)));
    const id = this.#check(this.#k.concat_tensors(axis, Number(newAxis), values.length));
    state.owned.add(id);
    return id;
  }
  #int(attrs: readonly Attribute[], name: string, defaultValue: number): number {
    const a = attrs.find((a) => a.name === name);
    if (!a) return defaultValue;
    if (a.kind !== 2) invalid(`attribute ${name} must be an integer`);
    const n = Number(a.value);
    if (!Number.isSafeInteger(n)) invalid(`attribute ${name} is outside safe integer range`);
    return n;
  }
  #list(attrs: readonly Attribute[], name: string): number[] | undefined {
    const a = attrs.find((a) => a.name === name);
    if (!a) return undefined;
    if (a.kind !== 7 || !Array.isArray(a.value)) invalid(`attribute ${name} must be integers`);
    return a.value.map((v) => {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) invalid(`attribute ${name} has an unsafe integer`);
      return n;
    });
  }
  #emptyScan(type: OnnxType | null, axis: number, state: RunState): number {
    if (!type || type.tag !== 'tensor' || !type.shape || type.shape.some((d) => typeof d !== 'number'))
      throw fault(
        'unsupported',
        'ONNX empty scan needs static element shape information; export static scan output dimensions',
        'compute',
      );
    const shape = type.shape as number[];
    const d = axis < 0 ? axis + shape.length + 1 : axis;
    if (d < 0 || d > shape.length) invalid('scan output axis is outside its rank');
    const dims = [...shape];
    dims.splice(d, 0, 0);
    const Type = CONSTRUCTORS[type.kind!]!;
    const data = type.kind === 8 ? [] : new Type(0);
    return this.#upload(new OnnxTensor(TYPES[type.kind!] as OnnxDType, data, dims), state.owned);
  }
  #sweep(state: RunState): void {
    const live = new Set<number>();
    const seen = new Set<object>();
    const visit = (v: Value): void => {
      if (typeof v === 'number') live.add(v);
      else if (v !== null) {
        if (seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) v.forEach(visit);
        else if (v instanceof Map) v.forEach(visit);
      }
    };
    for (const frame of state.frames) for (const value of frame.values()) visit(value);
    for (const id of state.owned)
      if (!live.has(id)) {
        this.#check(this.#k.drop_tensor(id));
        state.owned.delete(id);
      }
  }
  #mlMap(node: Node, values: readonly Value[], attrs: readonly Attribute[], state: RunState): Value[] {
    const integer = (name: string, fallback: number) => this.#int(attrs, name, fallback);
    const strings = (name: string): string[] | undefined => {
      const a = attrs.find((a) => a.name === name);
      if (!a) return undefined;
      if (a.kind !== 8 || !Array.isArray(a.value) || a.value.some((v) => typeof v !== 'string'))
        invalid(`${name} must be a string list`);
      return a.value as string[];
    };
    const ints = (name: string): bigint[] | undefined => {
      const a = attrs.find((a) => a.name === name);
      if (!a) return undefined;
      if (a.kind !== 7 || !Array.isArray(a.value)) invalid(`${name} must be an integer list`);
      return a.value.map((v) => BigInt(String(v)));
    };
    const text = (name: string, fallback: string): string => {
      const a = attrs.find((a) => a.name === name);
      if (!a) return fallback;
      if (a.kind !== 3 || typeof a.value !== 'string') invalid(`${name} must be a string`);
      return a.value;
    };
    const allowed =
      node.op === 'ZipMap'
        ? ['classlabels_int64s', 'classlabels_strings']
        : node.op === 'DictVectorizer'
          ? ['int64_vocabulary', 'string_vocabulary']
          : ['cast_to', 'map_form', 'max_map'];
    if (attrs.some((a) => !allowed.includes(a.name)) || values.length !== 1 || node.outputs.length !== 1)
      invalid(`${node.op} has invalid attributes or arity`);
    if (node.op === 'ZipMap') {
      const x = this.#read(this.#tensor(values[0]));
      if (x.dtype !== 'float32' || x.shape.length !== 2) invalid('ZipMap needs float32[N,C]');
      const a = ints('classlabels_int64s'),
        b = strings('classlabels_strings');
      if (!!a === !!b) invalid('ZipMap requires exactly one class label list');
      const labels = (a ?? b)!;
      if (labels.length !== x.shape[1] || new Set<string | bigint>(labels).size !== labels.length)
        invalid('ZipMap labels must be unique and match the class dimension');
      return [
        Array.from({ length: x.shape[0] }, (_, row) => {
          const result = new Map<string | bigint, Value>();
          labels.forEach((key, col) =>
            result.set(
              key,
              this.#upload(
                new OnnxTensor('float32', Float32Array.of(Number(x.data[row * labels.length + col])), []),
                state.owned,
              ),
            ),
          );
          this.#mapKinds.set(result, 1);
          return result;
        }),
      ];
    }
    const map = values[0];
    if (!(map instanceof Map)) invalid(`${node.op} needs a map`);
    const entries = [...map].map(([key, id]) => {
      const value = this.#read(this.#tensor(id));
      if (count(value.shape) !== 1) invalid(`${node.op} needs scalar map values`);
      return { key, value };
    });
    const inferred = entries.length ? TYPES.indexOf(entries[0].value.dtype) : this.#mapKinds.get(map);
    if (inferred === undefined || inferred === 0) invalid('an empty map requires its declared value dtype');
    if (entries.some(({ value }) => TYPES.indexOf(value.dtype) !== inferred)) invalid('map value dtypes differ');
    let kind = inferred,
      shape: number[],
      data: OnnxData;
    if (node.op === 'DictVectorizer') {
      const a = ints('int64_vocabulary'),
        b = strings('string_vocabulary');
      if (!!a === !!b) invalid('DictVectorizer requires one vocabulary');
      const vocabulary = (a ?? b)!;
      if (new Set<string | bigint>(vocabulary).size !== vocabulary.length)
        invalid('DictVectorizer vocabulary must be unique');
      const indices = new Map<string | bigint, number>(vocabulary.map((key, i) => [key, i]));
      shape = [1, vocabulary.length];
      const Type = CONSTRUCTORS[kind];
      data = kind === 8 ? Array<string>(vocabulary.length).fill('') : new Type!(vocabulary.length);
      for (const { key, value } of entries) {
        const normalized = typeof key === 'number' ? BigInt(key) : key;
        const at = indices.get(normalized);
        if (at === undefined) invalid('DictVectorizer input key is absent from the vocabulary');
        (data as unknown as (string | number | bigint)[])[at] = value.data[0];
      }
    } else {
      const cast = text('cast_to', 'TO_FLOAT'),
        form = text('map_form', 'DENSE');
      kind = cast === 'TO_FLOAT' ? 1 : cast === 'TO_INT64' ? 7 : cast === 'TO_STRING' ? 8 : 0;
      if (!kind || !['DENSE', 'SPARSE'].includes(form)) invalid('CastMap has an invalid cast_to or map_form');
      if (entries.some(({ key }) => typeof key !== 'number' && typeof key !== 'bigint'))
        invalid('CastMap keys must be int64');
      entries.sort((a, b) => (BigInt(a.key) < BigInt(b.key) ? -1 : BigInt(a.key) > BigInt(b.key) ? 1 : 0));
      const size = form === 'DENSE' ? entries.length : integer('max_map', 1);
      if (size < 0) invalid('CastMap max_map must be nonnegative');
      count([size]);
      shape = [size];
      data = kind === 8 ? Array<string>(size).fill('') : kind === 7 ? new BigInt64Array(size) : new Float32Array(size);
      entries.forEach(({ key, value }, j) => {
        const at = form === 'DENSE' ? j : Number(key);
        if (!Number.isSafeInteger(at) || at < 0 || at >= size) invalid('CastMap sparse key is outside max_map');
        const v = value.data[0];
        if (kind === 8) (data as string[])[at] = String(v);
        else if (kind === 7) {
          const n = typeof v === 'string' ? Number(v) : Number(v);
          if (!Number.isFinite(n)) invalid('CastMap integer conversion needs finite numeric data');
          (data as BigInt64Array)[at] =
            typeof v === 'string' && /^[+-]?\d+$/.test(v) ? BigInt(v) : BigInt(Math.trunc(n));
        } else {
          const n = Number(v);
          if (typeof v === 'string' && (!v.trim() || Number.isNaN(n))) invalid('CastMap string is not numeric');
          (data as Float32Array)[at] = n;
        }
      });
    }
    return [this.#upload(new OnnxTensor(TYPES[kind] as OnnxDType, data, shape), state.owned)];
  }
  async #containers(
    node: Node,
    values: readonly Value[],
    attrs: readonly Attribute[],
    env: Map<string, Value>,
    opsets: Record<string, number>,
    scopes: readonly number[],
    state: RunState,
    depth: number,
    path: string,
  ): Promise<Value[] | undefined> {
    if (node.domain === 'ai.onnx.ml' && ['ZipMap', 'DictVectorizer', 'CastMap'].includes(node.op)) {
      if ((opsets[node.domain] ?? 0) < 1 || (opsets[node.domain] ?? 0) > 5) invalid('ai.onnx.ml opset must be in 1..5');
      return this.#mlMap(node, values, attrs, state);
    }
    const integer = (name: string, defaultValue: number) => this.#int(attrs, name, defaultValue);
    const sequence = (v: Value | undefined): readonly Value[] => {
      if (!Array.isArray(v)) invalid('sequence input expected');
      return v;
    };
    const flag = (name: string, defaultValue: number) => {
      const n = integer(name, defaultValue);
      if (n !== 0 && n !== 1) invalid(`${name} must be 0 or 1`);
      return !!n;
    };
    const graph = (name: string): Graph => {
      const a = attrs.find((a) => a.name === name);
      if (!a || a.kind !== 5) invalid(`${node.op} requires graph attribute ${name}`);
      return a.value as Graph;
    };
    const bool = (v: Value) => !!this.#check(this.#k.scalar_bool(this.#tensor(v)));
    const scalar = (kind: 'int64' | 'bool', n: number) =>
      this.#upload(
        new OnnxTensor(kind, kind === 'int64' ? BigInt64Array.of(BigInt(n)) : Uint8Array.of(n), []),
        state.owned,
      );
    switch (node.op) {
      case 'StringNormalizer': {
        if ((opsets[''] ?? 1) < 10 || values.length !== 1 || node.outputs.length !== 1)
          invalid('StringNormalizer needs opset >=10 and one input/output');
        const x = this.#read(this.#tensor(values[0]));
        if (x.dtype !== 'string' || !(x.shape.length === 1 || (x.shape.length === 2 && x.shape[0] === 1)))
          invalid('StringNormalizer needs string[C] or string[1,C]');
        if (attrs.some((a) => !['case_change_action', 'is_case_sensitive', 'locale', 'stopwords'].includes(a.name)))
          invalid('unknown StringNormalizer attribute');
        const text = (name: string, fallback: string) => {
          const a = attrs.find((a) => a.name === name);
          if (!a) return fallback;
          if (a.kind !== 3 || typeof a.value !== 'string') invalid(`${name} must be a string`);
          return a.value;
        };
        const action = text('case_change_action', 'NONE');
        if (!['NONE', 'LOWER', 'UPPER'].includes(action)) invalid('invalid StringNormalizer case action');
        const requested = text('locale', 'en-US');
        const locale =
          requested === 'C' || requested === 'POSIX' ? 'en-US' : requested.replaceAll('_', '-').replace(/\..*$/, '');
        try {
          Intl.getCanonicalLocales(locale);
        } catch {
          invalid('StringNormalizer locale is invalid');
        }
        const attr = attrs.find((a) => a.name === 'stopwords');
        if (
          attr &&
          (attr.kind !== 8 ||
            !Array.isArray(attr.value) ||
            (attr.value as unknown[]).some((v) => typeof v !== 'string'))
        )
          invalid('stopwords must be strings');
        const sensitive = flag('is_case_sensitive', 0);
        const normalize = (s: string) => (sensitive ? s : s.toLocaleLowerCase(locale));
        const stops = new Set(((attr?.value ?? []) as string[]).map(normalize));
        const output = (x.data as readonly string[])
          .filter((s) => !stops.has(normalize(s)))
          .map((s) =>
            action === 'LOWER' ? s.toLocaleLowerCase(locale) : action === 'UPPER' ? s.toLocaleUpperCase(locale) : s,
          );
        if (!output.length) output.push('');
        const shape = x.shape.length === 1 ? [output.length] : [1, output.length];
        return [this.#upload(new OnnxTensor('string', output, shape), state.owned)];
      }
      case 'SequenceMap': {
        if ((opsets[''] ?? 1) < 17) invalid('SequenceMap requires opset >=17');
        const first = sequence(values[0]);
        const body = graph('body');
        if (body.inputs.length !== values.length || body.outputs.length !== node.outputs.length || attrs.length !== 1)
          invalid('SequenceMap body input/output count differs');
        for (const v of values)
          if (Array.isArray(v) && v.length !== first.length) invalid('SequenceMap sequence lengths differ');
        if (first.length > state.max)
          throw fault('failed', 'ONNX SequenceMap exceeds maxIterations; increase its safety bound', 'compute');
        const result: Value[][] = Array.from({ length: body.outputs.length }, () => []);
        state.frames.push(new Map([['mapped', result]]));
        try {
          for (let j = 0; j < first.length; j++) {
            const args = new Map(env);
            values.forEach((v, i) => args.set(body.inputs[i].name, Array.isArray(v) ? v[j] : v));
            const output = await this.#graph(body, args, opsets, scopes, state, depth + 1, path);
            output.forEach((v, i) => result[i].push(v));
            this.#sweep(state);
          }
          return result.map((v, i) => this.#sequence(v, body.outputs[i].type?.kind));
        } finally {
          state.frames.pop();
        }
      }
      case 'Identity':
        if (values.length !== 1) invalid('Identity expects one input');
        if (node.outputs.length !== 1 || attrs.length) invalid('Identity expects one output and no attributes');
        if (typeof values[0] === 'object' && (opsets[''] ?? opsets['ai.onnx'] ?? 1) < (values[0] === null ? 16 : 14))
          invalid('container Identity needs a newer ONNX opset');
        return [values[0]];
      case 'SequenceEmpty': {
        const kind = integer('dtype', 1);
        if (kind < 1 || !TYPES[kind]) invalid('SequenceEmpty dtype must be a supported tensor type');
        return [this.#sequence([], kind)];
      }
      case 'SequenceConstruct':
        if (!values.length) invalid('SequenceConstruct needs at least one tensor');
        {
          const kind = this.#shape(values[0]).kind;
          for (const v of values) if (this.#shape(v).kind !== kind) invalid('sequence tensor element types differ');
          return [this.#sequence([...values], kind)];
        }
      case 'SequenceLength':
        return [scalar('int64', sequence(values[0]).length)];
      case 'SequenceAt': {
        const seq = sequence(values[0]);
        const p = this.#scalar(values[1]);
        const at = p < 0 ? p + seq.length : p;
        if (at < 0 || at >= seq.length) invalid('SequenceAt position is outside its sequence');
        return [seq[at]];
      }
      case 'SequenceInsert': {
        const seq = sequence(values[0]);
        const p = values[2] == null ? seq.length : this.#scalar(values[2]);
        const at = p < 0 ? p + seq.length : p;
        if (at < 0 || at > seq.length) invalid('SequenceInsert position is outside its sequence');
        const value = this.#tensor(values[1]);
        const kind = this.#sequenceKinds.get(seq) ?? (seq.length ? this.#shape(seq[0]).kind : undefined);
        if (kind !== undefined && kind !== this.#shape(value).kind) invalid('SequenceInsert element type differs');
        const result = [...seq];
        result.splice(at, 0, value);
        return [this.#sequence(result, kind ?? this.#shape(value).kind)];
      }
      case 'SequenceErase': {
        const seq = sequence(values[0]);
        const p = values[1] == null ? -1 : this.#scalar(values[1]);
        const at = p < 0 ? p + seq.length : p;
        if (at < 0 || at >= seq.length) invalid('SequenceErase position is outside its sequence');
        const result = [...seq];
        result.splice(at, 1);
        return [this.#sequence(result, this.#sequenceKinds.get(seq))];
      }
      case 'ConcatFromSequence':
        return [this.#concat(sequence(values[0]), integer('axis', 0), flag('new_axis', 0), state)];
      case 'SplitToSequence': {
        const value = this.#tensor(values[0]);
        const shape = this.#shape(value).shape;
        let axis = integer('axis', 0);
        if (axis < 0) axis += shape.length;
        if (axis < 0 || axis >= shape.length) invalid('SplitToSequence axis is outside its rank');
        const keep = flag('keepdims', 1);
        let sizes: number[];
        if (values[1] != null) {
          const split = this.#read(this.#tensor(values[1]));
          if (split.dtype !== 'int32' && split.dtype !== 'int64') invalid('SplitToSequence split must be int32/int64');
          if (split.shape.length === 0) {
            const n = this.#scalar(values[1]);
            if (n <= 0) invalid('SplitToSequence scalar split must be positive');
            sizes = Array.from({ length: Math.ceil(shape[axis] / n) }, (_, i) => Math.min(n, shape[axis] - i * n));
          } else {
            if (split.shape.length !== 1) invalid('SplitToSequence split must be scalar or rank one');
            sizes = Array.from(split.data as BigInt64Array, (v) => Number(v));
          }
        } else sizes = Array(shape[axis]).fill(1) as number[];
        if (sizes.some((n) => !Number.isSafeInteger(n) || n < 0) || sizes.reduce((a, b) => a + b, 0) !== shape[axis])
          invalid('SplitToSequence lengths must be nonnegative and sum to its axis');
        if (!keep && sizes.some((n) => n !== 1)) invalid('SplitToSequence keepdims=0 needs unit splits');
        const result: Value[] = [];
        let start = 0;
        for (const size of sizes) {
          const slices = Array.from({ length: size }, (_, i) => this.#slice(value, axis, start + i, keep, state));
          if (!slices.length) {
            const dims = [...shape];
            dims[axis] = 0;
            const Type = CONSTRUCTORS[this.#shape(value).kind]!;
            result.push(
              this.#upload(
                new OnnxTensor(TYPES[this.#shape(value).kind] as OnnxDType, Type ? new Type(0) : [], dims),
                state.owned,
              ),
            );
          } else result.push(slices.length === 1 ? slices[0] : this.#concat(slices, axis, false, state));
          start += size;
        }
        return [this.#sequence(result, this.#shape(value).kind)];
      }
      case 'Optional':
        return [values[0] ?? null];
      case 'OptionalHasElement':
        return [scalar('bool', Number(values[0] != null))];
      case 'OptionalGetElement':
        if (values[0] == null) invalid('OptionalGetElement received an empty optional');
        return [values[0]];
      case 'Loop': {
        const body = graph('body');
        const carried = values.slice(2);
        if (body.inputs.length !== carried.length + 2 || body.outputs.length < carried.length + 1)
          invalid('Loop body input/output count differs from carried values');
        let current = [...carried];
        let condition = values[1] == null ? true : bool(values[1]);
        const trip = values[0] == null ? undefined : this.#scalar(values[0]);
        const scanned: Value[][] = Array.from({ length: body.outputs.length - current.length - 1 }, () => []);
        let iteration = 0;
        const roots = new Map<string, Value>([
          ['current', current],
          ['scanned', scanned],
        ]);
        state.frames.push(roots);
        try {
          while (condition && (trip === undefined || iteration < trip)) {
            if (iteration >= state.max)
              throw fault('failed', 'ONNX Loop reached maxIterations; increase its explicit safety bound', 'compute');
            const args = new Map(env);
            args.set(body.inputs[0].name, scalar('int64', iteration));
            args.set(body.inputs[1].name, scalar('bool', Number(condition)));
            current.forEach((v, i) => args.set(body.inputs[i + 2].name, v));
            const outputs = await this.#graph(body, args, opsets, scopes, state, depth + 1, path);
            condition = bool(outputs[0]);
            current = outputs.slice(1, 1 + carried.length);
            scanned.forEach((v, i) => v.push(outputs[1 + carried.length + i]));
            roots.set('current', current);
            this.#sweep(state);
            iteration++;
          }
          return [
            ...current,
            ...scanned.map((v, i) =>
              v.length
                ? this.#concat(v, 0, true, state)
                : this.#emptyScan(body.outputs[1 + carried.length + i].type, 0, state),
            ),
          ];
        } finally {
          state.frames.pop();
        }
      }
      case 'Scan': {
        const body = graph('body');
        const n = integer('num_scan_inputs', 0);
        if (n < 1 || n > values.length) invalid('Scan num_scan_inputs must identify its final inputs');
        const count = values.length - n;
        let current = values.slice(0, count);
        const scans = values.slice(count);
        if (body.inputs.length !== values.length || body.outputs.length < count)
          invalid('Scan body input/output count differs');
        const axes = this.#list(attrs, 'scan_input_axes') ?? (Array(n).fill(0) as number[]);
        const directions = this.#list(attrs, 'scan_input_directions') ?? (Array(n).fill(0) as number[]);
        const nout = body.outputs.length - count;
        const outAxes = this.#list(attrs, 'scan_output_axes') ?? (Array(nout).fill(0) as number[]);
        const outDirections = this.#list(attrs, 'scan_output_directions') ?? (Array(nout).fill(0) as number[]);
        if (
          axes.length !== n ||
          directions.length !== n ||
          outAxes.length !== nout ||
          outDirections.length !== nout ||
          [...directions, ...outDirections].some((v) => v !== 0 && v !== 1)
        )
          invalid('Scan axes/direction lists have invalid lengths or flags');
        const lengths = scans.map((v, i) => {
          const shape = this.#shape(v).shape;
          const d = axes[i] < 0 ? axes[i] + shape.length : axes[i];
          if (d < 0 || d >= shape.length) invalid('Scan input axis is outside its rank');
          axes[i] = d;
          return shape[d];
        });
        if (lengths.some((v) => v !== lengths[0])) invalid('Scan input axis lengths differ');
        if (lengths[0] > state.max)
          throw fault('failed', 'ONNX Scan exceeds maxIterations; increase its explicit safety bound', 'compute');
        const scanned: Value[][] = Array.from({ length: nout }, () => []);
        const roots = new Map<string, Value>([
          ['current', current],
          ['scanned', scanned],
        ]);
        state.frames.push(roots);
        try {
          for (let step = 0; step < lengths[0]; step++) {
            const args = new Map(env);
            current.forEach((v, i) => args.set(body.inputs[i].name, v));
            scans.forEach((v, i) =>
              args.set(
                body.inputs[count + i].name,
                this.#slice(v, axes[i], directions[i] ? lengths[i] - 1 - step : step, false, state),
              ),
            );
            const outputs = await this.#graph(body, args, opsets, scopes, state, depth + 1, path);
            current = outputs.slice(0, count);
            scanned.forEach((v, i) => v.push(outputs[count + i]));
            roots.set('current', current);
            this.#sweep(state);
          }
          return [
            ...current,
            ...scanned.map((v, i) =>
              v.length
                ? this.#concat(outDirections[i] ? [...v].reverse() : v, outAxes[i], true, state)
                : this.#emptyScan(body.outputs[count + i].type, outAxes[i], state),
            ),
          ];
        } finally {
          state.frames.pop();
        }
      }
      default:
        return undefined;
    }
  }
  /** Execute one inference. A session rejects overlapping runs; use separate sessions for parallel inference. */
  async run(
    feeds: Readonly<Record<string, OnnxValue>>,
    options: OnnxRunOptions = {},
  ): Promise<Readonly<Record<string, OnnxValue>>> {
    this.#assert();
    aborted(options.signal);
    if (this.#busy)
      throw fault('failed', 'ONNX session is already running; await its run or use another session', 'compute');
    const max = options.maxIterations ?? 10000;
    const maxNodes = options.maxNodes ?? 1000000;
    const yieldEvery = options.yieldEvery ?? 16;
    if (
      !Number.isSafeInteger(max) ||
      max < 1 ||
      !Number.isSafeInteger(yieldEvery) ||
      yieldEvery < 1 ||
      !Number.isSafeInteger(maxNodes) ||
      maxNodes < 1
    )
      invalid('maxIterations, maxNodes and yieldEvery must be positive integers');
    const requested = options.outputs ?? this.outputs.map((v) => v.name);
    if (new Set(requested).size !== requested.length || requested.some((n) => !this.outputs.some((v) => v.name === n)))
      invalid('requested outputs must be unique declared graph outputs');
    const owned = new Set<number>();
    const symbols = new Map<string, number>();
    this.#busy = true;
    try {
      const env = new Map<string, Value>();
      const initializers = new Map(this.#model.graph.initializers.map((t) => [t.name, t.id]));
      for (const name of Object.keys(feeds))
        if (!this.inputs.some((v) => v.name === name)) invalid(`unknown model input ${name}`);
      for (const info of this.inputs) {
        const v = Object.hasOwn(feeds, info.name)
          ? this.#input(feeds[info.name], owned)
          : (initializers.get(info.name) ?? (info.type?.tag === 'optional' ? null : undefined));
        if (v === undefined) invalid(`missing model input ${info.name}`);
        this.#match(v, info.type, symbols);
        env.set(info.name, v);
      }
      const state = { owned, options, max, yieldEvery, nodes: 0, symbols, frames: [] };
      const result = await this.#graph(this.#model.graph, env, this.#model.opsets, [], state, 0, '');
      const output: Record<string, OnnxValue> = Object.create(null);
      for (const name of requested) {
        const i = this.outputs.findIndex((v) => v.name === name);
        output[name] = this.#output(result[i]);
      }
      return Object.freeze(output);
    } finally {
      if (!this.#dead) for (const id of owned) this.#check(this.#k.drop_tensor(id));
      this.#busy = false;
    }
  }
  async #graph(
    g: Graph,
    env: Map<string, Value>,
    opsets: Record<string, number>,
    scopes: readonly number[],
    state: RunState,
    depth: number,
    path: string,
  ): Promise<Value[]> {
    if (depth > 64) invalid('runtime graph nesting exceeds 64');
    const local = new Map(env);
    for (const t of g.initializers)
      if (!local.has(t.name) || !g.inputs.some((v) => v.name === t.name)) local.set(t.name, t.id);
    for (const info of g.inputs) {
      const value = local.get(info.name);
      if (value === undefined) invalid(`missing graph input ${info.name}`);
      this.#match(value, info.type, state.symbols);
    }
    const uses = new Map<string, number>();
    for (const node of g.nodes) for (const name of dependencies(node)) uses.set(name, (uses.get(name) ?? 0) + 1);
    for (const info of g.outputs) uses.set(info.name, (uses.get(info.name) ?? 0) + 1);
    for (const name of local.keys()) if (!uses.has(name)) local.delete(name);
    state.frames.push(local);
    try {
      for (const node of g.nodes) {
        const nodePath = `${path}/${node.kernelIndex}`;
        this.#assert();
        aborted(state.options.signal);
        if (++state.nodes > (state.options.maxNodes ?? 1000000))
          throw fault('failed', 'ONNX inference reached maxNodes; increase its explicit work bound', 'compute');
        if (state.nodes % state.yieldEvery === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          this.#assert();
          aborted(state.options.signal);
        }
        const values = node.inputs.map((n) => (n ? local.get(n) : null));
        if (values.some((v) => v === undefined)) invalid(`missing input while executing ${node.op}`);
        const resolved = this.#attrs(node, scopes);
        const fn = this.#functions.get(key(node.domain, node.op, node.overload));
        let output: Value[] | undefined;
        if (fn) {
          for (const name of fn.requiredAttributes)
            if (!resolved.attrs.some((a) => a.name === name) && !fn.defaults.some((a) => a.name === name))
              invalid(`function ${fn.name} is missing attribute ${name}`);
          const args = new Map(fn.inputs.map((name, i) => [name, values[i]!]));
          output = await this.#graph(
            {
              name: fn.name,
              nodes: fn.nodes,
              inputs: fn.inputs.map((name) => ({ name, type: null })),
              outputs: fn.outputs.map((name) => ({ name, type: null })),
              initializers: [],
            },
            args,
            fn.opsets,
            [resolved.id, fn.defaultSet],
            state,
            depth + 1,
            nodePath,
          );
        } else if (node.op === 'If') {
          const condition = values[0];
          if (typeof condition !== 'number') invalid('If condition must be a bool tensor');
          const yes = !!this.#check(this.#k.scalar_bool(condition));
          const attr = resolved.attrs.find((a) => a.name === (yes ? 'then_branch' : 'else_branch'));
          if (!attr || attr.kind !== 5) invalid('If requires then_branch and else_branch graphs');
          const branch = attr.value as Graph;
          if (branch.inputs.length) invalid('If branch graphs must capture values rather than declare inputs');
          output = await this.#graph(branch, local, opsets, scopes, state, depth + 1, nodePath);
        } else if (
          (output = await this.#containers(
            node,
            values as Value[],
            resolved.attrs,
            local,
            opsets,
            scopes,
            state,
            depth,
            nodePath,
          )) === undefined
        ) {
          if (values.some((v) => v !== null && typeof v !== 'number')) invalid(`${node.op} needs tensor inputs`);
          const version = opsets[node.domain === 'ai.onnx' ? '' : node.domain] ?? 1;
          this.#ids(values.map((v) => (v === null ? 0 : (v as number))));
          if (/^(RandomUniform|RandomNormal|Bernoulli|Multinomial|Dropout)/.test(node.op)) {
            let stream = this.#streams.get(nodePath);
            if (stream === undefined) {
              if (this.#streams.size >= 1000000) invalid('random call sites exceed one million');
              stream = this.#streams.size;
              this.#streams.set(nodePath, stream);
            }
            this.#k.random_stream(stream);
          }
          const n = this.#check(
            this.#k.execute(node.kernelIndex, resolved.id, version, values.length, node.outputs.length),
          );
          output = Array.from({ length: n }, (_, i) => {
            const id = this.#k.output(i);
            state.owned.add(id);
            return id;
          });
        }
        if (output.length < node.outputs.length) invalid(`${node.op} returned fewer outputs than declared`);
        node.outputs.forEach((name, i) => {
          if (name) local.set(name, output[i]);
        });
        for (const name of dependencies(node)) {
          const n = uses.get(name)! - 1;
          uses.set(name, n);
          if (n === 0) local.delete(name);
        }
        for (const name of node.outputs) if (!uses.has(name)) local.delete(name);
        this.#sweep(state);
      }
      return g.outputs.map((info) => {
        const value = local.get(info.name);
        if (value === undefined) invalid(`graph output ${info.name} is unavailable`);
        this.#match(value, info.type, state.symbols);
        return value;
      });
    } finally {
      state.frames.pop();
    }
  }
  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#k.release();
    this.#resolved.clear();
    this.#streams.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
interface RunState {
  owned: Set<number>;
  options: OnnxRunOptions;
  max: number;
  yieldEvery: number;
  nodes: number;
  symbols: Map<string, number>;
  frames: Map<string, Value>[];
}

/** Parse a binary ONNX ModelProto and load inline, sparse and external initializers. Nothing loads on import. */
export async function loadOnnx(
  source: Uint8Array | ArrayBuffer | URL | string,
  options: OnnxLoadOptions = {},
): Promise<OnnxModel> {
  aborted(options.signal);
  const asset = new URL(/* @vite-ignore */ './onnx-kernel.wasm?no-inline', import.meta.url);
  let kernel: Kernel | undefined;
  try {
    const wasmUrl = new URL(asset);
    if (wasmUrl.protocol === 'file:') wasmUrl.search = '';
    const wasm = await bytesFrom(wasmUrl, options.signal);
    const { instance } = await WebAssembly.instantiate(wasm);
    kernel = instance.exports as unknown as Kernel;
    const message = () =>
      decoder.decode(new Uint8Array(kernel!.memory.buffer, kernel!.message_ptr(), kernel!.message_len()));
    const check = (n: number) => {
      if (n < 0) throw fault('failed', `ONNX: ${message()}`, 'compute');
      return n;
    };
    if (options.memoryLimit !== undefined) {
      if (!Number.isSafeInteger(options.memoryLimit)) invalid('memoryLimit must be an integer byte count');
      check(kernel.memory_limit(options.memoryLimit));
    }
    const url =
      typeof source === 'string'
        ? new URL(source, globalThis.location?.href)
        : source instanceof URL
          ? source
          : undefined;
    const bytes = url
      ? await bytesFrom(url, options.signal)
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : (source as Uint8Array);
    const packet = (data: Uint8Array) => {
      const ptr = kernel!.reserve(data.length);
      if (ptr === 0xffffffff) check(-1);
      new Uint8Array(kernel!.memory.buffer, ptr, data.length).set(data);
    };
    packet(bytes);
    check(kernel.load_model(bytes.length));
    const metadata = JSON.parse(message()) as Metadata;
    const seed = crypto.getRandomValues(new Uint32Array(2));
    kernel.random_seed(seed[0], seed[1]);
    const loaded = new Set<number>();
    const files = new Map<string, Uint8Array>();
    const initialize = async (t: Initializer): Promise<void> => {
      if (loaded.has(t.id)) return;
      aborted(options.signal);
      if (t.externalStorage) {
        const external = t.external!;
        const location = external.location;
        if (!location) invalid('external tensor has no location');
        const decimal = (s: string | undefined, defaultValue: number): number => {
          if (s === undefined) return defaultValue;
          if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)))
            invalid('external offset/length must be safe nonnegative decimal integers');
          return Number(s);
        };
        const offset = decimal(external.offset, 0);
        const length = decimal(external.length, t.bytes);
        if (length !== t.bytes) invalid('external data length differs from tensor storage size');
        let data: Uint8Array;
        if (options.externalData)
          data = await options.externalData({
            location,
            offset,
            length,
            checksum: external.checksum,
            signal: options.signal,
          });
        else {
          if (!url) invalid('external tensor needs a URL source or externalData resolver');
          if (/^[a-z][a-z0-9+.-]*:|^[\\/]|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(location))
            invalid(
              'external location must be a relative path without parent traversal; use externalData for other locations',
            );
          const target = new URL(location, url);
          if (target.origin !== url.origin)
            invalid('external location must have the model origin; use externalData for another origin');
          const cache = target.href;
          let file = files.get(cache);
          if (!file) {
            file = await bytesFrom(target, options.signal);
            files.set(cache, file);
          }
          if (offset + length > file.length) invalid('external tensor range exceeds its file');
          data = file.subarray(offset, offset + length);
        }
        aborted(options.signal);
        if (!(data instanceof Uint8Array) || data.length !== length)
          invalid('externalData must return exactly the requested bytes');
        packet(data);
        check(kernel!.fill_external(t.id, data.length));
      }
      if (t.sparseValues && t.sparseIndices) {
        await initialize(t.sparseValues);
        await initialize(t.sparseIndices);
        check(kernel!.fill_sparse(t.id, t.sparseValues.id, t.sparseIndices.id));
      }
      loaded.add(t.id);
    };
    const visit = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== 'object') return;
      if ('id' in value && 'shape' in value && 'kind' in value) {
        await initialize(value as Initializer);
        return;
      }
      for (const item of Object.values(value))
        if (Array.isArray(item)) {
          for (const v of item) await visit(v);
        } else await visit(item);
    };
    await visit(metadata);
    aborted(options.signal);
    return new OnnxModel(kernel, metadata);
  } catch (error) {
    kernel?.release();
    aborted(options.signal);
    throw error;
  }
}

// VRM 1.0 first person, from the VRM Consortium's VRMC_vrm 1.0 specification (firstPerson.md, lookAt.md): each mesh
// annotation says which cameras draw a mesh. `thirdPersonOnly` hides it from the first-person cameras (the head seen
// from inside), `firstPersonOnly` shows it to them alone, `both` to every camera, and `auto` (also a mesh with no
// annotation) splits a skinned mesh into the triangles with skin weight on the head or a bone below it, drawn in third
// person only, and the rest, drawn by every camera. The split is a change to the file before it loads, so the loaded
// model holds plain nodes and the visibility is render layers (@margoengine/cameras/layers), which every view, mirror
// and XR eye already filters by. Compressed geometry (KHR_draco_mesh_compression, EXT_meshopt_compression) is read
// through @margoengine/decoders, loaded only for a file that needs it.
import type { EngineKernel } from '@margoengine/core';
import type { Camera } from '@margoengine/core/extension';
import type { GLTFLoadOptions, PBRModel } from '@margoengine/gltf/pbr';
import { MargoError } from '@margoengine/math/errors';
import { GLB_BIN, GLB_JSON, GLB_MAGIC, glbChunks, isGLB } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import {
  FIRST_PERSON_ONLY_LAYER,
  THIRD_PERSON_ONLY_LAYER,
  renderLayers,
  setRenderLayers,
} from '../../shared/layers.js';
import { readResponse } from '../../shared/loading.js';
import { readVRM, type VRMDocument } from './vrm.js';

export { FIRST_PERSON_ONLY_LAYER, THIRD_PERSON_ONLY_LAYER };

/** Which cameras draw a mesh (`firstPerson.meshAnnotations[].type`). */
export type VRMFirstPersonType = 'auto' | 'both' | 'thirdPersonOnly' | 'firstPersonOnly';

/** What a Draco decoder returns for one primitive; @margoengine/decoders' `DracoDecoder` matches it. */
export interface VRMDracoGeometry {
  vertexCount: number;
  positions?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  colors?: ArrayLike<number>;
  indices?: ArrayLike<number>;
  attributes?: Record<string, { array: ArrayLike<number> }>;
}

/** Options of {@link splitVRMFirstPerson}. */
export interface SplitVRMFirstPersonOptions {
  /**
   * Skin weight a vertex must exceed on the head or a bone below it to belong to the head. Default 0: any weight, as
   * the specification describes. Raise it to keep collar triangles with a stray head weight in first person.
   */
  threshold?: number;
  /** Cancels the split, also while a Draco decoder runs. */
  signal?: AbortSignal;
  /**
   * Decoder for KHR_draco_mesh_compression primitives the split has to read. Default: a `DracoDecoder` from
   * @margoengine/decoders, made for this call and disposed after it. The caller keeps ownership of one passed here.
   */
  draco?: {
    decode(
      data: Uint8Array,
      options: { attributeIds: Record<string, number>; componentTypes: Record<string, number>; signal?: AbortSignal },
    ): Promise<VRMDracoGeometry>;
  };
}

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}
interface Meshopt {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: string;
  filter?: string;
}
interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  extensions?: { EXT_meshopt_compression?: Meshopt; KHR_meshopt_compression?: Meshopt };
}
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  targets?: Record<string, number>[];
  extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> } };
  [field: string]: unknown;
}
interface GMesh {
  primitives: Primitive[];
  name?: string;
  [field: string]: unknown;
}
interface GNode {
  mesh?: number;
  skin?: number;
  children?: number[];
  name?: string;
  weights?: number[];
  [field: string]: unknown;
}
interface Channel {
  sampler: number;
  target: { node?: number; path: string; extensions?: { KHR_animation_pointer?: { pointer: string } } };
}
interface Document extends VRMDocument {
  accessors?: Accessor[];
  bufferViews?: BufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  meshes?: GMesh[];
  nodes?: GNode[];
  skins?: { joints: number[] }[];
  animations?: { channels: Channel[] }[];
}
interface Annotation {
  node: number;
  type: string;
}
/** One accessor's elements, tightly packed. */
interface Column {
  bytes: Uint8Array;
  element: number;
  componentType: number;
  type: string;
  normalized: boolean;
  count: number;
  view?: DataView;
}
/** A primitive as columns and a list of points, lines or triangles. */
interface Data {
  attributes: Record<string, Column>;
  targets: Record<string, Column>[];
  elements: Uint32Array;
  /** Vertices per element: 1, 2 or 3. */
  per: number;
  count: number;
}

const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 },
  WIDTHS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
  NORMS: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 },
  TYPES = new Set(['auto', 'both', 'thirdPersonOnly', 'firstPersonOnly']),
  DRACO = 'KHR_draco_mesh_compression';

const bad = (message: string): MargoError =>
  new MargoError('failed', `VRM firstPerson split: ${message}; repair the file and check it with the glTF Validator`);

/** Reads one number of an element: component `c` of element `i`. `normalized` maps integers to 0..1 or -1..1. */
function read(column: Column, i: number, c: number, normalized = column.normalized): number {
  const view = (column.view ??= new DataView(column.bytes.buffer, column.bytes.byteOffset, column.bytes.byteLength)),
    at = i * column.element + c * SIZES[column.componentType];
  let value: number;
  switch (column.componentType) {
    case 5120:
      value = view.getInt8(at);
      break;
    case 5121:
      value = view.getUint8(at);
      break;
    case 5122:
      value = view.getInt16(at, true);
      break;
    case 5123:
      value = view.getUint16(at, true);
      break;
    case 5125:
      value = view.getUint32(at, true);
      break;
    default:
      return view.getFloat32(at, true);
  }
  return normalized ? Math.max(-1, value / NORMS[column.componentType]) : value;
}

/** Numbers as `componentType` elements of `width` components (rounded for integers). */
function encode(values: ArrayLike<number>, componentType: number, width: number, type: string): Column {
  const size = SIZES[componentType],
    count = values.length / width,
    bytes = new Uint8Array(values.length * size),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i],
      at = i * size;
    if (componentType === 5126) view.setFloat32(at, v, true);
    else if (componentType === 5120) view.setInt8(at, Math.round(v));
    else if (componentType === 5121) view.setUint8(at, Math.round(v));
    else if (componentType === 5122) view.setInt16(at, Math.round(v), true);
    else if (componentType === 5123) view.setUint16(at, Math.round(v), true);
    else view.setUint32(at, Math.round(v), true);
  }
  return { bytes, element: size * width, componentType, type, normalized: false, count };
}

/** The bytes of a file: buffers, buffer views (meshopt streams decoded) and accessors. */
class Source {
  private readonly views = new Map<number, Uint8Array>();
  private readonly buffers = new Map<number, Uint8Array>();
  meshopt?: (source: Uint8Array, count: number, stride: number, mode: string, filter?: string) => Uint8Array;
  constructor(
    private readonly doc: Document,
    private readonly bin: Uint8Array | undefined,
  ) {}
  private buffer(index: number): Uint8Array {
    let bytes = this.buffers.get(index);
    if (bytes) return bytes;
    const buffer = this.doc.buffers?.[index];
    if (!buffer) throw bad(`buffer ${index} does not exist`);
    if (buffer.uri === undefined) {
      if (index !== 0 || !this.bin) throw bad(`buffer ${index} has no data`);
      bytes = this.bin;
    } else {
      const data = /^data:[^,]*;base64,(.*)$/s.exec(buffer.uri);
      if (!data)
        throw new MargoError(
          'unsupported',
          `VRM firstPerson split: buffer ${index} is the external file ${buffer.uri}; pass a .vrm with every buffer embedded`,
        );
      bytes = Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0));
    }
    this.buffers.set(index, bytes);
    return bytes;
  }
  private slice(buffer: number, offset = 0, length: number): Uint8Array {
    const bytes = this.buffer(buffer);
    if (!(offset >= 0 && length >= 0 && offset + length <= bytes.length))
      throw bad(`a buffer view runs past buffer ${buffer}`);
    return bytes.subarray(offset, offset + length);
  }
  view(index: number): Uint8Array {
    let bytes = this.views.get(index);
    if (bytes) return bytes;
    const view = this.doc.bufferViews?.[index];
    if (!view) throw bad(`buffer view ${index} does not exist`);
    const meshopt = view.extensions?.EXT_meshopt_compression ?? view.extensions?.KHR_meshopt_compression;
    if (meshopt) {
      bytes = this.meshopt!(
        this.slice(meshopt.buffer, meshopt.byteOffset, meshopt.byteLength),
        meshopt.count,
        meshopt.byteStride,
        meshopt.mode,
        meshopt.filter,
      );
      if (bytes.length !== view.byteLength) throw bad(`meshopt buffer view ${index} decodes to the wrong length`);
    } else bytes = this.slice(view.buffer, view.byteOffset, view.byteLength);
    this.views.set(index, bytes);
    return bytes;
  }
  column(index: number): Column {
    const a = this.doc.accessors?.[index];
    if (!a) throw bad(`accessor ${index} does not exist`);
    const size = SIZES[a.componentType],
      width = WIDTHS[a.type];
    if (!size || !width || !Number.isSafeInteger(a.count) || a.count < 0)
      throw bad(`accessor ${index} is not a vertex or index accessor`);
    const element = size * width,
      count = a.count,
      bytes = new Uint8Array(count * element);
    if (a.bufferView !== undefined) {
      const view = this.view(a.bufferView),
        stride = this.doc.bufferViews![a.bufferView].byteStride ?? element,
        start = a.byteOffset ?? 0;
      if (count && start + (count - 1) * stride + element > view.length)
        throw bad(`accessor ${index} runs past its buffer view`);
      for (let i = 0; i < count; i++)
        bytes.set(view.subarray(start + i * stride, start + i * stride + element), i * element);
    }
    const sparse = a.sparse;
    if (sparse) {
      const indices = this.view(sparse.indices.bufferView),
        values = this.view(sparse.values.bufferView),
        indexSize = SIZES[sparse.indices.componentType],
        indexStart = sparse.indices.byteOffset ?? 0,
        valueStart = sparse.values.byteOffset ?? 0;
      if (
        ![5121, 5123, 5125].includes(sparse.indices.componentType) ||
        indexStart + sparse.count * indexSize > indices.length ||
        valueStart + sparse.count * element > values.length
      )
        throw bad(`the sparse part of accessor ${index} runs past its buffer views`);
      const keys: Column = {
        bytes: indices.subarray(indexStart),
        element: indexSize,
        componentType: sparse.indices.componentType,
        type: 'SCALAR',
        normalized: false,
        count: sparse.count,
      };
      for (let i = 0; i < sparse.count; i++) {
        const at = read(keys, i, 0);
        if (at >= count) throw bad(`sparse index ${at} of accessor ${index} is past its ${count} elements`);
        bytes.set(values.subarray(valueStart + i * element, valueStart + (i + 1) * element), at * element);
      }
    }
    return { bytes, element, componentType: a.componentType, type: a.type, normalized: !!a.normalized, count };
  }
}

/** Points, lines and triangles of `indices` drawn as `mode`, as lists (glTF 2.0 section 3.7.2.1). */
function listOf(indices: ArrayLike<number>, mode: number): { elements: Uint32Array; per: number } {
  const n = indices.length,
    out: number[] = [];
  switch (mode) {
    case 0:
      return { elements: Uint32Array.from(indices), per: 1 };
    case 1:
      return { elements: Uint32Array.from(indices).subarray(0, n - (n % 2)), per: 2 };
    case 2:
    case 3:
      for (let i = 0; i + 1 < n; i++) out.push(indices[i], indices[i + 1]);
      if (mode === 2 && n > 2) out.push(indices[n - 1], indices[0]);
      return { elements: Uint32Array.from(out), per: 2 };
    case 4:
      return { elements: Uint32Array.from(indices).subarray(0, n - (n % 3)), per: 3 };
    case 5:
      for (let i = 0; i + 2 < n; i++) out.push(indices[i], indices[i + 1 + (i % 2)], indices[i + 2 - (i % 2)]);
      return { elements: Uint32Array.from(out), per: 3 };
    case 6:
      for (let i = 0; i + 2 < n; i++) out.push(indices[i + 1], indices[i + 2], indices[0]);
      return { elements: Uint32Array.from(out), per: 3 };
  }
  throw bad(`primitive mode ${mode} is not 0 to 6`);
}

/** Appends buffer views to the BIN chunk. */
class Writer {
  readonly chunks: Uint8Array[] = [];
  constructor(
    private readonly doc: Document,
    public length: number,
  ) {}
  /** A new accessor holding `column`'s elements `order`; vertex data gets a 4-byte aligned stride. */
  accessor(column: Column, order: ArrayLike<number> | null, vertex: boolean, bounds: boolean): number {
    const count = order ? order.length : column.count,
      element = column.element,
      stride = vertex ? (element + 3) & ~3 : element,
      bytes = new Uint8Array(count * stride);
    for (let i = 0; i < count; i++) {
      const from = (order ? order[i] : i) * element;
      bytes.set(column.bytes.subarray(from, from + element), i * stride);
    }
    const views = (this.doc.bufferViews ??= []);
    views.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.length,
      ...(stride !== element ? { byteStride: stride } : {}),
      target: vertex ? 34962 : 34963,
    });
    this.chunks.push(bytes);
    this.length += (bytes.length + 3) & ~3;
    if (bytes.length & 3) this.chunks.push(new Uint8Array(4 - (bytes.length & 3)));
    const accessor: Accessor = {
      bufferView: views.length - 1,
      componentType: column.componentType,
      count,
      type: column.type,
      ...(column.normalized ? { normalized: true } : {}),
    };
    if (bounds) {
      const width = WIDTHS[column.type],
        min = new Array<number>(width).fill(Infinity),
        max = new Array<number>(width).fill(-Infinity),
        packed: Column = { ...column, bytes, element: stride, count, view: undefined };
      for (let i = 0; i < count; i++)
        for (let c = 0; c < width; c++) {
          const v = read(packed, i, c, false);
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      if (count) Object.assign(accessor, { min, max });
    }
    (this.doc.accessors ??= []).push(accessor);
    return this.doc.accessors.length - 1;
  }
}

/** A primitive's data, decoding a Draco stream when it has one. */
async function primitiveData(
  doc: Document,
  source: Source,
  p: Primitive,
  draco: () => Promise<NonNullable<SplitVRMFirstPersonOptions['draco']>>,
  signal?: AbortSignal,
): Promise<Data> {
  const attributes: Record<string, Column> = {},
    compressed = p.extensions?.[DRACO];
  let indices: ArrayLike<number> | undefined,
    mode = p.mode ?? 4;
  if (compressed) {
    const componentTypes: Record<string, number> = {};
    for (const semantic of Object.keys(compressed.attributes)) {
      const accessor = doc.accessors?.[p.attributes[semantic]];
      if (!accessor) throw bad(`Draco attribute ${semantic} has no accessor`);
      componentTypes[semantic] = accessor.componentType;
    }
    const decoder = await draco(),
      result = await decoder.decode(source.view(compressed.bufferView).slice(), {
        attributeIds: compressed.attributes,
        componentTypes,
        signal,
      });
    signal?.throwIfAborted();
    const fields: Record<string, ArrayLike<number> | undefined> = {
      POSITION: result.positions,
      NORMAL: result.normals,
      TEXCOORD_0: result.uvs,
      COLOR_0: result.colors,
    };
    for (const semantic of Object.keys(compressed.attributes)) {
      const accessor = doc.accessors![p.attributes[semantic]],
        width = WIDTHS[accessor.type],
        values = fields[semantic] ?? result.attributes?.[semantic]?.array;
      if (!width || !values || values.length !== result.vertexCount * width)
        throw bad(`Draco attribute ${semantic} does not match its accessor`);
      // The decoder gives colours as 0..1 numbers and every other channel in the accessor's own values
      // (gltf/pbr's compression.ts reads them the same way), so colours are written as floats.
      const type = semantic === 'COLOR_0' ? 5126 : accessor.componentType,
        column = encode(values, type, width, accessor.type);
      column.normalized = type !== 5126 && !!accessor.normalized;
      attributes[semantic] = column;
    }
    indices = result.indices ?? Uint32Array.from({ length: result.vertexCount }, (_, i) => i);
    mode = 4;
  }
  for (const [semantic, index] of Object.entries(p.attributes)) attributes[semantic] ??= source.column(index);
  const count = attributes.POSITION?.count ?? Object.values(attributes)[0]?.count ?? 0;
  for (const column of Object.values(attributes))
    if (column.count !== count) throw bad('the attributes of a primitive have different counts');
  if (!indices)
    if (p.indices === undefined) indices = Uint32Array.from({ length: count }, (_, i) => i);
    else {
      const column = source.column(p.indices);
      if (![5121, 5123, 5125].includes(column.componentType) || column.type !== 'SCALAR')
        throw bad('indices must be unsigned SCALAR integers');
      indices = Uint32Array.from({ length: column.count }, (_, i) => read(column, i, 0, false));
    }
  for (let i = 0; i < indices.length; i++)
    if (indices[i] >= count) throw bad(`index ${indices[i]} is past ${count} vertices`);
  const targets = (p.targets ?? []).map((target) => {
    const columns: Record<string, Column> = {};
    for (const [semantic, index] of Object.entries(target)) {
      columns[semantic] = source.column(index);
      if (columns[semantic].count !== count) throw bad('a morph target has a different vertex count');
    }
    return columns;
  });
  return { attributes, targets, ...listOf(indices, mode), count };
}

/** Whether each vertex has skin weight above `threshold` on a joint `head` marks. */
function headVertices(data: Data, head: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(data.count);
  for (let set = 0; data.attributes[`JOINTS_${set}`]; set++) {
    const joints = data.attributes[`JOINTS_${set}`],
      weights = data.attributes[`WEIGHTS_${set}`];
    if (!weights) continue;
    const width = WIDTHS[joints.type];
    for (let v = 0; v < data.count; v++)
      for (let c = 0; c < width; c++) {
        const joint = read(joints, v, c, false);
        if (joint >= head.length) throw bad(`joint ${joint} is past the skin's ${head.length} joints`);
        if (head[joint] && read(weights, v, c, true) > threshold) out[v] = 1;
      }
  }
  return out;
}

/** The elements of `data` with `flags[e] === want`, as a new primitive with compact copies of every vertex used. */
function compact(p: Primitive, data: Data, flags: Uint8Array, want: number, writer: Writer): Primitive {
  const map = new Int32Array(data.count).fill(-1),
    order: number[] = [],
    indices: number[] = [],
    per = data.per;
  for (let e = 0; e < flags.length; e++)
    if (flags[e] === want)
      for (let k = 0; k < per; k++) {
        const v = data.elements[e * per + k];
        if (map[v] < 0) {
          map[v] = order.length;
          order.push(v);
        }
        indices.push(map[v]);
      }
  const attributes: Record<string, number> = {};
  for (const [semantic, column] of Object.entries(data.attributes))
    attributes[semantic] = writer.accessor(column, order, true, semantic === 'POSITION');
  const big = order.length > 65535,
    index = encode(indices, big ? 5125 : 5123, 1, 'SCALAR'),
    { extensions, ...rest } = p,
    copy: Primitive = {
      ...structuredClone(rest),
      attributes,
      indices: writer.accessor(index, null, false, false),
      mode: per === 3 ? 4 : per === 2 ? 1 : 0,
    };
  if (extensions) {
    const kept = structuredClone(extensions);
    delete kept[DRACO];
    if (Object.keys(kept).length) copy.extensions = kept;
  }
  if (data.targets.length)
    copy.targets = data.targets.map((target) =>
      Object.fromEntries(
        Object.entries(target).map(([semantic, column]) => [
          semantic,
          writer.accessor(column, order, true, semantic === 'POSITION'),
        ]),
      ),
    );
  else delete copy.targets;
  return copy;
}

const accessorsOf = (p: Primitive): number[] => [
  ...Object.values(p.attributes),
  ...(p.targets ?? []).flatMap((target) => Object.values(target)),
];

/**
 * Resolves every `auto` mesh annotation of a VRM 1.0 file (a missing annotation, or no `firstPerson`, also means
 * `auto`), as VRMC_vrm 1.0 firstPerson.md describes. A skinned mesh whose every point, line or triangle has a vertex
 * with weight on the head bone or a bone below it becomes `thirdPersonOnly`; one with none becomes `both`; a mixed one
 * keeps the rest (`both`) and gives the head part to a new child node (`thirdPersonOnly`, the same skin, appended after
 * every existing node so no index moves). Each part holds compact copies of the vertices it uses, morph targets
 * included, so skinning works on the original vertex count plus the seam. An unskinned `auto` mesh is
 * `thirdPersonOnly` when its node is the head or below it, else `both`. Expression binds and animation weight channels
 * of a split node get a twin for the child. The result has no `auto` left, so a second split returns its input; a file
 * with no `auto` comes back as it was, byte for byte.
 * @throws MargoError `failed` for a file whose geometry breaks glTF 2.0, `unsupported` for an external buffer; what
 * {@link readVRM} throws for a file that is not VRM 1.0; the signal's reason when aborted.
 */
export async function splitVRMFirstPerson(
  glb: Uint8Array,
  options: SplitVRMFirstPersonOptions = {},
): Promise<Uint8Array> {
  const { threshold = 0, signal } = options;
  signal?.throwIfAborted();
  if (!(glb instanceof Uint8Array) || !isGLB(glb))
    throw new TypeError('splitVRMFirstPerson needs the bytes of a .vrm file');
  if (!(threshold >= 0 && threshold < 1)) throw new RangeError('threshold must be a weight from 0 up to 1');
  const chunks = glbChunks(glb),
    doc = parseJSON<Document>(new TextDecoder().decode(chunks[0].data)),
    avatar = readVRM(doc),
    vrm = doc.extensions!.VRMC_vrm as { firstPerson?: { meshAnnotations?: Annotation[] } },
    nodes = doc.nodes ?? [],
    head = avatar.humanoid.humanBones.head?.node;
  const types = new Map<number, string>();
  for (const annotation of vrm.firstPerson?.meshAnnotations ?? []) {
    if (!nodes[annotation?.node]) throw bad(`an annotation names node ${annotation?.node}, which does not exist`);
    if (!TYPES.has(annotation.type))
      throw bad(
        `node ${annotation.node} has the type ${String(annotation.type)}, not auto, both, thirdPersonOnly or firstPersonOnly`,
      );
    if (!types.has(annotation.node)) types.set(annotation.node, annotation.type);
  }
  const auto = nodes.flatMap((node, i) => (node.mesh !== undefined && (types.get(i) ?? 'auto') === 'auto' ? [i] : []));
  if (!auto.length) return glb;
  // The head set: the head bone and everything below it.
  const below = new Uint8Array(nodes.length);
  if (head !== undefined && nodes[head]) {
    const stack = [head];
    while (stack.length) {
      const at = stack.pop()!;
      if (below[at]) continue;
      below[at] = 1;
      for (const child of nodes[at].children ?? []) if (nodes[child]) stack.push(child);
    }
  }
  const bin = chunks[1]?.type === GLB_BIN ? chunks[1].data : undefined,
    source = new Source(doc, bin);
  if (
    doc.bufferViews?.some(
      (view) => view.extensions?.EXT_meshopt_compression ?? view.extensions?.KHR_meshopt_compression,
    )
  )
    source.meshopt = (await import('@margoengine/decoders/meshopt')).meshoptDecodeGltfBuffer;
  signal?.throwIfAborted();
  // A file with no BIN chunk gets one as buffer 0 (GLB section 4.4.3.3), the other buffers moving up one.
  let binLength = bin?.length ?? 0;
  const buffers = (doc.buffers ??= []);
  if (!bin && (!buffers.length || buffers[0].uri !== undefined)) {
    for (const view of doc.bufferViews ?? []) {
      view.buffer++;
      const meshopt = view.extensions?.EXT_meshopt_compression ?? view.extensions?.KHR_meshopt_compression;
      if (meshopt) meshopt.buffer++;
    }
    buffers.unshift({ byteLength: 0 });
    binLength = 0;
  }
  const writer = new Writer(doc, (binLength + 3) & ~3),
    users = new Map<number, number>();
  for (const node of nodes) if (node.mesh !== undefined) users.set(node.mesh, (users.get(node.mesh) ?? 0) + 1);
  let owned: { dispose(): void } | undefined,
    decoder: NonNullable<SplitVRMFirstPersonOptions['draco']> | undefined = options.draco;
  const draco = async () => {
    if (!decoder) {
      const { DracoDecoder } = await import('@margoengine/decoders');
      signal?.throwIfAborted();
      const made = new DracoDecoder();
      owned = made;
      decoder = made as unknown as NonNullable<SplitVRMFirstPersonOptions['draco']>;
    }
    return decoder;
  };
  const twins = new Map<number, number>(),
    meshTwins = new Map<number, number[]>(),
    done = new Map<string, { type: string; rest?: number; head?: number }>();
  try {
    for (const n of auto) {
      const node = nodes[n],
        meshIndex = node.mesh!,
        mesh = doc.meshes?.[meshIndex];
      if (!mesh) throw bad(`node ${n} names mesh ${meshIndex}, which does not exist`);
      if (node.skin === undefined) {
        types.set(n, below[n] ? 'thirdPersonOnly' : 'both');
        continue;
      }
      const key = `${meshIndex} ${node.skin}`;
      let result = done.get(key);
      if (!result) {
        const joints = doc.skins?.[node.skin]?.joints;
        if (!joints) throw bad(`node ${n} names skin ${node.skin}, which does not exist`);
        const headJoints = Uint8Array.from(joints, (joint) => below[joint] ?? 0),
          parts: { data?: Data; flags?: Uint8Array; heads: number; total: number }[] = [];
        for (const p of mesh.primitives) {
          if (!p.attributes.JOINTS_0) {
            parts.push({ heads: 0, total: 1 });
            continue;
          }
          const data = await primitiveData(doc, source, p, draco, signal),
            vertices = headVertices(data, headJoints, threshold),
            total = data.elements.length / data.per,
            flags = new Uint8Array(total);
          let heads = 0;
          for (let e = 0; e < total; e++)
            for (let k = 0; k < data.per; k++)
              if (vertices[data.elements[e * data.per + k]]) {
                flags[e] = 1;
                heads++;
                break;
              }
          parts.push({ data, flags, heads, total });
        }
        const heads = parts.reduce((sum, part) => sum + part.heads, 0),
          total = parts.reduce((sum, part) => sum + part.total, 0);
        if (!heads) result = { type: 'both' };
        else if (heads === total && parts.every((part) => part.heads === part.total))
          result = { type: 'thirdPersonOnly' };
        else {
          // Whole primitives keep their accessors unless the other part keeps a whole primitive sharing one: two
          // meshes skinning one vertex accessor would skin those vertices twice.
          const whole = (side: 0 | 1) =>
            new Set(
              mesh.primitives.flatMap((p, i) => (parts[i].heads === (side ? parts[i].total : 0) ? accessorsOf(p) : [])),
            );
          const restWhole = whole(0),
            shared = [...whole(1)].some((accessor) => restWhole.has(accessor)),
            rest: Primitive[] = [],
            headPrimitives: Primitive[] = [];
          mesh.primitives.forEach((p, i) => {
            const part = parts[i];
            if (part.heads === 0) rest.push(p);
            else if (part.heads === part.total && !shared) headPrimitives.push(p);
            else {
              if (part.heads < part.total) rest.push(compact(p, part.data!, part.flags!, 0, writer));
              headPrimitives.push(compact(p, part.data!, part.flags!, 1, writer));
            }
          });
          const { primitives: _, ...fields } = mesh,
            meshes = doc.meshes!,
            restMesh: GMesh = { ...structuredClone(fields), primitives: rest },
            headMesh: GMesh = {
              ...structuredClone(fields),
              ...(mesh.name ? { name: `${mesh.name} head` } : {}),
              primitives: headPrimitives,
            };
          let restIndex = meshIndex;
          if (users.get(meshIndex) === 1) meshes[meshIndex] = restMesh;
          else restIndex = meshes.push(restMesh) - 1;
          const headIndex = meshes.push(headMesh) - 1;
          meshTwins.set(meshIndex, [
            ...(meshTwins.get(meshIndex) ?? []),
            ...(restIndex === meshIndex ? [] : [restIndex]),
            headIndex,
          ]);
          result = { type: 'split', rest: restIndex, head: headIndex };
        }
        done.set(key, result);
      }
      if (result.type !== 'split') {
        types.set(n, result.type);
        continue;
      }
      node.mesh = result.rest;
      types.set(n, 'both');
      const child: GNode = { name: `${node.name ?? `node ${n}`} head`, mesh: result.head, skin: node.skin };
      if (node.weights) child.weights = [...node.weights];
      const index = nodes.push(child) - 1;
      (node.children ??= []).push(index);
      types.set(index, 'thirdPersonOnly');
      twins.set(n, index);
    }
  } finally {
    owned?.dispose();
  }
  signal?.throwIfAborted();
  // Twins: expression binds and morph weight channels of a split node also drive its head part.
  type Binds = { morphTargetBinds?: { node: number }[] };
  const raw = (vrm as { expressions?: { preset?: Record<string, Binds>; custom?: Record<string, Binds> } }).expressions;
  for (const table of [raw?.preset, raw?.custom])
    for (const expression of Object.values(table ?? {})) {
      const binds = expression?.morphTargetBinds ?? [];
      for (const bind of [...binds]) {
        const twin = twins.get(bind.node);
        if (twin !== undefined) binds.push({ ...bind, node: twin });
      }
    }
  for (const animation of doc.animations ?? [])
    for (const channel of [...(animation.channels ?? [])]) {
      const target = channel.target,
        pointer = target.extensions?.KHR_animation_pointer?.pointer,
        match = pointer && /^\/(nodes|meshes)\/(\d+)\/weights$/.exec(pointer);
      const add = (copy: Channel['target']): void =>
        void animation.channels.push({ ...structuredClone(channel), target: copy });
      if (target.path === 'weights' && target.node !== undefined && twins.has(target.node))
        add({ ...structuredClone(target), node: twins.get(target.node) });
      else if (match) {
        const index = Number(match[2]),
          copies = match[1] === 'nodes' ? (twins.has(index) ? [twins.get(index)!] : []) : (meshTwins.get(index) ?? []);
        for (const copy of copies)
          add({
            ...structuredClone(target),
            extensions: {
              ...structuredClone(target.extensions),
              KHR_animation_pointer: { pointer: `/${match[1]}/${copy}/weights` },
            },
          });
      }
    }
  const annotations: Annotation[] = (vrm.firstPerson?.meshAnnotations ?? []).filter(
    (a) => nodes[a.node].mesh === undefined,
  );
  nodes.forEach((node, i) => {
    if (node.mesh !== undefined) annotations.push({ node: i, type: types.get(i)! });
  });
  (vrm.firstPerson ??= {}).meshAnnotations = annotations;
  const tail = new Uint8Array(writer.length);
  if (bin) tail.set(bin);
  let at = (binLength + 3) & ~3;
  for (const chunk of writer.chunks) {
    tail.set(chunk, at);
    at += chunk.length;
  }
  buffers[0].byteLength = tail.length;
  return pack(doc, tail, chunks.slice(bin ? 2 : 1));
}

/** A GLB of `doc`, `bin` and the later chunks as they were. */
function pack(doc: Document, bin: Uint8Array, rest: { type: number; data: Uint8Array }[]): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(doc)),
    padded = (text.length + 3) & ~3,
    binPadded = (bin.length + 3) & ~3,
    total = 20 + padded + 8 + binPadded + rest.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0),
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, GLB_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + padded);
  let at = 20 + padded;
  for (const chunk of [{ type: GLB_BIN, data: bin }, ...rest]) {
    const length = chunk.type === GLB_BIN ? binPadded : chunk.data.length;
    view.setUint32(at, length, true);
    view.setUint32(at + 4, chunk.type, true);
    out.set(chunk.data, at + 8);
    at += 8 + length;
  }
  return out;
}

/** Options of {@link loadVRM}: gltf/pbr's load options and the split's threshold. */
export interface LoadVRMOptions extends GLTFLoadOptions {
  /** See {@link SplitVRMFirstPersonOptions.threshold}. Default 0. */
  threshold?: number;
}

/**
 * Loads a VRM 1.0 URL or bytes as a PBRModel after {@link splitVRMFirstPerson}, so {@link addVRMFirstPerson} finds no
 * `auto` mesh. Downloads at most `maxDownloadBytes` (default 64 MiB); `signal` cancels the download, the split and
 * the load. For a VRM 0.x file, convert it with `convertVRM0Bytes` from @margoengine/rigging/vrm0 first.
 * @throws what {@link splitVRMFirstPerson} and gltf/pbr's `parseGLTFAsync` throw; RangeError past the download budget.
 */
export async function loadVRM(
  engine: EngineKernel,
  source: string | URL | Uint8Array,
  options: LoadVRMOptions = {},
): Promise<PBRModel> {
  const { signal } = options;
  signal?.throwIfAborted();
  const limit = options.maxDownloadBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError('maxDownloadBytes must be a positive safe integer');
  const bytes =
    source instanceof Uint8Array
      ? source
      : await readResponse(await (options.fetch ?? globalThis.fetch)(source, { signal }), {
          maxBytes: limit,
          signal,
          label: 'VRM',
        });
  if (bytes.byteLength > limit)
    throw new RangeError('The VRM is larger than maxDownloadBytes; raise it to load this file');
  const { threshold, ...load } = options,
    split = await splitVRMFirstPerson(bytes, {
      threshold,
      signal,
      draco: load.draco as SplitVRMFirstPersonOptions['draco'],
    }),
    { parseGLTFAsync } = await import('@margoengine/gltf/pbr');
  signal?.throwIfAborted();
  return parseGLTFAsync(engine, split, load);
}

/** Options of {@link addVRMFirstPerson}. */
export interface VRMFirstPersonOptions {
  /** Layer (0 to 31) of `firstPersonOnly` meshes. Default {@link FIRST_PERSON_ONLY_LAYER}, 29. */
  firstPersonOnlyLayer?: number;
  /** Layer (0 to 31) of `thirdPersonOnly` meshes. Default {@link THIRD_PERSON_ONLY_LAYER}, 30. */
  thirdPersonOnlyLayer?: number;
  /** Cameras that see through the avatar's eyes: each draws `firstPersonLayers`. Default none. */
  firstPersonCameras?: readonly Camera[];
  /**
   * Cameras that see the avatar from outside: each draws `thirdPersonLayers`, but only when the file has a
   * `firstPersonOnly` mesh (otherwise every layer already is right). Default the engine's camera.
   */
  thirdPersonCameras?: readonly Camera[];
}

/** What {@link addVRMFirstPerson} returns. `dispose()` or `using` puts every mask back as it was. */
export interface VRMFirstPerson extends Disposable {
  /** Layer of `firstPersonOnly` meshes. */
  readonly firstPersonOnlyLayer: number;
  /** Layer of `thirdPersonOnly` meshes. */
  readonly thirdPersonOnlyLayer: number;
  /** Mask for a view through the eyes: every layer but `thirdPersonOnlyLayer`. */
  readonly firstPersonLayers: number;
  /** Mask for a view from outside, a mirror or a probe: every layer but `firstPersonOnlyLayer`. */
  readonly thirdPersonLayers: number;
  /** Each mesh node's resolved type, as in the file. */
  readonly meshAnnotations: readonly { node: number; type: Exclude<VRMFirstPersonType, 'auto'> }[];
  /**
   * World position of the eyes: `lookAt.offsetFromHeadBone` (the specification gives no default; [0, 0, 0] as `vrmGaze` uses) through the head bone's world
   * matrix as the engine last computed it. Put the first-person camera here.
   */
  viewpoint(out?: [number, number, number]): [number, number, number];
  dispose(): void;
}

const layerOf = (layer: number, name: string): number => {
  if (!Number.isInteger(layer) || layer < 0 || layer > 31) throw new RangeError(`${name} must be a layer from 0 to 31`);
  return layer;
};

/**
 * Applies the first-person annotations of a loaded VRM 1.0 model through render layers: `thirdPersonOnly` nodes get
 * only `thirdPersonOnlyLayer`, `firstPersonOnly` nodes only `firstPersonOnlyLayer`, `both` keep their mask, and the
 * given cameras get the matching view masks. Give any other view the handle's masks: a view, mirror or probe with no
 * mask draws every layer, `firstPersonOnly` meshes included. Shadows are not filtered: the avatar casts its whole
 * shadow in every view. Setting a mask replaces a layer the caller had set on that node, until `dispose()`.
 * @throws MargoError `state` when a mesh node is still `auto` (load the file with {@link loadVRM}); what
 * {@link readVRM} throws for a model that is not VRM 1.0; RangeError for a layer outside 0 to 31 or two equal layers.
 */
export function addVRMFirstPerson(model: PBRModel, options: VRMFirstPersonOptions = {}): VRMFirstPerson {
  const doc = model.asset.doc as unknown as Document,
    avatar = readVRM(doc as VRMDocument),
    first = layerOf(options.firstPersonOnlyLayer ?? FIRST_PERSON_ONLY_LAYER, 'firstPersonOnlyLayer'),
    third = layerOf(options.thirdPersonOnlyLayer ?? THIRD_PERSON_ONLY_LAYER, 'thirdPersonOnlyLayer');
  if (first === third) throw new RangeError('firstPersonOnlyLayer and thirdPersonOnlyLayer must differ');
  const nodes = doc.nodes ?? [],
    types = new Map<number, string>();
  for (const annotation of (avatar.firstPerson?.meshAnnotations ?? []) as Annotation[])
    if (!types.has(annotation.node)) types.set(annotation.node, annotation.type);
  const annotations: { node: number; type: Exclude<VRMFirstPersonType, 'auto'> }[] = [];
  nodes.forEach((node, i) => {
    if (node.mesh === undefined) return;
    const type = types.get(i) ?? 'auto';
    if (type === 'auto')
      throw new MargoError(
        'state',
        `Node ${i} is a firstPerson auto mesh, which needs its head split before loading; load the file with loadVRM, or pass it through splitVRMFirstPerson`,
      );
    if (!TYPES.has(type)) throw new MargoError('failed', `Node ${i} has the firstPerson type ${type}; repair the file`);
    annotations.push({ node: i, type: type as Exclude<VRMFirstPersonType, 'auto'> });
  });
  const registry = renderLayers(),
    ALL = 0xffffffff,
    firstPersonLayers = (ALL & ~(1 << third)) >>> 0,
    thirdPersonLayers = (ALL & ~(1 << first)) >>> 0,
    meshes: [object, number | undefined][] = [],
    cameras: [object, number | undefined][] = [];
  for (const { node, type } of annotations) {
    const mesh = model.nodes[node];
    if (!mesh || type === 'both') continue;
    meshes.push([mesh, registry.masks.get(mesh)]);
    setRenderLayers(mesh, (1 << (type === 'thirdPersonOnly' ? third : first)) >>> 0);
  }
  const engine = (model.root as unknown as { engine: { camera: Camera } }).engine,
    hasFirstOnly = annotations.some((a) => a.type === 'firstPersonOnly'),
    view = (list: readonly Camera[], mask: number) => {
      for (const camera of list) {
        cameras.push([camera, registry.cameras.get(camera)]);
        registry.cameras.set(camera, mask);
      }
    };
  view(options.firstPersonCameras ?? [], firstPersonLayers);
  if (hasFirstOnly) view(options.thirdPersonCameras ?? [engine.camera], thirdPersonLayers);
  const headIndex = avatar.humanoid.humanBones.head?.node,
    offset = avatar.lookAt?.offsetFromHeadBone ?? [0, 0, 0];
  let disposed = false;
  const handle: VRMFirstPerson = {
    firstPersonOnlyLayer: first,
    thirdPersonOnlyLayer: third,
    firstPersonLayers,
    thirdPersonLayers,
    meshAnnotations: annotations,
    viewpoint(out: [number, number, number] = [0, 0, 0]) {
      const head = headIndex === undefined ? undefined : model.nodes[headIndex];
      if (!head) throw new MargoError('failed', 'The VRM has no head bone node; repair the file');
      const m = head.matrix;
      for (let k = 0; k < 3; k++) out[k] = m[k] * offset[0] + m[4 + k] * offset[1] + m[8 + k] * offset[2] + m[12 + k];
      return out;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [mesh, mask] of meshes.reverse()) {
        if (mask === undefined) registry.masks.delete(mesh);
        else registry.masks.set(mesh, mask);
        const owner = (mesh as { engine?: { collected: number } }).engine;
        if (owner) owner.collected = -1;
      }
      for (const [camera, mask] of cameras.reverse())
        if (mask === undefined) registry.cameras.delete(camera);
        else registry.cameras.set(camera, mask);
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}

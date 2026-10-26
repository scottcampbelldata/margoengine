// Lossless GLB augmentation: split a GLB into its JSON, BIN and any further chunks, join them back, and append named
// meshes (collision proxies, markers) to an existing file without touching its other data, extensions or extras.
import { parseJSON } from '../../shared/json.js';
import { copyExtras } from './extras.js';
import type { Extras } from './scene.js';
import { GLB_BIN, GLB_JSON, GLB_MAGIC, glbChunks } from '../../shared/glb.js';
import { readComponent } from '../../shared/accessor.js';

const isObject = <T>(value: T): value is T & Record<string, unknown> => typeof value === 'object' && value !== null;

/** One GLB chunk: its type (little-endian four-character code) and bytes, a multiple of 4 long. */
export interface GLBChunk {
  type: number;
  data: Uint8Array;
}

/** A GLB split into its parts: {@link splitGLB}'s result and {@link joinGLB}'s input. */
export interface GLBParts {
  /** The parsed JSON chunk. */
  json: Record<string, unknown>;
  /** The BIN chunk (buffer 0) with its padding, or null when the file has none. */
  bin: Uint8Array | null;
  /** Chunks after JSON and BIN, unknown to glTF 2.0, in file order. */
  chunks: GLBChunk[];
}

/** Options for {@link splitGLB}. */
export interface SplitGLBOptions {
  /**
   * `false` returns `bin` and the chunk data as views into `bytes` instead of copies, for large files read once;
   * they change if `bytes` does. Default `true`.
   */
  copy?: boolean;
  /**
   * Parses the JSON chunk's text, for a stricter parser. The default is JSON.parse without `__proto__`,
   * `constructor` and `prototype` keys. A throw refuses the GLB.
   */
  parse?: (text: string) => unknown;
}

/** A triangle mesh to append as a new root node. */
export interface AppendedMesh {
  /** Name of the new node and its mesh, distinct from every node name already in the file. */
  name: string;
  /** xyz per vertex, finite Float32. */
  positions: ArrayLike<number>;
  /** Triangle list; every triangle needs area. */
  indices: ArrayLike<number>;
  /** Require the referenced points to span a volume (not all on one plane), as convex collision hulls need. */
  volume?: boolean;
  /** `extras` of the new node. */
  extras?: Extras;
  /** `extras` of the new mesh. */
  meshExtras?: Extras;
}

const align = (n: number): number => (n + 3) & ~3;

/**
 * @internal A zeroed GLB of one JSON chunk (`text`, space-padded to `jsonLength`) and, when `binLength` > 0, a BIN
 * chunk header for `binLength` bytes; the caller writes the BIN data at the returned `bin` offset. Shared by the
 * scene and model writers so neither concatenates its buffer parts.
 */
export function glbFrame(text: Uint8Array, jsonLength: number, binLength: number): { out: Uint8Array; bin: number } {
  const total = 20 + jsonLength + (binLength ? 8 + binLength : 0),
    out = new Uint8Array(total),
    view = new DataView(out.buffer),
    at = 20 + jsonLength;
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, at);
  if (binLength) {
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, GLB_BIN, true);
  }
  return { out, bin: at + 8 };
}

/**
 * Splits GLB bytes into the parsed JSON, the BIN chunk and any further chunks, checking the header, chunk order and
 * alignment, the UTF-8 JSON and that buffer 0 matches the BIN chunk.
 * @throws TypeError for anything that is not a valid glTF 2.0 GLB, or when `options.parse` throws.
 */
export function splitGLB(bytes: Uint8Array, options: SplitGLBOptions = {}): GLBParts {
  const { copy = true, parse = parseJSON } = options;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('splitGLB needs the GLB file as a Uint8Array');
  const chunks: GLBChunk[] = glbChunks(bytes);
  let json: unknown;
  try {
    // Untrusted file: the default parser drops __proto__/constructor/prototype keys so they cannot reach a caller's merge.
    json = parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].data));
  } catch (cause) {
    throw new TypeError('GLB JSON chunk is not valid UTF-8 JSON; pass an unmodified GLB file', { cause });
  }
  if (!isObject(json) || Array.isArray(json) || !isObject(json.asset) || json.asset.version !== '2.0')
    throw new TypeError('GLB JSON is not a glTF 2.0 document; pass a GLB that holds a glTF 2.0 document');
  const bin = chunks[1]?.type === GLB_BIN ? chunks[1].data : null,
    buffers = json.buffers;
  if (buffers !== undefined && (!Array.isArray(buffers) || !buffers.every(isObject)))
    throw new TypeError('glTF buffers must be an array of objects');
  const first = buffers?.[0] as Record<string, unknown> | undefined;
  if (bin) {
    const length = first?.byteLength;
    if (!first || first.uri !== undefined || !Number.isSafeInteger(length) || (length as number) < 1)
      throw new TypeError('GLB BIN chunk needs buffer 0 without a uri');
    if ((length as number) > bin.length || bin.length - (length as number) > 3)
      throw new TypeError('GLB buffer 0 byteLength does not match its BIN chunk; pass an unmodified GLB file');
  }
  return {
    json: json as Record<string, unknown>,
    bin: bin && (copy ? bin.slice() : bin),
    chunks: chunks.slice(bin ? 2 : 1).map(({ type, data }) => ({ type, data: copy ? data.slice() : data })),
  };
}

/**
 * GLB bytes from its parts: the JSON (padded with spaces), the BIN chunk (zero-padded) and the other chunks in order.
 * @throws TypeError for a chunk that is not 4-byte aligned or uses the JSON or BIN type; RangeError over 4 GiB.
 */
export function joinGLB({ json, bin, chunks = [] }: GLBParts): Uint8Array {
  if (!isObject(json) || Array.isArray(json)) throw new TypeError('GLB json must be a glTF object');
  if (bin !== null && bin !== undefined && !(bin instanceof Uint8Array))
    throw new TypeError('GLB bin must be a Uint8Array or null');
  const text = new TextEncoder().encode(JSON.stringify(json)),
    parts: { type: number; data: Uint8Array; length: number; fill: number }[] = [
      { type: GLB_JSON, data: text, length: align(text.length), fill: 0x20 },
    ];
  if (bin) parts.push({ type: GLB_BIN, data: bin, length: align(bin.length), fill: 0 });
  for (const chunk of chunks) {
    if (!isObject(chunk) || !(chunk.data instanceof Uint8Array) || !Number.isInteger(chunk.type))
      throw new TypeError('GLB chunks need a type and data');
    if (chunk.data.length % 4 || chunk.type === GLB_JSON || chunk.type === GLB_BIN)
      throw new TypeError('Extra GLB chunks must be 4-byte aligned and neither JSON nor BIN');
    parts.push({ type: chunk.type, data: chunk.data, length: chunk.data.length, fill: 0 });
  }
  const total = parts.reduce((sum, part) => sum + 8 + part.length, 12);
  if (total > 0xffffffff) throw new RangeError('GLB exceeds its 4 GiB length limit; split the scene');
  const out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let at = 12;
  for (const part of parts) {
    view.setUint32(at, part.length, true);
    view.setUint32(at + 4, part.type >>> 0, true);
    out.set(part.data, at + 8);
    out.fill(part.fill, at + 8 + part.data.length, at + 8 + part.length);
    at += 8 + part.length;
  }
  return out;
}

/** Values of one glTF accessor read from a GLB: {@link readAccessor}'s result. */
export interface AccessorValues {
  /** Every element's components packed without stride or padding, in the accessor's component type. */
  values: Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;
  /** Elements in the accessor. */
  count: number;
  /** Components per element: 1 (SCALAR), 2 to 4 (VEC2 to VEC4), 4, 9 or 16 (MAT2 to MAT4, column-major). */
  width: number;
  /** glTF component type: 5120 to 5123 (8- and 16-bit integers), 5125 (uint32) or 5126 (float32). */
  componentType: number;
  /** The accessor's `normalized` flag; integer values are returned as stored, not divided. */
  normalized: boolean;
}

// [columns, rows] of each accessor type.
const SHAPES: Record<string, [number, number]> = {
  SCALAR: [1, 1],
  VEC2: [1, 2],
  VEC3: [1, 3],
  VEC4: [1, 4],
  MAT2: [2, 2],
  MAT3: [3, 3],
  MAT4: [4, 4],
};
const COMPONENTS: Record<number, [new (length: number) => AccessorValues['values'], number]> = {
  5120: [Int8Array, 1],
  5121: [Uint8Array, 1],
  5122: [Int16Array, 2],
  5123: [Uint16Array, 2],
  5125: [Uint32Array, 4],
  5126: [Float32Array, 4],
};
const SPARSE_INDEX: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4 };

/**
 * Reads accessor `index` of a split GLB ({@link splitGLB}) as plain data: strided and matrix-padded elements are
 * packed, sparse substitutions applied, and an accessor without a buffer view reads as zeros plus its sparse values.
 * Only buffer 0, the BIN chunk, is read.
 * @throws TypeError for a missing or malformed accessor, buffer view or sparse block, or one that reads another
 * buffer; RangeError for data that runs past its buffer view or the BIN chunk, a sparse index past `count`, or a
 * non-finite float.
 */
export function readAccessor(parts: GLBParts, index: number): AccessorValues {
  const json = parts?.json as Record<string, unknown> | undefined,
    list = json?.accessors,
    accessor = Array.isArray(list) && Number.isSafeInteger(index) ? list[index] : undefined;
  if (!isObject(accessor)) throw new TypeError(`glTF accessor ${index} does not exist; pass an index into accessors`);
  const label = `glTF accessor ${index}`,
    shape = SHAPES[accessor.type as string],
    component = COMPONENTS[accessor.componentType as number],
    count = accessor.count as number;
  if (!shape || !component) throw new TypeError(`${label} has an unknown type or componentType; repair the GLB`);
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError(`${label} needs a count of at least 1`);
  const [columns, rows] = shape,
    [Values, size] = component,
    type = accessor.componentType as number,
    width = columns * rows,
    // Matrix columns start on 4-byte boundaries, so 1- and 2-byte MAT2 and MAT3 columns carry padding.
    column = columns > 1 ? (rows * size + 3) & ~3 : rows * size,
    element = columns * column,
    values = new Values(count * width);
  const view = (id: unknown, what: string): { data: DataView; stride: number } => {
    const views = json!.bufferViews,
      bufferView = Array.isArray(views) && Number.isSafeInteger(id) ? views[id as number] : undefined;
    if (!isObject(bufferView)) throw new TypeError(`${label} ${what} buffer view does not exist; repair the GLB`);
    if (bufferView.buffer !== 0 || !parts.bin)
      throw new TypeError(`${label} reads a buffer other than the GLB BIN chunk; only buffer 0 is read`);
    const offset = bufferView.byteOffset ?? 0,
      length = bufferView.byteLength,
      stride = bufferView.byteStride ?? 0;
    if (![offset, length, stride].every((n) => Number.isSafeInteger(n) && (n as number) >= 0))
      throw new TypeError(
        `${label} ${what} buffer view has a bad byteOffset, byteLength or byteStride; repair the GLB`,
      );
    if ((offset as number) + (length as number) > parts.bin.length)
      throw new RangeError(`${label} ${what} buffer view runs past the BIN chunk; repair the GLB`);
    return {
      data: new DataView(parts.bin.buffer, parts.bin.byteOffset + (offset as number), length as number),
      stride: stride as number,
    };
  };
  const copy = (data: DataView, at: number, step: number, from: number, to: number, valueType: number): void => {
    if (at < 0 || at + (to - from - 1) * step + element > data.byteLength)
      throw new RangeError(`${label} runs past its buffer view; repair the GLB`);
    for (let i = from; i < to; i++) {
      const base = at + (i - from) * step;
      for (let c = 0; c < columns; c++)
        for (let r = 0; r < rows; r++)
          values[i * width + c * rows + r] = readComponent(data, base + c * column + r * size, valueType);
    }
  };
  const start = accessor.byteOffset ?? 0;
  if (!Number.isSafeInteger(start) || (start as number) < 0)
    throw new TypeError(`${label} has a bad byteOffset; repair the GLB`);
  if (accessor.bufferView !== undefined) {
    const { data, stride } = view(accessor.bufferView, 'data');
    copy(data, start as number, stride || element, 0, count, type);
  }
  const sparse = accessor.sparse;
  if (sparse !== undefined) {
    if (!isObject(sparse) || !isObject(sparse.indices) || !isObject(sparse.values))
      throw new TypeError(`${label} sparse needs indices and values`);
    const total = sparse.count as number,
      indexType = sparse.indices.componentType as number,
      indexSize = SPARSE_INDEX[indexType];
    if (!Number.isSafeInteger(total) || total < 1 || total > count)
      throw new TypeError(`${label} sparse count must be 1 to the accessor count`);
    if (!indexSize) throw new TypeError(`${label} sparse indices need an unsigned componentType`);
    const indices = view(sparse.indices.bufferView, 'sparse index'),
      substitutes = view(sparse.values.bufferView, 'sparse value'),
      indexStart = (sparse.indices.byteOffset as number | undefined) ?? 0,
      valueStart = (sparse.values.byteOffset as number | undefined) ?? 0;
    if (!Number.isSafeInteger(indexStart) || !Number.isSafeInteger(valueStart) || indexStart < 0 || valueStart < 0)
      throw new TypeError(`${label} sparse has a bad byteOffset; repair the GLB`);
    if (indexStart + total * indexSize > indices.data.byteLength)
      throw new RangeError(`${label} sparse indices run past their buffer view; repair the GLB`);
    for (let k = 0; k < total; k++) {
      const target = readComponent(indices.data, indexStart + k * indexSize, indexType);
      if (target >= count)
        throw new RangeError(`${label} sparse index ${target} is past count ${count}; repair the GLB`);
      // One element at a time from the packed values view into slot `target`.
      copy(substitutes.data, valueStart + k * element, element, target, target + 1, type);
    }
  }
  if (Values === Float32Array && !values.every(Number.isFinite))
    throw new RangeError(`${label} holds a non-finite float; repair the GLB`);
  return { values, count, width, componentType: type, normalized: accessor.normalized === true };
}

type Point = [number, number, number];

/** Validated Float32 positions with bounds, after checking every triangle has area (and the volume when asked). */
function checkMesh(
  mesh: AppendedMesh,
  label: string,
): { positions: Float32Array; indices: Uint32Array; min: Point; max: Point } {
  const length = mesh.positions?.length;
  if (typeof length !== 'number' || length < 9 || length % 3)
    throw new RangeError(`${label} positions need xyz for at least three vertices`);
  const positions = new Float32Array(length),
    count = length / 3;
  for (let i = 0; i < length; i++) {
    const v = mesh.positions[i];
    if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)))
      throw new RangeError(`${label} positions must be finite Float32 values`);
    positions[i] = v;
  }
  const source = mesh.indices;
  if (!isObject(source) || typeof source.length !== 'number' || !source.length || source.length % 3)
    throw new RangeError(`${label} indices must hold complete triangles`);
  const indices = Uint32Array.from({ length: source.length }, (_, i) => {
    const index = source[i];
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new RangeError(`${label} index exceeds vertices; keep every index below the vertex count`);
    return index;
  });
  const min: Point = [Infinity, Infinity, Infinity],
    max: Point = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i]);
    max[i % 3] = Math.max(max[i % 3], positions[i]);
  }
  // Coordinates scaled into the bounds box, so tiny or huge Float32 values keep their rank in the products.
  const point = (index: number): Point =>
    [0, 1, 2].map((axis) => (positions[index * 3 + axis] - min[axis]) / (max[axis] - min[axis] || 1)) as Point;
  const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    cross = (a: Point, b: Point): Point => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  for (let i = 0; i < indices.length; i += 3) {
    const a = point(indices[i]);
    if (cross(sub(point(indices[i + 1]), a), sub(point(indices[i + 2]), a)).every((v) => v === 0))
      throw new RangeError(`${label} has a triangle without area at index ${i}; remove the zero-area triangle`);
  }
  if (mesh.volume) {
    // An edge, a plane through it, then any point off that plane.
    const used = [...new Set(indices)].map(point),
      origin = used[0],
      edge = used.map((p) => sub(p, origin)).find((d) => d.some((v) => v !== 0)),
      normal = edge && used.map((p) => cross(edge, sub(p, origin))).find((n) => n.some((v) => v !== 0)),
      off = (p: Point) => {
        const d = sub(p, origin);
        return d[0] * normal![0] + d[1] * normal![1] + d[2] * normal![2] !== 0;
      };
    if (!normal || !used.some(off))
      throw new RangeError(`${label} points lie on one plane; a volume needs points off it`);
  }
  return { positions, indices, min, max };
}

/**
 * Appends `meshes` to GLB bytes as new root nodes of the active scene, each with a POSITION and index accessor in
 * buffer 0, and returns the new file. Everything else is kept: the existing JSON (extensions, extras and unknown
 * members included), the BIN bytes, and every further chunk in order. Nodes are named exactly `mesh.name`, so an
 * importer's naming convention (a Godot `-colonly` suffix, for example) is the caller's choice.
 * @throws TypeError for an invalid GLB, scene or node references that do not resolve (checked even when `meshes` is
 * empty), or a buffer 0 that is external; RangeError for bad geometry or a name already used by a node.
 */
export function appendGLBMeshes(bytes: Uint8Array, meshes: readonly AppendedMesh[]): Uint8Array {
  const { json, bin, chunks } = splitGLB(bytes);
  if (!Array.isArray(meshes)) throw new TypeError('meshes must be an array');
  for (const key of ['nodes', 'meshes', 'accessors', 'bufferViews', 'scenes'])
    if (json[key] !== undefined && (!Array.isArray(json[key]) || !(json[key] as unknown[]).every(isObject)))
      throw new TypeError(`glTF ${key} must be an array of objects`);
  const lists = json as Record<string, Record<string, unknown>[]>,
    names = new Set((lists.nodes ?? []).map((node) => node.name).filter((name) => typeof name === 'string'));
  // Existing references are checked even when nothing is appended, so a malformed file is never returned as valid.
  const nodeCount = lists.nodes?.length ?? 0,
    index = (value: unknown, count: number): boolean =>
      Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < count,
    references = (list: unknown, what: string): void => {
      if (
        list !== undefined &&
        (!Array.isArray(list) || !list.every((i) => index(i, nodeCount)) || new Set(list).size !== list.length)
      )
        throw new TypeError(`glTF ${what} must list distinct existing node indices`);
    };
  (lists.scenes ?? []).forEach((scene, i) => references(scene.nodes, `scene ${i} nodes`));
  (lists.nodes ?? []).forEach((node, i) => references(node.children, `node ${i} children`));
  if (json.scene !== undefined && !index(json.scene, lists.scenes?.length ?? 0))
    throw new TypeError('glTF scene index is out of range; pick a scene index below the scene count');
  const prepared = meshes.map((mesh, i) => {
    if (!isObject(mesh)) throw new TypeError(`meshes[${i}] must be an object`);
    if (typeof mesh.name !== 'string' || !mesh.name || /[\u0000-\u001f]/.test(mesh.name))
      throw new TypeError(`meshes[${i}] needs a nonempty name without control characters`);
    if (names.has(mesh.name)) throw new RangeError(`A node named ${mesh.name} already exists; names must be distinct`);
    names.add(mesh.name);
    return {
      mesh,
      ...checkMesh(mesh, `Mesh ${mesh.name}`),
      extras: copyExtras(mesh.extras, `Mesh ${mesh.name} extras`),
      meshExtras: copyExtras(mesh.meshExtras, `Mesh ${mesh.name} meshExtras`),
    };
  });
  if (!prepared.length) return bytes.slice();
  if (bin === null && lists.buffers?.length)
    throw new TypeError('GLB buffer 0 is external; append to a GLB that embeds its buffer');
  if (lists.scenes === undefined) {
    // A file without scenes gets one holding its existing root nodes, so appending does not hide them.
    const children = new Set((lists.nodes ?? []).flatMap((node) => (node.children as number[] | undefined) ?? []));
    lists.scenes = [{ nodes: (lists.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i)) }];
  }
  const sceneIndex = (json.scene ?? 0) as number,
    scenes = lists.scenes;
  if (!Number.isSafeInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= scenes.length)
    throw new TypeError('glTF scene index is out of range; pick a scene index below the scene count');
  json.scene = sceneIndex;
  const roots = ((scenes[sceneIndex].nodes as number[] | undefined) ??= []),
    nodes = (lists.nodes ??= []),
    meshList = (lists.meshes ??= []),
    accessors = (lists.accessors ??= []),
    views = (lists.bufferViews ??= []),
    buffers = (lists.buffers ??= [{ byteLength: 0 }]),
    parts: Uint8Array[] = bin ? [bin] : [];
  let length = bin ? align(bin.length) : 0;
  if (bin && length > bin.length) parts.push(new Uint8Array(length - bin.length));
  const write = (data: Float32Array | Uint16Array | Uint32Array, target: number): number => {
    // DataView keeps the GLB little-endian on any host.
    const padded = new Uint8Array(align(data.byteLength)),
      out = new DataView(padded.buffer),
      size = data.BYTES_PER_ELEMENT;
    for (let i = 0; i < data.length; i++)
      if (data instanceof Float32Array) out.setFloat32(i * 4, data[i], true);
      else if (size === 2) out.setUint16(i * 2, data[i], true);
      else out.setUint32(i * 4, data[i], true);
    views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, target });
    parts.push(padded);
    length += padded.length;
    return views.length - 1;
  };
  for (const { mesh, positions, indices, min, max, extras, meshExtras } of prepared) {
    const position =
        accessors.push({
          bufferView: write(positions, 34962),
          componentType: 5126,
          count: positions.length / 3,
          type: 'VEC3',
          min,
          max,
        }) - 1,
      short = positions.length / 3 <= 65535,
      index =
        accessors.push({
          bufferView: write(short ? Uint16Array.from(indices) : indices, 34963),
          componentType: short ? 5123 : 5125,
          count: indices.length,
          type: 'SCALAR',
        }) - 1;
    const meshDefinition: Record<string, unknown> = {
      name: mesh.name,
      primitives: [{ attributes: { POSITION: position }, indices: index, mode: 4 }],
    };
    if (meshExtras) meshDefinition.extras = meshExtras;
    const node: Record<string, unknown> = { name: mesh.name, mesh: meshList.push(meshDefinition) - 1 };
    if (extras) node.extras = extras;
    roots.push(nodes.push(node) - 1);
  }
  buffers[0].byteLength = length;
  const merged = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    merged.set(part, at);
    at += part.length;
  }
  return joinGLB({ json, bin: merged, chunks });
}

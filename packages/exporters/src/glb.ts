// Lossless GLB augmentation: split a GLB into its JSON, BIN and any further chunks, join them back, and append named
// meshes (collision proxies, markers) to an existing file without touching its other data, extensions or extras.
import { copyExtras } from './extras.js';
import type { Extras } from './scene.js';

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

const MAGIC = 0x46546c67,
  JSON_CHUNK = 0x4e4f534a,
  BIN_CHUNK = 0x004e4942;
const align = (n: number): number => (n + 3) & ~3;

/**
 * Splits GLB bytes into the parsed JSON, the BIN chunk and any further chunks, checking the header, chunk order and
 * alignment, the UTF-8 JSON and that buffer 0 matches the BIN chunk.
 * @throws TypeError for anything that is not a valid glTF 2.0 GLB.
 */
export function splitGLB(bytes: Uint8Array): GLBParts {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20) throw new TypeError('GLB needs at least a 20-byte header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length)
    throw new TypeError('GLB magic, version 2 or total length is wrong; pass a whole binary glTF 2.0 file');
  const chunks: GLBChunk[] = [];
  for (let at = 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) throw new TypeError('GLB ends inside a chunk header');
    const length = view.getUint32(at, true),
      type = view.getUint32(at + 4, true),
      end = at + 8 + length;
    if (length % 4 || end > bytes.length) throw new TypeError('GLB chunk is misaligned or runs past the file');
    if ((chunks.length === 0) !== (type === JSON_CHUNK) || (type === BIN_CHUNK && chunks.length !== 1))
      throw new TypeError('GLB chunks must be JSON first, then at most one BIN second');
    chunks.push({ type, data: bytes.subarray(at + 8, end) });
    at = end;
  }
  if (!chunks.length) throw new TypeError('GLB has no JSON chunk');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].data));
  } catch {
    throw new TypeError('GLB JSON chunk is not valid UTF-8 JSON');
  }
  if (!isObject(json) || Array.isArray(json) || !isObject(json.asset) || json.asset.version !== '2.0')
    throw new TypeError('GLB JSON is not a glTF 2.0 document');
  const bin = chunks[1]?.type === BIN_CHUNK ? chunks[1].data : null,
    buffers = json.buffers;
  if (buffers !== undefined && (!Array.isArray(buffers) || !buffers.every(isObject)))
    throw new TypeError('glTF buffers must be an array of objects');
  const first = buffers?.[0] as Record<string, unknown> | undefined;
  if (bin) {
    const length = first?.byteLength;
    if (!first || first.uri !== undefined || !Number.isSafeInteger(length) || (length as number) < 1)
      throw new TypeError('GLB BIN chunk needs buffer 0 without a uri');
    if ((length as number) > bin.length || bin.length - (length as number) > 3)
      throw new TypeError('GLB buffer 0 byteLength does not match its BIN chunk');
  }
  return {
    json: json as Record<string, unknown>,
    bin: bin && bin.slice(),
    chunks: chunks.slice(bin ? 2 : 1).map(({ type, data }) => ({ type, data: data.slice() })),
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
      { type: JSON_CHUNK, data: text, length: align(text.length), fill: 0x20 },
    ];
  if (bin) parts.push({ type: BIN_CHUNK, data: bin, length: align(bin.length), fill: 0 });
  for (const chunk of chunks) {
    if (!isObject(chunk) || !(chunk.data instanceof Uint8Array) || !Number.isInteger(chunk.type))
      throw new TypeError('GLB chunks need a type and data');
    if (chunk.data.length % 4 || chunk.type === JSON_CHUNK || chunk.type === BIN_CHUNK)
      throw new TypeError('Extra GLB chunks must be 4-byte aligned and neither JSON nor BIN');
    parts.push({ type: chunk.type, data: chunk.data, length: chunk.data.length, fill: 0 });
  }
  const total = parts.reduce((sum, part) => sum + 8 + part.length, 12);
  if (total > 0xffffffff) throw new RangeError('GLB exceeds its 4 GiB length limit; split the scene');
  const out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
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
      throw new RangeError(`${label} index exceeds vertices`);
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
      throw new RangeError(`${label} has a triangle without area at index ${i}`);
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
 * @throws TypeError for an invalid GLB or one whose buffer 0 is external; RangeError for bad geometry or a name
 * already used by a node.
 */
export function appendGLBMeshes(bytes: Uint8Array, meshes: readonly AppendedMesh[]): Uint8Array {
  const { json, bin, chunks } = splitGLB(bytes);
  if (!Array.isArray(meshes)) throw new TypeError('meshes must be an array');
  for (const key of ['nodes', 'meshes', 'accessors', 'bufferViews', 'scenes'])
    if (json[key] !== undefined && (!Array.isArray(json[key]) || !(json[key] as unknown[]).every(isObject)))
      throw new TypeError(`glTF ${key} must be an array of objects`);
  const lists = json as Record<string, Record<string, unknown>[]>,
    names = new Set((lists.nodes ?? []).map((node) => node.name).filter((name) => typeof name === 'string'));
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
    throw new TypeError('glTF scene index is out of range');
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

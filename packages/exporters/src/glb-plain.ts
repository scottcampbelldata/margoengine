// A compressed GLB as a plain one, for readers of plain accessors: meshopt buffer views (EXT_meshopt_compression and
// KHR_meshopt_compression, Khronos glTF extension registry) and KHR_draco_mesh_compression primitives (same registry),
// decoded with the engine's own decoders. Loaded only for a file that requires one, so no other file brings a decoder in.
import type { DecodedDracoGeometry, DracoDecoder } from '@margoengine/decoders/draco-native';
import { ACCESSOR_WIDTHS, COMPONENT_BYTES } from '../../shared/accessor.js';
import type { GLBParts } from './glb.js';
import type { JSONObject } from './glb-pack.js';

const MESHOPT = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];
const DRACO = 'KHR_draco_mesh_compression';
// The most one file may decode to, four times the glTF loader's default byte budget, as the loader allows.
const MOST_BYTES = 2 ** 31;
const ARRAYS: Record<number, new (values: ArrayLike<number>) => ArrayBufferView> = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
// Draco's four named channels come back in fields of their own; every other one under `attributes`.
const FIELDS: Record<string, 'positions' | 'normals' | 'uvs' | 'colors'> = {
  POSITION: 'positions',
  NORMAL: 'normals',
  TEXCOORD_0: 'uvs',
  COLOR_0: 'colors',
};

const broken = (what: string): string => `${what}; re-export the file and check it with the glTF Validator`;

function whole(value: unknown, what: string, least = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < least) throw new TypeError(broken(`Invalid glTF ${what}`));
  return value as number;
}

function item(list: JSONObject[] | undefined, index: unknown, what: string): JSONObject {
  const value = list?.[whole(index, what)];
  if (!value || typeof value !== 'object') throw new TypeError(broken(`Missing glTF ${what}`));
  return value;
}

/**
 * The parts with every buffer view and primitive that a required extension compresses decoded into one new BIN chunk.
 * Changes `parts.json` in place. A compression the file only lists as used keeps its uncompressed fallback.
 * @throws TypeError for a malformed compressed block; RangeError for data past its buffer or more than 2 GiB decoded; what
 * the decoder throws for a damaged stream; the signal's reason on an abort.
 */
export async function plainGLBParts(parts: GLBParts, signal?: AbortSignal): Promise<GLBParts> {
  const json = parts.json as JSONObject,
    required: string[] = json.extensionsRequired ?? [],
    views: JSONObject[] = json.bufferViews ?? [],
    chunks: Uint8Array[] = [];
  let length = 0,
    decoded = 0;
  /** Appends `data` to the new BIN chunk on a 4-byte boundary and returns where it starts. */
  const append = (data: Uint8Array): number => {
    const at = (length + 3) & ~3;
    chunks[chunks.length] = data;
    length = at + data.length;
    return at;
  };
  const budget = (bytes: number): void => {
    decoded += bytes;
    if (decoded > MOST_BYTES)
      throw new RangeError('This GLB decodes to more than 2 GiB; split the model or reduce its meshes');
  };
  const slice = (offset: number, size: number, what: string): Uint8Array => {
    if (!parts.bin || offset + size > parts.bin.length) throw new RangeError(broken(`${what} runs past the BIN chunk`));
    return parts.bin.subarray(offset, offset + size);
  };

  // The new bytes of every view that lived in the BIN chunk or was compressed into it.
  const held = new Map<number, Uint8Array>(),
    meshopt = MESHOPT.some((name) => required.includes(name))
      ? (await import('@margoengine/decoders/meshopt')).meshoptDecodeGltfBuffer
      : undefined;
  for (let index = 0; index < views.length; index++) {
    signal?.throwIfAborted();
    const view = views[index]!,
      found = MESHOPT.filter((name) => view.extensions?.[name] !== undefined);
    let data: Uint8Array;
    if (meshopt && found.length) {
      if (found.length > 1) throw new TypeError(broken('A buffer view uses both meshopt extensions'));
      const stream = view.extensions[found[0]!] as JSONObject;
      if (whole(stream?.buffer, 'meshopt buffer reference') !== 0)
        throw new TypeError('Meshopt data outside the GLB BIN chunk is not read; pack the file into one GLB');
      const count = whole(stream.count, 'meshopt count', 1),
        stride = whole(stream.byteStride, 'meshopt stride', 1);
      if (count * stride !== view.byteLength || (view.byteStride !== undefined && view.byteStride !== stride))
        throw new RangeError(broken('A meshopt buffer view does not match its decoded size'));
      budget(count * stride);
      const source = slice(
        whole(stream.byteOffset ?? 0, 'meshopt offset'),
        whole(stream.byteLength, 'meshopt length', 1),
        'A meshopt stream',
      );
      data = meshopt(source, count, stride, stream.mode, stream.filter ?? 'NONE');
      delete view.extensions[found[0]!];
    } else if (view.buffer === 0) {
      data = slice(whole(view.byteOffset ?? 0, 'view offset'), whole(view.byteLength, 'view length', 1), 'A view');
    } else continue;
    held.set(index, data);
    view.buffer = 0;
    view.byteOffset = append(data);
  }

  if (required.includes(DRACO)) await draco(json, held, views, append, budget, signal);

  const bin = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    at = (at + 3) & ~3;
    bin.set(chunk, at);
    at += chunk.length;
  }
  json.buffers = [{ byteLength: length }, ...(json.buffers ?? []).slice(1)];
  json.extensionsRequired = required.filter((name) => name !== DRACO && !MESHOPT.includes(name));
  return { json, bin, chunks: parts.chunks };
}

/** Decodes every Draco primitive into new views and points its accessors at them. */
async function draco(
  json: JSONObject,
  held: Map<number, Uint8Array>,
  views: JSONObject[],
  append: (data: Uint8Array) => number,
  budget: (bytes: number) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const accessors: JSONObject[] = json.accessors ?? [],
    written = new Map<number, Uint8Array>();
  /** Points accessor `id` at `values`; a second primitive sharing it must decode to the same bytes. */
  const store = (id: number, values: ArrayBufferView, componentType: number, normalized: boolean): void => {
    const data = new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      before = written.get(id);
    if (before) {
      if (before.length !== data.length || before.some((byte, i) => byte !== data[i]))
        throw new TypeError(broken('Two Draco primitives decode one accessor to different values'));
      return;
    }
    written.set(id, data);
    budget(data.length);
    const def = accessors[id]!;
    def.bufferView = views.length;
    views.push({
      buffer: 0,
      byteOffset: append(data),
      byteLength: data.length,
    });
    def.byteOffset = 0;
    def.componentType = componentType;
    def.count = values.byteLength / (COMPONENT_BYTES[componentType]! * ACCESSOR_WIDTHS[def.type]!);
    if (normalized) def.normalized = true;
    else delete def.normalized;
    delete def.sparse;
  };
  let decoder: DracoDecoder | undefined;
  try {
    for (const mesh of (json.meshes ?? []) as JSONObject[])
      for (const primitive of (mesh.primitives ?? []) as JSONObject[]) {
        const extension = primitive.extensions?.[DRACO];
        if (!extension) continue;
        signal?.throwIfAborted();
        if ((primitive.mode ?? 4) !== 4)
          throw new TypeError('Only Draco triangle lists are read; re-export the mesh with mode 4 (TRIANGLES)');
        const view = whole(extension.bufferView, 'Draco bufferView'),
          source = held.get(view);
        if (!source) throw new TypeError(broken('A Draco primitive reads a buffer view outside the GLB BIN chunk'));
        if (!extension.attributes || typeof extension.attributes !== 'object')
          throw new TypeError(broken('Invalid glTF Draco attributes'));
        const componentTypes: Record<string, number> = {},
          attributeIds: Record<string, number> = {},
          attributeWidths: Record<string, number> = {},
          targets = new Map<string, { id: number; def: JSONObject }>();
        for (const [semantic, unique] of Object.entries(extension.attributes)) {
          const id = whole(primitive.attributes?.[semantic], 'Draco attribute accessor'),
            def = item(accessors, id, 'Draco attribute accessor'),
            width = ACCESSOR_WIDTHS[def.type];
          if (!width || !ARRAYS[def.componentType]) throw new TypeError(broken('Invalid glTF Draco accessor type'));
          targets.set(semantic, { id, def });
          componentTypes[semantic] = def.componentType;
          attributeIds[semantic] = whole(unique, 'Draco attribute id');
          attributeWidths[semantic] = width;
        }
        const position = targets.get('POSITION');
        if (!position) throw new TypeError(broken('A Draco primitive has no compressed POSITION'));
        const vertices = whole(position.def.count, 'Draco vertex count', 3),
          indexDef =
            primitive.indices === undefined ? undefined : item(accessors, primitive.indices, 'Draco index accessor');
        decoder ??= new (await import('@margoengine/decoders/draco-native')).DracoDecoder();
        const result: DecodedDracoGeometry = await decoder.decode(source, {
          attributeIds,
          componentTypes,
          signal,
          limits: {
            maxVertices: vertices,
            ...(indexDef ? { maxIndices: whole(indexDef.count, 'Draco index count', 3) } : {}),
            attributeWidths,
          },
        });
        signal?.throwIfAborted();
        const { indices, vertexCount } = result;
        if (
          vertexCount !== vertices ||
          !indices ||
          indices.length % 3 ||
          (indexDef && indices.length !== indexDef.count) ||
          indices.some((i) => i >= vertexCount)
        )
          throw new RangeError(broken('A Draco stream does not match its accessors'));
        for (const [semantic, { id, def }] of targets) {
          const field = Object.hasOwn(FIELDS, semantic) ? FIELDS[semantic] : undefined,
            values = field ? result[field] : result.attributes[semantic]?.array;
          if (!values || def.count !== vertexCount || values.length !== vertexCount * attributeWidths[semantic]!)
            throw new RangeError(broken(`Draco ${semantic} does not match its accessor`));
          // Colours come back already scaled to 0 to 1; every other channel holds the accessor's own stored values.
          if (semantic === 'COLOR_0') store(id, values, 5126, false);
          else store(id, new ARRAYS[def.componentType]!(values), def.componentType, def.normalized === true);
        }
        // The index accessor's componentType does not bound decoded Draco indices (Blender declares UNSIGNED_SHORT past
        // 65,535 vertices), so the accessor takes the type the decoder returned.
        if (!indexDef) primitive.indices = accessors.push({ type: 'SCALAR' }) - 1;
        store(primitive.indices, indices, indices.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, false);
        delete primitive.extensions[DRACO];
      }
  } finally {
    decoder?.dispose();
  }
}

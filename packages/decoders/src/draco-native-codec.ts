// Owned-buffer bridge for the clean-room crate. No prebuilt codec is loaded here.
import { decodeFailed, deviceUnsupported } from './errors.js';
import { validatedDracoLimits } from './protocol.js';
import type { DecodedDracoGeometry, DecodedDracoPoints, DracoRequest, DracoPointsRequest } from './protocol.js';

interface NativeExports {
  memory: WebAssembly.Memory;
  draco_alloc(length: number): number;
  draco_free(pointer: number, length: number): void;
  draco_decode(
    pointer: number,
    length: number,
    vertices: number,
    indices: number,
    bytes: number,
    flavor: number,
  ): number;
}
type Samples =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;
interface Attribute {
  semantic: number;
  type: number;
  width: number;
  normalized: boolean;
  id: number;
  values: Samples;
}
interface Geometry {
  points: number;
  mesh: boolean;
  indices: Uint32Array;
  attributes: Attribute[];
  names: Map<number, string>;
}
const constructors = [
  undefined,
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  undefined,
  undefined,
  Float32Array,
  Float64Array,
  Uint8Array,
] as const;
const ranges: Record<number, number> = { 1: 127, 2: 255, 3: 32767, 4: 65535, 5: 2147483647, 6: 4294967295 };
const semantics = ['POSITION', 'NORMAL', 'COLOR', 'TEX_COORD', 'GENERIC'] as const;
const fields = { POSITION: 'positions', NORMAL: 'normals', COLOR_0: 'colors', TEXCOORD_0: 'uvs' } as const;
const gltfTypes = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

/** Compile one clean-room module; called only by its dedicated worker on first use. */
export async function loadNativeDraco(url: string): Promise<NativeExports> {
  const response = await fetch(url);
  if (!response.ok) throw decodeFailed(`Draco: could not load ${url} (${response.status}); check the asset URL`);
  return (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports as unknown as NativeExports;
}

function unpack(data: Uint8Array): Geometry {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  const num = (): number => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const blob = (): Uint8Array => {
    const length = num(),
      result = data.subarray(at, at + length);
    at += length;
    return result;
  };
  const points = num(),
    mesh = num() !== 0,
    count = num(),
    attributesCount = num();
  const indices = new Uint32Array(data.buffer.slice(data.byteOffset + at, data.byteOffset + at + count * 4));
  at += count * 4;
  const attributes: Attribute[] = [];
  for (let i = 0; i < attributesCount; i++) {
    const semantic = data[at++],
      type = data[at++],
      width = data[at++],
      normalized = data[at++] !== 0;
    const id = num(),
      bytes = blob(),
      Ctor = constructors[type];
    if (!Ctor) throw deviceUnsupported('Draco: unsupported attribute type; export integers or floats');
    const values = new Ctor(bytes.slice().buffer);
    attributes.push({ semantic, type, width, normalized, id, values });
  }
  const names = new Map<number, string>();
  if (at < data.length) {
    if (num() !== 0x4154454d) throw decodeFailed('Draco: invalid metadata trailer; rebuild the decoder assets');
    const nodes = num(),
      roots = num();
    num(); // File metadata root: point names use the attribute roots below.
    const ids = new Map<number, number[]>();
    for (let i = 0; i < roots; i++) {
      const id = num(),
        root = num();
      ids.set(root, [...(ids.get(root) ?? []), id]);
    }
    const text = (bytes: Uint8Array): string => {
      const end = bytes.indexOf(0);
      return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
    };
    for (let i = 0; i < nodes; i++) {
      const entries = num(),
        children = num();
      for (let j = 0; j < entries; j++) {
        const key = text(blob()),
          value = blob();
        if (key === 'name') for (const id of ids.get(i) ?? []) names.set(id, text(value));
      }
      for (let j = 0; j < children; j++) {
        blob();
        num();
      }
    }
  }
  return { points, mesh, indices, attributes, names };
}

function native(module: NativeExports, bytes: Uint8Array, request: DracoRequest, flavor: number): Geometry {
  const limits = validatedDracoLimits(request.limits);
  const input = module.draco_alloc(bytes.length);
  if (!input) throw decodeFailed('Draco: input is empty or exceeds 256 MiB; supply a bounded .drc buffer');
  let output = 0,
    length = 0;
  try {
    new Uint8Array(module.memory.buffer, input, bytes.length).set(bytes);
    // The crate's workspace budget is separate from the requested output budget.
    output = module.draco_decode(input, bytes.length, limits.maxVertices, limits.maxIndices, 256 * 1024 * 1024, flavor);
    if (!output) throw decodeFailed('Draco: allocation failed; export a smaller mesh');
    const view = new DataView(module.memory.buffer);
    length = view.getUint32(output, true);
    const code = view.getUint32(output + 4, true);
    if (code === 6)
      throw Object.assign(new RangeError('Draco: decode limit exceeded; export a smaller mesh'), { code: 'failed' });
    if (code === 5) throw deviceUnsupported('Draco: unsupported bitstream path; use the default prebuilt decoder');
    if (code)
      throw decodeFailed(
        `Draco: damaged bitstream (${code}); re-export the file. See https://margoengine.com/errors/failed`,
      );
    return unpack(new Uint8Array(module.memory.buffer, output, length));
  } finally {
    if (output) module.draco_free(output, length);
    module.draco_free(input, bytes.length);
  }
}

/** Convert the native output to the existing glTF decoder contract. */
export function decodeNativeDraco(
  module: NativeExports,
  bytes: Uint8Array,
  request: DracoRequest = {},
): DecodedDracoGeometry {
  const limits = validatedDracoLimits(request.limits),
    g = native(module, bytes, request, 1);
  if (!g.mesh)
    throw deviceUnsupported('Draco: use DracoPointsDecoder from @margoengine/decoders/draco-native for point clouds');
  if (!g.points || !g.indices.length) throw decodeFailed('Draco: empty mesh; export vertices and triangles');
  const ids =
    request.attributeIds ??
    Object.fromEntries(
      [
        ['POSITION', 0],
        ['NORMAL', 1],
        ['COLOR_0', 2],
        ['TEXCOORD_0', 3],
      ].flatMap(([name, semantic]) => {
        const attribute = g.attributes.find((a) => a.semantic === semantic);
        return attribute ? [[name, attribute.id]] : [];
      }),
    );
  const result: DecodedDracoGeometry = { vertexCount: g.points, positions: new Float32Array(0), attributes: {} };
  const Index = g.points >= 65536 ? Uint32Array : Uint16Array;
  let size = g.indices.length * Index.BYTES_PER_ELEMENT;
  const reads = Object.entries(ids).map(([name, id]) => {
    if (!Number.isSafeInteger(id) || id < 0)
      throw new TypeError(`Draco: invalid attribute id for ${name}; use the file's unique ID`);
    const a = g.attributes.find((a) => a.id === id);
    if (!a) throw decodeFailed(`Draco: missing attribute ${name}; correct the attribute map`);
    const type = request.componentTypes?.[name] ?? 5126,
      Ctor = gltfTypes[type as keyof typeof gltfTypes];
    if (!Ctor) throw new TypeError(`Draco: unsupported component type ${type}; use a glTF numeric accessor type`);
    if (limits.attributeWidths?.[name] !== undefined && a.width !== limits.attributeWidths[name])
      throw new RangeError(`Draco: ${name} width does not match accessor; correct its type`);
    const field = Object.hasOwn(fields, name) ? fields[name as keyof typeof fields] : undefined;
    size += a.values.length * (field ? 4 : Ctor.BYTES_PER_ELEMENT);
    return { name, a, type, Ctor, field };
  });
  if (size > limits.maxDecodedBytes)
    throw new RangeError('Draco: decoded byte limit exceeded; raise maxDecodedBytes or export fewer points');
  for (const { name, a, type, Ctor, field } of reads) {
    const values = new Ctor(a.values.length);
    for (let i = 0; i < values.length; i++) {
      const v = a.values[i];
      values[i] = type === 5126 && a.normalized && ranges[a.type] ? Math.max(-1, v / ranges[a.type]) : v;
    }
    if (field) {
      const floats = values instanceof Float32Array ? values : Float32Array.from(values);
      if (field === 'colors') {
        const sourceRange =
          request.componentTypes?.[name] !== undefined
            ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295 } as Record<number, number>)[type]
            : !a.normalized
              ? ranges[a.type]
              : undefined;
        if (sourceRange) for (let i = 0; i < floats.length; i++) floats[i] = Math.max(-1, floats[i] / sourceRange);
        result.colorSize = a.width;
      }
      result[field] = floats;
    } else result.attributes[name] = { array: values, itemSize: a.width, componentType: type };
  }
  if (!result.positions.length && (request.attributeIds === undefined || Object.hasOwn(ids, 'POSITION')))
    throw decodeFailed('Draco: geometry has no POSITION attribute; export positions');
  result.indices = new Index(g.indices);
  return result;
}

/** Convert full-flavor native output to the existing point-cloud contract. */
export function decodeNativePoints(
  module: NativeExports,
  bytes: Uint8Array,
  request: DracoPointsRequest = {},
): DecodedDracoPoints {
  const limits = validatedDracoLimits(request.limits),
    g = native(module, bytes, request, 0);
  if (g.mesh) throw decodeFailed('Draco: this file is a mesh; decode it with DracoDecoder');
  if (!g.points) throw decodeFailed('Draco: empty point cloud; export points');
  const Index = g.points >= 65536 ? Uint32Array : Uint16Array;
  const size = g.points * Index.BYTES_PER_ELEMENT + g.attributes.reduce((n, a) => n + a.values.byteLength, 0);
  if (size > limits.maxDecodedBytes)
    throw new RangeError('Draco: decoded byte limit exceeded; raise maxDecodedBytes or export fewer points');
  const seen = new Map<string, number>();
  const attributes = g.attributes.map((a) => {
    const semantic = semantics[a.semantic];
    if (!semantic || a.values instanceof Float64Array || a.type === 11)
      throw deviceUnsupported('Draco: unsupported point attribute type; export 32-bit integers or floats');
    const label = semantic === 'TEX_COORD' ? 'TEXCOORD' : semantic;
    const nth = seen.get(label) ?? 0;
    seen.set(label, nth + 1);
    const fallback = nth === 0 && (label === 'POSITION' || label === 'NORMAL') ? label : `${label}_${nth}`;
    return {
      name: g.names.get(a.id) ?? fallback,
      semantic,
      uniqueId: a.id,
      array: a.values,
      itemSize: a.width,
      normalized: a.normalized,
    };
  });
  const indices = new Index(g.points);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { pointCount: g.points, indices, attributes };
}

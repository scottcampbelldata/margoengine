// Worker-side decode functions. Kept free of worker globals so unit tests can drive them with real or mock modules.
import { transcodeFormats } from './formats.js';
import type { DecodedDracoGeometry, DracoRequest, KTX2Mip, TranscodeTarget, TranscodedKTX2Result } from './protocol.js';

/**
 * Runs a classic Emscripten script in global scope so its top-level `var` factory becomes a global. The worker passes
 * `importScripts`, which a strict CSP (`script-src 'self'`, no `'unsafe-eval'`) allows; Node tests pass their own. The
 * Wasm download starts first and overlaps the (synchronous) script load.
 */
export type ScriptLoader = (url: string) => Promise<void>;

async function binary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.arrayBuffer();
}

/** Emscripten module objects are thenable, so they travel inside a box to keep promise resolution finite. */
export interface ModuleBox {
  module: any;
}

/** Load Google's Draco wrapper with `load` and instantiate it on the downloaded `draco_decoder.wasm`. */
export async function initDraco(wrapperURL: string, wasmURL: string, load: ScriptLoader): Promise<ModuleBox> {
  const [wasmBinary] = await Promise.all([binary(wasmURL), load(wrapperURL)]);
  const factory = (globalThis as any).DracoDecoderModule;
  if (typeof factory !== 'function') throw new Error('Draco wrapper did not define DracoDecoderModule');
  return new Promise((resolve, reject) => {
    factory({ wasmBinary }).then((module: any) => resolve({ module }), reject);
  });
}

/** Load the Basis transcoder with `load` and instantiate it on the downloaded `basis_transcoder.wasm`. */
export async function initBasis(transcoderURL: string, wasmURL: string, load: ScriptLoader): Promise<ModuleBox> {
  const [wasmBinary] = await Promise.all([binary(wasmURL), load(transcoderURL)]);
  const factory = (globalThis as any).BASIS;
  if (typeof factory !== 'function') throw new Error('Basis transcoder did not define BASIS');
  const module: any = await new Promise((resolve, reject) => {
    factory({ wasmBinary }).then((m: any) => resolve({ m }), reject);
  }).then((box: any) => box.m);
  module.initializeBasis();
  if (typeof module.KTX2File !== 'function') throw new Error('Basis transcoder lacks KTX2 support');
  return { module };
}

const fields: Record<string, 'positions' | 'normals' | 'uvs' | 'colors'> = {
  POSITION: 'positions',
  NORMAL: 'normals',
  TEXCOORD_0: 'uvs',
  COLOR_0: 'colors',
};
const dracoTypes: Record<number, [string, any]> = {
  5120: ['DT_INT8', Int8Array],
  5121: ['DT_UINT8', Uint8Array],
  5122: ['DT_INT16', Int16Array],
  5123: ['DT_UINT16', Uint16Array],
  5125: ['DT_UINT32', Uint32Array],
  5126: ['DT_FLOAT32', Float32Array],
};
const integerRange: Record<string, number> = {
  DT_INT8: 127,
  DT_UINT8: 255,
  DT_INT16: 32767,
  DT_UINT16: 65535,
  DT_INT32: 2147483647,
  DT_UINT32: 4294967295,
};
const vertexLimit = 16_777_216;

/**
 * Decode one Draco buffer. Every Draco handle and heap allocation is released before returning, including on error,
 * and every output array is a copy that owns its own buffer so it can be transferred.
 */
export function decodeDraco(draco: any, bytes: Uint8Array, request: DracoRequest = {}): DecodedDracoGeometry {
  const decoder = new draco.Decoder(),
    buffer = new draco.DecoderBuffer();
  let geometry: any = null;
  try {
    buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    const kind = decoder.GetEncodedGeometryType(buffer);
    let status: any;
    if (kind === draco.TRIANGULAR_MESH) {
      geometry = new draco.Mesh();
      status = decoder.DecodeBufferToMesh(buffer, geometry);
    } else if (kind === draco.POINT_CLOUD) {
      geometry = new draco.PointCloud();
      status = decoder.DecodeBufferToPointCloud(buffer, geometry);
    } else throw new Error('Draco: unknown geometry type');
    if (!status.ok() || !geometry.ptr) throw new Error('Draco: ' + status.error_msg());
    const vertexCount: number = geometry.num_points();
    if (!vertexCount || vertexCount > vertexLimit) throw new RangeError('Draco: invalid vertex count');
    const byId = request.attributeIds !== undefined;
    const ids: Record<string, number> = request.attributeIds ?? {};
    if (!byId)
      for (const [semantic, type] of [
        ['POSITION', 'POSITION'],
        ['NORMAL', 'NORMAL'],
        ['TEXCOORD_0', 'TEX_COORD'],
        ['COLOR_0', 'COLOR'],
      ]) {
        const id = decoder.GetAttributeId(geometry, draco[type]);
        if (id >= 0) ids[semantic] = id;
      }
    const result: DecodedDracoGeometry = {
      vertexCount,
      positions: undefined as unknown as Float32Array,
      attributes: Object.create(null),
    };
    for (const [semantic, id] of Object.entries(ids)) {
      if (!Number.isSafeInteger(id) || id < 0) throw new TypeError(`Draco: invalid attribute id for ${semantic}`);
      const attribute = byId ? decoder.GetAttributeByUniqueId(geometry, id) : decoder.GetAttribute(geometry, id);
      if (!attribute || !attribute.ptr) throw new Error(`Draco: missing attribute ${semantic}`);
      // Own keys only: semantics and component types come from the glTF (`constructor`, `__proto__`).
      const field = Object.hasOwn(fields, semantic) ? fields[semantic] : undefined,
        componentType = field ? 5126 : (request.componentTypes?.[semantic] ?? 5126),
        type = Object.hasOwn(dracoTypes, componentType) ? dracoTypes[componentType] : undefined;
      if (!type) throw new TypeError(`Draco: unsupported component type ${componentType} for ${semantic}`);
      const [name, Ctor] = type,
        itemSize: number = attribute.num_components(),
        count = vertexCount * itemSize,
        byteLength = count * Ctor.BYTES_PER_ELEMENT;
      if (itemSize < 1 || itemSize > 16) throw new RangeError(`Draco: invalid ${semantic} width`);
      const pointer = draco._malloc(byteLength);
      let array: any;
      try {
        if (!decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, draco[name], byteLength, pointer))
          throw new Error(`Draco: could not read ${semantic}`);
        array = new Ctor(draco.HEAPU8.buffer, pointer, count).slice();
      } finally {
        draco._free(pointer);
      }
      if (field === 'colors') {
        const source = Object.keys(integerRange).find((key) => draco[key] === attribute.data_type());
        if (source) {
          const scale = 1 / integerRange[source];
          for (let i = 0; i < array.length; i++) array[i] = Math.max(-1, array[i] * scale);
        }
        result.colorSize = itemSize;
      }
      if (field) result[field] = array;
      else result.attributes[semantic] = { array, itemSize, componentType };
    }
    if (!result.positions) throw new Error('Draco: geometry has no POSITION attribute');
    if (kind === draco.TRIANGULAR_MESH) {
      const count = geometry.num_faces() * 3,
        wide = vertexCount > 65536,
        byteLength = count * (wide ? 4 : 2),
        pointer = draco._malloc(byteLength);
      try {
        const ok = wide
          ? decoder.GetTrianglesUInt32Array(geometry, byteLength, pointer)
          : decoder.GetTrianglesUInt16Array(geometry, byteLength, pointer);
        if (!ok) throw new Error('Draco: could not read indices');
        result.indices = wide
          ? new Uint32Array(draco.HEAPU8.buffer, pointer, count).slice()
          : new Uint16Array(draco.HEAPU8.buffer, pointer, count).slice();
      } finally {
        draco._free(pointer);
      }
    }
    return result;
  } finally {
    if (geometry) draco.destroy(geometry);
    draco.destroy(buffer);
    draco.destroy(decoder);
  }
}

/** Unique buffers to hand to postMessage so nothing is copied. */
export function dracoTransferables(result: DecodedDracoGeometry): ArrayBuffer[] {
  const arrays = [
    result.positions,
    result.indices,
    result.normals,
    result.uvs,
    result.colors,
    ...Object.values(result.attributes).map((a) => a.array),
  ];
  return [...new Set(arrays.filter(Boolean).map((a) => a!.buffer as ArrayBuffer))];
}

const transferSRGB = 2;

/** Transcode every mip level of a 2D KTX2 file into one buffer. The Basis file handle is closed and deleted on every path. */
export function transcodeKTX2(basis: any, bytes: Uint8Array, target: TranscodeTarget): TranscodedKTX2Result {
  if (!transcodeFormats[target]) throw new TypeError(`Unknown transcode target ${target}`);
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid()) throw new Error('KTX2: invalid or unsupported file');
    if (file.isHDR?.()) throw new Error('KTX2: HDR textures are not supported');
    if (file.getFaces() > 1 || file.getLayers() > 1)
      throw new Error('KTX2: cube maps and texture arrays are not supported');
    const width: number = file.getWidth(),
      height: number = file.getHeight(),
      levels: number = file.getLevels();
    if (!width || !height || !levels || width > 16384 || height > 16384)
      throw new RangeError('KTX2: invalid dimensions');
    const chosen: TranscodeTarget = target !== 'rgba8' && (width % 4 || height % 4) ? 'rgba8' : target,
      format = transcodeFormats[chosen];
    if (!file.startTranscoding()) throw new Error('KTX2: startTranscoding failed');
    const sizes: number[] = [];
    for (let level = 0; level < levels; level++)
      sizes.push(file.getImageTranscodedSizeInBytes(level, 0, 0, format.basis));
    const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0)),
      mipmaps: KTX2Mip[] = [];
    for (let level = 0, offset = 0; level < levels; offset += sizes[level++]) {
      const data = out.subarray(offset, offset + sizes[level]);
      if (!file.transcodeImage(data, level, 0, 0, format.basis, 0, -1, -1))
        throw new Error(`KTX2: could not transcode level ${level}`);
      mipmaps.push({
        data,
        width: Math.max(1, width >> level),
        height: Math.max(1, height >> level),
        byteLength: sizes[level],
      });
    }
    const srgb = file.getDFDTransferFunc?.() === transferSRGB;
    return {
      width,
      height,
      mipmaps,
      format: (format.gpu + (srgb ? '-srgb' : '')) as GPUTextureFormat,
      target: chosen,
      hasAlpha: !!file.getHasAlpha(),
      srgb,
    };
  } finally {
    file.close();
    file.delete();
  }
}

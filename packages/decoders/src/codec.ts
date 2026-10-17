// Worker-side decode functions. Kept free of worker globals so unit tests can drive them with real or mock modules.
import { decodeFailed } from './errors.js';
import { transcodeFormats } from './formats.js';
import type { DecodedDracoGeometry, DracoRequest, KTX2Mip, TranscodeTarget, TranscodedKTX2Result } from './protocol.js';
import { validatedDracoLimits } from './protocol.js';
import type {
  BasisModule,
  DracoModule,
  DracoGeometry,
  DracoPointAttribute,
  DracoArrayConstructor,
  DracoArray,
  DracoDataType,
  DracoSemantic,
} from './vendor-codecs.js';

export type ScriptLoader = (url: string) => Promise<void>;

/** Run a classic Emscripten script in module-worker global scope. Indirect eval keeps its top-level `var` global. */
export const evaluateScript: ScriptLoader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  (0, eval)(await response.text());
};

async function binary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.arrayBuffer();
}

/** Emscripten module objects are thenable, so they travel inside a box to keep promise resolution finite. */
export interface ModuleBox<T> {
  module: T;
}

export async function initDraco(
  wrapperURL: string,
  wasmURL: string,
  load: ScriptLoader = evaluateScript,
): Promise<ModuleBox<DracoModule>> {
  const [, wasmBinary] = await Promise.all([load(wrapperURL), binary(wasmURL)]);
  const factory = (
    globalThis as typeof globalThis & {
      DracoDecoderModule?: (options: { wasmBinary: ArrayBuffer }) => PromiseLike<DracoModule>;
    }
  ).DracoDecoderModule;
  if (typeof factory !== 'function') throw new Error('Draco wrapper did not define DracoDecoderModule');
  return new Promise((resolve, reject) => {
    factory({ wasmBinary }).then((module) => resolve({ module }), reject);
  });
}

export async function initBasis(
  transcoderURL: string,
  wasmURL: string,
  load: ScriptLoader = evaluateScript,
): Promise<ModuleBox<BasisModule>> {
  const [, wasmBinary] = await Promise.all([load(transcoderURL), binary(wasmURL)]);
  const factory = (
    globalThis as typeof globalThis & { BASIS?: (options: { wasmBinary: ArrayBuffer }) => PromiseLike<BasisModule> }
  ).BASIS;
  if (typeof factory !== 'function') throw new Error('Basis transcoder did not define BASIS');
  const module = await new Promise<{ m: BasisModule }>((resolve, reject) => {
    factory({ wasmBinary }).then((m) => resolve({ m }), reject);
  }).then((box) => box.m);
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
const dracoTypes: Record<number, [DracoDataType, DracoArrayConstructor]> = {
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
const dracoMagic = [0x44, 0x52, 0x41, 0x43, 0x4f];

/**
 * True for the error a Wasm trap or Emscripten abort inside a decoder leaves (`unreachable`, `memory access out of
 * bounds`, `Aborted(OOM)`), directly or as the `cause` of the decoder's own error. The module's state is undefined
 * afterwards, so the decoder worker drops it and instantiates a fresh one for the next file.
 */
export const isDecoderCrash = (error: unknown): boolean =>
  error instanceof WebAssembly.RuntimeError ||
  (error instanceof Error && error.cause instanceof WebAssembly.RuntimeError);
// A trap becomes the decoder's own error (trap as its cause); anything else passes through.
const trapped = (label: string, error: unknown): unknown =>
  error instanceof WebAssembly.RuntimeError
    ? decodeFailed(`${label}: corrupt or unsupported data stopped the decoder (${error.message})`, error)
    : error;
// Runs `make` (a constructor that copies input into the Wasm heap) with a trap turned into the decoder's own error.
function guard<T>(label: string, make: () => T): T {
  try {
    return make();
  } catch (error) {
    throw trapped(label, error);
  }
}
// Releases handles after a decode; after a trap the module is discarded, so a second trap here is dropped.
function release(failure: unknown, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    if (!isDecoderCrash(failure)) throw trapped('Decoder', error);
  }
}

/**
 * Decode one Draco buffer. Every Draco handle and heap allocation is released before returning, including on error,
 * and every output array is a copy that owns its own buffer so it can be transferred. A Wasm trap on corrupt data
 * throws `Error('Draco: ...')` with the trap as its cause (isDecoderCrash).
 */
export function decodeDraco(draco: DracoModule, bytes: Uint8Array, request: DracoRequest = {}): DecodedDracoGeometry {
  const limits = validatedDracoLimits(request.limits);
  // The 11-byte Draco header ("DRACO", version, geometry type 0 or 1, method, flags) is checked here: for a header it
  // cannot parse, GetEncodedGeometryType returns an uninitialized value, so the outcome would depend on Wasm memory.
  if (bytes.length < 11 || dracoMagic.some((b, i) => bytes[i] !== b) || bytes[7] > 1)
    throw new TypeError('Draco: invalid header');
  const decoder = guard('Draco', () => new draco.Decoder()),
    buffer = guard('Draco', () => new draco.DecoderBuffer());
  let geometry: DracoGeometry | null = null,
    failure: unknown;
  try {
    buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    const kind = decoder.GetEncodedGeometryType(buffer);
    let status: { ok(): boolean; error_msg(): string };
    if (kind === draco.TRIANGULAR_MESH) {
      geometry = new draco.Mesh();
      status = decoder.DecodeBufferToMesh(buffer, geometry);
    } else if (kind === draco.POINT_CLOUD) {
      geometry = new draco.PointCloud();
      status = decoder.DecodeBufferToPointCloud(buffer, geometry);
    } else throw new Error('Draco: unknown geometry type');
    if (!status.ok() || !geometry.ptr) throw new Error('Draco: ' + status.error_msg());
    const vertexCount: number = geometry.num_points();
    if (!Number.isSafeInteger(vertexCount) || vertexCount < 1 || vertexCount > limits.maxVertices)
      throw new RangeError('Draco: invalid vertex count or vertex limit exceeded');
    const faces: number = kind === draco.TRIANGULAR_MESH ? geometry.num_faces!() : 0;
    if (!Number.isSafeInteger(faces) || faces < (kind === draco.TRIANGULAR_MESH ? 1 : 0))
      throw new RangeError('Draco: invalid face count');
    const indexCount = faces * 3,
      wide = vertexCount >= 65536,
      indexBytes = indexCount * (wide ? 4 : 2);
    if (!Number.isSafeInteger(indexCount) || indexCount > limits.maxIndices || !Number.isSafeInteger(indexBytes))
      throw new RangeError('Draco: index limit exceeded');
    let decodedBytes = indexBytes;
    if (decodedBytes > limits.maxDecodedBytes) throw new RangeError('Draco: decoded byte limit exceeded');
    const byId = request.attributeIds !== undefined;
    const ids: Record<string, number> = request.attributeIds ?? {};
    if (!byId)
      for (const [semantic, type] of <[string, DracoSemantic][]>[
        ['POSITION', 'POSITION'],
        ['NORMAL', 'NORMAL'],
        ['TEXCOORD_0', 'TEX_COORD'],
        ['COLOR_0', 'COLOR'],
      ]) {
        const id = decoder.GetAttributeId(geometry, draco[type]);
        if (id >= 0) ids[semantic] = id;
      }
    if (!byId && !Object.hasOwn(ids, 'POSITION')) throw new Error('Draco: geometry has no POSITION attribute');
    const descriptors: {
      semantic: string;
      attribute: DracoPointAttribute;
      field: (typeof fields)[string] | undefined;
      componentType: number;
      requestedType: number | undefined;
      name: DracoDataType;
      Ctor: DracoArrayConstructor;
      itemSize: number;
      count: number;
      byteLength: number;
    }[] = [];
    for (const [semantic, id] of Object.entries(ids)) {
      if (!Number.isSafeInteger(id) || id < 0) throw new TypeError(`Draco: invalid attribute id for ${semantic}`);
      const attribute = byId ? decoder.GetAttributeByUniqueId(geometry, id) : decoder.GetAttribute(geometry, id);
      if (!attribute || !attribute.ptr) throw new Error(`Draco: missing attribute ${semantic}`);
      const field = fields[semantic],
        requestedType = request.componentTypes?.[semantic],
        componentType = requestedType ?? 5126,
        type = dracoTypes[componentType];
      if (!type) throw new TypeError(`Draco: unsupported component type ${componentType} for ${semantic}`);
      const [name, Ctor] = type,
        itemSize: number = attribute.num_components(),
        count = vertexCount * itemSize,
        byteLength = count * Ctor.BYTES_PER_ELEMENT;
      if (!Number.isSafeInteger(itemSize) || itemSize < 1 || itemSize > 16)
        throw new RangeError(`Draco: invalid ${semantic} width`);
      if (limits.attributeWidths?.[semantic] !== undefined && limits.attributeWidths[semantic] !== itemSize)
        throw new RangeError(`Draco: ${semantic} width does not match accessor`);
      const outputBytes = field ? count * Float32Array.BYTES_PER_ELEMENT : byteLength;
      if (
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(byteLength) ||
        !Number.isSafeInteger(outputBytes) ||
        outputBytes > limits.maxDecodedBytes - decodedBytes
      )
        throw new RangeError('Draco: decoded byte limit exceeded');
      decodedBytes += outputBytes;
      descriptors.push({
        semantic,
        attribute,
        field,
        componentType,
        requestedType,
        name,
        Ctor,
        itemSize,
        count,
        byteLength,
      });
    }
    // The entire primitive must pass metadata preflight before any output allocation or Draco extraction.
    const result: DecodedDracoGeometry = { vertexCount, positions: new Float32Array(0), attributes: {} };
    for (const {
      semantic,
      attribute,
      field,
      componentType,
      requestedType,
      name,
      Ctor,
      itemSize,
      count,
      byteLength,
    } of descriptors) {
      const pointer = draco._malloc(byteLength);
      if (!pointer) throw new Error('Draco: could not allocate attribute output');
      let array: DracoArray;
      try {
        if (!decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, draco[name], byteLength, pointer))
          throw new Error(`Draco: could not read ${semantic}`);
        array = new Ctor(draco.HEAPU8.buffer, pointer, count).slice();
      } finally {
        draco._free(pointer);
      }
      if (field) array = array instanceof Float32Array ? array : Float32Array.from(array);
      if (field === 'colors') {
        // Native float conversion honors Draco's normalized flag. Explicit accessor types
        // retain integer values, so normalize those once using the requested type.
        const source =
          requestedType !== undefined
            ? name
            : !attribute.normalized?.()
              ? Object.keys(integerRange).find((key) => draco[key as DracoDataType] === attribute.data_type())
              : undefined;
        if (source && integerRange[source]) {
          const scale = 1 / integerRange[source];
          for (let i = 0; i < array.length; i++) array[i] = Math.max(-1, array[i] * scale);
        }
        result.colorSize = itemSize;
      }
      if (field) result[field] = array as Float32Array;
      else result.attributes[semantic] = { array, itemSize, componentType };
    }
    if (!result.positions.length && (!byId || Object.hasOwn(ids, 'POSITION')))
      throw new Error('Draco: geometry has no POSITION attribute');
    if (kind === draco.TRIANGULAR_MESH) {
      const count = indexCount,
        byteLength = indexBytes,
        pointer = draco._malloc(byteLength);
      if (!pointer) throw new Error('Draco: could not allocate index output');
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
  } catch (error) {
    throw (failure = trapped('Draco', error));
  } finally {
    release(failure, () => {
      if (geometry) draco.destroy(geometry);
      draco.destroy(buffer);
      draco.destroy(decoder);
    });
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

const ktx2Identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
/**
 * KTX 2.0 header and index checks (KTX 2.0 specification, section 3) before the transcoder reads the file: the level
 * count fits the size, and every byte range the index declares (levels, DFD, key/value data, supercompression global
 * data) lies inside the file. A truncated or corrupted file throws `Error('KTX2: invalid file (...)')` here.
 */
function checkKTX2(bytes: Uint8Array): void {
  const fail = (what: string) => {
    throw new TypeError(`KTX2: invalid file (${what})`);
  };
  if (bytes.length < 80) fail('truncated header');
  if (ktx2Identifier.some((b, i) => bytes[i] !== b)) fail('not KTX 2.0');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u32 = (at: number) => view.getUint32(at, true),
    // 64-bit offsets and lengths: a high word means past 4 GiB, outside any file this can be given.
    u64 = (at: number) => (u32(at + 4) ? Number.POSITIVE_INFINITY : u32(at)),
    inside = (offset: number, length: number) => offset + length <= bytes.length;
  const levels = Math.max(1, u32(40)),
    size = Math.max(u32(20), u32(24), 1);
  if (levels > 1 + Math.floor(Math.log2(size))) fail('level count');
  if (!inside(80, levels * 24)) fail('truncated level index');
  for (let i = 0; i < levels; i++) if (!inside(u64(80 + i * 24), u64(88 + i * 24))) fail(`level ${i} out of bounds`);
  // Zstandard-supercompressed levels (UASTC) inflate to the level's 16-byte 4x4 blocks: a larger declared size made the
  // transcoder read past its buffer (a Wasm trap, or stale memory read as texels).
  if (u32(44) === 2)
    for (let i = 0; i < levels; i++) {
      const blocks =
        Math.ceil(Math.max(1, u32(20) >> i) / 4) *
        Math.ceil(Math.max(1, u32(24) >> i) / 4) *
        Math.max(1, u32(28) >> i) *
        Math.max(1, u32(32)) *
        u32(36);
      if (u64(96 + i * 24) > blocks * 16) fail(`level ${i} size`);
    }
  if (!inside(u32(48), u32(52)) || !inside(u32(56), u32(60)) || !inside(u64(64), u64(72))) fail('index out of bounds');
}

/**
 * Transcode every mip level of a 2D KTX2 file into one buffer. The Basis file handle is closed and deleted on every path.
 * The header and level index are checked first (checkKTX2); a Wasm trap on corrupt data throws `Error('KTX2: ...')`
 * with the trap as its cause (isDecoderCrash).
 */
export function transcodeKTX2(basis: BasisModule, bytes: Uint8Array, target: TranscodeTarget): TranscodedKTX2Result {
  if (!transcodeFormats[target]) throw new TypeError(`Unknown transcode target ${target}`);
  checkKTX2(bytes);
  const file = guard('KTX2', () => new basis.KTX2File(bytes));
  let failure: unknown;
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
  } catch (error) {
    throw (failure = trapped('KTX2', error));
  } finally {
    release(failure, () => {
      file.close();
      file.delete();
    });
  }
}

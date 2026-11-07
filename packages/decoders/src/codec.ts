// Worker-side decode functions. Kept free of worker globals so unit tests can drive them with real or mock modules.
import { decodeFailed, deviceUnsupported } from './errors.js';
import { hdrFormats, transcodeFormats, type HDRTranscodeTarget } from './formats.js';
import { readKTX2Index, type KTX2Index } from './ktx2-file.js';
import { formatBlock, type TextureFile } from './texture-file.js';
import type {
  DecodedDracoGeometry,
  DecodedDracoPoints,
  DracoPointsAttribute,
  DracoPointsRequest,
  DracoRequest,
  KTX2Mip,
  TranscodeTarget,
  TranscodedKTX2Result,
} from './protocol.js';
import { validatedDracoLimits } from './protocol.js';
import type {
  BasisFile,
  BasisModule,
  DracoModule,
  DracoGeometry,
  DracoPointAttribute,
  DracoArrayConstructor,
  DracoArray,
  DracoDataType,
  DracoSemantic,
  PointArrayConstructor,
} from './vendor-codecs.js';

export type ScriptLoader = (url: string) => Promise<void>;

/** Run a classic Emscripten script in module-worker global scope. Indirect eval keeps its top-level `var` global. */
export const evaluateScript: ScriptLoader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw decodeFailed(`Could not load ${url} (${response.status})`);
  (0, eval)(await response.text());
};

async function binary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw decodeFailed(`Could not load ${url} (${response.status})`);
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
  if (typeof factory !== 'function')
    throw decodeFailed(
      'Draco wrapper did not define DracoDecoderModule; load the unmodified draco_decoder.js from the package assets',
    );
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
  const factory = (globalThis as typeof globalThis & { BASIS?: BasisFactory }).BASIS;
  if (typeof factory !== 'function')
    throw decodeFailed(
      'Basis transcoder did not define BASIS; load the unmodified basis_transcoder.js from the package assets',
    );
  return startBasis(factory, wasmBinary);
}

/** The factory `basis_transcoder.js` defines. */
export type BasisFactory = (options: { wasmBinary: ArrayBuffer }) => PromiseLike<BasisModule>;

/** Starts a loaded transcoder: Node requires the wrapper rather than evaluating it, so it joins here. */
export async function startBasis(factory: BasisFactory, wasmBinary: ArrayBuffer): Promise<ModuleBox<BasisModule>> {
  const module = await new Promise<{ m: BasisModule }>((resolve, reject) => {
    factory({ wasmBinary }).then((m) => resolve({ m }), reject);
  }).then((box) => box.m);
  module.initializeBasis();
  if (typeof module.KTX2File !== 'function')
    throw decodeFailed(
      'Basis transcoder lacks KTX2 support; use the basis_transcoder build that ships with this release',
    );
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

// Copies one attribute out of the Wasm heap into an array that owns its buffer.
function readAttribute(
  draco: DracoModule,
  decoder: InstanceType<DracoModule['Decoder']>,
  geometry: DracoGeometry,
  attribute: DracoPointAttribute,
  name: DracoDataType,
  Ctor: PointArrayConstructor,
  count: number,
  byteLength: number,
  label: string,
): DracoPointsAttribute['array'] {
  const pointer = draco._malloc(byteLength);
  if (!pointer) throw decodeFailed('Draco: could not allocate attribute output; reduce the size or free memory');
  try {
    if (!decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, draco[name], byteLength, pointer))
      throw decodeFailed(`Draco: could not read ${label}; re-export the file, the attribute data is damaged`);
    return new Ctor(draco.HEAPU8.buffer, pointer, count).slice();
  } finally {
    draco._free(pointer);
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
    throw new TypeError('Draco: invalid header; pass an unmodified .drc buffer');
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
    } else throw decodeFailed('Draco: unknown geometry type; pass a mesh or point-cloud Draco file');
    // The glTF build refuses every point cloud with this message; the file is fine, so the error must not blame it.
    if (kind === draco.POINT_CLOUD && !status.ok() && status.error_msg() === 'Unsupported geometry type.')
      throw deviceUnsupported(
        'Draco: this build reads meshes only; decode point clouds with DracoPointsDecoder from @margoengine/decoders/draco-points',
      );
    if (!status.ok() || !geometry.ptr)
      throw decodeFailed('Draco: ' + status.error_msg() + '; re-export the mesh, the file is damaged');
    const vertexCount: number = geometry.num_points();
    if (!Number.isSafeInteger(vertexCount) || vertexCount < 1 || vertexCount > limits.maxVertices)
      throw new RangeError(
        'Draco: invalid vertex count or vertex limit exceeded; raise maxVertices or re-export a smaller mesh',
      );
    const faces: number = kind === draco.TRIANGULAR_MESH ? geometry.num_faces!() : 0;
    if (!Number.isSafeInteger(faces) || faces < (kind === draco.TRIANGULAR_MESH ? 1 : 0))
      throw new RangeError('Draco: invalid face count; re-export the mesh with a valid triangle count');
    const indexCount = faces * 3,
      wide = vertexCount >= 65536,
      indexBytes = indexCount * (wide ? 4 : 2);
    if (!Number.isSafeInteger(indexCount) || indexCount > limits.maxIndices || !Number.isSafeInteger(indexBytes))
      throw new RangeError('Draco: index limit exceeded; raise maxIndices or re-export a smaller mesh');
    let decodedBytes = indexBytes;
    if (decodedBytes > limits.maxDecodedBytes)
      throw new RangeError('Draco: decoded byte limit exceeded; raise maxDecodedBytes or re-export a smaller mesh');
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
    if (!byId && !Object.hasOwn(ids, 'POSITION'))
      throw decodeFailed('Draco: geometry has no POSITION attribute; export the mesh with positions');
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
      if (!Number.isSafeInteger(id) || id < 0)
        throw new TypeError(
          `Draco: invalid attribute id for ${semantic}; map each glTF attribute to an attribute id present in the file`,
        );
      const attribute = byId ? decoder.GetAttributeByUniqueId(geometry, id) : decoder.GetAttribute(geometry, id);
      if (!attribute || !attribute.ptr)
        throw decodeFailed(
          `Draco: missing attribute ${semantic}; remove it from the attribute map or re-export the mesh with it`,
        );
      const field = fields[semantic],
        requestedType = request.componentTypes?.[semantic],
        componentType = requestedType ?? 5126,
        type = dracoTypes[componentType];
      if (!type)
        throw new TypeError(
          `Draco: unsupported component type ${componentType} for ${semantic}; use a float, byte, short or integer accessor`,
        );
      const [name, Ctor] = type,
        itemSize: number = attribute.num_components(),
        count = vertexCount * itemSize,
        byteLength = count * Ctor.BYTES_PER_ELEMENT;
      if (!Number.isSafeInteger(itemSize) || itemSize < 1 || itemSize > 16)
        throw new RangeError(`Draco: invalid ${semantic} width; re-export the mesh with a 1 to 4 wide attribute`);
      if (limits.attributeWidths?.[semantic] !== undefined && limits.attributeWidths[semantic] !== itemSize)
        throw new RangeError(
          `Draco: ${semantic} width does not match accessor; correct the accessor type to match the Draco data`,
        );
      const outputBytes = field ? count * Float32Array.BYTES_PER_ELEMENT : byteLength;
      if (
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(byteLength) ||
        !Number.isSafeInteger(outputBytes) ||
        outputBytes > limits.maxDecodedBytes - decodedBytes
      )
        throw new RangeError('Draco: decoded byte limit exceeded; raise maxDecodedBytes or re-export a smaller mesh');
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
      let array = readAttribute(draco, decoder, geometry, attribute, name, Ctor, count, byteLength, semantic) as DracoArray;
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
      throw decodeFailed('Draco: geometry has no POSITION attribute; export the mesh with positions');
    if (kind === draco.TRIANGULAR_MESH) {
      const count = indexCount,
        byteLength = indexBytes,
        pointer = draco._malloc(byteLength);
      if (!pointer) throw decodeFailed('Draco: could not allocate index output; reduce the mesh size or free memory');
      try {
        const ok = wide
          ? decoder.GetTrianglesUInt32Array(geometry, byteLength, pointer)
          : decoder.GetTrianglesUInt16Array(geometry, byteLength, pointer);
        if (!ok) throw decodeFailed('Draco: could not read indices; re-export the mesh, the index data is damaged');
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

const pointTypes: [DracoDataType, PointArrayConstructor][] = [
    ['DT_INT8', Int8Array],
    ['DT_UINT8', Uint8Array],
    ['DT_INT16', Int16Array],
    ['DT_UINT16', Uint16Array],
    ['DT_INT32', Int32Array],
    ['DT_UINT32', Uint32Array],
    ['DT_FLOAT32', Float32Array],
  ],
  pointSemantics: readonly [DracoSemantic | 'GENERIC', DracoPointsAttribute['semantic'], string][] = [
    ['POSITION', 'POSITION', 'POSITION'],
    ['NORMAL', 'NORMAL', 'NORMAL'],
    ['COLOR', 'COLOR', 'COLOR'],
    ['TEX_COORD', 'TEX_COORD', 'TEXCOORD'],
    ['GENERIC', 'GENERIC', 'GENERIC'],
  ];

/**
 * Decode one Draco point cloud with Draco's full build: every attribute in its stored type, named by the file's `name` metadata
 * when it has one, and identity indices, one per point. Every handle is released before returning, and every array owns its
 * buffer so it can be transferred.
 */
export function decodeDracoPoints(
  draco: DracoModule,
  bytes: Uint8Array,
  request: DracoPointsRequest = {},
): DecodedDracoPoints {
  const limits = validatedDracoLimits(request.limits);
  if (bytes.length < 11 || dracoMagic.some((b, i) => bytes[i] !== b) || bytes[7] > 1)
    throw new TypeError('Draco: invalid header; pass an unmodified .drc buffer');
  const decoder = guard('Draco', () => new draco.Decoder()),
    buffer = guard('Draco', () => new draco.DecoderBuffer()),
    metadata = guard('Draco', () => new draco.MetadataQuerier());
  let cloud: DracoGeometry | null = null,
    failure: unknown;
  try {
    buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    if (decoder.GetEncodedGeometryType(buffer) !== draco.POINT_CLOUD)
      throw decodeFailed('Draco: this file is a mesh, not a point cloud; decode it with DracoDecoder');
    cloud = new draco.PointCloud();
    const status = decoder.DecodeBufferToPointCloud(buffer, cloud);
    if (!status.ok() || !cloud.ptr)
      throw decodeFailed('Draco: ' + status.error_msg() + '; re-export the point cloud, the file is damaged');
    const pointCount = cloud.num_points(),
      wide = pointCount >= 65536;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1 || pointCount > limits.maxVertices)
      throw new RangeError('Draco: invalid point count or limit exceeded; raise maxVertices or export fewer points');
    let decodedBytes = pointCount * (wide ? 4 : 2);
    const seen: Record<string, number> = {},
      attributes: DracoPointsAttribute[] = [],
      reads: (() => void)[] = [];
    for (let id = 0; id < cloud.num_attributes!(); id++) {
      const attribute = decoder.GetAttribute(cloud, id),
        kind = pointSemantics.find(([name]) => draco[name] === attribute.attribute_type!()),
        type = pointTypes.find(([name]) => draco[name] === attribute.data_type());
      if (!kind || !type)
        throw decodeFailed(`Draco: attribute ${id} has a type this build cannot read; re-export it as integers or floats`);
      const [, semantic, label] = kind,
        [name, Ctor] = type,
        itemSize = attribute.num_components(),
        count = pointCount * itemSize,
        byteLength = count * Ctor.BYTES_PER_ELEMENT,
        nth = (seen[label] = (seen[label] ?? -1) + 1),
        fallback = nth === 0 && (label === 'POSITION' || label === 'NORMAL') ? label : `${label}_${nth}`,
        entries = decoder.GetAttributeMetadata(cloud, id);
      if (!Number.isSafeInteger(itemSize) || itemSize < 1 || itemSize > 255)
        throw new RangeError(`Draco: invalid width on attribute ${id}; re-export the point cloud`);
      if (byteLength > limits.maxDecodedBytes - decodedBytes)
        throw new RangeError('Draco: decoded byte limit exceeded; raise maxDecodedBytes or export fewer points');
      decodedBytes += byteLength;
      const entry: DracoPointsAttribute = {
        name: entries.ptr && metadata.HasEntry(entries, 'name') ? metadata.GetStringEntry(entries, 'name') : fallback,
        semantic,
        uniqueId: attribute.unique_id!(),
        array: new Ctor(0),
        itemSize,
        normalized: attribute.normalized?.() ?? false,
      };
      attributes.push(entry);
      reads.push(() => {
        entry.array = readAttribute(draco, decoder, cloud!, attribute, name, Ctor, count, byteLength, entry.name);
      });
    }
    // The whole cloud passed its limits above, before any output is allocated.
    for (const read of reads) read();
    const indices = wide ? new Uint32Array(pointCount) : new Uint16Array(pointCount);
    for (let i = 0; i < pointCount; i++) indices[i] = i;
    return { pointCount, indices, attributes };
  } catch (error) {
    throw (failure = trapped('Draco', error));
  } finally {
    release(failure, () => {
      if (cloud) draco.destroy(cloud);
      draco.destroy(metadata);
      draco.destroy(buffer);
      draco.destroy(decoder);
    });
  }
}

/** Unique buffers of a point cloud to hand to postMessage so nothing is copied. */
export function dracoPointsTransferables(result: DecodedDracoPoints): ArrayBuffer[] {
  return [result.indices, ...result.attributes.map((attribute) => attribute.array)].map(
    (array) => array.buffer as ArrayBuffer,
  );
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

// Opens a checked KTX2 file for `use`, turning a Wasm trap into the decoder's own error and always freeing the handle.
function withKTX2<T>(basis: BasisModule, bytes: Uint8Array, use: (file: BasisFile) => T): T {
  const file = guard('KTX2', () => new basis.KTX2File(bytes));
  let failure: unknown;
  try {
    if (!file.isValid()) throw decodeFailed('KTX2: invalid or unsupported file; pass an unmodified .ktx2 file');
    return use(file);
  } catch (error) {
    throw (failure = trapped('KTX2', error));
  } finally {
    release(failure, () => {
      file.close();
      file.delete();
    });
  }
}

/**
 * Transcode every mip level of a 2D KTX2 file into one buffer. The Basis file handle is closed and deleted on every path.
 * The header and level index are checked first (readKTX2Index); a Wasm trap on corrupt data throws `Error('KTX2: ...')`
 * with the trap as its cause (isDecoderCrash).
 */
export function transcodeKTX2(basis: BasisModule, bytes: Uint8Array, target: TranscodeTarget): TranscodedKTX2Result {
  if (!transcodeFormats[target])
    throw new TypeError(`Unknown transcode target ${target}; use one of the targets listed in KTX2Options.target`);
  readKTX2Index(bytes);
  return withKTX2(basis, bytes, (file) => {
    if (file.isHDR?.())
      throw decodeFailed(
        'KTX2: HDR textures are not supported here; use KTX2HDRDecoder from @margoengine/decoders/ktx2-hdr',
      );
    if (file.getFaces() > 1 || file.getLayers() > 1)
      throw decodeFailed(
        'KTX2: cube maps and texture arrays are not supported here; use KTX2LayerDecoder from @margoengine/decoders/ktx2-layers',
      );
    const width: number = file.getWidth(),
      height: number = file.getHeight(),
      levels: number = file.getLevels();
    if (!width || !height || !levels || width > 16384 || height > 16384)
      throw new RangeError('KTX2: invalid dimensions; re-encode the texture with non-zero dimensions');
    const chosen: TranscodeTarget = target !== 'rgba8' && (width % 4 || height % 4) ? 'rgba8' : target,
      format = transcodeFormats[chosen];
    if (!file.startTranscoding())
      throw decodeFailed('KTX2: startTranscoding failed; re-encode the file with Basis Universal');
    const sizes: number[] = [];
    for (let level = 0; level < levels; level++)
      sizes.push(file.getImageTranscodedSizeInBytes(level, 0, 0, format.basis));
    const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0)),
      mipmaps: KTX2Mip[] = [];
    for (let level = 0, offset = 0; level < levels; offset += sizes[level++]) {
      const data = out.subarray(offset, offset + sizes[level]);
      if (!file.transcodeImage(data, level, 0, 0, format.basis, 0, -1, -1))
        throw decodeFailed(`KTX2: could not transcode level ${level}; re-encode the file, the level data is damaged`);
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
  });
}

/** What transcodeImages writes: the Basis enum, the WebGPU format and the name the result reports. */
interface ImageTarget {
  basis: number;
  gpu: string;
  name: string;
}

// Every image of every level into one buffer: a level's images back to back in WebGPU layer order (layer * faces + face),
// so one writeTexture per level uploads them.
function transcodeImages(
  file: BasisFile,
  index: KTX2Index,
  target: ImageTarget,
  srgb: boolean,
  hasAlpha: boolean,
): TextureFile {
  const { width, height, layerCount, faceCount } = index,
    arrayLayers = Math.max(1, layerCount),
    images = arrayLayers * faceCount,
    levels = index.levels.length;
  if (index.depth > 1) throw decodeFailed('KTX2: 3D textures are not supported; re-encode the file as a 2D array');
  if (!width || !height || width > 16384 || height > 16384 || images > 2048)
    throw new RangeError('KTX2: invalid dimensions; re-encode the texture with non-zero dimensions');
  if (faceCount !== 1 && faceCount !== 6) throw new RangeError(`KTX2: invalid face count ${faceCount}; use 1 or 6`);
  if (faceCount === 6 && width !== height) throw new RangeError('KTX2: cube faces are not square; re-encode the file');
  if (!file.startTranscoding())
    throw decodeFailed('KTX2: startTranscoding failed; re-encode the file with Basis Universal');
  const sizes: number[] = [];
  for (let level = 0; level < levels; level++) sizes.push(file.getImageTranscodedSizeInBytes(level, 0, 0, target.basis));
  const out = new Uint8Array(sizes.reduce((a, b) => a + b * images, 0)),
    mipmaps: TextureFile['mipmaps'] = [];
  for (let level = 0, offset = 0; level < levels; level++) {
    const start = offset;
    for (let layer = 0; layer < arrayLayers; layer++)
      for (let face = 0; face < faceCount; face++, offset += sizes[level]) {
        const image = out.subarray(offset, offset + sizes[level]);
        if (!file.transcodeImage(image, level, layer, face, target.basis, 0, -1, -1))
          throw decodeFailed(
            `KTX2: could not transcode level ${level} layer ${layer} face ${face}; re-encode the file, the data is damaged`,
          );
      }
    mipmaps.push({
      data: out.subarray(start, offset),
      width: Math.max(1, width >> level),
      height: Math.max(1, height >> level),
      byteLength: offset - start,
    });
  }
  const feature = formatBlock(target.gpu)?.[3];
  return {
    width,
    height,
    layers: images,
    dimension: faceCount === 6 ? (layerCount ? 'cube-array' : 'cube') : layerCount ? '2d-array' : '2d',
    mipmaps,
    format: target.gpu as GPUTextureFormat,
    ...(feature ? { feature } : {}),
    target: 'ktx2',
    transcoded: target.name,
    srgb,
    hasAlpha,
  };
}

/**
 * Transcode every level, array layer and cube face of an 8-bit KTX2 file. A 2D file comes back as a one-layer texture.
 * `exact` keeps `target` whatever the size: a one-level file of a stream is part of a larger texture.
 * Checks, handle release and trap handling as in {@link transcodeKTX2}.
 */
export function transcodeKTX2Layers(
  basis: BasisModule,
  bytes: Uint8Array,
  target: TranscodeTarget,
  exact = false,
): TextureFile {
  if (!transcodeFormats[target])
    throw new TypeError(`Unknown transcode target ${target}; use one of the targets listed in KTX2Options.target`);
  const index = readKTX2Index(bytes);
  return withKTX2(basis, bytes, (file) => {
    if (file.isHDR?.())
      throw decodeFailed('KTX2: HDR textures need KTX2HDRDecoder from @margoengine/decoders/ktx2-hdr');
    const chosen: TranscodeTarget = !exact && target !== 'rgba8' && (index.width % 4 || index.height % 4) ? 'rgba8' : target,
      format = transcodeFormats[chosen],
      srgb = file.getDFDTransferFunc?.() === transferSRGB;
    return transcodeImages(
      file,
      index,
      { basis: format.basis, gpu: format.gpu + (srgb ? '-srgb' : ''), name: chosen },
      srgb,
      !!file.getHasAlpha(),
    );
  });
}

/**
 * Transcode every level, array layer and cube face of a UASTC HDR file. BC6H falls back to half float when level 0 is
 * not a multiple of 4, as WebGPU needs of block formats. Checks, handle release and trap handling as in {@link transcodeKTX2}.
 */
export function transcodeKTX2HDR(
  basis: BasisModule,
  bytes: Uint8Array,
  target: HDRTranscodeTarget,
  exact = false,
): TextureFile {
  if (!hdrFormats[target])
    throw new TypeError(`Unknown HDR target ${target}; use bc6h, astc-hdr-4x4, rgba16float or rgb9e5`);
  const index = readKTX2Index(bytes);
  return withKTX2(basis, bytes, (file) => {
    if (!file.isHDR?.()) throw decodeFailed('KTX2: this file is not HDR; read it with KTX2LayerDecoder or KTX2Decoder');
    const chosen = !exact && target === 'bc6h' && (index.width % 4 || index.height % 4) ? 'rgba16float' : target,
      format = hdrFormats[chosen];
    const result = transcodeImages(file, index, { basis: format.basis, gpu: format.gpu, name: chosen }, false, false);
    // WebGPU has no ASTC HDR format, so no device feature can stand for it.
    return chosen === 'astc-hdr-4x4' ? { ...result, feature: undefined } : result;
  });
}

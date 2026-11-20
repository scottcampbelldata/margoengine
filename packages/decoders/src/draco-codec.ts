// Draco decode functions, run by the decoder worker and, in Node, in the calling thread (node-thread.ts). Kept free of
// worker globals so unit tests can drive them with real or mock modules; codec.ts re-exports them.
import { decodeFailed, deviceUnsupported, guard, release, trapped } from './errors.js';
import type {
  DecodedDracoGeometry,
  DecodedDracoPoints,
  DracoPointsAttribute,
  DracoPointsRequest,
  DracoRequest,
} from './protocol.js';
import { validatedDracoLimits } from './protocol.js';
import type {
  DracoModule,
  DracoGeometry,
  DracoPointAttribute,
  DracoArrayConstructor,
  DracoArray,
  DracoDataType,
  DracoSemantic,
  PointArrayConstructor,
} from './vendor-codecs.js';

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
      let array = readAttribute(
        draco,
        decoder,
        geometry,
        attribute,
        name,
        Ctor,
        count,
        byteLength,
        semantic,
      ) as DracoArray;
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
        throw decodeFailed(
          `Draco: attribute ${id} has a type this build cannot read; re-export it as integers or floats`,
        );
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

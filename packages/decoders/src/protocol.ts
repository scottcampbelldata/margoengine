/** Hardware-negotiated KTX2 transcode target. */
export type TranscodeTarget = 'bc7' | 'astc-4x4' | 'etc2' | 'rgba8';

/** A decoded attribute outside the four named Draco channels (tangents, extra UV sets, joints, weights). */
export interface DracoAttribute {
  array: Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;
  itemSize: number;
  /** glTF accessor component type of `array`. */
  componentType: number;
}

/** Contiguous typed arrays in Margo Engine's geometry layout. Every array owns its buffer and arrives by transfer. */
export interface DecodedDracoGeometry {
  vertexCount: number;
  /** Empty when an explicit attributeIds map does not request POSITION. */
  positions: Float32Array;
  /** Uint16Array below 65,536 vertices; otherwise Uint32Array. Absent for Draco point clouds. */
  indices?: Uint16Array | Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  /** Normalized to 0-1 whatever the encoded type. */
  colors?: Float32Array;
  /** Components per color: 3 (RGB) or 4 (RGBA). */
  colorSize?: number;
  attributes: Record<string, DracoAttribute>;
}

/** glTF KHR_draco_mesh_compression attribute ids and accessor component types for all requested channels. */
export interface DracoRequest {
  attributeIds?: Record<string, number>;
  componentTypes?: Record<string, number>;
  limits?: DracoDecodeLimits;
}

/** Output limits checked after Draco reads geometry metadata and before extracting any output arrays. */
export interface DracoDecodeLimits {
  /** Maximum vertices. Cannot raise the decoder's 16,777,216-vertex ceiling. */
  maxVertices?: number;
  /** Maximum triangle indices; zero permits only point clouds. */
  maxIndices?: number;
  /** Combined bytes of every requested output attribute and the indices. Cannot raise the 256 MiB ceiling. */
  maxDecodedBytes?: number;
  /** Required component widths for requested attributes, such as the glTF accessor widths. */
  attributeWidths?: Record<string, number>;
}

const dracoVertexLimit = 16_777_216,
  dracoByteLimit = 256 * 1024 * 1024;

/** Validate before copying or transferring input; repeat in the worker before touching Draco. */
export function validatedDracoLimits(
  limits: DracoDecodeLimits | undefined,
): Required<Omit<DracoDecodeLimits, 'attributeWidths'>> & Pick<DracoDecodeLimits, 'attributeWidths'> {
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits)))
    throw new TypeError('Draco: limits must be an object');
  const maximum = (
    name: 'maxVertices' | 'maxIndices' | 'maxDecodedBytes',
    ceiling: number,
    minimum: number,
  ): number => {
    const value = limits?.[name];
    if (value === undefined) return ceiling;
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new RangeError(`Draco: ${name} must be a safe integer >= ${minimum}`);
    return Math.min(value, ceiling);
  };
  const maxVertices = maximum('maxVertices', dracoVertexLimit, 1),
    maxIndices = maximum('maxIndices', dracoByteLimit / 2, 0),
    maxDecodedBytes = maximum('maxDecodedBytes', dracoByteLimit, 1);
  let attributeWidths: Record<string, number> | undefined;
  if (limits?.attributeWidths !== undefined) {
    if (!limits.attributeWidths || typeof limits.attributeWidths !== 'object' || Array.isArray(limits.attributeWidths))
      throw new TypeError('Draco: attributeWidths must be an object');
    attributeWidths = Object.create(null);
    for (const [semantic, width] of Object.entries(limits.attributeWidths)) {
      if (!Number.isSafeInteger(width) || width < 1 || width > 16)
        throw new RangeError(`Draco: invalid ${semantic} width limit`);
      attributeWidths![semantic] = width;
    }
  }
  return { maxVertices, maxIndices, maxDecodedBytes, attributeWidths };
}

export interface KTX2Mip {
  data: Uint8Array;
  width: number;
  height: number;
  byteLength: number;
}

export interface TranscodedKTX2Result {
  width: number;
  height: number;
  /** Every level views one transferred buffer. */
  mipmaps: KTX2Mip[];
  format: GPUTextureFormat;
  /** The target actually used. Compressed targets fall back to rgba8 when level 0 is not 4-pixel aligned. */
  target: TranscodeTarget;
  hasAlpha: boolean;
  srgb: boolean;
}

export type WorkerRequest =
  | { id: number; type: 'draco'; buffer: ArrayBuffer; request: DracoRequest; wrapperURL: string; wasmURL: string }
  | { id: number; type: 'ktx2'; buffer: ArrayBuffer; target: TranscodeTarget; transcoderURL: string; wasmURL: string };

export type WorkerResponse =
  | { id: number; result: unknown; error?: undefined }
  | { id: number; error: string; result?: undefined };

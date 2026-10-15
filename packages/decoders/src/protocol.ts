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
  positions: Float32Array;
  /** Uint16Array when every index fits in 16 bits; absent for Draco point clouds. */
  indices?: Uint16Array | Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  /** Normalized to 0-1 whatever the encoded type. */
  colors?: Float32Array;
  /** Components per color: 3 (RGB) or 4 (RGBA). */
  colorSize?: number;
  attributes: Record<string, DracoAttribute>;
}

/** glTF KHR_draco_mesh_compression attribute ids and the accessor component types to decode extra channels into. */
export interface DracoRequest {
  attributeIds?: Record<string, number>;
  componentTypes?: Record<string, number>;
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

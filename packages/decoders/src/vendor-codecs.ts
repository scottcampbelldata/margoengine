import type { DracoAttribute } from './protocol.js';

export type DracoArray = DracoAttribute['array'];
export type DracoArrayConstructor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor;
export type DracoDataType = 'DT_INT8' | 'DT_UINT8' | 'DT_INT16' | 'DT_UINT16' | 'DT_INT32' | 'DT_UINT32' | 'DT_FLOAT32';
export type PointArrayConstructor = DracoArrayConstructor | Int32ArrayConstructor;
export type DracoSemantic = 'POSITION' | 'NORMAL' | 'TEX_COORD' | 'COLOR';

export interface DracoGeometry {
  ptr: number;
  num_points(): number;
  num_faces?(): number;
  num_attributes?(): number;
}
export interface DracoPointAttribute {
  ptr: number;
  num_components(): number;
  normalized?(): boolean;
  data_type(): number;
  attribute_type?(): number;
  unique_id?(): number;
}
/** A handle on one attribute's metadata; `ptr` is 0 when it has none. */
export interface DracoMetadata {
  ptr: number;
}
interface DracoMetadataQuerier {
  HasEntry(metadata: DracoMetadata, name: string): boolean;
  GetStringEntry(metadata: DracoMetadata, name: string): string;
}
interface DracoBuffer {
  Init(bytes: Int8Array, length: number): void;
}
interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}
interface DracoDecoder {
  GetEncodedGeometryType(buffer: DracoBuffer): number;
  DecodeBufferToMesh(buffer: DracoBuffer, geometry: DracoGeometry): DracoStatus;
  DecodeBufferToPointCloud(buffer: DracoBuffer, geometry: DracoGeometry): DracoStatus;
  GetAttributeId(geometry: DracoGeometry, semantic: number): number;
  GetAttributeByUniqueId(geometry: DracoGeometry, id: number): DracoPointAttribute;
  GetAttribute(geometry: DracoGeometry, id: number): DracoPointAttribute;
  GetAttributeMetadata(geometry: DracoGeometry, id: number): DracoMetadata;
  GetAttributeDataArrayForAllPoints(
    geometry: DracoGeometry,
    attribute: DracoPointAttribute,
    type: number,
    bytes: number,
    pointer: number,
  ): boolean;
  GetTrianglesUInt32Array(geometry: DracoGeometry, bytes: number, pointer: number): boolean;
  GetTrianglesUInt16Array(geometry: DracoGeometry, bytes: number, pointer: number): boolean;
}
/** The Emscripten Draco surface used by the worker, independent of its factory globals. */
export interface DracoModule extends Record<DracoDataType | DracoSemantic | 'GENERIC', number> {
  Decoder: new () => DracoDecoder;
  DecoderBuffer: new () => DracoBuffer;
  MetadataQuerier: new () => DracoMetadataQuerier;
  Mesh: new () => DracoGeometry;
  PointCloud: new () => DracoGeometry;
  TRIANGULAR_MESH: number;
  POINT_CLOUD: number;
  HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  destroy(handle: object): void;
}
export interface BasisFile {
  isValid(): boolean;
  isHDR?(): boolean;
  getFaces(): number;
  getLayers(): number;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(
    data: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: number,
    flags: number,
    channel0: number,
    channel1: number,
  ): boolean;
  getDFDTransferFunc?(): number;
  getHasAlpha(): boolean;
  close(): void;
  delete(): void;
}
/** The Emscripten Basis surface used by KTX2 transcoding. */
export interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (bytes: Uint8Array) => BasisFile;
}

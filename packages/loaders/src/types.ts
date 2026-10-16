/** A sub-range of `indices` (or of vertices for point clouds) that belongs to one object or one color. */
export interface LoadedGroup {
  /** First index in `indices` (for point clouds: first vertex). */
  start: number;
  /** Number of indices (a multiple of 3) or, for point clouds, vertices. */
  count: number;
  /** Object or element name from the file, when it has one. */
  name?: string;
  /** Source object id (3MF). */
  objectId?: string;
  /** Uniform sRGB color in [0,1], `[r, g, b, a]`, when the file gives this group one color. */
  color?: [number, number, number, number];
}

/** The common output of every loader in this package. */
export interface LoadedGeometry {
  /** `'mesh'` when `indices` holds triangles, `'points'` for point clouds. */
  kind: 'mesh' | 'points';
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per vertex, as stored in the file (not renormalized). */
  normals?: Float32Array;
  /** sRGB rgb per vertex in [0,1]. */
  colors?: Float32Array;
  /** uv per vertex. */
  uvs?: Float32Array;
  /** Triangle list, three per triangle. Absent for point clouds. */
  indices?: Uint32Array;
  /** Per-object or per-color index ranges, in order and non-overlapping. */
  groups?: LoadedGroup[];
  /** Extra per-vertex scalars such as PCD `intensity` or VTK point SCALARS. */
  attributes?: Record<string, Float32Array>;
}

/** Bounds shared by every parser. Counts past these throw a `LoaderError` with code `'limit'`. */
export interface ParseLimits {
  /** Maximum vertices or points. Default 8,000,000. */
  maxVertices?: number;
  /** Maximum triangles after triangulation. Default 16,000,000. */
  maxTriangles?: number;
}

export type LoaderErrorCode =
  | 'header'
  | 'truncated'
  | 'limit'
  | 'range'
  | 'syntax'
  | 'unsupported'
  | 'zip'
  | 'aborted'
  | 'fetch';

/** Thrown for every malformed, truncated, oversized or unsupported input. */
export class LoaderError extends Error {
  readonly format: string;
  readonly code: LoaderErrorCode;
  constructor(format: string, code: LoaderErrorCode, message: string) {
    super(`${format}: ${message}`);
    this.name = 'LoaderError';
    this.format = format;
    this.code = code;
  }
}

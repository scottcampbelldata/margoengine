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
  /** The object's `type` when it is not `model`: `solidsupport`, `support` or `surface` (3MF). */
  objectType?: string;
  /** The `partnumber` of the mesh object (3MF). */
  partNumber?: string;
  /** The `partnumber` of the build item that placed it (3MF). */
  itemPartNumber?: string;
  /** Uniform sRGB color in [0,1], `[r, g, b, a]`, when the file gives this group one color. */
  color?: [number, number, number, number];
  /** Raw source face properties, including scalar values and owned lists (PLY/OFF). */
  properties?: Record<string, number | number[]>;
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
  /**
   * Line segments, two vertex indices each, when the file holds lines beside or instead of faces (PLY `edge`, OBJ `l`,
   * COLLADA `<lines>` and `<linestrips>`). A file of lines and no faces has `kind` `'points'`.
   */
  lineIndices?: Uint32Array;
  /** Per-object or per-color index ranges, in order and non-overlapping. */
  groups?: LoadedGroup[];
  /** Extra per-vertex scalars such as PCD `intensity`, VTK point SCALARS or USD `opacity` (0 to 1). */
  attributes?: Record<string, Float32Array>;
}

/**
 * Reads a file a model refers to (an MTL library, a TSX tileset), given its path relative to the folder of the file
 * being parsed. Return the bytes, or the text. In Electron read from disk; in a browser `fetch(new URL(path, base))`.
 */
export type AssetResolver = (path: string) => Promise<Uint8Array | string>;

/** Bounds shared by every parser. Counts past these throw a `LoaderError` with code `'limit'`. */
export interface ParseLimits {
  /** Maximum vertices or points. Default 8,000,000. */
  maxVertices?: number;
  /** Maximum triangles after triangulation. Default 16,000,000. */
  maxTriangles?: number;
}

/**
 * Why a LoaderError was thrown: a bad header, truncated data, a size limit, a value out of range, a syntax fault, an unsupported feature, a bad zip, an abort, a failed fetch, or a URL inside the file that leaves the file's directory (`'url'`: add its prefix to `allowedURLs` to load it).
 */
export type LoaderErrorCode =
  | 'header'
  | 'truncated'
  | 'limit'
  | 'range'
  | 'syntax'
  | 'unsupported'
  | 'zip'
  | 'aborted'
  | 'fetch'
  | 'url';

/**
 * Thrown for every malformed, truncated, oversized or unsupported input. The message reads `<format>: <message>` and
 * ends with `; see https://margoengine.com/errors#loader-<code>`, the help entry for the code.
 */
export class LoaderError extends Error {
  readonly format: string;
  readonly code: LoaderErrorCode;
  /**
   * The HTTP status of a refused request (`403`, `404`, `429`, `503`...) when the server answered one, so a caller
   * tells a refusal from a network failure without reading the message; undefined for every other error.
   */
  readonly status?: number;
  /**
   * Seconds the server asked the client to wait before trying again: its `Retry-After` header (RFC 9110 10.2.3), given
   * as seconds or as a date, counted from when the answer came. Undefined when the answer had none or it was unreadable.
   */
  readonly retryAfter?: number;
  /**
   * `options.cause`: the error behind this one, such as what a custom `fetch` threw. `options.status` and
   * `options.retryAfter` fill the fields of the same names.
   */
  constructor(
    format: string,
    code: LoaderErrorCode,
    message: string,
    options?: { cause?: unknown; status?: number; retryAfter?: number },
  ) {
    super(`${format}: ${message}; see https://margoengine.com/errors#loader-${code}`, options);
    this.name = 'LoaderError';
    this.format = format;
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

/**
 * The status and the `Retry-After` delay of an HTTP answer, for a {@link LoaderError}. Retry-After is delay-seconds
 * (digits) or an HTTP-date (RFC 9110 10.2.3 and 5.6.7); a date gives the whole seconds from `now` to it, 0 when past.
 */
export function httpRefusal(response: Response, now = Date.now()): { status: number; retryAfter?: number } {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return { status: response.status };
  if (/^\d+$/.test(value))
    return { status: response.status, retryAfter: Math.min(Number(value), Number.MAX_SAFE_INTEGER) };
  const at = Date.parse(value);
  return Number.isNaN(at)
    ? { status: response.status }
    : { status: response.status, retryAfter: Math.max(0, Math.ceil((at - now) / 1000)) };
}

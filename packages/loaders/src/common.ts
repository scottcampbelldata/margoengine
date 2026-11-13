// Building blocks shared by format loaders: `@margoengine/loaders/common`. Packages that read their own formats (usdz,
// ifc) import these instead of the root, which loads every parser.
export { LoaderError } from './types.js';
export type { LoadedGeometry, LoadedGroup, ParseLimits, LoaderErrorCode, AssetResolver } from './types.js';
export type { BinaryInput } from './util.js';
export { fetchBytes, DEFAULT_MAX_BYTES, type FetchOptions } from './load.js';
export { readZipDirectory, readZipEntry, crc32 } from './zip.js';
export type { ZipEntry, ZipOptions } from './zip.js';
export { computeVertexNormals, faceNormal } from './normals.js';

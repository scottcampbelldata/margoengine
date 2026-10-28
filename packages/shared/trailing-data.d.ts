/** The DecompressionStream formats. */
export type CompressionFormatName = 'deflate' | 'deflate-raw' | 'gzip';
/** Whether this runtime's DecompressionStream accepts data after the end of a `format` stream (Node 22 does). */
export function acceptsTrailingData(format: CompressionFormatName): Promise<boolean>;
/** For `bytes` that decoded as `format`: whether data follows the end of the compressed stream. */
export function hasTrailingData(bytes: Uint8Array, format: CompressionFormatName): Promise<boolean>;

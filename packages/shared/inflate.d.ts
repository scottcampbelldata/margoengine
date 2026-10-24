/**
 * Inflates a zlib stream (2 byte header, DEFLATE data, Adler-32 trailer is not verified) into exactly `size` bytes.
 * Throws MargoError `'failed'` on malformed data or when the stream does not produce exactly `size` bytes.
 */
export function inflateZlib(input: Uint8Array, size: number): Uint8Array;

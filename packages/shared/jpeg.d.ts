/** A decoded image: RGBA8 rows, top row first, `width * height * 4` bytes, alpha 255. */
export interface DecodedJPEG {
  width: number;
  height: number;
  data: Uint8Array;
}
/** Limits for {@link decodeJPEG}. */
export interface JPEGDecodeOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
}
/**
 * Decodes JPEG bytes to RGBA8 pixels. Grey images expand to RGB, and YCbCr converts as JFIF says; an Adobe marker saying
 * the file holds plain RGB is honoured. Subsampled chroma is filtered up linearly, as JFIF places it. EXIF orientation
 * and colour profiles are ignored: samples come out as stored.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` for a damaged or cut short file, and `unsupported` for arithmetic coding, lossless
 * JPEG, 12-bit samples and four-component CMYK files.
 */
export declare function decodeJPEG(bytes: Uint8Array, options?: JPEGDecodeOptions): DecodedJPEG;

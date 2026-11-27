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
 * Decodes JPEG bytes to RGBA8 pixels: baseline, extended and progressive DCT files of 8 or 12 bits, and lossless files of
 * 2 to 16 bits. Grey images expand to RGB, and YCbCr converts as JFIF says; an Adobe marker saying the file holds plain
 * RGB is honoured. A lossless file holds plain RGB unless a JFIF or Adobe marker says YCbCr. Samples of other than 8 bits
 * scale to 0-255 after conversion. Subsampled chroma is filtered up linearly, as JFIF places it. EXIF orientation and
 * colour profiles are ignored: samples come out as stored.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` for a damaged or cut short file, and `unsupported` for arithmetic coding, hierarchical
 * files, a precision its process does not allow and four-component CMYK files.
 */
export declare function decodeJPEG(bytes: Uint8Array, options?: JPEGDecodeOptions): DecodedJPEG;
/** A JPEG file's samples at its own precision: what {@link decodeJPEGSamples} returns. */
export interface JPEGSamples {
  width: number;
  height: number;
  /** Samples per pixel, 1 to 4, in frame order. */
  components: number;
  /** Bits per sample: 8 or 12 for a DCT file, 2 to 16 for a lossless one. */
  precision: number;
  /** True for a lossless (SOF3) file. */
  lossless: boolean;
  /** Component ids in frame order. */
  ids: number[];
  /** The Adobe APP14 colour transform byte, or -1 when the file has no Adobe marker. */
  adobeTransform: number;
  /** `width * height * components` values, interleaved: bytes up to 8 bits, 16-bit words above. */
  data: Uint8Array | Uint16Array;
}
/**
 * Decodes JPEG bytes to their samples at the file's precision, with no colour conversion. Subsampled components are
 * filtered up to full size and rounded. A lossless file comes out exactly as it was encoded.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` for a damaged or cut short file, and `unsupported` for arithmetic coding, hierarchical
 * files, a precision its process does not allow and more than four components.
 */
export declare function decodeJPEGSamples(bytes: Uint8Array, options?: JPEGDecodeOptions): JPEGSamples;
/** One decoded frame's components, before colour conversion. */
export interface JPEGComponents {
  width: number;
  height: number;
  /** Bits per sample; the planes return values of 0 to 2^precision - 1. */
  precision: number;
  /** True for a lossless (SOF3) file. */
  lossless: boolean;
  /** True when the file has a JFIF APP0 marker. */
  jfif: boolean;
  /** Component ids in frame order. */
  ids: number[];
  /** The Adobe APP14 colour transform byte, or -1 when the file has no Adobe marker. */
  adobeTransform: number;
  /** Per component, its sample at full image size (subsampled components filtered up linearly, centred). */
  planes: ((x: number, y: number) => number)[];
}
/**
 * Decodes JPEG bytes to their components without colour conversion. `counts` lists the component counts accepted
 * (default 1 and 3); any other count throws MargoError `unsupported`.
 */
export declare function decodeJPEGComponents(
  bytes: Uint8Array,
  options?: JPEGDecodeOptions,
  counts?: readonly number[],
): JPEGComponents;

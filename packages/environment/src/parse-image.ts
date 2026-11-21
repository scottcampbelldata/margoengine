import { parseHDR, toBytes, type FloatImage } from './hdr.js';
import { parseEXR } from './exr.js';
import { isEXR, isHDR, isJPEG, JPEG_ERROR, UNKNOWN_ERROR } from './signature.js';

/**
 * Parses `.hdr` or `.exr` bytes, picked by file signature. UltraHDR JPEGs need the async `decodeUltraHDR`.
 * @throws TypeError for a JPEG or an unrecognized signature; otherwise what `parseHDR` or `parseEXR` throws.
 */
export function parseEnvironmentImage(source: ArrayBuffer | ArrayBufferView): FloatImage {
  const bytes = toBytes(source);
  if (isEXR(bytes)) return parseEXR(bytes);
  if (isHDR(bytes)) return parseHDR(bytes);
  throw new TypeError(isJPEG(bytes) ? JPEG_ERROR : UNKNOWN_ERROR);
}

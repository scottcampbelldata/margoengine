import type { CubeLUT } from './cube.js';

// A 3D LUT stored as a picture: the blue slices of an N³ grid laid out as one strip of N tiles of N x N pixels. The 3D
// lookup of a colour transform follows J. Selan, "Using Lookup Tables to Accelerate Color Transformations", GPU Gems 2,
// 2005, chapter 24,
// https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-24-using-lookup-tables-accelerate-color

/** Decoded pixels of a LUT picture, top row first: a `decodePNG` result, or a browser `ImageData`. */
export interface LUTImageSource {
  /** N² for a horizontal strip, N for a vertical one. */
  width: number;
  /** N for a horizontal strip, N² for a vertical one. */
  height: number;
  /**
   * `width * height` pixels of 3 or 4 values, red first (alpha is ignored): bytes of 0-255, 16-bit values of 0-65535
   * (`decodePNG` with `bitDepth: 16`) or floats of 0-1.
   */
  data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
}

/** Controls for {@link parseLUTImage}. */
export interface ParseLUTImageOptions {
  /**
   * True when green runs from the bottom of each tile to its top, as a strip saved by a tool with a bottom-left texture
   * origin does. Default false: green 0 is each tile's top row.
   */
  flipGreen?: boolean;
}

/**
 * Reads a strip LUT picture into the {@link CubeLUT} that `Tonemap.setLUT` takes. A horizontal strip (N² x N pixels,
 * for example 1024 x 32 or 256 x 16) holds blue slice b in the b-th tile from the left; a vertical strip (N x N²) in
 * the b-th tile from the top. In every tile red runs left to right and green top to bottom, and the domain is 0..1.
 * Store the strip losslessly (PNG): lossy compression moves the colours. Decode it without colour management, so the
 * stored values arrive unchanged (`decodePNG` does).
 * @throws TypeError when `image` has no pixel data of a supported array type, or not 3 or 4 values per pixel.
 * @throws RangeError when neither side is the square of the other with 2 to 65 samples per axis, or a float value is
 * not finite.
 * @example
 * tonemap.setLUT(parseLUTImage(decodePNG(pngBytes)));
 */
export function parseLUTImage(image: LUTImageSource, options: ParseLUTImageOptions = {}): CubeLUT {
  const { width, height, data: pixels } = image ?? {};
  const max =
    pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray
      ? 255
      : pixels instanceof Uint16Array
        ? 65535
        : pixels instanceof Float32Array
          ? 1
          : 0;
  if (!max)
    throw new TypeError('LUT image needs pixel data; supply a decoded image with Uint8, Uint16 or Float32 data');
  const across = width === height * height,
    size = across ? height : width;
  if (!(across || height === width * width) || !Number.isInteger(size) || size < 2 || size > 65)
    throw new RangeError(
      `LUT image of ${width} x ${height} is not a strip; supply N² x N or N x N² pixels with N from 2 through 65`,
    );
  const channels = pixels.length / (width * height);
  if (channels !== 3 && channels !== 4)
    throw new TypeError('LUT image data must hold 3 or 4 values per pixel; supply RGB or RGBA pixels');
  const data = new Float32Array(size ** 3 * 4);
  for (let b = 0, o = 0; b < size; b++)
    for (let g = 0; g < size; g++) {
      const row = options.flipGreen ? size - 1 - g : g,
        // The first pixel of row `row` of tile `b`.
        start = across ? row * width + b * size : (b * size + row) * width;
      for (let r = 0; r < size; r++, o += 4) {
        const at = (start + r) * channels;
        for (let c = 0; c < 3; c++) {
          const value = pixels[at + c] / max;
          if (!Number.isFinite(value)) throw new RangeError('LUT image value is not finite; supply finite pixels');
          data[o + c] = value;
        }
        data[o + 3] = 1;
      }
    }
  return {
    size,
    data,
    domainMin: new Float32Array(3),
    domainMax: new Float32Array([1, 1, 1]),
  };
}

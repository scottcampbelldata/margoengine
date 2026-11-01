// What every frame encoder shares: the pixel and frame-source shapes and their checks.

/** RGBA8 pixels, 4 bytes per pixel, top row first, not premultiplied: an `ImageData` or a capture result. */
export interface Pixels {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}
/** Produces frame `index` (0-based) for an encoder: set the scene state for that frame, then return a capture. */
export type FrameSource = (index: number) => Pixels | Promise<Pixels>;

export function checked(pixels: Pixels): Pixels {
  const { data, width, height } = pixels ?? {};
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw new TypeError('Frame pixels need data as a Uint8Array or Uint8ClampedArray; pass an ImageData or a capture');
  if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
    throw new RangeError(`Frame size ${width}x${height} is invalid; pass whole numbers of pixels >= 1`);
  if (data.length !== width * height * 4)
    throw new RangeError(
      `Frame ${width}x${height} has ${data.length} bytes, not ${width * height * 4}; pass RGBA8 rows`,
    );
  return pixels;
}
export function checkCount(count: number): void {
  if (!(Number.isInteger(count) && count >= 1))
    throw new RangeError(`Frame count ${count} is invalid; pass a whole number >= 1`);
}

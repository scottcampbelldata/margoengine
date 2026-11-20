// The frames of the alpha video checks (test:gpu in a page, test:real-ffmpeg in Node): red at alpha 0 (left third), 128
// (middle) and 255 (right), and an opaque square on the left that steps down 16 rows a frame, so a wrong frame shows.
export const ALPHA = { width: 128, height: 96, frames: 30, fps: 30, red: [220, 40, 40] };

/** Frame `index` as straight RGBA. */
export function alphaFrame(index) {
  const { width, height, red } = ALPHA,
    data = new Uint8Array(width * height * 4),
    top = (index % 6) * 16;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4,
        square = x >= 8 && x < 24 && y >= top && y < top + 16;
      data.set(red, at);
      data[at + 3] = square || x >= (2 * width) / 3 ? 255 : x >= width / 3 ? 128 : 0;
    }
  return { width, height, data };
}

/** Every frame, in order. */
export function* alphaFile() {
  for (let index = 0; index < ALPHA.frames; index++) yield alphaFrame(index);
}

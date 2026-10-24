// PNG encoding for exportModel, loaded with import() only when a texture has no encoded bytes or must shrink.
import { pngParts } from '../../shared/png.js';

interface Pixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}
export type PNGSource = CanvasImageSource | Pixels;
const raw = (s: PNGSource): s is Pixels =>
  'data' in s && (s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray);

/**
 * RGBA8 PNG (Sub filter, zlib from CompressionStream) of a texture source, at most `max` pixels on its longer side,
 * its rows bottom first with `flipY`. Raw `{data, width, height}` rows encode directly (anywhere); other sources and
 * resizing draw through an OffscreenCanvas.
 */
export async function png(source: PNGSource, max: number, flipY: boolean): Promise<Uint8Array> {
  const dimensions = source as {
      videoWidth?: number;
      displayWidth?: number;
      naturalWidth?: number;
      width: number;
      videoHeight?: number;
      displayHeight?: number;
      naturalHeight?: number;
      height: number;
    },
    w = dimensions.videoWidth ?? dimensions.displayWidth ?? dimensions.naturalWidth ?? dimensions.width,
    h = dimensions.videoHeight ?? dimensions.displayHeight ?? dimensions.naturalHeight ?? dimensions.height;
  const scale = Math.min(1, max / Math.max(w, h)),
    W = Math.max(1, Math.round(w * scale)),
    H = Math.max(1, Math.round(h * scale));
  let rgba = raw(source) ? source.data : undefined,
    reverse = flipY;
  if (!raw(source) || scale < 1) {
    reverse = false;
    if (typeof OffscreenCanvas !== 'function')
      throw new TypeError('Encoding this texture needs OffscreenCanvas (a browser or worker)');
    let image: CanvasImageSource;
    if (raw(source)) {
      const canvas = new OffscreenCanvas(w, h);
      canvas
        .getContext('2d')!
        .putImageData(new ImageData(new Uint8ClampedArray(source.data.subarray(0, w * h * 4)), w, h), 0, 0);
      image = canvas;
    } else image = source;
    const context = new OffscreenCanvas(W, H).getContext('2d')!;
    if (flipY) {
      context.translate(0, H);
      context.scale(1, -1);
    }
    context.drawImage(image, 0, 0, W, H);
    rgba = context.getImageData(0, 0, W, H).data;
  }
  const stride = W * 4,
    rows = new Uint8Array((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    const o = y * (stride + 1),
      i = (reverse ? H - 1 - y : y) * stride;
    rows[o] = 1;
    for (let x = 0; x < stride; x++) rows[o + 1 + x] = rgba![i + x] - (x < 4 ? 0 : rgba![i + x - 4]);
  }
  const zlib = new Uint8Array(
    await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
  return new Uint8Array(await new Blob(pngParts(W, H, 6, zlib)).arrayBuffer());
}

// One JPEG XL decode on the vendored jxl-oxide module, to straight-alpha sRGB RGBA8. It runs in jxl.worker.ts, and in
// anything else that has loaded the module. jxl-oxide hands out PNG bytes, so decodePNG reads them.
import { decodeFailed } from './errors.js';
import { readJXLHeader } from './jxl-file.js';
import { decodePNG } from './png.js';

/** The JxlImage class of the vendored module, as far as a decode needs it. */
export interface JXLModule {
  JxlImage: new () => {
    feedBytes(bytes: Uint8Array): number;
    tryInit(): boolean;
    render(keyframe?: number): { encodeToPng(): Uint8Array };
    free(): void;
    forceSrgb: boolean;
    readonly loaded: boolean;
  };
}

/** Decoded JPEG XL pixels: RGBA8 rows, top row first, straight alpha, sRGB, `width * height * 4` bytes. */
export interface DecodedJXL {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Divides 16-bit premultiplied samples by their alpha into straight 8-bit ones; no alpha leaves black. */
function unpremultiply(samples: Uint16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let at = 0; at < samples.length; at += 4) {
    const alpha = samples[at + 3];
    out[at + 3] = Math.round(alpha / 257);
    if (alpha)
      for (let channel = 0; channel < 3; channel++)
        out[at + channel] = Math.round((Math.min(samples[at + channel], alpha) / alpha) * 255);
  }
  return out;
}

/**
 * Decodes the first frame. A premultiplied sRGB file keeps 16 bits until it is divided by its alpha, because dividing 8-bit
 * samples by a small alpha would magnify their rounding; every other file comes out of the module as 8-bit sRGB.
 *
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the file is cut short, corrupt or in a colour model with no RGB rendering (CMYK).
 */
export function renderJXL(module: JXLModule, bytes: Uint8Array, maxPixels = 2 ** 26): DecodedJXL {
  const header = readJXLHeader(bytes);
  if (header.width * header.height > maxPixels)
    throw new RangeError(
      `JPEG XL is ${header.width} x ${header.height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`,
    );
  const image = new module.JxlImage(),
    exact = header.alphaPremultiplied && header.srgb;
  let png: Uint8Array;
  try {
    image.feedBytes(bytes);
    if (!image.tryInit() || !image.loaded)
      throw decodeFailed('JPEG XL: the file is cut short; pass the complete bytes of a .jxl file');
    image.forceSrgb = !exact;
    png = image.render(0).encodeToPng();
  } catch (error) {
    if ((error instanceof Error && error.name === 'MargoError') || error instanceof WebAssembly.RuntimeError) throw error;
    throw decodeFailed(`JPEG XL: ${String(error)}; check the file, and convert CMYK images to RGB first`, error);
  } finally {
    image.free();
  }
  if (!header.alphaPremultiplied) return decodePNG(png, { maxPixels });
  if (exact) {
    const { width, height, data } = decodePNG(png, { maxPixels, bitDepth: 16 });
    return { width, height, data: unpremultiply(data) };
  }
  const { width, height, data } = decodePNG(png, { maxPixels }),
    wide = new Uint16Array(data.length);
  for (let at = 0; at < data.length; at++) wide[at] = data[at] * 257;
  return { width, height, data: unpremultiply(wide) };
}

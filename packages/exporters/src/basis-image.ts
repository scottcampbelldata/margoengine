// Image preparation shared by the bundled Basis encoder (ktx2-encode.ts) and the native one (basis-native.ts). ktx2.ts
// loads each of those with import(), so neither imports the other: this module is the static part both need
// (tests/dist-dynamic-imports.test.js). The JPEG reader comes from the shared decoder, not the ./jpeg-read
// compatibility entry, which texture-decode.ts loads on demand.
import { decodePNG } from '@margoengine/decoders/png';
import { decodeJPEG } from '../../shared/jpeg.js';
import type { BasisJob, RGBAImage } from './ktx2-encode.js';

/** Reads a PNG or JPEG file, picked by signature. */
function readImage(bytes: Uint8Array): RGBAImage {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePNG(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJPEG(bytes);
  throw new TypeError('KTX2 encoding reads PNG and JPEG files; pass pixels for anything else');
}

/** The image at the next multiples of 4, filtered linearly, with each new pixel's centre placed in the old image. */
function grownToBlocks(image: RGBAImage): RGBAImage {
  const { width, height, data } = image,
    W = (width + 3) & ~3,
    H = (height + 3) & ~3;
  if (W === width && H === height) return image;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = Math.min(Math.max(((y + 0.5) * height) / H - 0.5, 0), height - 1),
      y0 = v | 0,
      y1 = Math.min(y0 + 1, height - 1),
      fy = v - y0;
    for (let x = 0; x < W; x++) {
      const u = Math.min(Math.max(((x + 0.5) * width) / W - 0.5, 0), width - 1),
        x0 = u | 0,
        x1 = Math.min(x0 + 1, width - 1),
        fx = u - x0;
      for (let c = 0; c < 4; c++) {
        const top = data[(y0 * width + x0) * 4 + c] * (1 - fx) + data[(y0 * width + x1) * 4 + c] * fx,
          bottom = data[(y1 * width + x0) * 4 + c] * (1 - fx) + data[(y1 * width + x1) * 4 + c] * fx;
        out[(y * W + x) * 4 + c] = top * (1 - fy) + bottom * fy + 0.5;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/** Shared image preparation for the bundled encoder and custom encoderPath. */
export function imageForBasisJob(job: BasisJob): RGBAImage {
  const image = job.source instanceof Uint8Array ? readImage(job.source) : job.source;
  return job.wholeBlocks ? grownToBlocks(image) : image;
}

// Image comparison for visual regression tests. SSIM follows Wang, Bovik, Sheikh and Simoncelli, "Image Quality
// Assessment: From Error Visibility to Structural Similarity" (2004): an 11 x 11 Gaussian window of sigma 1.5, K1 0.01,
// K2 0.03, on luma. The PNG reader follows the W3C PNG specification. Runs anywhere, with no node: imports.
import type { HeadlessPixels } from './index.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** RGBA pixels, or PNG file bytes where a function says so. */
export type ImageSource = HeadlessPixels | Uint8Array;

/** Options of {@link pixelDiff}. */
export interface PixelDiffOptions {
  /** Largest difference in any channel, 0 to 255, that still counts as the same. Default 2, which covers rounding
   * between GPUs. */
  threshold?: number;
  /** Also return `image`, showing changed pixels in red over a faded copy of `a`. Default false. */
  image?: boolean;
}

/** What {@link pixelDiff} gives back. Differences are of colours premultiplied by alpha, on 0 to 255. */
export interface PixelDiff {
  /** Pixels over the threshold. */
  different: number;
  /** All pixels. */
  total: number;
  /** `different / total`. */
  ratio: number;
  /** The largest channel difference anywhere. */
  largest: number;
  /** The mean of each pixel's largest channel difference. */
  mean: number;
  /** With `image: true`. */
  image?: HeadlessPixels;
}

/** Options of {@link ssim}. */
export interface SSIMOptions {
  /** Window width in pixels, odd, shrunk to fit a small image. Default 11. */
  window?: number;
  /** Standard deviation of the window's Gaussian in pixels. Default 1.5. */
  sigma?: number;
  /** Also return `map`. Default false. */
  map?: boolean;
}

/** What {@link ssim} gives back. */
export interface SSIMResult {
  /** The mean over all windows: 1 for identical images, lower as structure differs. */
  score: number;
  /** With `map: true`: the score of each window, `width` by `height`, one window per position fully inside the image. */
  map?: { width: number; height: number; data: Float32Array };
}

/** Options of {@link compareImages}: the limits a pass must meet, and those of {@link pixelDiff}. */
export interface CompareOptions extends Pick<PixelDiffOptions, 'threshold'> {
  /** Largest `ratio` that passes. Default 0.001, one pixel in a thousand. */
  maxRatio?: number;
  /** Smallest SSIM score that passes. Default 0.99. */
  minSSIM?: number;
}

/** What {@link compareImages} gives back. */
export interface CompareResult extends PixelDiff {
  /** Whether both limits held. */
  pass: boolean;
  /** The SSIM score. */
  ssim: number;
  /** Always present: `a` faded with changes in red, ready to save with `encodePNG` when a test fails. */
  image: HeadlessPixels;
}

function checkPair(a: HeadlessPixels, b: HeadlessPixels): void {
  for (const { width, height, data } of [a, b])
    if (data?.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
  if (a.width !== b.width || a.height !== b.height) throw rangeError('Images must be one size to compare', 'headless');
}

/** Counts the pixels that differ. A pixel is compared premultiplied, so colour under full transparency does not count. */
export function pixelDiff(a: HeadlessPixels, b: HeadlessPixels, options: PixelDiffOptions = {}): PixelDiff {
  const { threshold = 2, image = false } = options;
  checkPair(a, b);
  if (!(threshold >= 0 && threshold <= 255)) throw rangeError('Invalid threshold', 'headless');
  const { width, height } = a,
    first = a.data,
    second = b.data,
    total = width * height,
    picture = image ? new Uint8Array(total * 4) : undefined;
  let different = 0,
    largest = 0,
    sum = 0;
  for (let i = 0; i < first.length; i += 4) {
    const alphaA = first[i + 3],
      alphaB = second[i + 3];
    let most = Math.abs(alphaA - alphaB);
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(first[i + c] * alphaA - second[i + c] * alphaB) / 255;
      if (delta > most) most = delta;
    }
    sum += most;
    if (most > largest) largest = most;
    const changed = most > threshold;
    if (changed) different++;
    if (picture) {
      if (changed) picture.set([255, 0, 0, 255], i);
      else {
        // A quarter of the picture over white, so changes stand out.
        for (let c = 0; c < 3; c++) picture[i + c] = 191 + first[i + c] / 4;
        picture[i + 3] = 255;
      }
    }
  }
  return {
    different,
    total,
    ratio: different / total,
    largest,
    mean: sum / total,
    ...(picture ? { image: { width, height, data: picture } } : {}),
  };
}

/** Rec. 709 luma of each pixel, premultiplied by alpha. */
function luma({ width, height, data }: HeadlessPixels): Float64Array {
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const at = i * 4;
    out[i] = ((0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]) * data[at + 3]) / 255;
  }
  return out;
}

/** Filters with a separable kernel, keeping only positions where the whole window fits. */
function blur(source: Float64Array, width: number, height: number, kernel: Float64Array): Float64Array {
  const size = kernel.length,
    outWidth = width - size + 1,
    outHeight = height - size + 1,
    rows = new Float64Array(outWidth * height),
    out = new Float64Array(outWidth * outHeight);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      for (let k = 0; k < size; k++) sum += source[y * width + x + k] * kernel[k];
      rows[y * outWidth + x] = sum;
    }
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      for (let k = 0; k < size; k++) sum += rows[(y + k) * outWidth + x] * kernel[k];
      out[y * outWidth + x] = sum;
    }
  return out;
}

const C1 = (0.01 * 255) ** 2,
  C2 = (0.03 * 255) ** 2;

/** Structural similarity of two images of one size: how alike they look, where a pixel count sees only how many moved. */
export function ssim(a: HeadlessPixels, b: HeadlessPixels, options: SSIMOptions = {}): SSIMResult {
  const { window = 11, sigma = 1.5, map = false } = options;
  checkPair(a, b);
  if (!Number.isInteger(window) || window < 1 || window % 2 === 0) throw rangeError('Invalid SSIM window', 'headless');
  if (!(sigma > 0) || !Number.isFinite(sigma)) throw rangeError('Invalid SSIM sigma', 'headless');
  const { width, height } = a,
    most = Math.min(width, height),
    size = Math.min(window, most % 2 ? most : most - 1) || 1,
    kernel = new Float64Array(size),
    middle = (size - 1) / 2;
  let weight = 0;
  for (let i = 0; i < size; i++) weight += kernel[i] = Math.exp(-((i - middle) ** 2) / (2 * sigma * sigma));
  for (let i = 0; i < size; i++) kernel[i] /= weight;
  const first = luma(a),
    second = luma(b),
    product = (x: Float64Array, y: Float64Array) => x.map((value, i) => value * y[i]),
    filtered = (source: Float64Array) => blur(source, width, height, kernel),
    meanA = filtered(first),
    meanB = filtered(second),
    squareA = filtered(product(first, first)),
    squareB = filtered(product(second, second)),
    cross = filtered(product(first, second)),
    scores = new Float32Array(meanA.length);
  let sum = 0;
  for (let i = 0; i < meanA.length; i++) {
    const ma = meanA[i],
      mb = meanB[i],
      varianceA = squareA[i] - ma * ma,
      varianceB = squareB[i] - mb * mb,
      covariance = cross[i] - ma * mb,
      score =
        ((2 * ma * mb + C1) * (2 * covariance + C2)) / ((ma * ma + mb * mb + C1) * (varianceA + varianceB + C2));
    scores[i] = score;
    sum += score;
  }
  return {
    score: sum / meanA.length,
    ...(map ? { map: { width: width - size + 1, height: height - size + 1, data: scores } } : {}),
  };
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10],
  PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 },
  /** The bit depths the PNG specification allows for each colour type. */
  PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  },
  /** Adam7's seven passes, each as first column, first row, column step, row step. */
  ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ],
  CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });

/** PNG's CRC-32 of a chunk's name and body. */
function chunkCRC(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const badPNG = () => fault('failed', 'Not a PNG file this reader can use', 'headless');

/** Reverses PNG's per-row filters in place, over rows of `stride` bytes each led by a filter byte. */
function unfilter(raw: Uint8Array, stride: number, height: number, step: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      from = y * (stride + 1) + 1,
      row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= step ? out[row + x - step] : 0,
        up = y ? out[row - stride + x] : 0,
        corner = y && x >= step ? out[row - stride + x - step] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner,
          toLeft = Math.abs(estimate - left),
          toUp = Math.abs(estimate - up),
          toCorner = Math.abs(estimate - corner);
        predicted = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
      } else if (filter !== 0) throw badPNG();
      out[row + x] = raw[from + x] + predicted;
    }
  }
  return out;
}

/**
 * Reads a PNG file to RGBA pixels, so a reference image made by any tool can be compared. Takes every colour type at
 * every bit depth, interlaced or not; 16-bit samples keep their high byte. A chunk whose CRC does not match, or a bit depth
 * the colour type does not allow, is refused. Colour profiles and gamma are ignored.
 */
export async function decodePNG(bytes: Uint8Array): Promise<HeadlessPixels> {
  if (!(bytes instanceof Uint8Array)) throw typeError('decodePNG needs PNG file bytes', 'headless');
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) throw badPNG();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = view.getUint32(16),
    height = view.getUint32(20),
    depth = bytes[24],
    type = bytes[25],
    channels = PNG_CHANNELS[type];
  if (!channels || !PNG_DEPTHS[type].includes(depth) || !width || !height || bytes[28] > 1) throw badPNG();
  const interlaced = bytes[28] === 1,
    compressed: Uint8Array[] = [];
  let palette: Uint8Array | undefined, transparency: Uint8Array | undefined;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at),
      name = String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      body = bytes.subarray(at + 8, at + 8 + length);
    if (at + 12 + length > bytes.length || view.getUint32(at + 8 + length) !== chunkCRC(bytes.subarray(at + 4, at + 8 + length)))
      throw badPNG();
    if (name === 'IDAT') compressed.push(body);
    else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') transparency = body;
    else if (name === 'IEND') break;
    at += length + 12;
  }
  if (!compressed.length) throw badPNG();
  const stream = new Blob(compressed as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate')),
    raw = new Uint8Array(await new Response(stream).arrayBuffer()),
    bits = channels * depth,
    data = new Uint8Array(width * height * 4),
    most = 2 ** Math.min(depth, 8) - 1,
    scale = 255 / most,
    // The transparent colour of grey and RGB files is stored in 16 bits per sample, whatever the depth.
    key = (index: number) => (transparency!.length > index * 2 + 1 ? (transparency![index * 2] << 8) | transparency![index * 2 + 1] : -1);
  let consumed = 0;
  // Reads one image of `across` by `down` pixels from the stream, its pixel (x, y) landing at (left + x * stepX, top + y * stepY).
  const pass = (across: number, down: number, left: number, top: number, stepX: number, stepY: number): void => {
    const stride = Math.ceil((across * bits) / 8);
    if (raw.length < consumed + (stride + 1) * down) throw badPNG();
    const rows = unfilter(raw.subarray(consumed), stride, down, Math.max(1, bits >> 3)),
      sample = (y: number, index: number): number => {
        const at = y * stride;
        if (depth === 16) return rows[at + index * 2];
        if (depth === 8) return rows[at + index];
        const bit = index * depth;
        return (rows[at + (bit >> 3)] >> (8 - depth - (bit & 7))) & most;
      },
      whole = (y: number, index: number) =>
        depth === 16 ? (rows[y * stride + index * 2] << 8) | rows[y * stride + index * 2 + 1] : sample(y, index);
    consumed += (stride + 1) * down;
    for (let y = 0; y < down; y++)
      for (let x = 0; x < across; x++) {
        const at = ((top + y * stepY) * width + left + x * stepX) * 4;
        if (type === 3) {
          const index = sample(y, x);
          if (!palette || index * 3 + 2 >= palette.length) throw badPNG();
          data.set(palette.subarray(index * 3, index * 3 + 3), at);
          data[at + 3] = transparency?.[index] ?? 255;
        } else if (type === 0 || type === 4) {
          data.fill(Math.round(sample(y, x * channels) * scale), at, at + 3);
          data[at + 3] =
            type === 4
              ? Math.round(sample(y, x * 2 + 1) * scale)
              : transparency && whole(y, x) === key(0)
                ? 0
                : 255;
        } else {
          for (let c = 0; c < 3; c++) data[at + c] = Math.round(sample(y, x * channels + c) * scale);
          data[at + 3] =
            type === 6
              ? Math.round(sample(y, x * 4 + 3) * scale)
              : transparency && [0, 1, 2].every((c) => whole(y, x * 3 + c) === key(c))
                ? 0
                : 255;
        }
      }
  };
  if (!interlaced) pass(width, height, 0, 0, 1, 1);
  else
    for (const [left, top, stepX, stepY] of ADAM7) {
      const across = Math.ceil((width - left) / stepX),
        down = Math.ceil((height - top) / stepY);
      // A small image leaves some passes with no pixels, and those have no rows in the stream.
      if (across > 0 && down > 0) pass(across, down, left, top, stepX, stepY);
    }
  return { width, height, data };
}

const pixels = (source: ImageSource): HeadlessPixels | Promise<HeadlessPixels> =>
  source instanceof Uint8Array ? decodePNG(source) : source;

/**
 * Compares a picture with its reference, each RGBA pixels or PNG file bytes, and says whether it passes: the check for
 * a visual regression test. Images of different sizes reject.
 */
export async function compareImages(
  actual: ImageSource,
  reference: ImageSource,
  { threshold, maxRatio = 0.001, minSSIM = 0.99 }: CompareOptions = {},
): Promise<CompareResult> {
  if (!(maxRatio >= 0 && maxRatio <= 1) || !(minSSIM >= -1 && minSSIM <= 1))
    throw rangeError('Invalid compare limits', 'headless');
  const [a, b] = await Promise.all([pixels(actual), pixels(reference)]),
    difference = pixelDiff(a, b, { threshold, image: true }),
    { score } = ssim(a, b);
  return {
    ...difference,
    image: difference.image!,
    ssim: score,
    pass: difference.ratio <= maxRatio && score >= minSSIM,
  };
}

// Pixel maths of the shot tool's capture (tools/shot/driver.js runs it in the page; tests/shot-file.test.js runs it in
// Node): sub-frames summed in linear light, an area-filter downsample from the supersampled canvas to the shot's size,
// and one encode to 8-bit sRGB with a blue-noise dither. The functions use no imports and nothing of this module but
// each other, because render.mjs installs their source in the page together (pixelScript).
//
// Sources: accumulation of sub-frames over the shutter, Haeberli and Akeley, "The accumulation buffer: hardware support
// for high-quality rendering", SIGGRAPH 1990. Area (box) resampling in linear light, Wolberg, "Digital Image Warping",
// IEEE Computer Society Press 1990, chapter 5. The sRGB transfer functions, IEC 61966-2-1:1999. Blue-noise dither
// arrays by the void-and-cluster method, Ulichney, "The void-and-cluster method for dither array generation", Proc.
// SPIE 1913, 1993; blue noise for dithering, Ulichney, "Dithering with blue noise", Proc. IEEE 76(1), 1988.

/** sRGB-encoded 0 to 1 to linear light (IEC 61966-2-1). */
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light to sRGB-encoded 0 to 1 (IEC 61966-2-1). */
export function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * The area filter from `from` pixels to `to` pixels along one axis: output pixel j covers input [j, j + 1) * from / to
 * and takes each input pixel by the share of it inside that span. Returns, per output pixel, its first input pixel
 * and weights that add up to 1, flat: `first[j]`, `count[j]`, and `weights` from `offset[j]`.
 */
export function areaWeights(from, to) {
  const scale = from / to,
    first = new Int32Array(to),
    count = new Int32Array(to),
    offset = new Int32Array(to),
    list = [];
  for (let j = 0; j < to; j++) {
    const a = j * scale,
      b = (j + 1) * scale,
      start = Math.floor(a),
      end = Math.min(from, Math.ceil(b - 1e-9));
    first[j] = start;
    offset[j] = list.length;
    for (let i = start; i < end; i++) list.push((Math.min(b, i + 1) - Math.max(a, i)) / scale);
    count[j] = end - start;
  }
  return { first, count, offset, weights: Float64Array.from(list) };
}

/**
 * Adds one sub-frame to `sum` (linear RGB, three floats a pixel): 8-bit sRGB RGBA bytes through a 256-entry table, or
 * half floats (`rgba16float`, sRGB-encoded, clamped to 0 to 1) from `half` with `stride` 16-bit words a row.
 */
export function addSubframe(sum, { width, height, rgba, half, stride }) {
  if (rgba) {
    const table = new Float64Array(256);
    for (let k = 0; k < 256; k++) table[k] = srgbToLinear(k / 255);
    for (let p = 0, q = 0; p < width * height; p++, q += 4) {
      sum[p * 3] += table[rgba[q]];
      sum[p * 3 + 1] += table[rgba[q + 1]];
      sum[p * 3 + 2] += table[rgba[q + 2]];
    }
    return;
  }
  const value = (bits) => {
    const exponent = (bits >> 10) & 31,
      fraction = bits & 1023;
    if (bits & 0x8000 || (exponent === 31 && fraction)) return 0;
    const v = exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? 1 : (1 + fraction / 1024) * 2 ** (exponent - 15);
    return srgbToLinear(v >= 1 ? 1 : v);
  };
  for (let y = 0; y < height; y++)
    for (let x = 0, at = y * stride, p = y * width * 3; x < width; x++, at += 4, p += 3) {
      sum[p] += value(half[at]);
      sum[p + 1] += value(half[at + 1]);
      sum[p + 2] += value(half[at + 2]);
    }
}

/**
 * The kept frame from the summed sub-frames: the mean of `count` sub-frames, the area filter from `width` x `height`
 * to `outWidth` x `outHeight`, then one encode to 8-bit sRGB with the blue-noise dither `noise` (ranks 0 to n - 1 of a
 * `noiseSize` square, tiled; each channel reads it at its own offset), so the step from float to 8 bits leaves no
 * bands in slow gradients. Returns RGBA bytes, alpha 255, row 0 at the top.
 */
export function resolveFrame({ sum, width, height, count, outWidth, outHeight, noise, noiseSize }) {
  const across = areaWeights(width, outWidth),
    down = areaWeights(height, outHeight),
    rows = new Float32Array(outWidth * height * 3);
  for (let y = 0; y < height; y++)
    for (let j = 0; j < outWidth; j++) {
      let r = 0,
        g = 0,
        b = 0;
      for (
        let k = 0, at = (y * width + across.first[j]) * 3, w = across.offset[j];
        k < across.count[j];
        k++, at += 3, w++
      ) {
        const weight = across.weights[w];
        r += sum[at] * weight;
        g += sum[at + 1] * weight;
        b += sum[at + 2] * weight;
      }
      const to = (y * outWidth + j) * 3;
      rows[to] = r;
      rows[to + 1] = g;
      rows[to + 2] = b;
    }
  const out = new Uint8ClampedArray(outWidth * outHeight * 4),
    levels = noiseSize * noiseSize,
    // Channel offsets into the dither tile, far apart so the three channels' dithers are not one pattern.
    shift = [
      [0, 0],
      [Math.floor(noiseSize / 2) + 3, Math.floor(noiseSize / 3)],
      [Math.floor(noiseSize / 3), Math.floor(noiseSize / 2) + 5],
    ];
  const line = new Float64Array(outWidth * 3);
  for (let i = 0; i < outHeight; i++) {
    line.fill(0);
    for (let k = 0; k < down.count[i]; k++) {
      const weight = down.weights[down.offset[i] + k] / count,
        from = (down.first[i] + k) * outWidth * 3;
      for (let q = 0; q < line.length; q++) line[q] += rows[from + q] * weight;
    }
    const noiseRow = [0, 1, 2].map((c) => ((i + shift[c][1]) % noiseSize) * noiseSize);
    for (let x = 0; x < outWidth; x++)
      for (let c = 0; c < 3; c++) {
        const v = line[x * 3 + c],
          encoded = v <= 0 ? 0 : v >= 1 ? 1 : linearToSrgb(v),
          rank = noise[noiseRow[c] + ((x + shift[c][0]) % noiseSize)],
          // A dither from -0.5 to 0.5 of a level, never reaching either, so an exact 8-bit level stays itself.
          level = Math.round(encoded * 255 + (rank + 0.5) / levels - 0.5);
        out[(i * outWidth + x) * 4 + c] = level < 0 ? 0 : level > 255 ? 255 : level;
      }
    for (let x = 0; x < outWidth; x++) out[(i * outWidth + x) * 4 + 3] = 255;
  }
  return out;
}

/**
 * An 8-bit grey mask from `width` x `height` to `outWidth` x `outHeight` by the area filter (coverage at the edges).
 * Coverage rounds to the nearest level with an exact half rounding down (127.5 to 127), so 128 and above (the look
 * masks' inside, @margoengine/headless/look) means more than half the pixel is covered: two masks that never share a
 * sample (plants and lit ground) never both read inside, where rounding half up put a half-and-half edge pixel in both
 * (KB-LOOK-MASKTIE1). The 1e-7 takes up the float error of the weights, so a sum that is half in exact maths ties.
 */
export function resampleMask({ grey, width, height, outWidth, outHeight }) {
  if (width === outWidth && height === outHeight) return grey;
  const across = areaWeights(width, outWidth),
    down = areaWeights(height, outHeight),
    out = new Uint8Array(outWidth * outHeight);
  for (let i = 0; i < outHeight; i++)
    for (let j = 0; j < outWidth; j++) {
      let v = 0;
      for (let a = 0; a < down.count[i]; a++)
        for (let b = 0; b < across.count[j]; b++)
          v +=
            grey[(down.first[i] + a) * width + across.first[j] + b] *
            down.weights[down.offset[i] + a] *
            across.weights[across.offset[j] + b];
      out[i * outWidth + j] = Math.max(0, Math.ceil(v - 0.5 - 1e-7));
    }
  return out;
}

/**
 * A nearness mask (a larger value is a nearer surface, 0 is nothing drawn) from `width` x `height` to `outWidth` x
 * `outHeight`: each output pixel takes the largest value its footprint covers, so a silhouette pixel holds the nearest
 * surface's own distance and never a mix with the background's, which is no distance at all.
 */
export function resampleNearness({ value, width, height, outWidth, outHeight }) {
  if (width === outWidth && height === outHeight) return value;
  const across = areaWeights(width, outWidth),
    down = areaWeights(height, outHeight),
    out = new Float32Array(outWidth * outHeight);
  for (let i = 0; i < outHeight; i++)
    for (let j = 0; j < outWidth; j++) {
      let v = 0;
      for (let a = 0; a < down.count[i]; a++)
        for (let b = 0; b < across.count[j]; b++) {
          const read = value[(down.first[i] + a) * width + across.first[j] + b];
          if (read > v) v = read;
        }
      out[i * outWidth + j] = v;
    }
  return out;
}

/**
 * A `size` x `size` blue-noise dither array by the void-and-cluster method (Ulichney 1993): ranks 0 to size^2 - 1, each
 * once, so a threshold at any level gives an even scatter with no clumps. Toroidal Gaussian energy of `sigma` pixels;
 * the starting pattern is seeded (mulberry32), so the array is the same on every machine.
 */
export function blueNoise(size = 64, { sigma = 1.5, seed = 1 } = {}) {
  const n = size * size,
    kernel = new Float64Array(n);
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = Math.min(dx, size - dx),
        y = Math.min(dy, size - dy);
      kernel[dy * size + dx] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  const energy = new Float64Array(n),
    on = new Uint8Array(n),
    splat = (p, sign) => {
      const px = p % size,
        py = (p - px) / size;
      for (let y = 0; y < size; y++) {
        const row = ((y - py + size) % size) * size;
        for (let x = 0; x < size; x++) energy[y * size + x] += sign * kernel[row + ((x - px + size) % size)];
      }
    };
  const tightest = () => {
    let best = -1;
    for (let p = 0; p < n; p++) if (on[p] && (best < 0 || energy[p] > energy[best])) best = p;
    return best;
  };
  const emptiest = () => {
    let best = -1;
    for (let p = 0; p < n; p++) if (!on[p] && (best < 0 || energy[p] < energy[best])) best = p;
    return best;
  };
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const start = Math.max(1, Math.floor(n / 10));
  for (let placed = 0; placed < start; ) {
    const p = Math.floor(random() * n);
    if (on[p]) continue;
    on[p] = 1;
    splat(p, 1);
    placed++;
  }
  // The initial binary pattern: move the tightest cluster's point to the largest void until it lands where it was.
  for (let round = 0; round < n; round++) {
    const from = tightest();
    on[from] = 0;
    splat(from, -1);
    const to = emptiest();
    on[to] = 1;
    splat(to, 1);
    if (to === from) break;
  }
  const prototype = on.slice(),
    base = energy.slice(),
    rank = new Uint16Array(n);
  // Phase 1: ranks below the starting count, removing the tightest cluster each time.
  for (let r = start - 1; r >= 0; r--) {
    const p = tightest();
    on[p] = 0;
    splat(p, -1);
    rank[p] = r;
  }
  on.set(prototype);
  energy.set(base);
  // Phases 2 and 3: the rest, filling the largest void each time (the tightest cluster of the empty pixels past half,
  // which is the same pixel: the two energies add up to a constant on the torus).
  for (let r = start; r < n; r++) {
    const p = emptiest();
    on[p] = 1;
    splat(p, 1);
    rank[p] = r;
  }
  return rank;
}

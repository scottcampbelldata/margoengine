// Radiance RGBE (.hdr) decoder: the Three.js RGBELoader equivalent.

/** Linear float image, row 0 at the top. `data` is RGBA (4 floats per pixel; alpha is 1 when the file has none). */
export interface FloatImage {
  width: number;
  height: number;
  data: Float32Array;
}

export interface HDRImage extends FloatImage {
  /** Value of the EXPOSURE header lines multiplied together (1 when absent). Not applied to `data`. */
  exposure: number;
  /** Value of the GAMMA header line (1 when absent). Not applied to `data`. */
  gamma: number;
}

/** Hard limit on decoded pixels, about 1 GiB of float RGBA. */
export const MAX_PIXELS = 1 << 26;

const decoder = /* @__PURE__ */ new TextDecoder('latin1');

/**
 * Parses a Radiance `.hdr` file (`32-bit_rle_rgbe`), decoding flat, old-style run-length and adaptive
 * (new-style) run-length scanlines. Orientations `-Y h +X w` (standard) and `+Y h +X w` (bottom-up) are
 * supported; mirrored X and transposed layouts are rejected.
 */
export function parseHDR(source: ArrayBuffer | ArrayBufferView): HDRImage {
  const bytes = toBytes(source);
  let position = 0;
  const readLine = (): string => {
    const start = position;
    while (position < bytes.length && bytes[position] !== 10) position++;
    if (position >= bytes.length) throw new Error('Invalid HDR: header is not terminated');
    if (position - start > 4096) throw new Error('Invalid HDR: header line too long');
    return decoder.decode(bytes.subarray(start, position++)).replace(/\r$/, '');
  };
  const magic = readLine();
  if (!/^#\?(RADIANCE|RGBE)/.test(magic)) throw new Error('Invalid HDR: missing #?RADIANCE signature');
  let format = '', exposure = 1, gamma = 1;
  for (let lines = 0; ; lines++) {
    if (lines > 256) throw new Error('Invalid HDR: too many header lines');
    const line = readLine();
    if (line === '') break;
    if (line.startsWith('#')) continue;
    const match = /^([A-Za-z-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toUpperCase(), value = match[2].trim();
    if (key === 'FORMAT') format = value;
    else if (key === 'EXPOSURE') {const v = Number(value); if (Number.isFinite(v) && v > 0) exposure *= v;}
    else if (key === 'GAMMA') {const v = Number(value); if (Number.isFinite(v) && v > 0) gamma = v;}
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`Unsupported HDR format "${format}" (only 32-bit_rle_rgbe)`);
  const resolution = /^([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)\s*$/.exec(readLine());
  if (!resolution) throw new Error('Invalid HDR: unsupported resolution line (expected "-Y h +X w")');
  if (resolution[3] !== '+') throw new Error('Unsupported HDR orientation: mirrored X');
  const height = Number(resolution[2]), width = Number(resolution[4]), bottomUp = resolution[1] === '+';
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) throw new Error(`Invalid HDR size ${width}x${height}`);

  const data = new Float32Array(width * height * 4);
  const scanline = new Uint8Array(width * 4);
  for (let row = 0; row < height; row++) {
    position = readScanline(bytes, position, scanline, width);
    const y = bottomUp ? height - 1 - row : row;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const e = scanline[x * 4 + 3];
      if (e === 0) {data[o] = data[o + 1] = data[o + 2] = 0;}
      else {
        const scale = 2 ** (e - 136);
        data[o] = scanline[x * 4] * scale; data[o + 1] = scanline[x * 4 + 1] * scale; data[o + 2] = scanline[x * 4 + 2] * scale;
      }
      data[o + 3] = 1;
    }
  }
  return {width, height, data, exposure, gamma};
}

function readScanline(bytes: Uint8Array, position: number, out: Uint8Array, width: number): number {
  if (position + 4 > bytes.length) throw new Error('Invalid HDR: truncated pixel data');
  // Adaptive run-length scanline: 2, 2, width high byte, width low byte, then four planar channels.
  if (width >= 8 && width < 0x8000 && bytes[position] === 2 && bytes[position + 1] === 2 && !(bytes[position + 2] & 0x80)) {
    if (((bytes[position + 2] << 8) | bytes[position + 3]) !== width) throw new Error('Invalid HDR: scanline width mismatch');
    position += 4;
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        if (position >= bytes.length) throw new Error('Invalid HDR: truncated run-length data');
        let count = bytes[position++];
        if (count > 128) {
          count -= 128;
          if (count === 0 || x + count > width || position >= bytes.length) throw new Error('Invalid HDR: bad run');
          const value = bytes[position++];
          for (let i = 0; i < count; i++) out[(x++) * 4 + channel] = value;
        } else {
          if (count === 0 || x + count > width || position + count > bytes.length) throw new Error('Invalid HDR: bad literal run');
          for (let i = 0; i < count; i++) out[(x++) * 4 + channel] = bytes[position++];
        }
      }
    }
    return position;
  }
  // Flat RGBE pixels, possibly with old-style runs (1, 1, 1, count) repeating the previous pixel.
  let x = 0, shift = 0;
  while (x < width) {
    if (position + 4 > bytes.length) throw new Error('Invalid HDR: truncated pixel data');
    const r = bytes[position], g = bytes[position + 1], b = bytes[position + 2], e = bytes[position + 3];
    position += 4;
    if (r === 1 && g === 1 && b === 1) {
      if (x === 0) throw new Error('Invalid HDR: run with no previous pixel');
      if (shift > 24) throw new Error('Invalid HDR: run length overflow');
      const count = e * 2 ** shift;
      if (x + count > width) throw new Error('Invalid HDR: run exceeds scanline');
      for (let i = 0; i < count; i++, x++) out.copyWithin(x * 4, (x - 1) * 4, x * 4);
      shift += 8;
      continue;
    }
    out[x * 4] = r; out[x * 4 + 1] = g; out[x * 4 + 2] = b; out[x * 4 + 3] = e;
    x++; shift = 0;
  }
  return position;
}

export function toBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new TypeError('Expected an ArrayBuffer or typed array');
}

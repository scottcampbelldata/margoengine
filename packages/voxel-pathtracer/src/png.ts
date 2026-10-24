// A streaming PNG writer for 8-bit RGB or RGBA images, written from the W3C PNG specification (third edition): signature,
// IHDR, one IDAT holding the zlib stream (the platform's CompressionStream('deflate') is RFC 1950 zlib), IEND, each
// chunk with its CRC-32. Rows are filtered per row with the type of smallest sum of absolute differences, the
// specification's suggested heuristic. Rows go in as they are rendered, so a large capture never holds its raw image.

import { pngParts, pngPredict } from '../../shared/png.js';

/** Streams an RGB8 (or, with `alpha`, RGBA8 with straight alpha) image into a PNG Blob row by row. */
export class PngWriter {
  readonly width: number;
  readonly height: number;
  /** Bytes per pixel: 3, or 4 with alpha. */
  readonly channels: 3 | 4;
  #rows = 0;
  #writer: WritableStreamDefaultWriter<BufferSource>;
  #output: Promise<Uint8Array[]>;
  #previous: Uint8Array;
  #line: Uint8Array;
  #candidates: Uint8Array[];

  constructor(width: number, height: number, alpha = false) {
    this.width = width;
    this.height = height;
    this.channels = alpha ? 4 : 3;
    const stream = new CompressionStream('deflate');
    this.#writer = stream.writable.getWriter();
    const reader = stream.readable.getReader(),
      parts: Uint8Array[] = [];
    this.#output = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return parts;
        parts.push(value);
      }
    })();
    this.#output.catch(() => {});
    const stride = width * this.channels;
    this.#previous = new Uint8Array(stride);
    this.#line = new Uint8Array(stride);
    this.#candidates = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  }

  /** Appends `count` rows of tightly packed RGB (RGBA) bytes. */
  async write(rgb: Uint8Array, count: number): Promise<void> {
    const bpp = this.channels,
      stride = this.width * bpp;
    for (let r = 0; r < count; r++) {
      const line = rgb.subarray(r * stride, (r + 1) * stride),
        up = this.#previous;
      let best = this.#candidates[0],
        bestScore = Infinity;
      for (let type = 0; type < 5; type++) {
        const out = this.#candidates[type];
        out[0] = type;
        let score = 0;
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? line[i - bpp] : 0,
            b = up[i],
            c = i >= bpp ? up[i - bpp] : 0,
            x = line[i];
          const v = (x - pngPredict(type, a, b, c)) & 255;
          out[i + 1] = v;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) {
          bestScore = score;
          best = out;
        }
      }
      await this.#writer.ready;
      await this.#writer.write(best.slice());
      this.#line.set(line);
      [this.#previous, this.#line] = [this.#line, this.#previous];
      this.#rows++;
    }
  }

  /** Finishes the stream; every row must have been written. */
  async finish(): Promise<Blob> {
    if (this.#rows !== this.height) throw new RangeError(`PNG has ${this.#rows} of ${this.height} rows`);
    await this.#writer.close();
    const parts = await this.#output;
    let length = 0;
    for (const p of parts) length += p.length;
    const data = new Uint8Array(length);
    let at = 0;
    for (const p of parts) {
      data.set(p, at);
      at += p.length;
    }
    // 8 bits, RGB (6: RGBA), deflate, adaptive filters, no interlace.
    return new Blob(pngParts(this.width, this.height, this.channels === 4 ? 6 : 2, data), { type: 'image/png' });
  }

  /** Drops the stream (cancelled capture). */
  abort(): void {
    this.#writer.abort().catch(() => {});
  }
}

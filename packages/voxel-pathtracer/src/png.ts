// A streaming PNG writer for 8-bit RGB images, written from the W3C PNG specification (third edition): signature,
// IHDR, one IDAT holding the zlib stream (the platform's CompressionStream('deflate') is RFC 1950 zlib), IEND, each
// chunk with its CRC-32. Rows are filtered per row with the type of smallest sum of absolute differences, the
// specification's suggested heuristic. Rows go in as they are rendered, so a large capture never holds its raw image.

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
const crc = (value: number, bytes: Uint8Array): number => {
  let c = value;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return c;
};
const u32 = (value: number) => new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const name = ascii(type);
  return [u32(data.length), name, data, u32((crc(crc(0xffffffff, name), data) ^ 0xffffffff) >>> 0)];
}

/** Streams an RGB8 image into a PNG Blob row by row. */
export class PngWriter {
  readonly width: number;
  readonly height: number;
  #rows = 0;
  #writer: WritableStreamDefaultWriter<BufferSource>;
  #output: Promise<Uint8Array[]>;
  #previous: Uint8Array;
  #line: Uint8Array;
  #candidates: Uint8Array[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
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
    const stride = width * 3;
    this.#previous = new Uint8Array(stride);
    this.#line = new Uint8Array(stride);
    this.#candidates = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  }

  /** Appends `count` rows of tightly packed RGB bytes. */
  async write(rgb: Uint8Array, count: number): Promise<void> {
    const stride = this.width * 3;
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
          const a = i >= 3 ? line[i - 3] : 0,
            b = up[i],
            c = i >= 3 ? up[i - 3] : 0,
            x = line[i];
          let predictor = 0;
          if (type === 1) predictor = a;
          else if (type === 2) predictor = b;
          else if (type === 3) predictor = (a + b) >> 1;
          else if (type === 4) {
            const p = a + b - c,
              pa = Math.abs(p - a),
              pb = Math.abs(p - b),
              pc = Math.abs(p - c);
            predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
          const v = (x - predictor) & 255;
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
    const header = new Uint8Array(13);
    header.set(u32(this.width), 0);
    header.set(u32(this.height), 4);
    header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, adaptive filtering, no interlace
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    return new Blob(
      [signature, ...chunk('IHDR', header), ...chunk('IDAT', data), ...chunk('IEND', new Uint8Array(0))] as BlobPart[],
      { type: 'image/png' },
    );
  }

  /** Drops the stream (cancelled capture). */
  abort(): void {
    this.#writer.abort().catch(() => {});
  }
}

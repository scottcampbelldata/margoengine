// Lossless WebP (VP8L) writer for the SOG encoder. Written from the WebP Lossless Bitstream specification (RFC 9649);
// no other implementation was read. It writes the simplest valid stream: no transforms, no colour cache, one prefix
// code group, literal pixels only (no backward references), each channel with its own canonical prefix code built
// from the image's histogram and limited to 15 bits; the code lengths are written with a code-length code limited to
// 7 bits. SOG textures hold quantised indices, so per-channel entropy coding does most of the work.

const ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class BitWriter {
  private bytes = new Uint8Array(1 << 16);
  private at = 0;
  private acc = 0;
  private have = 0;
  /** Writes the low `n` (0..24) bits of `value`, least significant first. */
  write(value: number, n: number): void {
    this.acc |= (value & ((1 << n) - 1)) << this.have;
    this.have += n;
    while (this.have >= 8) {
      if (this.at === this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      this.bytes[this.at++] = this.acc & 255;
      this.acc >>>= 8;
      this.have -= 8;
    }
  }
  finish(): Uint8Array {
    if (this.have) this.write(0, 8 - this.have);
    return this.bytes.subarray(0, this.at);
  }
}

/**
 * Code lengths of a prefix code for `counts`, none longer than `limit`: Huffman's construction, with the counts
 * halved (keeping every used symbol at 1 or more) and rebuilt until the longest code fits.
 */
export function codeLengths(counts: ArrayLike<number>, limit: number): Uint8Array {
  const n = counts.length,
    lengths = new Uint8Array(n),
    weight = Array.from(counts, (c) => c);
  for (;;) {
    const used: number[] = [];
    for (let s = 0; s < n; s++) if (weight[s] > 0) used.push(s);
    lengths.fill(0);
    if (used.length < 2) {
      for (const s of used) lengths[s] = 1;
      return lengths;
    }
    // Nodes: leaves 0..used-1, inner nodes after; a sorted queue of leaves and a queue of inner nodes.
    const leaves = used.slice().sort((a, b) => weight[a] - weight[b] || a - b),
      total = leaves.length,
      w = new Float64Array(total * 2),
      parent = new Int32Array(total * 2);
    leaves.forEach((s, i) => (w[i] = weight[s]));
    let next = total,
      leaf = 0,
      inner = total;
    const take = (): number => (leaf < total && (inner >= next || w[leaf] <= w[inner]) ? leaf++ : inner++);
    while (next < total * 2 - 1) {
      const a = take(),
        b = take();
      w[next] = w[a] + w[b];
      parent[a] = parent[b] = next++;
    }
    let longest = 0;
    const depth = new Uint8Array(total * 2);
    for (let i = total * 2 - 3; i >= 0; i--) depth[i] = depth[parent[i]] + 1;
    leaves.forEach((s, i) => {
      lengths[s] = depth[i];
      longest = Math.max(longest, depth[i]);
    });
    if (longest <= limit) return lengths;
    for (const s of used) weight[s] = Math.max(1, weight[s] >> 1);
  }
}

/** Canonical codes for `lengths`, bit-reversed so they can be written least significant bit first. */
function canonical(lengths: Uint8Array): Uint32Array {
  const count = new Uint32Array(16),
    next = new Uint32Array(16),
    codes = new Uint32Array(lengths.length);
  for (const l of lengths) if (l) count[l]++;
  for (let l = 1, code = 0; l < 16; l++) {
    next[l] = code;
    code = (code + count[l]) << 1;
  }
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (!l) continue;
    let c = next[l]++,
      r = 0;
    for (let k = 0; k < l; k++) {
      r = (r << 1) | (c & 1);
      c >>= 1;
    }
    codes[s] = r;
  }
  return codes;
}

/** Writes one prefix code for an alphabet of `counts.length` and returns its lengths and codes for the symbols. */
function writeCode(bits: BitWriter, counts: Uint32Array): { lengths: Uint8Array; codes: Uint32Array } {
  const used: number[] = [];
  for (let s = 0; s < counts.length; s++) if (counts[s]) used.push(s);
  if (!used.length) used.push(0);
  // The simple code: one or two symbols below 256, one bit each (a single symbol takes no bits).
  if (used.length <= 2 && used[used.length - 1] < 256) {
    bits.write(1, 1);
    bits.write(used.length - 1, 1);
    const wide = used[0] > 1;
    bits.write(+wide, 1);
    bits.write(used[0], wide ? 8 : 1);
    if (used.length === 2) bits.write(used[1], 8);
    const lengths = new Uint8Array(counts.length);
    if (used.length === 2) lengths[used[0]] = lengths[used[1]] = 1;
    return { lengths, codes: canonical(lengths) };
  }
  const lengths = codeLengths(counts, 15),
    histogram = new Uint32Array(19);
  for (const l of lengths) histogram[l]++;
  // Two code-length symbols at least, so the code-length code is a full one-bit or longer code.
  if (histogram.filter((c) => c).length < 2) histogram[histogram[0] ? 1 : 0]++;
  const meta = codeLengths(histogram, 7),
    metaCodes = canonical(meta);
  let n = 19;
  while (n > 4 && !meta[ORDER[n - 1]]) n--;
  bits.write(0, 1);
  bits.write(n - 4, 4);
  for (let i = 0; i < n; i++) bits.write(meta[ORDER[i]], 3);
  bits.write(0, 1); // every symbol's length follows
  for (const l of lengths) bits.write(metaCodes[l], meta[l]);
  return { lengths, codes: canonical(lengths) };
}

/**
 * Encodes `rgba` (`width x height` pixels, 4 bytes each) as a lossless WebP file (RIFF, one VP8L chunk). Every value
 * decodes exactly.
 * @throws RangeError for a size outside 1 to 16,384 or a pixel array of another length.
 */
export function encodeWebpLossless(rgba: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384
  )
    throw new RangeError('A lossless WebP must be 1 to 16,384 pixels on each side; split the texture');
  if (rgba.length !== width * height * 4)
    throw new RangeError('A lossless WebP needs 4 bytes per pixel; pass width x height x 4');
  const histograms = [new Uint32Array(280), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let opaque = true;
  for (let i = 0; i < rgba.length; i += 4) {
    histograms[0][rgba[i + 1]]++;
    histograms[1][rgba[i]]++;
    histograms[2][rgba[i + 2]]++;
    histograms[3][rgba[i + 3]]++;
    if (rgba[i + 3] !== 255) opaque = false;
  }
  const bits = new BitWriter();
  bits.write(0x2f, 8);
  bits.write(width - 1, 14);
  bits.write(height - 1, 14);
  bits.write(+!opaque, 1);
  bits.write(0, 3); // version 0
  bits.write(0, 1); // no transform
  bits.write(0, 1); // no colour cache
  bits.write(0, 1); // no meta prefix codes
  // Green (with the unused length prefixes), red, blue, alpha, then a one-symbol distance code.
  const [green, red, blue, alpha] = histograms.map((h) => writeCode(bits, h));
  writeCode(bits, new Uint32Array(40));
  for (let i = 0; i < rgba.length; i += 4) {
    bits.write(green.codes[rgba[i + 1]], green.lengths[rgba[i + 1]]);
    bits.write(red.codes[rgba[i]], red.lengths[rgba[i]]);
    bits.write(blue.codes[rgba[i + 2]], blue.lengths[rgba[i + 2]]);
    bits.write(alpha.codes[rgba[i + 3]], alpha.lengths[rgba[i + 3]]);
  }
  const stream = bits.finish(),
    padded = stream.length + (stream.length & 1),
    out = new Uint8Array(20 + padded),
    view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 12 + padded, true);
  out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8);
  view.setUint32(16, stream.length, true);
  out.set(stream, 20);
  return out;
}

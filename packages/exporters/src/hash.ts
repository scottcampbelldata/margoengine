// SHA-256 (FIPS 180-4) for content hashes of exported files and manifests (`@margoengine/exporters/hash`).
// Synchronous and incremental: hash a file in pieces as it is written, with one 64-byte block buffer and no copy of
// the input. For one-shot hashing of large buffers in a browser, crypto.subtle.digest is faster; this one runs
// anywhere, in order, without awaiting.

const K = /* @__PURE__ */ Uint32Array.of(
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
);
const rotr = (n: number, s: number): number => (n >>> s) | (n << (32 - s));

/** Incremental SHA-256: `new SHA256().update(a).update(b).hex()`. */
export class SHA256 {
  private readonly h = Uint32Array.of(
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  );
  private readonly w = new Uint32Array(64);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private total = 0;
  private result: Uint8Array | undefined;

  private block(input: Uint8Array, offset: number): void {
    const { w, h } = this;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = (input[p] << 24) | (input[p + 1] << 16) | (input[p + 2] << 8) | input[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      w[i] = w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      k = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0,
        t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }

  /**
   * Adds `bytes` to the hash. Reads them now and keeps no reference.
   *
   * @throws TypeError when `bytes` is not a Uint8Array, or after {@link SHA256.digest} or {@link SHA256.hex}.
   * @throws RangeError past 2^53 - 1 bytes in total.
   */
  update(bytes: Uint8Array): this {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('SHA256.update needs a Uint8Array');
    if (this.result) throw new TypeError('SHA256 is already finished; create a new SHA256 for more data');
    if (!Number.isSafeInteger(this.total + bytes.length))
      throw new RangeError('SHA256 input is over 2^53 - 1 bytes; hash it in separate parts');
    this.total += bytes.length;
    let offset = 0;
    if (this.pendingLength) {
      const take = Math.min(64 - this.pendingLength, bytes.length);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset = take;
      if (this.pendingLength < 64) return this;
      this.block(this.pending, 0);
      this.pendingLength = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.block(bytes, offset);
    this.pending.set(bytes.subarray(offset));
    this.pendingLength = bytes.length - offset;
    return this;
  }

  /** The 32-byte hash of everything added. Finishes the hash; later calls return the same bytes (a copy). */
  digest(): Uint8Array {
    if (!this.result) {
      const tail = new Uint8Array(this.pendingLength < 56 ? 64 : 128),
        view = new DataView(tail.buffer);
      tail.set(this.pending.subarray(0, this.pendingLength));
      tail[this.pendingLength] = 0x80;
      view.setUint32(tail.length - 8, Math.floor(this.total / 0x20000000));
      view.setUint32(tail.length - 4, (this.total * 8) >>> 0);
      for (let offset = 0; offset < tail.length; offset += 64) this.block(tail, offset);
      const out = new Uint8Array(32),
        outView = new DataView(out.buffer);
      for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i]);
      this.result = out;
    }
    return this.result.slice();
  }

  /** {@link SHA256.digest} as 64 lowercase hexadecimal digits. */
  hex(): string {
    let text = '';
    for (const byte of this.digest()) text += byte.toString(16).padStart(2, '0');
    return text;
  }
}

/** SHA-256 of `bytes` as 64 lowercase hexadecimal digits. */
export const sha256 = (bytes: Uint8Array): string => new SHA256().update(bytes).hex();

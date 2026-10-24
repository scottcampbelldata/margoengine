// Little-endian byte writing and checked reading with LEB128 varints and zigzag integers, for the binary formats of
// @margoengine/voxel (chunks, block changes, entity snapshots) and @margoengine/voxel-net (its wire messages).

/** Signed integer to an unsigned one, small magnitudes small: 0, -1, 1, -2 ... become 0, 1, 2, 3 ... */
export const zigzag = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
/** The inverse of {@link zigzag}. */
export const unzigzag = (z) => (z % 2 ? -(z + 1) / 2 : z / 2);

/** A growing little-endian byte buffer. */
export class ByteWriter {
  at = 0;
  constructor(size = 64) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  room(n) {
    if (this.at + n <= this.bytes.length) return;
    const bytes = new Uint8Array(Math.max(2 * this.bytes.length, this.at + n));
    bytes.set(this.bytes);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer);
  }
  u8(v) {
    this.room(1);
    this.bytes[this.at++] = v;
  }
  u16(v) {
    this.room(2);
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v) {
    this.room(4);
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }
  f32(v) {
    this.room(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }
  /** LEB128 of an unsigned 32-bit integer: 7 bits per byte, low first, 1-5 bytes. */
  varint(v) {
    this.room(5);
    for (; v > 127; v >>>= 7) this.bytes[this.at++] = (v & 127) | 128;
    this.bytes[this.at++] = v;
  }
  raw(b) {
    this.room(b.length);
    this.bytes.set(b, this.at);
    this.at += b.length;
  }
  done() {
    return this.bytes.slice(0, this.at);
  }
}

/**
 * Checked little-endian reads from `bytes` starting at `start`; a short or malformed input throws a RangeError
 * `"<what> <problem>; <fix>"`.
 */
export class ByteReader {
  constructor(bytes, what, fix, start = 0) {
    this.bytes = bytes;
    this.what = what;
    this.fix = fix;
    this.at = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  fail(problem, fix = this.fix) {
    return new RangeError(`${this.what} ${problem}; ${fix}`);
  }
  need(n) {
    if (this.at + n > this.bytes.length) throw this.fail(`is truncated at byte ${this.at} of ${this.bytes.length}`);
  }
  u8() {
    this.need(1);
    return this.bytes[this.at++];
  }
  u16() {
    this.need(2);
    this.at += 2;
    return this.view.getUint16(this.at - 2, true);
  }
  u32() {
    this.need(4);
    this.at += 4;
    return this.view.getUint32(this.at - 4, true);
  }
  f32() {
    this.need(4);
    this.at += 4;
    return this.view.getFloat32(this.at - 4, true);
  }
  varint() {
    const bytes = this.bytes;
    let value = 0,
      scale = 1;
    for (let n = 0; ; n++, scale *= 128) {
      if (this.at >= bytes.length) this.need(1);
      const b = bytes[this.at++];
      if (n === 4 && b > 15) throw this.fail(`has a varint wider than 32 bits at byte ${this.at - 1}`);
      value += (b & 127) * scale;
      if (b < 128) return value;
    }
  }
  end() {
    if (this.at !== this.bytes.length) throw this.fail(`has ${this.bytes.length - this.at} bytes past its end`);
  }
}

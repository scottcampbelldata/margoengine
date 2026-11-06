// glTF meshopt bufferView decoding, written from the KHR_meshopt_compression and EXT_meshopt_compression extension
// specifications (Appendix A "Bitstream", Appendix B "Filters", Appendix C "Differences"). Covers the attribute codec
// in versions 0 and 1, the triangle and index-sequence codecs, and the OCTAHEDRAL, QUATERNION, EXPONENTIAL and COLOR
// filters. Synchronous, dependency-free, and every read is bounds checked before it happens.
import { decodeFailed } from './errors.js';
import { meshoptMostElements } from './meshopt-limit.js';

const PREFIX = 'EXT_meshopt_compression: ';
const fail = (message: string): never => {
  throw decodeFailed(PREFIX + message);
};
const failRange = (message: string): never => {
  throw new RangeError(PREFIX + message);
};

// ------------------------------------------------------------------------------------------------ attribute codec

/** Largest number of bytes one 16-element group can occupy: 8 bytes of 4-bit codes plus 16 escape bytes. */
const GROUP_MAX_BYTES = 24;

/**
 * Bits per delta for each 2-bit group header. 8 means the group stores 16 raw delta bytes; 0 means all deltas are 0.
 * Version 0 has one table; version 1 picks one of two per byte lane through the block's control header.
 */
const WIDTHS_V0 = [0, 2, 4, 8];
const WIDTHS_V1 = [
  [0, 1, 2, 4],
  [1, 2, 4, 8],
];

/**
 * Reads one group of 16 deltas of `bits` bits each at `pos` into `out[at..at+16]`. Values with every bit set are
 * escapes: their real value is the next byte after the packed codes. Returns the position after the group.
 */
function readGroup(src: Uint8Array, pos: number, bits: number, out: Uint8Array, at: number): number {
  if (bits === 0) {
    out.fill(0, at, at + 16);
    return pos;
  }
  if (bits === 8) {
    for (let i = 0; i < 16; i++) out[at + i] = src[pos + i];
    return pos + 16;
  }
  let escape = pos + bits * 2;
  if (bits === 1) {
    // Least significant bit first, 8 deltas per byte.
    for (let i = 0; i < 16; i++) {
      const v = (src[pos + (i >> 3)] >> (i & 7)) & 1;
      out[at + i] = v === 1 ? src[escape++] : 0;
    }
  } else if (bits === 2) {
    // Most significant pair first, 4 deltas per byte.
    for (let i = 0; i < 16; i++) {
      const v = (src[pos + (i >> 2)] >> (6 - 2 * (i & 3))) & 3;
      out[at + i] = v === 3 ? src[escape++] : v;
    }
  } else {
    // High nibble first, 2 deltas per byte.
    for (let i = 0; i < 16; i++) {
      const v = (src[pos + (i >> 1)] >> (4 - 4 * (i & 1))) & 15;
      out[at + i] = v === 15 ? src[escape++] : v;
    }
  }
  return escape;
}

/** Zigzag decoding at 8, 16 and 32 bits: the low bit is the sign. */
const unzig8 = (v: number): number => (v & 1 ? ~(v >> 1) : v >> 1) & 0xff;
const unzig16 = (v: number): number => (v & 1 ? ~(v >> 1) : v >> 1) & 0xffff;

/**
 * Decodes an attribute stream (codec version 0 or 1) into `target`: `count` elements of `size` bytes, interleaved.
 * Filters are not applied here.
 */
export function meshoptDecodeVertexBuffer(target: Uint8Array, count: number, size: number, src: Uint8Array): void {
  if (!Number.isInteger(size) || size < 1 || size > 256 || size % 4 !== 0)
    fail(`invalid ATTRIBUTES byteStride ${size}`);
  if (!Number.isSafeInteger(count) || count < 0 || target.length < count * size)
    failRange('invalid count or output size');
  const length = src.length;
  if (length < 1 + size) fail('truncated vertex stream');
  const header = src[0];
  if (header >> 4 !== 0xa) fail('bad vertex stream header');
  const version = header & 15;
  if (version > 1) fail(`vertex codec version ${version} is not supported (only versions 0 and 1)`);
  const channels = size >> 2;
  const v1 = version === 1;
  if (v1 && length < 1 + size + channels) fail('truncated vertex stream');
  const tailSize = v1 ? Math.max(24, size + channels) : Math.max(32, size);
  const baselineAt = length - size - (v1 ? channels : 0);
  const modesAt = length - channels;

  // The running value of every byte of the element, starting from the tail's baseline element.
  const prev = new Uint8Array(size);
  for (let i = 0; i < size; i++) prev[i] = src[baselineAt + i];

  const blockMax = Math.min(Math.floor(8192 / size) & ~15, 256);
  // Deltas for one block, one 256-byte row per byte lane.
  const lanes = new Uint8Array(size * 256);
  let pos = 1;
  let checkedModes = false;

  for (let start = 0; start < count; start += blockMax) {
    const n = Math.min(count - start, blockMax);
    const groups = (n + 15) >> 4;
    let controlAt = 0;
    if (v1) {
      if (pos + channels > length) fail('truncated vertex stream');
      controlAt = pos;
      pos += channels;
    }
    for (let lane = 0; lane < size; lane++) {
      const row = lane * 256;
      let widths = WIDTHS_V0;
      if (v1) {
        const control = (src[controlAt + (lane >> 2)] >> ((lane & 3) * 2)) & 3;
        if (control === 2) {
          lanes.fill(0, row, row + groups * 16);
          continue;
        }
        if (control === 3) {
          // Literal lane: one raw delta byte per element, no group headers.
          if (length - pos < n + GROUP_MAX_BYTES) fail('truncated vertex stream');
          for (let i = 0; i < n; i++) lanes[row + i] = src[pos + i];
          pos += n;
          continue;
        }
        widths = WIDTHS_V1[control];
      }
      const headerBytes = (groups + 3) >> 2;
      if (pos + headerBytes > length) fail('truncated vertex stream');
      const headerAt = pos;
      pos += headerBytes;
      for (let g = 0; g < groups; g++) {
        if (length - pos < GROUP_MAX_BYTES) fail('truncated vertex stream');
        const code = (src[headerAt + (g >> 2)] >> ((g & 3) * 2)) & 3;
        pos = readGroup(src, pos, widths[code], lanes, row + g * 16);
      }
    }

    // Channel modes live in the tail; check them once, after the first block shows the data is all there.
    if (v1 && !checkedModes) {
      for (let c = 0; c < channels; c++) if ((src[modesAt + c] & 3) === 3) fail('invalid vertex channel mode');
      checkedModes = true;
    }

    for (let i = 0; i < n; i++) {
      const out = (start + i) * size;
      for (let c = 0; c < channels; c++) {
        const b = c * 4;
        const mode = v1 ? src[modesAt + c] : 0;
        const kind = mode & 3;
        if (kind === 0) {
          for (let k = b; k < b + 4; k++) {
            const v = (prev[k] + unzig8(lanes[k * 256 + i])) & 0xff;
            prev[k] = v;
            target[out + k] = v;
          }
        } else if (kind === 1) {
          for (let k = b; k < b + 4; k += 2) {
            const delta = unzig16(lanes[k * 256 + i] | (lanes[(k + 1) * 256 + i] << 8));
            const v = (prev[k] + (prev[k + 1] << 8) + delta) & 0xffff;
            prev[k] = v & 0xff;
            prev[k + 1] = v >> 8;
            target[out + k] = v & 0xff;
            target[out + k + 1] = v >> 8;
          }
        } else {
          // 32-bit XOR delta, stored rotated left by the high nibble; rotate it back right.
          const r = mode >> 4;
          const d =
            (lanes[b * 256 + i] |
              (lanes[(b + 1) * 256 + i] << 8) |
              (lanes[(b + 2) * 256 + i] << 16) |
              (lanes[(b + 3) * 256 + i] << 24)) >>>
            0;
          const x = (d >>> r) | (d << ((32 - r) & 31));
          for (let k = 0; k < 4; k++) {
            const v = prev[b + k] ^ ((x >>> (8 * k)) & 0xff);
            prev[b + k] = v;
            target[out + b + k] = v;
          }
        }
      }
    }
  }
  if (length - pos !== tailSize) fail('vertex stream has trailing or missing data');
}

// ------------------------------------------------------------------------------------------------ index codecs

/** Reads an unsigned LEB128 value of at most 5 bytes at `state.pos` (32-bit wraparound). */
function readVarint(src: Uint8Array, state: { pos: number }): number {
  let value = 0;
  let shift = 0;
  let pos = state.pos;
  for (let i = 0; i < 5; i++) {
    const byte = src[pos++];
    value |= (byte & 127) << shift;
    shift += 7;
    if (byte < 128) break;
  }
  state.pos = pos;
  return value >>> 0;
}

function checkIndexOutput(out: Uint32Array | Uint16Array, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || out.length < count) failRange('invalid count or output size');
}

/**
 * Decodes a triangle-list stream (index codec version 0 or 1) into `out`: `count` indices, a multiple of 3.
 * A 16-bit output keeps the low 16 bits of each index.
 */
export function meshoptDecodeIndexBuffer(out: Uint32Array | Uint16Array, count: number, src: Uint8Array): void {
  checkIndexOutput(out, count);
  if (count % 3 !== 0) fail('TRIANGLES count must be a multiple of 3');
  const triangles = count / 3;
  const length = src.length;
  if (length < 1 + triangles + 16) fail('truncated index stream');
  const header = src[0];
  if (header >> 4 !== 0xe) fail('bad index stream header');
  const version = header & 15;
  if (version > 1) fail(`index codec version ${version} is not supported`);
  // Version 1 adds the "last - 1" and "last + 1" codes 13 and 14; version 0 reads the vertex FIFO there instead.
  const fifoLimit = version === 1 ? 13 : 15;

  const tail = length - 16;
  // FIFOs start filled with all ones: a slot read before it was written yields 0xffffffff (0xffff in 16 bits).
  const edgeA = new Uint32Array(16).fill(0xffffffff);
  const edgeB = new Uint32Array(16).fill(0xffffffff);
  const verts = new Uint32Array(16).fill(0xffffffff);
  let edgeHead = 0;
  let vertHead = 0;
  const pushEdge = (a: number, b: number): void => {
    edgeA[edgeHead] = a;
    edgeB[edgeHead] = b;
    edgeHead = (edgeHead + 1) & 15;
  };
  const pushVertex = (v: number): void => {
    verts[vertHead] = v;
    vertHead = (vertHead + 1) & 15;
  };
  // Index 0 is the most recent entry.
  const vertex = (i: number): number => verts[(vertHead - 1 - i) & 15];

  let next = 0;
  let last = 0;
  const data = { pos: 1 + triangles };
  const explicit = (): number => {
    const v = readVarint(src, data);
    last = (last + (v & 1 ? ~(v >>> 1) : v >>> 1)) >>> 0;
    return last;
  };

  for (let t = 0; t < triangles; t++) {
    if (data.pos > tail) fail('truncated index stream');
    const code = src[1 + t];
    const hi = code >> 4;
    const lo = code & 15;
    let a: number;
    let b: number;
    let c: number;
    if (hi < 15) {
      // An edge from the FIFO plus one more vertex.
      const e = (edgeHead - 1 - hi) & 15;
      a = edgeA[e];
      b = edgeB[e];
      if (lo === 0) {
        c = next;
        next = (next + 1) >>> 0;
        pushVertex(c);
      } else if (lo < fifoLimit) {
        c = vertex(lo);
      } else if (lo < 15) {
        c = (lo === 13 ? last - 1 : last + 1) >>> 0;
        last = c;
        pushVertex(c);
      } else {
        c = explicit();
        pushVertex(c);
      }
      pushEdge(c, b);
      pushEdge(a, c);
    } else {
      let z: number;
      let w: number;
      if (lo < 14) {
        // Three vertices described by one codeaux byte.
        const aux = src[tail + lo];
        z = aux >> 4;
        w = aux & 15;
        a = next;
        next = (next + 1) >>> 0;
      } else {
        const aux = src[data.pos++];
        if (aux === 0) next = 0;
        z = aux >> 4;
        w = aux & 15;
        if (lo === 14) {
          a = next;
          next = (next + 1) >>> 0;
        } else a = explicit();
      }
      if (z === 0) {
        b = next;
        next = (next + 1) >>> 0;
      } else b = z < 15 ? vertex(z - 1) : explicit();
      if (w === 0) {
        c = next;
        next = (next + 1) >>> 0;
      } else c = w < 15 ? vertex(w - 1) : explicit();
      pushEdge(b, a);
      pushEdge(c, b);
      pushEdge(a, c);
      pushVertex(a);
      if (z === 0 || z === 15) pushVertex(b);
      if (w === 0 || w === 15) pushVertex(c);
    }
    out[t * 3] = a;
    out[t * 3 + 1] = b;
    out[t * 3 + 2] = c;
  }
  if (data.pos !== tail) fail('index stream has trailing or missing data');
}

/**
 * Decodes an index-sequence stream (mode INDICES, version 0 or 1) into `out`: `count` indices, each a zigzag delta
 * against one of two running baselines. A 16-bit output keeps the low 16 bits.
 */
export function meshoptDecodeIndexSequence(out: Uint32Array | Uint16Array, count: number, src: Uint8Array): void {
  checkIndexOutput(out, count);
  const length = src.length;
  if (length < 1 + count + 4) fail('truncated index sequence');
  const header = src[0];
  if (header >> 4 !== 0xd) fail('bad index sequence header');
  const version = header & 15;
  if (version > 1) fail(`index sequence version ${version} is not supported`);
  const tail = length - 4;
  const baselines = [0, 0];
  const data = { pos: 1 };
  for (let i = 0; i < count; i++) {
    if (data.pos >= tail) fail('truncated index sequence');
    const v = readVarint(src, data);
    const which = v & 1;
    const value = (baselines[which] + (v & 2 ? ~(v >>> 2) : v >>> 2)) >>> 0;
    baselines[which] = value;
    out[i] = value;
  }
  if (data.pos !== tail) fail('index sequence has trailing or missing data');
}

// ------------------------------------------------------------------------------------------------ filters

const f32 = Math.fround;
/** 1.5 * 2^23: adding it to a float32 below 2^22 in magnitude leaves the value rounded half to even in the low bits. */
const ROUND_BIAS = 12582912;
const roundEven = (v: number): number => f32(v + ROUND_BIAS) - ROUND_BIAS;
const bitsScratch = new Float32Array(1);
const bitsView = new Uint32Array(bitsScratch.buffer);
/** The low bits of the float32 pattern of `v + 1.5 * 2^23`, which wrap for values outside the output range. */
const roundBits = (v: number): number => {
  bitsScratch[0] = v + ROUND_BIAS;
  return bitsView[0];
};
/** 32767 / sqrt(2) in float32: the largest magnitude of the three stored quaternion components. */
const QUAT_RANGE = f32(32767 / Math.SQRT2);

function octahedral(view: DataView, count: number, stride: number): void {
  const wide = stride === 8;
  const max = wide ? 32767 : 127;
  const step = wide ? 2 : 1;
  const get = wide ? (o: number) => view.getInt16(o, true) : (o: number) => view.getInt8(o);
  const set = wide ? (o: number, v: number) => view.setInt16(o, v, true) : (o: number, v: number) => view.setInt8(o, v);
  for (let i = 0, o = 0; i < count; i++, o += stride) {
    let x = get(o);
    let y = get(o + step);
    const one = get(o + 2 * step);
    const z = one - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      // Fold the lower hemisphere back: move x and y toward zero by |z|.
      x += x >= 0 ? z : -z;
      y += y >= 0 ? z : -z;
    }
    const lengthSq = f32(f32(x * x) + f32(f32(y * y) + f32(z * z)));
    if (lengthSq === 0) {
      set(o, 0);
      set(o + step, 0);
      set(o + 2 * step, 0);
      continue;
    }
    const scale = f32(max / f32(Math.sqrt(lengthSq)));
    set(o, roundEven(f32(x * scale)));
    set(o + step, roundEven(f32(y * scale)));
    set(o + 2 * step, roundEven(f32(z * scale)));
  }
}

function quaternion(view: DataView, count: number): void {
  for (let i = 0, o = 0; i < count; i++, o += 8) {
    const x = view.getInt16(o, true);
    const y = view.getInt16(o + 2, true);
    const z = view.getInt16(o + 4, true);
    const packed = view.getInt16(o + 6, true);
    const largest = packed & 3;
    const one = packed | 3;
    const wSq = f32(f32(2 * f32(one * one)) - f32(f32(x * x) + f32(f32(y * y) + f32(z * z))));
    const w = f32(Math.sqrt(Math.max(wSq, 0)));
    const scale = f32(QUAT_RANGE / one);
    view.setInt16(o + ((largest + 1) & 3) * 2, roundEven(f32(x * scale)), true);
    view.setInt16(o + ((largest + 2) & 3) * 2, roundEven(f32(y * scale)), true);
    view.setInt16(o + ((largest + 3) & 3) * 2, roundEven(f32(z * scale)), true);
    view.setInt16(o + largest * 2, roundEven(f32(w * scale)), true);
  }
}

function exponential(view: DataView, words: number): void {
  for (let i = 0, o = 0; i < words; i++, o += 4) {
    const v = view.getInt32(o, true);
    // m * 2^e is exact in float64 for every 8-bit e and 24-bit m, so this rounds once, to float32.
    view.setFloat32(o, ((v << 8) >> 8) * 2 ** (v >> 24), true);
  }
}

function color(view: DataView, count: number, stride: number): void {
  const wide = stride === 8;
  const max = wide ? 65535 : 255;
  const keep = wide ? 0xffff : 0xff;
  const step = wide ? 2 : 1;
  const getU = wide ? (o: number) => view.getUint16(o, true) : (o: number) => view.getUint8(o);
  const getS = wide ? (o: number) => view.getInt16(o, true) : (o: number) => view.getInt8(o);
  const set = wide
    ? (o: number, v: number) => view.setUint16(o, v, true)
    : (o: number, v: number) => view.setUint8(o, v);
  for (let i = 0, o = 0; i < count; i++, o += stride) {
    const luma = getU(o);
    const co = getS(o + step);
    const cg = getS(o + 2 * step);
    const alpha = getU(o + 3 * step);
    // Every bit at or below alpha's highest set bit; its top bit marks the precision K.
    const mask = alpha === 0 ? 0 : 2 ** (32 - Math.clz32(alpha)) - 1;
    const scale = f32(max / mask);
    const r = luma + co - cg;
    const g = luma + cg;
    const b = luma - co - cg;
    const a = ((alpha << 1) & mask) | (alpha & 1);
    set(o, roundBits(f32(r * scale)) & keep);
    set(o + step, roundBits(f32(g * scale)) & keep);
    set(o + 2 * step, roundBits(f32(b * scale)) & keep);
    set(o + 3 * step, roundBits(f32(a * scale)) & keep);
  }
}

function applyFilter(out: Uint8Array, count: number, stride: number, filter: string): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  switch (filter) {
    case 'OCTAHEDRAL':
      if (stride !== 4 && stride !== 8) fail('OCTAHEDRAL filter requires byteStride 4 or 8');
      octahedral(view, count, stride);
      return;
    case 'QUATERNION':
      if (stride !== 8) fail('QUATERNION filter requires byteStride 8');
      quaternion(view, count);
      return;
    case 'EXPONENTIAL':
      exponential(view, (count * stride) >> 2);
      return;
    case 'COLOR':
      if (stride !== 4 && stride !== 8) fail('COLOR filter requires byteStride 4 or 8');
      color(view, count, stride);
      return;
    default:
      fail(`unknown filter '${filter}'`);
  }
}

// ------------------------------------------------------------------------------------------------ glTF entry points

/**
 * Decodes one glTF meshopt bufferView payload (`EXT_meshopt_compression` or `KHR_meshopt_compression`) and returns
 * `count * stride` bytes. `mode` is `'ATTRIBUTES'`, `'TRIANGLES'` or `'INDICES'`; `filter` is `'NONE'` (also `''`),
 * `'OCTAHEDRAL'`, `'QUATERNION'`, `'EXPONENTIAL'` or `'COLOR'`. Both attribute codec versions are accepted under either
 * extension name.
 *
 * @throws RangeError for a bad count or stride, or a count the stream is too short to describe (checked before the
 * output is allocated); Error for a malformed, truncated or over-long stream, a bad stride for the mode or filter, or
 * an unknown mode or filter. Every message starts with `EXT_meshopt_compression: `.
 */
export function meshoptDecodeGltfBuffer(
  src: Uint8Array,
  count: number,
  stride: number,
  mode: string,
  filter = 'NONE',
): Uint8Array {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(stride) ||
    stride <= 0 ||
    count * stride > 2 ** 31
  )
    failRange('invalid count or byteStride');
  const length = src.length;
  if (count > meshoptMostElements(mode, length, stride)) failRange(`truncated stream (${count} elements cannot fit in ${length} bytes)`);

  let out: Uint8Array;
  if (mode === 'ATTRIBUTES') {
    out = new Uint8Array(count * stride);
    meshoptDecodeVertexBuffer(out, count, stride, src);
  } else if (mode === 'TRIANGLES' || mode === 'INDICES') {
    if (stride !== 2 && stride !== 4) fail(`${mode} byteStride must be 2 or 4`);
    out = new Uint8Array(count * stride);
    const indices = stride === 2 ? new Uint16Array(out.buffer, 0, count) : new Uint32Array(out.buffer, 0, count);
    if (mode === 'TRIANGLES') meshoptDecodeIndexBuffer(indices, count, src);
    else meshoptDecodeIndexSequence(indices, count, src);
  } else return fail(`unknown mode '${mode}'`);

  if (filter && filter !== 'NONE') {
    if (mode !== 'ATTRIBUTES') fail('filters only apply to ATTRIBUTES');
    applyFilter(out, count, stride, filter);
  }
  return out;
}

/**
 * An object with the members of the meshoptimizer project's own `MeshoptDecoder` (`supported`, `ready`,
 * `decodeGltfBuffer`), so glTF loaders written against that interface work unchanged. Decoding is synchronous.
 */
export const MeshoptDecoder = {
  /** Always true: the decoder is plain TypeScript. */
  supported: true,
  /** Already resolved; there is nothing to load. */
  ready: Promise.resolve(),
  /**
   * Decodes into `target`, which needs at least `count * stride` bytes. Throws what {@link meshoptDecodeGltfBuffer}
   * throws, then a RangeError when `target` is too small.
   */
  decodeGltfBuffer(
    target: Uint8Array,
    count: number,
    stride: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ): void {
    const decoded = meshoptDecodeGltfBuffer(source, count, stride, mode, filter);
    if (target.byteLength < count * stride) failRange('target buffer is too small');
    target.set(decoded);
  },
};

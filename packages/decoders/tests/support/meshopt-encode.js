// A small meshopt bitstream encoder for tests and proofs (not shipped). Written from the KHR_meshopt_compression and
// EXT_meshopt_compression specifications (Appendix A: bitstream, Appendix B: filters): attribute streams (codec version
// 0 and 1), triangle streams, index sequences, and the OCTAHEDRAL, QUATERNION, EXPONENTIAL and COLOR filter inputs.
// It aims to be correct and readable, not to give the smallest output.

const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

// ---------------------------------------------------------------------------------------------------------------
// Mode 0: attributes

const zigzag8 = (d) => ((d << 1) ^ (d >> 7)) & 0xff; // d is a signed 8-bit delta
const zigzag16 = (d) => ((d << 1) ^ (d >> 15)) & 0xffff; // d is a signed 16-bit delta
const rotl32 = (v, r) => ((v << r) | (v >>> ((32 - r) & 31))) >>> 0;

// Bytes needed to store 16 deltas at a sentinel width of `bits` (1, 2 or 4): the packed codes plus one full byte for
// each delta at or above the sentinel. 0 means all deltas must be zero; 8 is the 16 raw bytes.
function groupCost(deltas, at, bits) {
  if (bits === 0) {
    for (let i = 0; i < 16; i++) if (deltas[at + i] !== 0) return Number.POSITIVE_INFINITY;
    return 0;
  }
  if (bits === 8) return 16;
  const sentinel = (1 << bits) - 1;
  let size = 2 * bits;
  for (let i = 0; i < 16; i++) if (deltas[at + i] >= sentinel) size++;
  return size;
}

function writeGroup(out, deltas, at, bits) {
  if (bits === 0) return;
  if (bits === 8) {
    for (let i = 0; i < 16; i++) out.push(deltas[at + i]);
    return;
  }
  const sentinel = (1 << bits) - 1,
    perByte = 8 / bits,
    extra = [];
  for (let byte = 0; byte < 2 * bits; byte++) {
    let packed = 0;
    for (let k = 0; k < perByte; k++) {
      const delta = deltas[at + byte * perByte + k],
        code = delta >= sentinel ? sentinel : delta;
      if (code === sentinel) extra.push(delta);
      // 1-bit codes fill from the least significant bit; 2- and 4-bit codes from the most significant.
      packed |= bits === 1 ? code << k : code << (8 - bits * (k + 1));
    }
    out.push(packed);
  }
  for (const delta of extra) out.push(delta);
}

// The four sentinel widths a 2-bit group header selects, per header table.
const WIDTHS_V0 = [0, 2, 4, 8];
const WIDTHS_V1 = [
  [0, 1, 2, 4], // control 0
  [1, 2, 4, 8], // control 1
];

// One byte lane of one block: the cheapest header-bit choice for each group, and its encoded size.
function planLane(deltas, groups, widths) {
  const choice = new Uint8Array(groups);
  let size = Math.ceil(groups / 4);
  for (let g = 0; g < groups; g++) {
    let best = 0,
      bestCost = Number.POSITIVE_INFINITY;
    for (let h = 0; h < 4; h++) {
      const cost = groupCost(deltas, g * 16, widths[h]);
      if (cost < bestCost) {
        best = h;
        bestCost = cost;
      }
    }
    choice[g] = best;
    size += bestCost;
  }
  return { choice, size };
}

function writeLane(out, deltas, groups, widths, choice) {
  for (let g = 0; g < groups; g += 4) {
    let header = 0;
    for (let k = 0; k < 4 && g + k < groups; k++) header |= choice[g + k] << (2 * k);
    out.push(header);
  }
  for (let g = 0; g < groups; g++) writeGroup(out, deltas, g * 16, widths[choice[g]]);
}

// The stored delta bytes of one lane (byte position) for `n` elements starting at element `first`, under the channel
// mode of the lane's 4-byte channel. Padding elements of the last group get zero deltas.
function laneDeltas(data, stride, first, n, previous, lane, channel, groups) {
  const deltas = new Uint8Array(groups * 16),
    base = lane & ~3,
    within = lane & 3;
  const read8 = (element) => (element < 0 ? previous[lane] : data[element * stride + lane]);
  const read16 = (element) => {
    const at = base + (within & 2);
    return element < 0
      ? previous[at] | (previous[at + 1] << 8)
      : data[element * stride + at] | (data[element * stride + at + 1] << 8);
  };
  const read32 = (element) => {
    const src = element < 0 ? previous : data,
      at = element < 0 ? base : element * stride + base;
    return (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;
  };
  for (let i = 0; i < n; i++) {
    const element = first + i,
      before = i === 0 ? -1 : element - 1;
    if (channel.mode === 0) deltas[i] = zigzag8(((read8(element) - read8(before)) << 24) >> 24);
    else if (channel.mode === 1) {
      const value = zigzag16(((read16(element) - read16(before)) << 16) >> 16);
      deltas[i] = (within & 1 ? value >> 8 : value) & 0xff;
    } else {
      const value = rotl32((read32(element) ^ read32(before)) >>> 0, channel.rotation);
      deltas[i] = (value >>> (8 * within)) & 0xff;
    }
  }
  return deltas;
}

function blockLimit(stride) {
  return Math.min(Math.floor(8192 / stride) & ~15, 256);
}

// Encodes the blocks of the whole stream and returns the bytes, for a given channel mode per 4-byte channel.
function encodeBlocks(data, count, stride, version, channels) {
  const out = [],
    limit = blockLimit(stride),
    previous = new Uint8Array(stride);
  if (count > 0) previous.set(data.subarray(0, stride)); // the baseline in the tail block is the first element
  for (let first = 0; first < count; first += limit) {
    const n = Math.min(limit, count - first),
      groups = Math.ceil(n / 16),
      lanes = [];
    for (let lane = 0; lane < stride; lane++) {
      const deltas = laneDeltas(data, stride, first, n, previous, lane, channels[lane >> 2], groups);
      if (version === 0) lanes.push({ deltas, widths: WIDTHS_V0, ...planLane(deltas, groups, WIDTHS_V0) });
      else {
        let best = { control: 2, size: 0, deltas };
        if (deltas.some((d) => d !== 0)) {
          best = { control: 3, size: n, deltas };
          for (const control of [0, 1]) {
            const plan = planLane(deltas, groups, WIDTHS_V1[control]);
            if (plan.size < best.size) best = { control, deltas, widths: WIDTHS_V1[control], ...plan };
          }
        }
        lanes.push(best);
      }
    }
    if (version === 1)
      for (let lane = 0; lane < stride; lane += 4) {
        let control = 0;
        for (let k = 0; k < 4; k++) control |= lanes[lane + k].control << (2 * k);
        out.push(control);
      }
    for (const lane of lanes) {
      if (version === 1 && lane.control === 2) continue;
      if (version === 1 && lane.control === 3) for (let i = 0; i < n; i++) out.push(lane.deltas[i]);
      else writeLane(out, lane.deltas, groups, lane.widths, lane.choice);
    }
    previous.set(data.subarray((first + n - 1) * stride, (first + n) * stride));
  }
  return out;
}

/**
 * Encodes `count` elements of `stride` bytes as a mode 0 (ATTRIBUTES) stream.
 *
 * @param {Uint8Array | ArrayBufferView} data `count * stride` bytes.
 * @param {number} count Number of elements.
 * @param {number} stride Element size in bytes: a multiple of 4 from 4 to 256.
 * @param {{ version?: 0 | 1, channels?: { mode: 0 | 1 | 2, rotation?: number }[] }} [options] Codec version (default
 * 0, the EXT_meshopt_compression format). Version 1 also picks a channel mode for every 4-byte channel (byte, 16-bit or
 * rotated 32-bit XOR deltas), whichever is smallest, unless `channels` fixes them.
 * @returns {Uint8Array} The encoded stream.
 */
export function encodeAttributes(data, count, stride, { version = 0, channels: fixed } = {}) {
  const bytes = data instanceof Uint8Array ? data : bytesOf(data);
  if (!Number.isInteger(stride) || stride < 4 || stride > 256 || stride % 4)
    throw new RangeError(`encodeAttributes: stride ${stride} must be a multiple of 4 from 4 to 256`);
  if (!Number.isInteger(count) || count < 0 || bytes.length < count * stride)
    throw new RangeError(`encodeAttributes: pass at least count * stride (${count * stride}) bytes`);
  if (version !== 0 && version !== 1) throw new RangeError(`encodeAttributes: version must be 0 or 1, not ${version}`);
  const channelCount = stride / 4;
  let channels = Array.from({ length: channelCount }, () => ({ mode: 0, rotation: 0 }));
  if (version === 1 && fixed) {
    if (fixed.length !== channelCount) throw new RangeError(`encodeAttributes: pass ${channelCount} channels`);
    channels = fixed.map((c) => ({ mode: c.mode, rotation: c.mode === 2 ? (c.rotation ?? 0) : 0 }));
    for (const c of channels)
      if (![0, 1, 2].includes(c.mode) || !Number.isInteger(c.rotation) || c.rotation < 0 || c.rotation > 15)
        throw new RangeError('encodeAttributes: channel mode must be 0, 1 or 2 and rotation an integer from 0 to 15');
  } else if (version === 1) {
    // Choose each channel's mode by the size of its four lanes, trying the others with the rest held at mode 0.
    const candidates = [
      { mode: 0, rotation: 0 },
      { mode: 1, rotation: 0 },
    ];
    for (let r = 0; r < 16; r++) candidates.push({ mode: 2, rotation: r });
    channels = channels.map((_, c) => {
      let best = candidates[0],
        bestSize = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const trial = channels.map((existing, k) => (k === c ? candidate : existing)),
          size = encodeBlocks(bytes, count, stride, 1, trial).length;
        if (size < bestSize) {
          best = candidate;
          bestSize = size;
        }
      }
      return best;
    });
  }
  const body = encodeBlocks(bytes, count, stride, version, channels),
    tail = stride + (version === 1 ? channelCount : 0),
    padding = Math.max(0, (version === 1 ? 24 : 32) - tail),
    out = new Uint8Array(1 + body.length + padding + tail);
  out[0] = version === 1 ? 0xa1 : 0xa0;
  out.set(body, 1);
  const at = 1 + body.length + padding;
  if (count > 0) out.set(bytes.subarray(0, stride), at);
  if (version === 1) channels.forEach((c, k) => (out[at + stride + k] = c.mode | (c.rotation << 4)));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Varints shared by modes 1 and 2

function pushVarint(out, value) {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

const zigzag32 = (d) => ((d << 1) ^ (d >> 31)) >>> 0; // d is a signed 32-bit delta

// ---------------------------------------------------------------------------------------------------------------
// Mode 1: triangles

// The lookup table stored at the end of every triangle stream: (Z, W) pairs for `0xfY` codes, where 0 means the
// next new vertex and n > 0 means vertex FIFO entry n - 1. The last two entries must be zero.
const PAIRS = [0x00, 0x01, 0x10, 0x02, 0x20, 0x12, 0x21, 0x11, 0x03, 0x30, 0x13, 0x31, 0x23, 0x32, 0x00, 0x00];

function freshState() {
  return { next: 0, last: 0, edges: [], vertices: [] };
}
const cloneState = (s) => ({ next: s.next, last: s.last, edges: s.edges.slice(), vertices: s.vertices.slice() });
const pushEdge = (s, a, b) => {
  s.edges.unshift([a, b]);
  if (s.edges.length > 16) s.edges.pop();
};
const pushVertex = (s, v) => {
  s.vertices.unshift(v);
  if (s.vertices.length > 16) s.vertices.pop();
};
const explicit = (s, data, v) => {
  pushVarint(data, zigzag32((v - s.last) | 0));
  s.last = v;
};

// Encodes one triangle against `s`, mutating it; returns the code byte and appends extra bytes to `data`.
function encodeTriangle(s, a, b, c, data) {
  const edge = s.edges.findIndex((e, i) => i < 15 && e[0] === a && e[1] === b);
  if (edge >= 0) {
    const fifo = s.vertices.indexOf(c);
    let low;
    if (c === s.next) {
      low = 0;
      s.next = (s.next + 1) >>> 0;
    } else if (fifo >= 1 && fifo <= 12) low = fifo;
    else if (c === (s.last - 1) >>> 0) low = 0xd;
    else if (c === (s.last + 1) >>> 0) low = 0xe;
    else {
      low = 0xf;
      explicit(s, data, c);
    }
    if (low === 0xd || low === 0xe) s.last = c;
    pushEdge(s, c, b);
    pushEdge(s, a, c);
    if (low === 0 || low >= 0xd) pushVertex(s, c);
    return (edge << 4) | low;
  }
  // No shared edge: the free-triangle codes. Vertex FIFO reads use the state before this triangle's pushes; a slot is
  // 0 for the next new vertex, n for FIFO entry n - 1, or 0xf for an index spelled out as a varint.
  const before = s.vertices.slice(),
    inFifo = (v) => {
      const i = before.indexOf(v);
      return i >= 0 && i < 14 ? i + 1 : 0xf;
    };
  if (a === s.next) {
    // Try a table code: a is new, b and c are new or in the FIFO, and their pair is in the table.
    const n = (s.next + 1) >>> 0,
      z = b === n ? 0 : inFifo(b),
      w = c === (z === 0 ? (n + 1) >>> 0 : n) ? 0 : inFifo(c),
      pair = PAIRS.findIndex((p, i) => i < 14 && p === ((z << 4) | w));
    if (z !== 0xf && w !== 0xf && pair >= 0) {
      s.next = (n + (z === 0) + (w === 0)) >>> 0;
      finishFree(s, a, b, c, z, w);
      return 0xf0 | pair;
    }
  }
  // Explicit codes: a data byte with the (Z, W) pair, then varints for a (0xff only), b and c as needed.
  const code = a === s.next ? 0xfe : 0xff,
    at = data.length;
  data.push(0);
  if (code === 0xfe) s.next = (s.next + 1) >>> 0;
  else explicit(s, data, a);
  const z = b === s.next ? 0 : inFifo(b);
  if (z === 0) s.next = (s.next + 1) >>> 0;
  else if (z === 0xf) explicit(s, data, b);
  let w = c === s.next ? 0 : inFifo(c);
  if (z === 0 && w === 0) w = 0xf; // a zero pair byte would reset `next`, so c is spelled out instead
  if (w === 0) s.next = (s.next + 1) >>> 0;
  else if (w === 0xf) explicit(s, data, c);
  data[at] = (z << 4) | w;
  finishFree(s, a, b, c, z, w);
  return code;
}

function finishFree(s, a, b, c, z, w) {
  pushEdge(s, b, a);
  pushEdge(s, c, b);
  pushEdge(s, a, c);
  pushVertex(s, a);
  if (z === 0 || z === 0xf) pushVertex(s, b);
  if (w === 0 || w === 0xf) pushVertex(s, c);
}

/**
 * Encodes a triangle list as a mode 1 (TRIANGLES) stream.
 *
 * @param {ArrayLike<number>} indices Triangle list, length divisible by 3.
 * @param {{ keepOrder?: boolean }} [options] By default each triangle may be rotated (same winding, different first
 * vertex) when that encodes smaller; `keepOrder: true` keeps every index in place.
 * @returns {Uint8Array} The encoded stream.
 */
export function encodeTriangles(indices, { keepOrder = false } = {}) {
  if (indices.length % 3) throw new RangeError(`encodeTriangles: index count ${indices.length} must be divisible by 3`);
  const codes = [],
    data = [];
  let state = freshState();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] >>> 0,
      b = indices[t + 1] >>> 0,
      c = indices[t + 2] >>> 0,
      rotations = keepOrder
        ? [[a, b, c]]
        : [
            [a, b, c],
            [b, c, a],
            [c, a, b],
          ];
    let best;
    for (const [x, y, z] of rotations) {
      const trial = cloneState(state),
        extra = [],
        code = encodeTriangle(trial, x, y, z, extra);
      if (!best || extra.length < best.extra.length) best = { trial, extra, code };
    }
    state = best.trial;
    codes.push(best.code);
    for (const byte of best.extra) data.push(byte);
  }
  const out = new Uint8Array(1 + codes.length + data.length + 16);
  out[0] = 0xe1;
  out.set(codes, 1);
  out.set(data, 1 + codes.length);
  out.set(PAIRS, 1 + codes.length + data.length);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Mode 2: indices

/**
 * Encodes any index list as a mode 2 (INDICES) stream, with each delta taken from whichever of the two baselines is
 * closer.
 *
 * @param {ArrayLike<number>} indices Index values (unsigned 32-bit).
 * @returns {Uint8Array} The encoded stream.
 */
export function encodeIndexSequence(indices) {
  const out = [0xd1],
    last = [0, 0];
  for (let i = 0; i < indices.length; i++) {
    const value = indices[i] >>> 0,
      deltas = [(value - last[0]) | 0, (value - last[1]) | 0],
      pick = Math.abs(deltas[1]) < Math.abs(deltas[0]) ? 1 : 0,
      delta = deltas[pick];
    if (delta < -(2 ** 30) || delta > 2 ** 30 - 1)
      throw new RangeError(`encodeIndexSequence: index ${value} is more than 2^30 away from both baselines`);
    pushVarint(out, ((zigzag32(delta) << 1) | pick) >>> 0);
    last[pick] = value;
  }
  out.push(0, 0, 0, 0);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------------------------
// Filters: each turns float data into the filter's input integers, ready for encodeAttributes.

const roundAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

function checkBits(name, bits, low, high) {
  if (!Number.isInteger(bits) || bits < low || bits > high)
    throw new RangeError(`${name}: bits must be an integer from ${low} to ${high}, not ${bits}`);
}

/**
 * OCTAHEDRAL filter input: unit vectors (x, y, z, w per element; w passes through as a signed normalised value) as
 * K-bit octahedral coordinates in 8-bit (stride 4) or 16-bit (stride 8) components.
 *
 * @param {ArrayLike<number>} vectors `count * 4` floats.
 * @param {number} count Number of vectors.
 * @param {4 | 8} stride Bytes per element.
 * @param {number} bits K, from 2 to the component width.
 * @returns {Uint8Array} `count * stride` bytes.
 */
export function octahedralFilter(vectors, count, stride, bits) {
  if (stride !== 4 && stride !== 8) throw new RangeError(`octahedralFilter: stride must be 4 or 8, not ${stride}`);
  checkBits('octahedralFilter', bits, 2, stride * 2);
  const out = stride === 4 ? new Int8Array(count * 4) : new Int16Array(count * 4),
    max = (1 << (bits - 1)) - 1,
    full = stride === 4 ? 127 : 32767;
  for (let i = 0; i < count; i++) {
    const x = vectors[i * 4],
      y = vectors[i * 4 + 1],
      z = vectors[i * 4 + 2],
      sum = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
    let u = x / sum,
      v = y / sum;
    if (z < 0) {
      // Fold the lower hemisphere over the diagonals; the decoder's fixup unfolds it.
      const fu = (1 - Math.abs(v)) * (u < 0 ? -1 : 1),
        fv = (1 - Math.abs(u)) * (v < 0 ? -1 : 1);
      u = fu;
      v = fv;
    }
    out[i * 4] = roundAway(u * max);
    out[i * 4 + 1] = roundAway(v * max);
    out[i * 4 + 2] = max;
    out[i * 4 + 3] = roundAway(Math.max(-1, Math.min(1, vectors[i * 4 + 3])) * full);
  }
  return bytesOf(out);
}

/**
 * QUATERNION filter input: unit quaternions (x, y, z, w per element) as three K-bit components plus the index of the
 * dropped largest one, in 16-bit components (stride 8).
 *
 * @param {ArrayLike<number>} quaternions `count * 4` floats.
 * @param {number} count Number of quaternions.
 * @param {number} bits K, from 4 to 16.
 * @returns {Uint8Array} `count * 8` bytes.
 */
export function quaternionFilter(quaternions, count, bits) {
  checkBits('quaternionFilter', bits, 4, 16);
  const out = new Int16Array(count * 4),
    max = (1 << (bits - 1)) - 1,
    scale = Math.SQRT2 * max;
  for (let i = 0; i < count; i++) {
    const q = [0, 1, 2, 3].map((k) => quaternions[i * 4 + k]),
      length = Math.hypot(...q) || 1;
    let largest = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[largest])) largest = k;
    const sign = q[largest] < 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) {
      const value = (sign * q[(largest + 1 + k) % 4]) / length;
      out[i * 4 + k] = Math.max(-max, Math.min(max, roundAway(value * scale)));
    }
    out[i * 4 + 3] = (max & ~3) | largest;
  }
  return bytesOf(out);
}

/**
 * EXPONENTIAL filter input: floats as 2^e * m with an 8-bit exponent and a mantissa of `bits` significant bits (plus
 * sign) in each 32-bit word. Exponents are clamped to [-100, 100].
 *
 * @param {ArrayLike<number>} values `count * stride / 4` floats.
 * @param {number} count Number of elements.
 * @param {number} stride Bytes per element, a multiple of 4.
 * @param {number} bits Mantissa bits, from 1 to 23.
 * @returns {Uint8Array} `count * stride` bytes.
 */
export function exponentialFilter(values, count, stride, bits) {
  if (!Number.isInteger(stride) || stride <= 0 || stride % 4)
    throw new RangeError(`exponentialFilter: stride must be a multiple of 4, not ${stride}`);
  checkBits('exponentialFilter', bits, 1, 23);
  const n = (count * stride) / 4,
    out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) throw new RangeError(`exponentialFilter: value ${i} is ${value}; pass finite floats`);
    let e = value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value))) + 1 - bits;
    e = Math.max(-100, Math.min(100, e));
    let m = roundAway(value / 2 ** e);
    // log2 can be off by one near powers of two, and rounding can carry: keep |m| within `bits` bits.
    while (Math.abs(m) >= 2 ** bits && e < 100) m = roundAway(value / 2 ** ++e);
    m = Math.max(-0x7fffff, Math.min(0x7fffff, m));
    out[i] = (e << 24) | (m & 0xffffff);
  }
  return bytesOf(out);
}

/**
 * The K-bit integers the COLOR filter stores for one colour: R, G, B (K bits) adjusted by at most one step so that
 * the YCoCg values are whole numbers, and alpha (K - 1 bits). Floats are clamped to [0, 1].
 *
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @param {number} bits K.
 * @returns {[number, number, number, number]} The integers the decoder reconstructs before rescaling.
 */
export function quantizeColor(r, g, b, a, bits) {
  const top = (1 << bits) - 1,
    q = (v, range) => Math.round(Math.max(0, Math.min(1, v)) * range),
    // Moves an integer by one step towards its unrounded value (or the other way at the range limit) to flip parity.
    nudge = (value, exact) => {
      const up = exact > value ? value + 1 : value - 1;
      return up < 0 || up > top ? 2 * value - up : up;
    };
  const R = q(r, top),
    G0 = q(g, top);
  let B = q(b, top);
  if ((R ^ B) & 1) B = nudge(B, Math.max(0, Math.min(1, b)) * top); // Co = (R - B) / 2
  let G = G0;
  if ((((R + B) >> 1) ^ G) & 1) G = nudge(G, Math.max(0, Math.min(1, g)) * top); // Cg = (G - (R + B) / 2) / 2
  return [R, G, B, q(a, (1 << (bits - 1)) - 1)];
}

/**
 * COLOR filter input: RGBA colours (floats in [0, 1]) as K-bit YCoCg plus a (K - 1)-bit alpha carrying the K marker
 * bit, in 8-bit (stride 4) or 16-bit (stride 8) components. See {@link quantizeColor} for the integers it stores.
 *
 * @param {ArrayLike<number>} colors `count * 4` floats.
 * @param {number} count Number of colours.
 * @param {4 | 8} stride Bytes per element.
 * @param {number} bits K, from 2 to the component width.
 * @returns {Uint8Array} `count * stride` bytes.
 */
export function colorFilter(colors, count, stride, bits) {
  if (stride !== 4 && stride !== 8) throw new RangeError(`colorFilter: stride must be 4 or 8, not ${stride}`);
  checkBits('colorFilter', bits, 2, stride * 2);
  const out = stride === 4 ? new Uint8Array(count * 4) : new Uint16Array(count * 4),
    mask = stride === 4 ? 0xff : 0xffff;
  for (let i = 0; i < count; i++) {
    const [R, G, B, A] = quantizeColor(colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2], colors[i * 4 + 3], bits),
      s = (R + B) >> 1;
    out[i * 4] = (s + G) >> 1; // Y
    out[i * 4 + 1] = ((R - B) >> 1) & mask; // Co, two's complement
    out[i * 4 + 2] = ((G - s) >> 1) & mask; // Cg, two's complement
    out[i * 4 + 3] = A | (1 << (bits - 1));
  }
  return bytesOf(out);
}

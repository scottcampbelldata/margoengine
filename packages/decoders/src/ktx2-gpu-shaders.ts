// Compute shaders and tables of `@margoengine/decoders/ktx2-gpu`, from the public UASTC LDR 4x4 and ETC1S specifications
// and the ASTC section of the Khronos Data Format specification. One invocation decodes one 4x4 block to RGBA8.

// Mode index by the low 7 bits of a block, as the UASTC specification lists it.
// prettier-ignore
const MODE_BY_BITS = [
  11, 0, 10, 3, 11, 15, 12, 7, 11, 18, 10, 5, 11, 14, 12, 9, 11, 0, 10, 4, 11, 16, 12, 8, 11, 18, 10, 6, 11, 2, 12, 13,
  11, 0, 10, 3, 11, 17, 12, 7, 11, 18, 10, 5, 11, 14, 12, 9, 11, 0, 10, 4, 11, 1, 12, 8, 11, 18, 10, 6, 11, 2, 12, 13,
  11, 0, 10, 3, 11, 19, 12, 7, 11, 18, 10, 5, 11, 14, 12, 9, 11, 0, 10, 4, 11, 16, 12, 8, 11, 18, 10, 6, 11, 2, 12, 13,
  11, 0, 10, 3, 11, 17, 12, 7, 11, 18, 10, 5, 11, 14, 12, 9, 11, 0, 10, 4, 11, 1, 12, 8, 11, 18, 10, 6, 11, 2, 12, 13,
];

// Each mode: where its partition or component field is, where its endpoints start, weight bits, subsets, components, planes.
const MODES: [number, number, number, number, number, number][] = [
  [0, 19, 4, 1, 3, 1],
  [0, 21, 2, 1, 3, 1],
  [20, 25, 3, 2, 3, 1],
  [20, 24, 2, 3, 3, 1],
  [20, 25, 2, 2, 3, 1],
  [0, 20, 3, 1, 3, 1],
  [20, 22, 2, 1, 3, 2],
  [20, 25, 2, 2, 3, 1],
  [0, 0, 0, 0, 4, 1],
  [28, 33, 2, 2, 4, 1],
  [0, 20, 4, 1, 4, 1],
  [19, 21, 2, 1, 4, 2],
  [0, 20, 3, 1, 4, 1],
  [28, 30, 1, 1, 4, 2],
  [0, 28, 2, 1, 4, 1],
  [0, 30, 4, 1, 2, 1],
  [29, 34, 2, 2, 2, 1],
  [0, 29, 2, 1, 2, 2],
  [0, 19, 5, 1, 3, 1],
];

// Endpoint range of each mode, as [plain bits, kind]: kind 0 plain, 1 trits, 2 quints.
// prettier-ignore
const RANGES: [number, number][] = [
  [6, 1], [8, 0], [4, 0], [2, 1], [3, 2], [8, 0], [5, 2], [3, 2], [8, 0], [4, 0], [4, 1], [4, 1], [6, 1], [8, 0], [8, 0],
  [8, 0], [8, 0], [8, 0], [5, 0],
];

// Subset of each texel at 2 bits a texel: 30 two-subset patterns, 11 three-subset patterns, then the 19 of mode 7.
// prettier-ignore
const PATTERNS = [
  0x50505050, 0x40404040, 0x1010101, 0x54505040, 0x5151555, 0x55545450,
  0x10515, 0x1051555, 0x50400000, 0x105, 0x55544000, 0x1155555,
  0x115, 0x5555, 0x55555500, 0x555555, 0x55551501, 0x40545555,
  0x405054, 0x4050, 0x15050100, 0x50545555, 0x15050501, 0x404050,
  0x50545455, 0x14141414, 0x55000055, 0x11111111, 0x550055, 0x5145041,
  0xa5a50000, 0xaa005555, 0xaa000055, 0xaa55, 0x25252525, 0x94949494,
  0x58585858, 0x56560202, 0x92929292, 0x55aa0055, 0xa05050a0, 0x5500,
  0x10101010, 0x10505, 0x50504000, 0x55005555, 0x4040404, 0x55555040,
  0x50505054, 0x5500005, 0x5454, 0x15150000, 0x5000005, 0x5054,
  0x55554000, 0x14555555, 0x1050505, 0x1015555, 0x1051450, 0x5455,
];

// The texels whose weights are stored one bit short, one byte per subset, 255 for none.
// prettier-ignore
const ANCHORS = [
  0xff0200, 0xff0300, 0xff0001, 0xff0300, 0xff0007, 0xff0200, 0xff0003, 0xff0007,
  0xff0b00, 0xff0002, 0xff0700, 0xff000b, 0xff0003, 0xff0008, 0xff0400, 0xff000c,
  0xff0001, 0xff0008, 0xff0100, 0xff0200, 0xff0400, 0xff0008, 0xff0001, 0xff0200,
  0xff0004, 0xff0100, 0xff0004, 0xff0001, 0xff0004, 0xff0001, 0xa0800, 0xc0008,
  0xc0004, 0x40008, 0x20003, 0x30100, 0x10200, 0x901, 0x201, 0x80004,
  0x20600, 0xff0400, 0xff0200, 0xff0002, 0xff0700, 0xff0008, 0xff0100, 0xff0300,
  0xff0100, 0xff0002, 0xff0100, 0xff0800, 0xff0002, 0xff0100, 0xff0700, 0xff000c,
  0xff0002, 0xff0009, 0xff0200, 0xff0004,
];

// prettier-ignore
const WEIGHTS = [
  [0, 64],
  [0, 21, 43, 64],
  [0, 9, 18, 27, 37, 46, 55, 64],
  [0, 4, 8, 12, 17, 21, 25, 29, 35, 39, 43, 47, 52, 56, 60, 64],
  [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64],
];

const MODE_TABLE = 0,
  MODE_FIELDS = MODE_TABLE + 128,
  MODE_RANGES = MODE_FIELDS + 19,
  PATTERN_TABLE = MODE_RANGES + 19,
  ANCHOR_TABLE = PATTERN_TABLE + 60,
  WEIGHT_TABLE = ANCHOR_TABLE + 60,
  // A weight table of n bits starts 2^n - 2 words in.
  ENDPOINT_TABLE = WEIGHT_TABLE + 62;

// ASTC endpoint unquantisation of a value: `bits` plain bits under a trit or quint digit.
function unquantise(bits: number, kind: number, value: number): number {
  if (!kind) {
    let out = 0;
    for (let shift = 8 - bits; shift > -bits; shift -= bits) out |= shift >= 0 ? value << shift : value >> -shift;
    return out & 255;
  }
  const digit = value >> bits,
    low = value & ((1 << bits) - 1),
    a = low & 1 ? 0x1ff : 0,
    b = (low >> 1) & 1,
    c = (low >> 2) & 1,
    d = (low >> 3) & 1,
    e = (low >> 4) & 1,
    f = (low >> 5) & 1;
  let spread: number, scale: number;
  if (kind === 1) {
    if (bits === 2) [spread, scale] = [(b << 8) | (b << 4) | (b << 2) | (b << 1), 93];
    else if (bits === 4) [spread, scale] = [(d << 8) | (c << 7) | (b << 6) | (d << 2) | (c << 1) | b, 22];
    else [spread, scale] = [(f << 8) | (e << 7) | (d << 6) | (c << 5) | (b << 4) | f, 5];
  } else if (bits === 3) [spread, scale] = [(c << 8) | (b << 7) | (c << 2) | (b << 1) | c, 26];
  else [spread, scale] = [(e << 8) | (d << 7) | (c << 6) | (b << 5) | e, 6];
  const t = (digit * scale + spread) ^ a;
  return (a & 0x80) | (t >> 2);
}

/** The tables the UASTC shader reads, in one buffer. */
export function uastcTables(): Uint32Array {
  const endpointAt: number[] = [],
    endpoints: number[] = [];
  for (const [bits, kind] of RANGES) {
    const key = bits * 4 + kind,
      count = (1 << bits) * (kind === 1 ? 3 : kind === 2 ? 5 : 1);
    if (endpointAt[key] !== undefined) continue;
    endpointAt[key] = ENDPOINT_TABLE + endpoints.length;
    for (let value = 0; value < count; value++) endpoints.push(unquantise(bits, kind, value));
  }
  return Uint32Array.from([
    ...MODE_BY_BITS,
    ...MODES.map(
      ([field, start, weights, subsets, comps, planes]) =>
        (field | (start << 8) | (weights << 16) | (subsets << 20) | (comps << 24) | (planes << 28)) >>> 0,
    ),
    ...RANGES.map(([bits, kind]) => bits | (kind << 4) | (endpointAt[bits * 4 + kind] << 8)),
    ...PATTERNS,
    ...ANCHORS,
    ...WEIGHTS.flat(),
    ...endpoints,
  ]);
}

/** The mode a block's first byte names; 19 is reserved. */
export const uastcMode = (byte: number): number => MODE_BY_BITS[byte & 127];

const JOB = /* wgsl */ `
struct Job {
  blocksX: u32,
  blockRows: u32,
  firstRow: u32,
  width: u32,
  height: u32,
  rowWords: u32,
  hasAlpha: u32,
  pad: u32,
};
@group(0) @binding(0) var<uniform> job: Job;
@group(0) @binding(1) var<storage, read_write> pixels: array<u32>;

fn store(block: vec3<u32>, x: u32, y: u32, texel: u32) {
  let px = block.x * 4u + x;
  let py = block.y * 4u + y;
  if (px < job.width && (job.firstRow + block.y) * 4u + y < job.height) {
    pixels[(block.z * job.blockRows * 4u + py) * job.rowWords + px] = texel;
  }
}
`;

/** UASTC LDR 4x4 blocks to RGBA8. Field places and tables come from {@link uastcTables}. */
export const UASTC_SHADER =
  JOB +
  /* wgsl */ `
@group(0) @binding(2) var<storage, read> blocks: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> tables: array<u32>;

var<private> word: array<u32, 5>;

fn bits(at: u32, count: u32) -> u32 {
  let index = at >> 5u;
  let shift = at & 31u;
  var value = word[index] >> shift;
  if (shift != 0u) {
    value = value | (word[index + 1u] << (32u - shift));
  }
  return value & ((1u << count) - 1u);
}

// ASTC interpolation with the sRGB flag off, which is what the encoder aims at.
fn mixed(low: u32, high: u32, weight: u32) -> u32 {
  let l = (low << 8u) | low;
  let h = (high << 8u) | high;
  return ((l * (64u - weight) + h * weight + 32u) >> 6u) >> 8u;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= job.blocksX || id.y >= job.blockRows) {
    return;
  }
  let block = blocks[(id.z * job.blockRows + id.y) * job.blocksX + id.x];
  word = array<u32, 5>(block.x, block.y, block.z, block.w, 0u);
  let mode = tables[${MODE_TABLE}u + (block.x & 127u)];
  if (mode == 8u) {
    let solid = bits(5u, 31u) | (bits(36u, 1u) << 31u);
    for (var t = 0u; t < 16u; t = t + 1u) {
      store(id, t & 3u, t >> 2u, solid);
    }
    return;
  }
  let fields = tables[${MODE_FIELDS}u + mode];
  let range = tables[${MODE_RANGES}u + mode];
  let fieldAt = fields & 255u;
  var at = (fields >> 8u) & 255u;
  let weightBits = (fields >> 16u) & 15u;
  let subsets = (fields >> 20u) & 15u;
  let comps = (fields >> 24u) & 15u;
  let planes = fields >> 28u;
  let plainBits = range & 15u;
  let kind = (range >> 4u) & 15u;
  let endpointTable = range >> 8u;
  let count = comps * 2u * subsets;

  var digits: array<u32, 18>;
  if (kind == 1u) {
    var i = 0u;
    while (i < count) {
      let group = min(5u, count - i);
      let length = (0x875420u >> (group * 4u)) & 15u;
      var packed = bits(at, length);
      at = at + length;
      for (var j = 0u; j < group; j = j + 1u) {
        digits[i + j] = packed % 3u;
        packed = packed / 3u;
      }
      i = i + group;
    }
  } else if (kind == 2u) {
    var i = 0u;
    while (i < count) {
      let group = min(3u, count - i);
      let length = (0x7530u >> (group * 4u)) & 15u;
      var packed = bits(at, length);
      at = at + length;
      for (var j = 0u; j < group; j = j + 1u) {
        digits[i + j] = packed % 5u;
        packed = packed / 5u;
      }
      i = i + group;
    }
  }
  var endpoints: array<u32, 18>;
  for (var i = 0u; i < count; i = i + 1u) {
    let low = bits(at, plainBits);
    at = at + plainBits;
    endpoints[i] = tables[endpointTable + ((digits[i] << plainBits) | low)];
  }

  var pattern = 0u;
  var anchors = 0xffff00u;
  if (subsets > 1u) {
    var slot = bits(fieldAt, select(5u, 4u, mode == 3u));
    if (mode == 3u) {
      slot = slot + 30u;
    } else if (mode == 7u) {
      slot = slot + 41u;
    }
    pattern = tables[${PATTERN_TABLE}u + slot];
    anchors = tables[${ANCHOR_TABLE}u + slot];
  }
  var second = 4u;
  if (planes == 2u) {
    second = select(bits(fieldAt, 2u), 1u, comps == 2u);
  }

  let weightTable = ${WEIGHT_TABLE}u + (1u << weightBits) - 2u;
  var weights: array<u32, 32>;
  for (var t = 0u; t < 16u; t = t + 1u) {
    var length = weightBits;
    if (t == (anchors & 255u) || t == ((anchors >> 8u) & 255u) || t == ((anchors >> 16u) & 255u)) {
      length = length - 1u;
    }
    for (var p = 0u; p < planes; p = p + 1u) {
      weights[t * planes + p] = tables[weightTable + bits(at, length)];
      at = at + length;
    }
  }

  for (var t = 0u; t < 16u; t = t + 1u) {
    let base = ((pattern >> (t * 2u)) & 3u) * comps * 2u;
    var channel = array<u32, 4>(0u, 0u, 0u, 255u);
    for (var c = 0u; c < comps; c = c + 1u) {
      let weight = weights[t * planes + select(0u, 1u, c == second)];
      channel[c] = mixed(endpoints[base + c * 2u], endpoints[base + c * 2u + 1u], weight);
    }
    if (comps == 2u) {
      channel[3] = channel[1];
      channel[1] = channel[0];
      channel[2] = channel[0];
    }
    store(id, t & 3u, t >> 2u, channel[0] | (channel[1] << 8u) | (channel[2] << 16u) | (channel[3] << 24u));
  }
}
`;

/** ETC1S blocks, given as codebook indices, to RGBA8. The green channel of the alpha plane is the alpha. */
export const ETC1S_SHADER =
  JOB +
  /* wgsl */ `
@group(0) @binding(2) var<storage, read> color: array<u32>;
@group(0) @binding(3) var<storage, read> alpha: array<u32>;
@group(0) @binding(4) var<storage, read> endpoints: array<u32>;
@group(0) @binding(5) var<storage, read> selectors: array<u32>;

fn texel(block: u32, t: u32) -> vec3<u32> {
  var intensity = array<vec4<i32>, 8>(
    vec4<i32>(-8, -2, 2, 8),
    vec4<i32>(-17, -5, 5, 17),
    vec4<i32>(-29, -9, 9, 29),
    vec4<i32>(-42, -13, 13, 42),
    vec4<i32>(-60, -18, 18, 60),
    vec4<i32>(-80, -24, 24, 80),
    vec4<i32>(-106, -33, 33, 106),
    vec4<i32>(-183, -47, 47, 183),
  );
  let endpoint = endpoints[block & 0xffffu];
  let selector = (selectors[block >> 16u] >> (t * 2u)) & 3u;
  let delta = intensity[endpoint >> 24u][selector];
  let base = vec3<i32>(i32(endpoint & 255u), i32((endpoint >> 8u) & 255u), i32((endpoint >> 16u) & 255u));
  return vec3<u32>(clamp(base + vec3<i32>(delta), vec3<i32>(0), vec3<i32>(255)));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= job.blocksX || id.y >= job.blockRows) {
    return;
  }
  let at = (id.z * job.blockRows + id.y) * job.blocksX + id.x;
  let block = color[at];
  for (var t = 0u; t < 16u; t = t + 1u) {
    let rgb = texel(block, t);
    var a = 255u;
    if (job.hasAlpha != 0u) {
      a = texel(alpha[at], t).y;
    }
    store(id, t & 3u, t >> 2u, rgb.x | (rgb.y << 8u) | (rgb.z << 16u) | (a << 24u));
  }
}
`;

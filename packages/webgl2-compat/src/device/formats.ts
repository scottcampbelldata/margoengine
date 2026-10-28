// WebGPU texture formats on WebGL2 (W3C WebGPU specification section 26.1, "Texture Format Capabilities"; Khronos
// OpenGL ES 3.0 specification tables 3.13 and 3.14 and the WebGL 2.0 specification). Enum names are read from the
// context, so the table holds names, not numbers.

/** How a format's texels read in shaders and clear. */
type FormatKind = 'float' | 'sint' | 'uint' | 'depth' | 'depth-stencil' | 'stencil';

/** One WebGPU format as WebGL2 stores it. */
export interface FormatInfo {
  readonly name: string;
  /** Sized internal format, by WebGL2 enum name. */
  readonly internal: string;
  /** Upload format and type, by enum name. */
  readonly format: string;
  readonly type: string;
  /** Bytes per texel in WebGPU's own layout (writeTexture, copies); 0 when the format cannot be copied. */
  readonly bytes: number;
  /** Colour channels (depth and stencil formats: 1). */
  readonly channels: number;
  readonly kind: FormatKind;
  /** Renderable on a full-tier context (EXT_color_buffer_float makes the float formats renderable). */
  readonly renderable: boolean;
  /** Linear filtering works (32-bit floats need OES_texture_float_linear: checked at sampling). */
  readonly filterable: boolean;
  readonly srgb?: boolean;
  /** WebGPU's bgra order, stored as rgba: uploads and readbacks swap red and blue. */
  readonly bgra?: boolean;
  /** Per-channel bytes as WebGPU lays them out, for readback conversion: 1, 2 or 4; 0 for packed formats. */
  readonly channelBytes: number;
  /** The extension the format needs, if any. */
  readonly extension?: string;
  /**
   * A block-compressed format: the block size in texels and bytes, and the WebGPU feature that enables it. Its
   * `internal` enum lives on the extension object, not on the context.
   */
  readonly block?: { readonly w: number; readonly h: number; readonly bytes: number; readonly feature: string };
}

type Row = [
  name: string,
  internal: string,
  format: string,
  type: string,
  bytes: number,
  channels: number,
  kind: FormatKind,
  renderable: boolean,
  filterable: boolean,
  channelBytes: number,
];

const ROWS: Row[] = [
  ['r8unorm', 'R8', 'RED', 'UNSIGNED_BYTE', 1, 1, 'float', true, true, 1],
  ['r8snorm', 'R8_SNORM', 'RED', 'BYTE', 1, 1, 'float', false, true, 1],
  ['r8uint', 'R8UI', 'RED_INTEGER', 'UNSIGNED_BYTE', 1, 1, 'uint', true, false, 1],
  ['r8sint', 'R8I', 'RED_INTEGER', 'BYTE', 1, 1, 'sint', true, false, 1],
  ['r16uint', 'R16UI', 'RED_INTEGER', 'UNSIGNED_SHORT', 2, 1, 'uint', true, false, 2],
  ['r16sint', 'R16I', 'RED_INTEGER', 'SHORT', 2, 1, 'sint', true, false, 2],
  ['r16float', 'R16F', 'RED', 'HALF_FLOAT', 2, 1, 'float', true, true, 2],
  ['rg8unorm', 'RG8', 'RG', 'UNSIGNED_BYTE', 2, 2, 'float', true, true, 1],
  ['rg8snorm', 'RG8_SNORM', 'RG', 'BYTE', 2, 2, 'float', false, true, 1],
  ['rg8uint', 'RG8UI', 'RG_INTEGER', 'UNSIGNED_BYTE', 2, 2, 'uint', true, false, 1],
  ['rg8sint', 'RG8I', 'RG_INTEGER', 'BYTE', 2, 2, 'sint', true, false, 1],
  ['r32uint', 'R32UI', 'RED_INTEGER', 'UNSIGNED_INT', 4, 1, 'uint', true, false, 4],
  ['r32sint', 'R32I', 'RED_INTEGER', 'INT', 4, 1, 'sint', true, false, 4],
  ['r32float', 'R32F', 'RED', 'FLOAT', 4, 1, 'float', true, true, 4],
  ['rg16uint', 'RG16UI', 'RG_INTEGER', 'UNSIGNED_SHORT', 4, 2, 'uint', true, false, 2],
  ['rg16sint', 'RG16I', 'RG_INTEGER', 'SHORT', 4, 2, 'sint', true, false, 2],
  ['rg16float', 'RG16F', 'RG', 'HALF_FLOAT', 4, 2, 'float', true, true, 2],
  ['rgba8unorm', 'RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, 4, 'float', true, true, 1],
  ['rgba8unorm-srgb', 'SRGB8_ALPHA8', 'RGBA', 'UNSIGNED_BYTE', 4, 4, 'float', true, true, 1],
  ['rgba8snorm', 'RGBA8_SNORM', 'RGBA', 'BYTE', 4, 4, 'float', false, true, 1],
  ['rgba8uint', 'RGBA8UI', 'RGBA_INTEGER', 'UNSIGNED_BYTE', 4, 4, 'uint', true, false, 1],
  ['rgba8sint', 'RGBA8I', 'RGBA_INTEGER', 'BYTE', 4, 4, 'sint', true, false, 1],
  ['bgra8unorm', 'RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, 4, 'float', true, true, 1],
  ['bgra8unorm-srgb', 'SRGB8_ALPHA8', 'RGBA', 'UNSIGNED_BYTE', 4, 4, 'float', true, true, 1],
  ['rgb9e5ufloat', 'RGB9_E5', 'RGB', 'UNSIGNED_INT_5_9_9_9_REV', 4, 3, 'float', false, true, 0],
  ['rgb10a2uint', 'RGB10_A2UI', 'RGBA_INTEGER', 'UNSIGNED_INT_2_10_10_10_REV', 4, 4, 'uint', true, false, 0],
  ['rgb10a2unorm', 'RGB10_A2', 'RGBA', 'UNSIGNED_INT_2_10_10_10_REV', 4, 4, 'float', true, true, 0],
  ['rg11b10ufloat', 'R11F_G11F_B10F', 'RGB', 'UNSIGNED_INT_10F_11F_11F_REV', 4, 3, 'float', true, true, 0],
  ['rg32uint', 'RG32UI', 'RG_INTEGER', 'UNSIGNED_INT', 8, 2, 'uint', true, false, 4],
  ['rg32sint', 'RG32I', 'RG_INTEGER', 'INT', 8, 2, 'sint', true, false, 4],
  ['rg32float', 'RG32F', 'RG', 'FLOAT', 8, 2, 'float', true, true, 4],
  ['rgba16uint', 'RGBA16UI', 'RGBA_INTEGER', 'UNSIGNED_SHORT', 8, 4, 'uint', true, false, 2],
  ['rgba16sint', 'RGBA16I', 'RGBA_INTEGER', 'SHORT', 8, 4, 'sint', true, false, 2],
  ['rgba16float', 'RGBA16F', 'RGBA', 'HALF_FLOAT', 8, 4, 'float', true, true, 2],
  ['rgba32uint', 'RGBA32UI', 'RGBA_INTEGER', 'UNSIGNED_INT', 16, 4, 'uint', true, false, 4],
  ['rgba32sint', 'RGBA32I', 'RGBA_INTEGER', 'INT', 16, 4, 'sint', true, false, 4],
  ['rgba32float', 'RGBA32F', 'RGBA', 'FLOAT', 16, 4, 'float', true, true, 4],
  // WebGL2 has no stencil-only textures: stencil8 is stored with a depth part nobody reads.
  ['stencil8', 'DEPTH24_STENCIL8', 'DEPTH_STENCIL', 'UNSIGNED_INT_24_8', 1, 1, 'stencil', true, false, 1],
  ['depth16unorm', 'DEPTH_COMPONENT16', 'DEPTH_COMPONENT', 'UNSIGNED_SHORT', 2, 1, 'depth', true, false, 2],
  ['depth24plus', 'DEPTH_COMPONENT24', 'DEPTH_COMPONENT', 'UNSIGNED_INT', 0, 1, 'depth', true, false, 0],
  [
    'depth24plus-stencil8',
    'DEPTH24_STENCIL8',
    'DEPTH_STENCIL',
    'UNSIGNED_INT_24_8',
    0,
    1,
    'depth-stencil',
    true,
    false,
    0,
  ],
  ['depth32float', 'DEPTH_COMPONENT32F', 'DEPTH_COMPONENT', 'FLOAT', 4, 1, 'depth', true, false, 4],
  [
    'depth32float-stencil8',
    'DEPTH32F_STENCIL8',
    'DEPTH_STENCIL',
    'FLOAT_32_UNSIGNED_INT_24_8_REV',
    0,
    1,
    'depth-stencil',
    true,
    false,
    0,
  ],
];

/** Every format the layer maps, by WebGPU name. */
export const FORMATS: ReadonlyMap<string, FormatInfo> = new Map(
  ROWS.map(([name, internal, format, type, bytes, channels, kind, renderable, filterable, channelBytes]) => [
    name,
    {
      name,
      internal,
      format,
      type,
      bytes,
      channels,
      kind,
      renderable,
      filterable,
      channelBytes,
      srgb: name.endsWith('-srgb') || undefined,
      bgra: name.startsWith('bgra') || undefined,
    },
  ]),
);

/** WebGPU's compressed formats (WebGPU specification section 26.1.3) on the WebGL extensions that store them. */
const COMPRESSED: [name: string, internal: string, w: number, h: number, bytes: number, feature: string][] = [
  ['bc1-rgba-unorm', 'COMPRESSED_RGBA_S3TC_DXT1_EXT', 4, 4, 8, 'bc'],
  ['bc1-rgba-unorm-srgb', 'COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT', 4, 4, 8, 'bc'],
  ['bc2-rgba-unorm', 'COMPRESSED_RGBA_S3TC_DXT3_EXT', 4, 4, 16, 'bc'],
  ['bc2-rgba-unorm-srgb', 'COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT', 4, 4, 16, 'bc'],
  ['bc3-rgba-unorm', 'COMPRESSED_RGBA_S3TC_DXT5_EXT', 4, 4, 16, 'bc'],
  ['bc3-rgba-unorm-srgb', 'COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT', 4, 4, 16, 'bc'],
  ['bc4-r-unorm', 'COMPRESSED_RED_RGTC1_EXT', 4, 4, 8, 'bc'],
  ['bc4-r-snorm', 'COMPRESSED_SIGNED_RED_RGTC1_EXT', 4, 4, 8, 'bc'],
  ['bc5-rg-unorm', 'COMPRESSED_RED_GREEN_RGTC2_EXT', 4, 4, 16, 'bc'],
  ['bc5-rg-snorm', 'COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT', 4, 4, 16, 'bc'],
  ['bc6h-rgb-ufloat', 'COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT', 4, 4, 16, 'bc'],
  ['bc6h-rgb-float', 'COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT', 4, 4, 16, 'bc'],
  ['bc7-rgba-unorm', 'COMPRESSED_RGBA_BPTC_UNORM_EXT', 4, 4, 16, 'bc'],
  ['bc7-rgba-unorm-srgb', 'COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT', 4, 4, 16, 'bc'],
  ['etc2-rgb8unorm', 'COMPRESSED_RGB8_ETC2', 4, 4, 8, 'etc2'],
  ['etc2-rgb8unorm-srgb', 'COMPRESSED_SRGB8_ETC2', 4, 4, 8, 'etc2'],
  ['etc2-rgb8a1unorm', 'COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2', 4, 4, 8, 'etc2'],
  ['etc2-rgb8a1unorm-srgb', 'COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2', 4, 4, 8, 'etc2'],
  ['etc2-rgba8unorm', 'COMPRESSED_RGBA8_ETC2_EAC', 4, 4, 16, 'etc2'],
  ['etc2-rgba8unorm-srgb', 'COMPRESSED_SRGB8_ALPHA8_ETC2_EAC', 4, 4, 16, 'etc2'],
  ['eac-r11unorm', 'COMPRESSED_R11_EAC', 4, 4, 8, 'etc2'],
  ['eac-r11snorm', 'COMPRESSED_SIGNED_R11_EAC', 4, 4, 8, 'etc2'],
  ['eac-rg11unorm', 'COMPRESSED_RG11_EAC', 4, 4, 16, 'etc2'],
  ['eac-rg11snorm', 'COMPRESSED_SIGNED_RG11_EAC', 4, 4, 16, 'etc2'],
  ...[
    [4, 4],
    [5, 4],
    [5, 5],
    [6, 5],
    [6, 6],
    [8, 5],
    [8, 6],
    [8, 8],
    [10, 5],
    [10, 6],
    [10, 8],
    [10, 10],
    [12, 10],
    [12, 12],
  ].flatMap(([w, h]): [string, string, number, number, number, string][] => [
    [`astc-${w}x${h}-unorm`, `COMPRESSED_RGBA_ASTC_${w}x${h}_KHR`, w, h, 16, 'astc'],
    [`astc-${w}x${h}-unorm-srgb`, `COMPRESSED_SRGB8_ALPHA8_ASTC_${w}x${h}_KHR`, w, h, 16, 'astc'],
  ]),
];
for (const [name, internal, w, h, bytes, family] of COMPRESSED)
  (FORMATS as Map<string, FormatInfo>).set(name, {
    name,
    internal,
    format: '',
    type: '',
    bytes: 0,
    channels: 4,
    kind: 'float',
    renderable: false,
    filterable: true,
    channelBytes: 0,
    srgb: name.endsWith('-srgb') || undefined,
    block: { w, h, bytes, feature: `texture-compression-${family}` },
  });

/** The WebGL extensions behind each compressed-format feature (all of them must be there). */
export const COMPRESSION_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'texture-compression-bc': [
    'WEBGL_compressed_texture_s3tc',
    'WEBGL_compressed_texture_s3tc_srgb',
    'EXT_texture_compression_rgtc',
    'EXT_texture_compression_bptc',
  ],
  'texture-compression-etc2': ['WEBGL_compressed_texture_etc'],
  'texture-compression-astc': ['WEBGL_compressed_texture_astc'],
};

/** True for formats with a depth part. */
export const hasDepth = (f: FormatInfo): boolean => f.kind === 'depth' || f.kind === 'depth-stencil';
/** True for formats with a stencil part. */
export const hasStencil = (f: FormatInfo): boolean => f.kind === 'stencil' || f.kind === 'depth-stencil';

/** Vertex formats: component count, GL type name, normalized, integer (vertexAttribIPointer), bytes. */
export const VERTEX_FORMATS: Readonly<Record<string, readonly [number, string, boolean, boolean, number]>> = {
  uint8: [1, 'UNSIGNED_BYTE', false, true, 1],
  uint8x2: [2, 'UNSIGNED_BYTE', false, true, 2],
  uint8x4: [4, 'UNSIGNED_BYTE', false, true, 4],
  sint8: [1, 'BYTE', false, true, 1],
  sint8x2: [2, 'BYTE', false, true, 2],
  sint8x4: [4, 'BYTE', false, true, 4],
  unorm8: [1, 'UNSIGNED_BYTE', true, false, 1],
  unorm8x2: [2, 'UNSIGNED_BYTE', true, false, 2],
  unorm8x4: [4, 'UNSIGNED_BYTE', true, false, 4],
  snorm8: [1, 'BYTE', true, false, 1],
  snorm8x2: [2, 'BYTE', true, false, 2],
  snorm8x4: [4, 'BYTE', true, false, 4],
  uint16: [1, 'UNSIGNED_SHORT', false, true, 2],
  uint16x2: [2, 'UNSIGNED_SHORT', false, true, 4],
  uint16x4: [4, 'UNSIGNED_SHORT', false, true, 8],
  sint16: [1, 'SHORT', false, true, 2],
  sint16x2: [2, 'SHORT', false, true, 4],
  sint16x4: [4, 'SHORT', false, true, 8],
  unorm16: [1, 'UNSIGNED_SHORT', true, false, 2],
  unorm16x2: [2, 'UNSIGNED_SHORT', true, false, 4],
  unorm16x4: [4, 'UNSIGNED_SHORT', true, false, 8],
  snorm16: [1, 'SHORT', true, false, 2],
  snorm16x2: [2, 'SHORT', true, false, 4],
  snorm16x4: [4, 'SHORT', true, false, 8],
  float16: [1, 'HALF_FLOAT', false, false, 2],
  float16x2: [2, 'HALF_FLOAT', false, false, 4],
  float16x4: [4, 'HALF_FLOAT', false, false, 8],
  float32: [1, 'FLOAT', false, false, 4],
  float32x2: [2, 'FLOAT', false, false, 8],
  float32x3: [3, 'FLOAT', false, false, 12],
  float32x4: [4, 'FLOAT', false, false, 16],
  uint32: [1, 'UNSIGNED_INT', false, true, 4],
  uint32x2: [2, 'UNSIGNED_INT', false, true, 8],
  uint32x3: [3, 'UNSIGNED_INT', false, true, 12],
  uint32x4: [4, 'UNSIGNED_INT', false, true, 16],
  sint32: [1, 'INT', false, true, 4],
  sint32x2: [2, 'INT', false, true, 8],
  sint32x3: [3, 'INT', false, true, 12],
  sint32x4: [4, 'INT', false, true, 16],
  'unorm10-10-10-2': [4, 'UNSIGNED_INT_2_10_10_10_REV', true, false, 4],
};

/** IEEE half from a float (round to nearest even), for readbacks of 16-bit float targets read as 32-bit floats. */
export function toHalf(value: number): number {
  const f = new Float32Array([value]),
    u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000,
    exp = (u >>> 23) & 0xff,
    mant = u & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = (mant | 0x800000) >>> (1 - e + 13),
      rest = (mant | 0x800000) & ((1 << (1 - e + 13)) - 1),
      half = 1 << (1 - e + 12);
    return sign | (m + (rest > half || (rest === half && m & 1) ? 1 : 0));
  }
  let m = mant >>> 13;
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && m & 1)) {
    m++;
    if (m === 0x400) {
      m = 0;
      e++;
      if (e >= 0x1f) return sign | 0x7c00;
    }
  }
  return sign | (e << 10) | m;
}

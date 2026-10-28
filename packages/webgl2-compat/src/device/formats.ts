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

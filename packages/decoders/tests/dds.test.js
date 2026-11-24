// DDS reading (@margoengine/decoders/dds) and uploadTexture against files built by the test encoder
// (tests/support/texture-encoders.js, from Microsoft's DDS documentation): every block-compressed and passthrough
// format in both header forms, every legacy bit-mask conversion, mips, cubes, arrays, refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDDS, uploadTexture } from '../dist/dds.js';
import { uploadTexture as uploadKTX } from '../dist/ktx.js';
import { dds, failed, image, mockDevice, rejects, sequence } from './support/texture-encoders.js';

// Block-compressed formats: FourCC or DXGI number, WebGPU format, bytes per 4x4 block, sRGB, alpha.
const BC = [
  ['DXT1', 'bc1-rgba-unorm', 8, false, true],
  ['DXT2', 'bc2-rgba-unorm', 16, false, true],
  ['DXT3', 'bc2-rgba-unorm', 16, false, true],
  ['DXT4', 'bc3-rgba-unorm', 16, false, true],
  ['DXT5', 'bc3-rgba-unorm', 16, false, true],
  ['ATI1', 'bc4-r-unorm', 8, false, false],
  ['BC4U', 'bc4-r-unorm', 8, false, false],
  ['BC4S', 'bc4-r-snorm', 8, false, false],
  ['ATI2', 'bc5-rg-unorm', 16, false, false],
  ['BC5U', 'bc5-rg-unorm', 16, false, false],
  ['BC5S', 'bc5-rg-snorm', 16, false, false],
  [71, 'bc1-rgba-unorm', 8, false, true],
  [72, 'bc1-rgba-unorm-srgb', 8, true, true],
  [74, 'bc2-rgba-unorm', 16, false, true],
  [75, 'bc2-rgba-unorm-srgb', 16, true, true],
  [77, 'bc3-rgba-unorm', 16, false, true],
  [78, 'bc3-rgba-unorm-srgb', 16, true, true],
  [80, 'bc4-r-unorm', 8, false, false],
  [81, 'bc4-r-snorm', 8, false, false],
  [83, 'bc5-rg-unorm', 16, false, false],
  [84, 'bc5-rg-snorm', 16, false, false],
  [95, 'bc6h-rgb-ufloat', 16, false, false],
  [96, 'bc6h-rgb-float', 16, false, false],
  [98, 'bc7-rgba-unorm', 16, false, true],
  [99, 'bc7-rgba-unorm-srgb', 16, true, true],
];

test('DDS BC1-BC7 (sRGB, snorm, BC6H) from FourCC and DX10 headers: format, block size and every mip size', () => {
  // 16x8 with its full chain: 16x8, 8x4, 4x2, 2x1, 1x1 are 4x2, 2x1, 1x1, 1x1 and 1x1 blocks.
  const blocks = [8, 2, 1, 1, 1];
  for (const [source, format, bytes, srgb, alpha] of BC) {
    const data = sequence(16 * bytes, bytes),
      header = typeof source === 'string' ? { fourCC: source } : { dx10: { format: source } },
      file = parseDDS(dds({ width: 16, height: 8, mips: 5, ...header, data }));
    assert.deepEqual(
      [file.format, file.feature, file.srgb, file.hasAlpha, file.dimension, file.layers],
      [format, 'texture-compression-bc', srgb, alpha, '2d', 1],
      String(source),
    );
    assert.deepEqual(
      file.mipmaps.map((m) => [m.width, m.height, m.byteLength]),
      [16, 8, 4, 2, 1].map((w, i) => [w, Math.max(1, 8 >> i), blocks[i] * bytes]),
    );
    let at = 0;
    for (const mip of file.mipmaps) assert.deepEqual(mip.data, data.subarray(at, (at += mip.byteLength)));
  }
});

// Uncompressed formats passed through: DXGI number (or D3DFORMAT FourCC number), WebGPU format, bytes per texel.
const PASSTHROUGH = [
  [2, 'rgba32float', 16],
  [10, 'rgba16float', 8],
  [16, 'rg32float', 8],
  [24, 'rgb10a2unorm', 4],
  [26, 'rg11b10ufloat', 4],
  [28, 'rgba8unorm', 4],
  [29, 'rgba8unorm-srgb', 4],
  [31, 'rgba8snorm', 4],
  [34, 'rg16float', 4],
  [41, 'r32float', 4],
  [49, 'rg8unorm', 2],
  [51, 'rg8snorm', 2],
  [54, 'r16float', 2],
  [61, 'r8unorm', 1],
  [63, 'r8snorm', 1],
  [67, 'rgb9e5ufloat', 4],
];
const D3D = [
  [111, 'r16float', 2],
  [112, 'rg16float', 4],
  [113, 'rgba16float', 8],
  [114, 'r32float', 4],
  [115, 'rg32float', 8],
  [116, 'rgba32float', 16],
];

test('DDS DX10 and D3DFORMAT uncompressed formats pass through with their mips', () => {
  // 3x2 with two levels: 3x2 and 1x1.
  const check = (file, format, bytes, label) => {
    assert.deepEqual([file.format, file.feature, file.srgb], [format, undefined, format.endsWith('-srgb')], label);
    assert.deepEqual(
      file.mipmaps.map((m) => [m.width, m.height, m.byteLength]),
      [
        [3, 2, 6 * bytes],
        [1, 1, bytes],
      ],
    );
    assert.deepEqual(file.mipmaps[0].data, sequence(7 * bytes).subarray(0, 6 * bytes));
    assert.deepEqual(file.mipmaps[1].data, sequence(7 * bytes).subarray(6 * bytes));
  };
  for (const [dxgi, format, bytes] of PASSTHROUGH)
    check(
      parseDDS(dds({ width: 3, height: 2, mips: 2, dx10: { format: dxgi }, data: sequence(7 * bytes) })),
      format,
      bytes,
      `DXGI ${dxgi}`,
    );
  for (const [code, format, bytes] of D3D) {
    const file = dds({ width: 3, height: 2, mips: 2, fourCC: 'XXXX', data: sequence(7 * bytes) });
    new DataView(file.buffer).setUint32(84, code, true);
    check(parseDDS(file), format, bytes, `D3DFMT ${code}`);
  }
  // DX10 alpha mode 3 (opaque) clears hasAlpha.
  assert.equal(
    parseDDS(dds({ width: 1, height: 1, dx10: { format: 28, misc2: 3 }, data: sequence(4) })).hasAlpha,
    false,
  );
});

/** Independent reference for a bit-mask pixel: each channel's field scaled from its own bit width to 0-255. */
function reference(pixel, masks, luminance) {
  const field = (mask) => {
    if (!mask) return undefined;
    let shift = 0,
      width = 0;
    while (!((mask / 2 ** shift) & 1)) shift++;
    while (Math.floor(mask / 2 ** (shift + width)) & 1) width++;
    const value = Math.floor(pixel / 2 ** shift) % 2 ** width;
    return Math.round((value * 255) / (2 ** width - 1));
  };
  const [r, g, b, a] = masks.map(field),
    l = luminance ? r : undefined;
  return [l ?? r ?? 0, l ?? g ?? 0, l ?? b ?? 0, a ?? 255];
}
// Legacy DDS_PIXELFORMAT bit masks: name, bits, R (or luminance), G, B, A masks, flags.
const RGB = 0x40,
  ALPHAPIXELS = 1,
  LUMINANCE = 0x20000,
  ALPHA = 2;
const MASKS = [
  ['A8R8G8B8', 32, [0xff0000, 0xff00, 0xff, 0xff000000], RGB | ALPHAPIXELS],
  ['X8R8G8B8', 32, [0xff0000, 0xff00, 0xff, 0], RGB],
  ['A8B8G8R8', 32, [0xff, 0xff00, 0xff0000, 0xff000000], RGB | ALPHAPIXELS],
  ['X8B8G8R8', 32, [0xff, 0xff00, 0xff0000, 0], RGB],
  ['A2B10G10R10', 32, [0x3ff, 0xffc00, 0x3ff00000, 0xc0000000], RGB | ALPHAPIXELS],
  ['A2R10G10B10', 32, [0x3ff00000, 0xffc00, 0x3ff, 0xc0000000], RGB | ALPHAPIXELS],
  ['G16R16', 32, [0xffff, 0xffff0000, 0, 0], RGB],
  ['R8G8B8', 24, [0xff0000, 0xff00, 0xff, 0], RGB],
  ['R5G6B5', 16, [0xf800, 0x7e0, 0x1f, 0], RGB],
  ['X1R5G5B5', 16, [0x7c00, 0x3e0, 0x1f, 0], RGB],
  ['A1R5G5B5', 16, [0x7c00, 0x3e0, 0x1f, 0x8000], RGB | ALPHAPIXELS],
  ['A4R4G4B4', 16, [0xf00, 0xf0, 0xf, 0xf000], RGB | ALPHAPIXELS],
  ['X4R4G4B4', 16, [0xf00, 0xf0, 0xf, 0], RGB],
  ['A8R3G3B2', 16, [0xe0, 0x1c, 0x3, 0xff00], RGB | ALPHAPIXELS],
  ['R3G3B2', 8, [0xe0, 0x1c, 0x3, 0], RGB],
  ['L8', 8, [0xff, 0, 0, 0], LUMINANCE],
  ['A4L4', 8, [0xf, 0, 0, 0xf0], LUMINANCE | ALPHAPIXELS],
  ['L16', 16, [0xffff, 0, 0, 0], LUMINANCE],
  ['A8L8', 16, [0xff, 0, 0, 0xff00], LUMINANCE | ALPHAPIXELS],
  ['A8', 8, [0, 0, 0, 0xff], ALPHA],
];
// DXGI formats converted the same way: number, bits, masks, sRGB.
const DXGI_MASKS = [
  [85, 16, [0xf800, 0x7e0, 0x1f, 0]],
  [86, 16, [0x7c00, 0x3e0, 0x1f, 0x8000]],
  [87, 32, [0xff0000, 0xff00, 0xff, 0xff000000]],
  [88, 32, [0xff0000, 0xff00, 0xff, 0]],
  [91, 32, [0xff0000, 0xff00, 0xff, 0xff000000], true],
  [93, 32, [0xff0000, 0xff00, 0xff, 0], true],
  [115, 16, [0xf00, 0xf0, 0xf, 0xf000]],
];

test('DDS every legacy bit-mask format and the converted DXGI formats become exact rgba8unorm', () => {
  const width = 5,
    height = 3,
    count = width * height,
    expectRows = (bytes, bits, masks, luminance) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        let pixel = 0;
        for (let b = 0; b < bits / 8; b++) pixel += bytes[i * (bits / 8) + b] * 2 ** (8 * b);
        out.push(...reference(pixel, masks, luminance));
      }
      return out;
    };
  for (const [name, bits, masks, flags] of MASKS) {
    const data = image(count * (bits / 8), 1, bits).subarray(0, count * (bits / 8)),
      file = parseDDS(dds({ width, height, bits, masks, pfFlags: flags, data }));
    assert.deepEqual([file.format, file.hasAlpha], ['rgba8unorm', !!masks[3]], name);
    assert.deepEqual([...file.mipmaps[0].data], expectRows(data, bits, masks, !!(flags & LUMINANCE)), name);
  }
  for (const [dxgi, bits, masks, srgb] of DXGI_MASKS) {
    const data = image(count * (bits / 8), 1, dxgi).subarray(0, count * (bits / 8)),
      file = parseDDS(dds({ width, height, dx10: { format: dxgi }, data }));
    assert.deepEqual([file.format, file.srgb], [srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', !!srgb], `DXGI ${dxgi}`);
    assert.deepEqual([...file.mipmaps[0].data], expectRows(data, bits, masks, false), `DXGI ${dxgi}`);
  }
});

test('DDS mip chains on converted cubes, arrays and cube arrays come out level-major', () => {
  // A legacy A8R8G8B8 cube, 4x4 with 3 levels, converted per face and gathered per level.
  const levelSizes = [16, 4, 1],
    faceTexels = levelSizes.reduce((a, b) => a + b),
    faces = Array.from({ length: 6 }, (_, f) => image(faceTexels, 1, f + 1)),
    cube = parseDDS(
      dds({
        width: 4,
        height: 4,
        mips: 3,
        bits: 32,
        masks: [0xff0000, 0xff00, 0xff, 0xff000000],
        caps2: 0x200 | 0xfc00,
        data: faces.flatMap((f) => [...f]),
      }),
    ),
    swizzle = (bytes) => bytes.map((_, i) => bytes[i - (i % 4) + [2, 1, 0, 3][i % 4]]);
  assert.deepEqual([cube.dimension, cube.layers, cube.mipmaps.length], ['cube', 6, 3]);
  let at = 0;
  levelSizes.forEach((texels, level) => {
    assert.deepEqual(
      cube.mipmaps[level].data,
      Uint8Array.from(faces.flatMap((f) => [...swizzle(f.subarray(at * 4, (at + texels) * 4))])),
      `level ${level}`,
    );
    at += texels;
  });
  // A DX10 BC1 cube array of 2 cubes (12 layers), 8x8 with 2 levels: 32 + 8 bytes a layer.
  const layers = Array.from({ length: 12 }, (_, n) => sequence(40, n * 3)),
    cubes = parseDDS(
      dds({
        width: 8,
        height: 8,
        mips: 2,
        dx10: { format: 71, misc: 4, array: 2 },
        data: layers.flatMap((l) => [...l]),
      }),
    );
  assert.deepEqual([cubes.dimension, cubes.layers], ['cube-array', 12]);
  assert.deepEqual(cubes.mipmaps[0].data, Uint8Array.from(layers.flatMap((l) => [...l.subarray(0, 32)])));
  assert.deepEqual(cubes.mipmaps[1].data, Uint8Array.from(layers.flatMap((l) => [...l.subarray(32)])));
  // A 3-layer DX10 RG8 array, 4x2 with 3 levels: 16 + 4 + 2 bytes a layer.
  const planes = Array.from({ length: 3 }, (_, n) => sequence(22, n * 5)),
    array = parseDDS(
      dds({ width: 4, height: 2, mips: 3, dx10: { format: 49, array: 3 }, data: planes.flatMap((l) => [...l]) }),
    );
  assert.deepEqual([array.dimension, array.layers, array.format], ['2d-array', 3, 'rg8unorm']);
  [
    [0, 16],
    [16, 20],
    [20, 22],
  ].forEach(([from, to], level) =>
    assert.deepEqual(array.mipmaps[level].data, Uint8Array.from(planes.flatMap((l) => [...l.subarray(from, to)]))),
  );
});

test('DDS refuses bad magic, truncation, bad sizes, unsupported layouts and formats, naming the fix', () => {
  const good = () => dds({ width: 4, height: 4, fourCC: 'DXT1', data: sequence(8) }),
    patched = (at, value, file = good()) => {
      new DataView(file.buffer).setUint32(at, value, true);
      return file;
    };
  rejects(() => parseDDS(good().buffer), TypeError, /needs the DDS file as a Uint8Array/);
  failed(() => parseDDS(patched(0, 0x20534445)), /header is missing/);
  failed(() => parseDDS(patched(4, 100)), /header is missing/);
  failed(() => parseDDS(patched(76, 24)), /header is missing/);
  failed(() => parseDDS(good().subarray(0, 127)), /header is missing/);
  failed(
    () => parseDDS(dds({ width: 4, height: 4, dx10: { format: 98 }, data: [] }).subarray(0, 140)),
    /DX10 header is missing/,
  );
  failed(() => parseDDS(good().subarray(0, 135)), /ends inside layer 0 mip 0/);
  failed(() => parseDDS(patched(16, 0)), /size 0x4 is invalid/);
  failed(() => parseDDS(patched(12, 0)), /size 4x0 is invalid/);
  failed(() => parseDDS(patched(16, 65537)), /size 65537x4 is invalid/);
  failed(() => parseDDS(patched(28, 4)), /has 4 mip levels, too many/);
  failed(
    () => parseDDS(dds({ width: 4, height: 4, fourCC: 'RXGB', data: sequence(16) })),
    /FourCC RXGB is not supported; convert/,
  );
  failed(() => parseDDS(patched(84, 36)), /FourCC 36 is not supported/);
  for (const dxgi of [0, 20, 42, 45])
    failed(
      () => parseDDS(dds({ width: 4, height: 4, dx10: { format: dxgi }, data: sequence(64) })),
      new RegExp(`DXGI format ${dxgi} is not supported`),
    );
  failed(() => parseDDS(patched(112, 0x200000)), /volume texture is not supported/);
  failed(() => parseDDS(patched(24, 2, patched(8, 0x801007))), /volume texture/);
  failed(
    () => parseDDS(dds({ width: 4, height: 1, dx10: { format: 28, dimension: 2 }, data: sequence(16) })),
    /resource dimension 2/,
  );
  failed(
    () => parseDDS(dds({ width: 4, height: 4, dx10: { format: 28, dimension: 4 }, data: sequence(64) })),
    /resource dimension 4/,
  );
  // Partial cube maps: five faces, and only +X.
  failed(() => parseDDS(patched(112, 0x200 | 0x7c00)), /cube map without all six faces/);
  failed(() => parseDDS(patched(112, 0x200 | 0x400)), /cube map without all six faces/);
  failed(
    () => parseDDS(dds({ width: 4, height: 4, pfFlags: 0x200, bits: 16, data: sequence(32) })),
    /pixel format \(YUV or unknown\)/,
  );
  failed(
    () => parseDDS(dds({ width: 4, height: 4, bits: 32, masks: [0, 0, 0, 0], data: sequence(64) })),
    /pixel format of 32 bits/,
  );
  failed(
    () => parseDDS(dds({ width: 4, height: 4, bits: 48, masks: [1, 2, 4, 0], data: sequence(96) })),
    /pixel format of 48 bits/,
  );
});

test('DDS BC1 passes its blocks through with the mip chain and names texture-compression-bc', () => {
  // 8x8, three levels: 2x2, 1x1 and 1x1 blocks of 8 bytes.
  const blocks = sequence(32 + 8 + 8),
    file = parseDDS(dds({ width: 8, height: 8, mips: 4 - 1, fourCC: 'DXT1', data: blocks }));
  assert.equal(file.format, 'bc1-rgba-unorm');
  assert.equal(file.feature, 'texture-compression-bc');
  assert.equal(file.dimension, '2d');
  assert.equal(file.layers, 1);
  assert.equal(file.target, 'dds');
  assert.deepEqual(
    file.mipmaps.map((m) => [m.width, m.height, m.byteLength]),
    [
      [8, 8, 32],
      [4, 4, 8],
      [2, 2, 8],
    ],
  );
  assert.deepEqual(file.mipmaps[0].data, blocks.subarray(0, 32));
  assert.deepEqual(file.mipmaps[2].data, blocks.subarray(40));
  for (const [cc, format] of [
    ['DXT3', 'bc2-rgba-unorm'],
    ['DXT5', 'bc3-rgba-unorm'],
    ['ATI1', 'bc4-r-unorm'],
    ['BC4S', 'bc4-r-snorm'],
    ['ATI2', 'bc5-rg-unorm'],
    ['BC5S', 'bc5-rg-snorm'],
  ]) {
    const size = /bc4/.test(format) ? 8 : 16;
    const parsed = parseDDS(dds({ width: 4, height: 4, fourCC: cc, data: sequence(size) }));
    assert.equal(parsed.format, format);
    assert.deepEqual(parsed.mipmaps[0].data, sequence(size));
  }
});

test('DDS DX10: BC6H, BC7 sRGB cube map in layer order, arrays, float formats', () => {
  // A BC7 sRGB cube, 8x8 with 2 levels: each face stores its own mip chain (64 + 16 bytes).
  const faces = Array.from({ length: 6 }, (_, f) => sequence(80, f * 31)),
    cube = parseDDS(
      dds({
        width: 8,
        height: 8,
        mips: 2,
        dx10: { format: 99, misc: 4 },
        caps2: 0x200 | 0xfc00,
        data: faces.flatMap((f) => [...f]),
      }),
    );
  assert.equal(cube.format, 'bc7-rgba-unorm-srgb');
  assert.equal(cube.srgb, true);
  assert.equal(cube.dimension, 'cube');
  assert.equal(cube.layers, 6);
  assert.deepEqual(cube.mipmaps[0].data, Uint8Array.from(faces.flatMap((f) => [...f.subarray(0, 64)])));
  assert.deepEqual(cube.mipmaps[1].data, Uint8Array.from(faces.flatMap((f) => [...f.subarray(64)])));
  const cubes = parseDDS(
    dds({ width: 4, height: 4, dx10: { format: 98, misc: 4, array: 2 }, data: sequence(16 * 12) }),
  );
  assert.deepEqual([cubes.dimension, cubes.layers, cubes.srgb], ['cube-array', 12, false]);
  for (const [format, name] of [
    [95, 'bc6h-rgb-ufloat'],
    [96, 'bc6h-rgb-float'],
  ]) {
    const parsed = parseDDS(dds({ width: 4, height: 4, dx10: { format }, data: sequence(16) }));
    assert.deepEqual([parsed.format, parsed.hasAlpha], [name, false]);
  }
  // A 2-layer rgba16float array with two levels, and the D3DFMT FourCC form.
  const half = parseDDS(dds({ width: 2, height: 2, mips: 2, dx10: { format: 10, array: 2 }, data: sequence(80) }));
  assert.deepEqual([half.format, half.dimension, half.layers], ['rgba16float', '2d-array', 2]);
  assert.deepEqual(
    half.mipmaps[0].data,
    Uint8Array.from([...sequence(80).subarray(0, 32), ...sequence(80).subarray(40, 72)]),
  );
  assert.deepEqual(
    half.mipmaps[1].data,
    Uint8Array.from([...sequence(80).subarray(32, 40), ...sequence(80).subarray(72)]),
  );
  assert.equal(half.feature, undefined);
  const legacyFloat = new Uint8Array(dds({ width: 1, height: 1, fourCC: 'XXXX', data: sequence(16) }));
  new DataView(legacyFloat.buffer).setUint32(84, 116, true);
  assert.equal(parseDDS(legacyFloat).format, 'rgba32float');
  for (const [format, name, bytes] of [
    [41, 'r32float', 4],
    [54, 'r16float', 2],
    [34, 'rg16float', 4],
    [28, 'rgba8unorm', 4],
    [29, 'rgba8unorm-srgb', 4],
    [61, 'r8unorm', 1],
    [49, 'rg8unorm', 2],
  ])
    assert.deepEqual(
      parseDDS(dds({ width: 3, height: 1, dx10: { format }, data: sequence(3 * bytes) })).mipmaps[0].data,
      sequence(3 * bytes),
      name,
    );
});

test('DDS uncompressed bit-mask formats become rgba8unorm', () => {
  const rgba = image(3, 2),
    count = 6,
    pack = (bits, f) => {
      const out = new Uint8Array(count * (bits / 8));
      for (let i = 0; i < count; i++) {
        const v = f(rgba.subarray(i * 4, i * 4 + 4));
        for (let b = 0; b < bits / 8; b++) out[i * (bits / 8) + b] = Math.floor(v / 2 ** (8 * b)) & 255;
      }
      return out;
    },
    scaled = (bitsPer) => (v) =>
      Math.round((Math.round((v * ((1 << bitsPer) - 1)) / 255) * 255) / ((1 << bitsPer) - 1));
  // BGRA8 (A8R8G8B8): swizzled back to RGBA.
  const bgra8 = pack(32, ([r, g, b, a]) => ((a << 24) >>> 0) + (r << 16) + (g << 8) + b);
  const masksBGRA = [0xff0000, 0xff00, 0xff, 0xff000000];
  let parsed = parseDDS(dds({ width: 3, height: 2, bits: 32, masks: masksBGRA, data: bgra8 }));
  assert.deepEqual([parsed.format, parsed.hasAlpha], ['rgba8unorm', true]);
  assert.deepEqual(parsed.mipmaps[0].data, rgba);
  assert.deepEqual(parseDDS(dds({ width: 3, height: 2, dx10: { format: 87 }, data: bgra8 })).mipmaps[0].data, rgba);
  // X8R8G8B8: alpha ignored.
  const opaque = rgba.map((v, i) => (i % 4 === 3 ? 255 : v));
  parsed = parseDDS(dds({ width: 3, height: 2, bits: 32, masks: [0xff0000, 0xff00, 0xff, 0], data: bgra8 }));
  assert.deepEqual([parsed.mipmaps[0].data, parsed.hasAlpha], [opaque, false]);
  assert.deepEqual(parseDDS(dds({ width: 3, height: 2, dx10: { format: 88 }, data: bgra8 })).mipmaps[0].data, opaque);
  // A8B8G8R8 is already RGBA8 and passes through.
  const abgr = parseDDS(
    dds({ width: 3, height: 2, bits: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000], data: rgba }),
  );
  assert.deepEqual(abgr.mipmaps[0].data, rgba);
  // R8G8B8 (24-bit, B first in memory).
  const bgr = pack(24, ([r, g, b]) => (r << 16) + (g << 8) + b);
  assert.deepEqual(
    parseDDS(dds({ width: 3, height: 2, bits: 24, masks: [0xff0000, 0xff00, 0xff, 0], data: bgr })).mipmaps[0].data,
    opaque,
  );
  // R5G6B5, as legacy masks and as DXGI 85.
  const s5 = scaled(5),
    s6 = scaled(6),
    q = (v, n) => Math.round((v * ((1 << n) - 1)) / 255),
    r565 = pack(16, ([r, g, b]) => (q(r, 5) << 11) | (q(g, 6) << 5) | q(b, 5)),
    e565 = Uint8Array.from(rgba, (v, i) => (i % 4 === 3 ? 255 : i % 4 === 1 ? s6(v) : s5(v)));
  assert.deepEqual(
    parseDDS(dds({ width: 3, height: 2, bits: 16, masks: [0xf800, 0x7e0, 0x1f, 0], data: r565 })).mipmaps[0].data,
    e565,
  );
  assert.deepEqual(parseDDS(dds({ width: 3, height: 2, dx10: { format: 85 }, data: r565 })).mipmaps[0].data, e565);
  // A1R5G5B5 and A4R4G4B4.
  const r5551 = pack(16, ([r, g, b, a]) => ((a >> 7) << 15) | (q(r, 5) << 10) | (q(g, 5) << 5) | q(b, 5)),
    e5551 = Uint8Array.from(rgba, (v, i) => (i % 4 === 3 ? (v >> 7) * 255 : s5(v)));
  assert.deepEqual(
    parseDDS(dds({ width: 3, height: 2, bits: 16, masks: [0x7c00, 0x3e0, 0x1f, 0x8000], data: r5551 })).mipmaps[0].data,
    e5551,
  );
  assert.deepEqual(parseDDS(dds({ width: 3, height: 2, dx10: { format: 86 }, data: r5551 })).mipmaps[0].data, e5551);
  const r4444 = pack(16, ([r, g, b, a]) => (q(a, 4) << 12) | (q(r, 4) << 8) | (q(g, 4) << 4) | q(b, 4));
  assert.deepEqual(
    parseDDS(dds({ width: 3, height: 2, dx10: { format: 115 }, data: r4444 })).mipmaps[0].data,
    Uint8Array.from(rgba, scaled(4)),
  );
  // L8 luminance and A8 alpha.
  const lum = sequence(6);
  assert.deepEqual(
    [
      ...parseDDS(dds({ width: 3, height: 2, bits: 8, masks: [0xff, 0, 0, 0], pfFlags: 0x20000, data: lum })).mipmaps[0]
        .data,
    ],
    [...lum].flatMap((v) => [v, v, v, 255]),
  );
  assert.deepEqual(
    [...parseDDS(dds({ width: 3, height: 2, bits: 8, masks: [0, 0, 0, 0xff], pfFlags: 2, data: lum })).mipmaps[0].data],
    [...lum].flatMap((v) => [0, 0, 0, v]),
  );
});

test('DDS refuses malformed and unsupported files with named errors', () => {
  const good = dds({ width: 4, height: 4, fourCC: 'DXT1', data: sequence(8) });
  assert.throws(() => parseDDS(good.buffer), TypeError);
  failed(() => parseDDS(good.subarray(0, 100)), /header is missing/);
  failed(() => parseDDS(good.subarray(0, good.length - 1)), /ends inside layer 0 mip 0/);
  failed(
    () => parseDDS(dds({ width: 4, height: 4, fourCC: 'ABCD', data: sequence(8) })),
    /FourCC ABCD is not supported/,
  );
  failed(
    () => parseDDS(dds({ width: 4, height: 4, fourCC: 'DXT1', caps2: 0x200000, data: sequence(8) })),
    /volume texture/,
  );
  failed(
    () => parseDDS(dds({ width: 4, height: 4, fourCC: 'DXT1', caps2: 0x200 | 0x400, data: sequence(8) })),
    /without all six faces/,
  );
  failed(
    () => parseDDS(dds({ width: 4, height: 4, dx10: { format: 98, dimension: 4 }, data: sequence(16) })),
    /resource dimension 4/,
  );
  failed(() => parseDDS(dds({ width: 4, height: 4, dx10: { format: 20 }, data: sequence(16) })), /DXGI format 20/);
  failed(() => parseDDS(dds({ width: 4, height: 4, mips: 9, fourCC: 'DXT1', data: sequence(8) })), /too many/);
  failed(
    () => parseDDS(dds({ width: 4, height: 4, bits: 12, masks: [0xf00, 0xf0, 0xf, 0], data: sequence(32) })),
    /12 bits/,
  );
});

test('uploadTexture writes every level of every layer, and names the missing compression feature', () => {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
  const bc = parseDDS(dds({ width: 8, height: 8, mips: 4, dx10: { format: 71, array: 2 }, data: sequence(2 * 64) }));
  assert.throws(
    () => uploadTexture(mockDevice(), bc),
    (error) =>
      error.name === 'MargoError' &&
      error.code === 'unsupported' &&
      /bc1-rgba-unorm needs the device feature texture-compression-bc; request it/.test(error.message),
  );
  const device = mockDevice(['texture-compression-bc']);
  uploadTexture(device, bc, { label: 'bricks' });
  assert.deepEqual(device.calls[0][1], {
    label: 'bricks',
    size: [8, 8, 2],
    mipLevelCount: 4,
    format: 'bc1-rgba-unorm',
    usage: 6,
  });
  // Levels 8, 4, 2, 1 texels: 2, 1, 1, 1 block rows; the small levels copy at the 4x4 physical size.
  assert.deepEqual(
    device.calls
      .slice(1)
      .map(([, destination, data, layout, size]) => [destination.mipLevel, data.length, layout, size]),
    [
      [0, 64, { bytesPerRow: 16, rowsPerImage: 2 }, [8, 8, 2]],
      [1, 16, { bytesPerRow: 8, rowsPerImage: 1 }, [4, 4, 2]],
      [2, 16, { bytesPerRow: 8, rowsPerImage: 1 }, [4, 4, 2]],
      [3, 16, { bytesPerRow: 8, rowsPerImage: 1 }, [4, 4, 2]],
    ],
  );
  const odd = parseDDS(dds({ width: 6, height: 4, fourCC: 'DXT1', data: sequence(16) }));
  assert.throws(() => uploadTexture(device, odd), RangeError);
  assert.throws(() => uploadTexture(device, { ...odd, format: 'depth24plus' }), TypeError);
  const plain = mockDevice();
  uploadKTX(plain, parseDDS(dds({ width: 3, height: 1, dx10: { format: 54 }, data: sequence(6) })));
  assert.deepEqual(plain.calls[1].slice(3), [{ bytesPerRow: 6, rowsPerImage: 1 }, [3, 1, 1]]);
});

test('a DX10 header with dimension and array size left at zero is one 2D texture', () => {
  // Real writers do this: bc1.dds and bc5_snorm.dds of Pillow's test images (tests/real-files/manifest.json).
  for (const dx10 of [{ format: 28, array: 0 }, { format: 28, dimension: 0, array: 0 }, { format: 28, dimension: 0 }]) {
    const file = parseDDS(dds({ width: 4, height: 4, dx10, data: sequence(64) }));
    assert.equal(file.format, 'rgba8unorm');
    assert.deepEqual([file.mipmaps.length, file.mipmaps[0].width], [1, 4]);
  }
});

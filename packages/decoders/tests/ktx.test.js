// KTX 1 reading (@margoengine/decoders/ktx) against files built by the test encoder (tests/support/texture-encoders.js,
// from the Khronos KTX 1.1 specification): every glInternalFormat mapped, mips with row padding, cubes, arrays, both
// byte orders, key/value data, refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKTX } from '../dist/ktx.js';
import { failed, image, ktx, rejects, sequence } from './support/texture-encoders.js';

const BC = 'texture-compression-bc',
  ETC = 'texture-compression-etc2',
  ASTC_FEATURE = 'texture-compression-astc';
// glInternalFormat, WebGPU format, block width, block height, bytes per block (texel), glTypeSize, feature.
const UNCOMPRESSED = [
  [0x8229, 'r8unorm', 1, 1, 1, 1],
  [0x8f94, 'r8snorm', 1, 1, 1, 1],
  [0x822b, 'rg8unorm', 1, 1, 2, 1],
  [0x8f95, 'rg8snorm', 1, 1, 2, 1],
  [0x8058, 'rgba8unorm', 1, 1, 4, 1],
  [0x8c43, 'rgba8unorm-srgb', 1, 1, 4, 1],
  [0x8f97, 'rgba8snorm', 1, 1, 4, 1],
  [0x822d, 'r16float', 1, 1, 2, 2],
  [0x822f, 'rg16float', 1, 1, 4, 2],
  [0x881a, 'rgba16float', 1, 1, 8, 2],
  [0x822e, 'r32float', 1, 1, 4, 4],
  [0x8230, 'rg32float', 1, 1, 8, 4],
  [0x8814, 'rgba32float', 1, 1, 16, 4],
  [0x8059, 'rgb10a2unorm', 1, 1, 4, 4],
  [0x8c3a, 'rg11b10ufloat', 1, 1, 4, 4],
  [0x8c3d, 'rgb9e5ufloat', 1, 1, 4, 4],
];
const ASTC_SIZES = [
  '4x4',
  '5x4',
  '5x5',
  '6x5',
  '6x6',
  '8x5',
  '8x6',
  '8x8',
  '10x5',
  '10x6',
  '10x8',
  '10x10',
  '12x10',
  '12x12',
];
const COMPRESSED = [
  [0x83f0, 'bc1-rgba-unorm', 4, 4, 8, BC],
  [0x83f1, 'bc1-rgba-unorm', 4, 4, 8, BC],
  [0x83f2, 'bc2-rgba-unorm', 4, 4, 16, BC],
  [0x83f3, 'bc3-rgba-unorm', 4, 4, 16, BC],
  [0x8c4c, 'bc1-rgba-unorm-srgb', 4, 4, 8, BC],
  [0x8c4d, 'bc1-rgba-unorm-srgb', 4, 4, 8, BC],
  [0x8c4e, 'bc2-rgba-unorm-srgb', 4, 4, 16, BC],
  [0x8c4f, 'bc3-rgba-unorm-srgb', 4, 4, 16, BC],
  [0x8dbb, 'bc4-r-unorm', 4, 4, 8, BC],
  [0x8dbc, 'bc4-r-snorm', 4, 4, 8, BC],
  [0x8dbd, 'bc5-rg-unorm', 4, 4, 16, BC],
  [0x8dbe, 'bc5-rg-snorm', 4, 4, 16, BC],
  [0x8e8c, 'bc7-rgba-unorm', 4, 4, 16, BC],
  [0x8e8d, 'bc7-rgba-unorm-srgb', 4, 4, 16, BC],
  [0x8e8e, 'bc6h-rgb-float', 4, 4, 16, BC],
  [0x8e8f, 'bc6h-rgb-ufloat', 4, 4, 16, BC],
  [0x8d64, 'etc2-rgb8unorm', 4, 4, 8, ETC],
  [0x9270, 'eac-r11unorm', 4, 4, 8, ETC],
  [0x9271, 'eac-r11snorm', 4, 4, 8, ETC],
  [0x9272, 'eac-rg11unorm', 4, 4, 16, ETC],
  [0x9273, 'eac-rg11snorm', 4, 4, 16, ETC],
  [0x9274, 'etc2-rgb8unorm', 4, 4, 8, ETC],
  [0x9275, 'etc2-rgb8unorm-srgb', 4, 4, 8, ETC],
  [0x9276, 'etc2-rgb8a1unorm', 4, 4, 8, ETC],
  [0x9277, 'etc2-rgb8a1unorm-srgb', 4, 4, 8, ETC],
  [0x9278, 'etc2-rgba8unorm', 4, 4, 16, ETC],
  [0x9279, 'etc2-rgba8unorm-srgb', 4, 4, 16, ETC],
  ...ASTC_SIZES.flatMap((size, i) => {
    const [w, h] = size.split('x').map(Number);
    return [
      [0x93b0 + i, `astc-${size}-unorm`, w, h, 16, ASTC_FEATURE],
      [0x93d0 + i, `astc-${size}-unorm-srgb`, w, h, 16, ASTC_FEATURE],
    ];
  }),
];
/** Tight bytes of one `w` x `h` level of a format, and its bytes per row (of blocks). */
const levelSize = (bw, bh, bytes, w, h) => [Math.ceil(w / bw) * bytes * Math.ceil(h / bh), Math.ceil(w / bw) * bytes];

test('KTX maps every compressed glInternalFormat, with feature, sRGB and every mip size', () => {
  for (const [internal, format, bw, bh, bytes, feature] of COMPRESSED) {
    // Two blocks by two at level 0 plus a full chain down to 1x1.
    const width = bw * 2,
      height = bh * 2,
      levels = 32 - Math.clz32(Math.max(width, height)),
      images = Array.from({ length: levels }, (_, level) => [
        sequence(levelSize(bw, bh, bytes, Math.max(1, width >> level), Math.max(1, height >> level))[0], level),
      ]),
      label = `0x${internal.toString(16)}`;
    for (const big of [false, true]) {
      const file = parseKTX(
        ktx({
          internal,
          width,
          height,
          compressed: true,
          big,
          rowBytes: (w) => levelSize(bw, bh, bytes, w, 1)[1],
          images,
        }),
      );
      assert.deepEqual([file.format, file.feature, file.srgb], [format, feature, format.endsWith('-srgb')], label);
      assert.deepEqual(
        file.mipmaps.map((m) => m.data),
        images.map(([data]) => data),
        label,
      );
    }
  }
});

test('KTX maps every uncompressed glInternalFormat, strips row padding and swaps big-endian values', () => {
  // 3x2 with 2 levels (3x2, 1x1): rows of 3 texels pad to 4 bytes for the 1- and 2-byte formats.
  for (const [internal, format, , , bytes, typeSize] of UNCOMPRESSED)
    for (const big of [false, true]) {
      const images = [[sequence(6 * bytes, 1)], [sequence(bytes, 2)]],
        file = parseKTX(
          ktx({
            internal,
            typeSize,
            width: 3,
            height: 2,
            big,
            swap: big && typeSize > 1 ? typeSize : 0,
            rowBytes: (w) => w * bytes,
            images,
          }),
        );
      assert.deepEqual([file.format, file.feature, file.srgb], [format, undefined, format.endsWith('-srgb')], format);
      assert.deepEqual(
        file.mipmaps.map((m) => [m.width, m.height, m.data]),
        [
          [3, 2, images[0][0]],
          [1, 1, images[1][0]],
        ],
        `${format} big ${big}`,
      );
    }
  // RGB8 and SRGB8 expand to RGBA8 (rows of 9 bytes pad to 12).
  for (const [internal, format] of [
    [0x8051, 'rgba8unorm'],
    [0x8c41, 'rgba8unorm-srgb'],
  ]) {
    const rgb = sequence(18, 4),
      file = parseKTX(ktx({ internal, width: 3, height: 2, rowBytes: (w) => w * 3, images: [[rgb]] }));
    assert.deepEqual([file.format, file.hasAlpha], [format, false]);
    assert.deepEqual(
      [...file.mipmaps[0].data],
      [...rgb].flatMap((v, i) => (i % 3 === 2 ? [v, 255] : [v])),
    );
  }
});

test('KTX full mip chains with row padding, cubes, arrays and cube arrays, both byte orders', () => {
  // R8 5x3: levels 5x3, 2x1, 1x1, every row padded to 4 bytes.
  const chain = [sequence(15), sequence(2, 9), sequence(1, 3)];
  const r8 = parseKTX(
    ktx({ internal: 0x8229, width: 5, height: 3, rowBytes: (w) => w, images: chain.map((d) => [d]) }),
  );
  assert.deepEqual(
    r8.mipmaps.map((m) => [m.width, m.height, m.data]),
    [
      [5, 3, chain[0]],
      [2, 1, chain[1]],
      [1, 1, chain[2]],
    ],
  );
  // rg16float cube, 2x2 with 2 levels, and a cube array of 2 (12 layers), in both byte orders.
  for (const big of [false, true])
    for (const array of [0, 2]) {
      const layers = (array || 1) * 6,
        images = [0, 1].map((level) =>
          Array.from({ length: layers }, (_, f) => sequence(level ? 4 : 16, f * 11 + level)),
        ),
        file = parseKTX(
          ktx({
            internal: 0x822f,
            typeSize: 2,
            width: 2,
            height: 2,
            faces: 6,
            array,
            big,
            swap: big ? 2 : 0,
            rowBytes: (w) => w * 4,
            images,
          }),
        );
      assert.deepEqual([file.dimension, file.layers], [array ? 'cube-array' : 'cube', layers]);
      images.forEach((faces, level) =>
        assert.deepEqual(
          file.mipmaps[level].data,
          Uint8Array.from(faces.flatMap((f) => [...f])),
          `big ${big} array ${array}`,
        ),
      );
    }
  // A 3-layer BC4 array, 8x8 with 4 levels.
  const bc4 = Array.from({ length: 4 }, (_, level) =>
      Array.from({ length: 3 }, (_, n) => sequence(level ? 8 : 32, n + level)),
    ),
    file = parseKTX(
      ktx({
        internal: 0x8dbb,
        width: 8,
        height: 8,
        array: 3,
        compressed: true,
        rowBytes: (w) => Math.ceil(w / 4) * 8,
        images: bc4,
      }),
    );
  assert.deepEqual([file.dimension, file.layers, file.mipmaps.length], ['2d-array', 3, 4]);
  bc4.forEach((layers, level) =>
    assert.deepEqual(file.mipmaps[level].data, Uint8Array.from(layers.flatMap((l) => [...l]))),
  );
});

test('KTX skips key/value data of several pairs', () => {
  const pair = (key, value) => {
    const body = [...Buffer.from(key + '\0', 'latin1'), ...value],
      padded = [...body, ...new Array((4 - (body.length % 4)) % 4).fill(0)];
    return [body.length & 255, body.length >> 8, 0, 0, ...padded];
  };
  const keyValue = [
      ...pair('KTXorientation', Buffer.from('S=r,T=d\0')),
      ...pair('Writer', Buffer.from('test')),
      ...pair('x', []),
    ],
    data = sequence(16),
    file = parseKTX(ktx({ internal: 0x8058, width: 2, height: 2, rowBytes: (w) => w * 4, images: [[data]], keyValue }));
  assert.deepEqual(file.mipmaps[0].data, data);
});

test('KTX refuses bad identifiers, truncation, bad sizes, partial cubes and unsupported formats, naming the fix', () => {
  const good = () => ktx({ internal: 0x8058, width: 2, height: 2, rowBytes: (w) => w * 4, images: [[sequence(16)]] }),
    patched = (at, value, file = good()) => {
      new DataView(file.buffer).setUint32(at, value, true);
      return file;
    },
    make = (options) =>
      ktx({ internal: 0x8058, width: 2, height: 2, rowBytes: (w) => w * 4, images: [[sequence(16)]], ...options });
  rejects(() => parseKTX(new Uint16Array(40)), TypeError, /needs the KTX file as a Uint8Array/);
  failed(() => parseKTX(good().subarray(0, 63)), /identifier is missing/);
  failed(() => parseKTX(patched(0, 0)), /identifier is missing/);
  failed(() => parseKTX(patched(12, 0x01020305)), /endianness field is invalid/);
  failed(() => parseKTX(patched(60, 1000)), /key\/value data runs past the end/);
  failed(() => parseKTX(good().subarray(0, 66)), /ends before mip 0/);
  failed(() => parseKTX(good().subarray(0, 70)), /ends inside mip 0/);
  failed(() => parseKTX(make({ imageSize: [12] })), /mip 0 imageSize 12 should be 16/);
  failed(() => parseKTX(patched(36, 0)), /size 0x2 is invalid/);
  failed(() => parseKTX(patched(36, 65537)), /size 65537x2 is invalid/);
  failed(() => parseKTX(patched(40, 65537)), /size 2x65537 is invalid/);
  failed(() => parseKTX(patched(40, 0)), /1D texture is not supported; convert/);
  failed(() => parseKTX(patched(44, 4)), /3D texture is not supported/);
  // A partial cube (3 faces) and no faces at all.
  failed(() => parseKTX(patched(52, 3)), /numberOfFaces 3 is invalid/);
  failed(() => parseKTX(patched(52, 0)), /numberOfFaces 0 is invalid/);
  failed(
    () => parseKTX(make({ width: 2, height: 1, faces: 6, images: [Array.from({ length: 6 }, () => sequence(8))] })),
    /cube faces are not square/,
  );
  failed(() => parseKTX(patched(56, 3)), /has 3 mip levels, too many/);
  // Integer, depth and luminance formats.
  for (const internal of [0x8d7c, 0x81a5, 0x8040, 0])
    failed(
      () => parseKTX(patched(28, internal)),
      new RegExp(`glInternalFormat 0x${internal.toString(16)} is not supported`),
    );
});

test('KTX RGBA8 mips with key/value data skipped', () => {
  const levels = [image(4, 4), image(2, 2, 2), image(1, 1, 3)],
    kv = [...new Uint8Array(new Uint32Array([12]).buffer), ...Buffer.from('KTXorient\0\0\0', 'latin1')],
    file = parseKTX(
      ktx({
        internal: 0x8058,
        width: 4,
        height: 4,
        rowBytes: (w) => w * 4,
        images: levels.map((l) => [l]),
        keyValue: kv,
      }),
    );
  assert.deepEqual(
    [file.format, file.dimension, file.layers, file.target, file.srgb, file.hasAlpha],
    ['rgba8unorm', '2d', 1, 'ktx', false, true],
  );
  assert.deepEqual(
    file.mipmaps.map((m) => m.data),
    levels,
  );
  const srgb = parseKTX(ktx({ internal: 0x8c43, width: 1, height: 1, rowBytes: (w) => w * 4, images: [[levels[2]]] }));
  assert.deepEqual([srgb.format, srgb.srgb], ['rgba8unorm-srgb', true]);
});

test('KTX row padding, mip padding and cube faces with R8, RGB8 expansion', () => {
  // R8 3x3 cube with 2 levels: rows pad from 3 to 4 bytes, so each face is 12 bytes (level 1: 4 bytes).
  const faces = (level) => Array.from({ length: 6 }, (_, f) => sequence(level ? 1 : 9, f * 13 + level));
  const cube = parseKTX(
    ktx({ internal: 0x8229, width: 3, height: 3, faces: 6, rowBytes: (w) => w, images: [faces(0), faces(1)] }),
  );
  assert.deepEqual([cube.format, cube.dimension, cube.layers, cube.hasAlpha], ['r8unorm', 'cube', 6, false]);
  assert.deepEqual(cube.mipmaps[0].data, Uint8Array.from(faces(0).flatMap((f) => [...f])));
  assert.deepEqual(cube.mipmaps[1].data, Uint8Array.from(faces(1).flatMap((f) => [...f])));
  // An RG8 array of 2 at 5x2.
  const layers = [sequence(20), sequence(20, 3)],
    rg = parseKTX(ktx({ internal: 0x822b, width: 5, height: 2, array: 2, rowBytes: (w) => w * 2, images: [layers] }));
  assert.deepEqual([rg.format, rg.dimension, rg.layers], ['rg8unorm', '2d-array', 2]);
  assert.deepEqual(rg.mipmaps[0].data, Uint8Array.from([...layers[0], ...layers[1]]));
  // RGB8 rows of 3 * 3 = 9 bytes pad to 12 and expand to RGBA8.
  const rgb = sequence(18),
    expanded = parseKTX(ktx({ internal: 0x8051, width: 3, height: 2, rowBytes: (w) => w * 3, images: [[rgb]] }));
  assert.equal(expanded.format, 'rgba8unorm');
  assert.deepEqual(
    [...expanded.mipmaps[0].data],
    [...rgb].flatMap((v, i) => (i % 3 === 2 ? [v, 255] : [v])),
  );
});

test('KTX big-endian half floats are swapped; compressed BC, ETC2 and ASTC pass through', () => {
  const halves = new Uint16Array([0x3c00, 0xc000, 0x7bff, 0x0001, 0x3555, 0x8000, 0x0000, 0x4248]),
    native = new Uint8Array(halves.buffer),
    file = ktx({
      internal: 0x881a,
      type: 0x140b,
      typeSize: 2,
      width: 1,
      height: 2,
      rowBytes: (w) => w * 8,
      images: [[native]],
      big: true,
      swap: 2,
    });
  // The writer stores each 16-bit value big-endian.
  assert.notDeepEqual(file.subarray(file.length - 16), native);
  const parsed = parseKTX(file);
  assert.equal(parsed.format, 'rgba16float');
  assert.deepEqual(new Uint16Array(parsed.mipmaps[0].data.slice().buffer), halves);
  // BC1 array of 2 with 2 levels: imageSize counts the whole level.
  const bc = parseKTX(
    ktx({
      internal: 0x83f1,
      width: 8,
      height: 4,
      array: 2,
      compressed: true,
      rowBytes: (w) => Math.ceil(w / 4) * 8,
      images: [
        [sequence(16), sequence(16, 1)],
        [sequence(8, 2), sequence(8, 3)],
      ],
    }),
  );
  assert.deepEqual(
    [bc.format, bc.feature, bc.layers, bc.mipmaps.length],
    ['bc1-rgba-unorm', 'texture-compression-bc', 2, 2],
  );
  assert.deepEqual(bc.mipmaps[1].data, Uint8Array.from([...sequence(8, 2), ...sequence(8, 3)]));
  for (const [internal, format, feature, bytes] of [
    [0x9278, 'etc2-rgba8unorm', 'texture-compression-etc2', 16],
    [0x9274, 'etc2-rgb8unorm', 'texture-compression-etc2', 8],
    [0x8d64, 'etc2-rgb8unorm', 'texture-compression-etc2', 8],
    [0x9270, 'eac-r11unorm', 'texture-compression-etc2', 8],
    [0x8e8d, 'bc7-rgba-unorm-srgb', 'texture-compression-bc', 16],
    [0x8dbe, 'bc5-rg-snorm', 'texture-compression-bc', 16],
    [0x93b0, 'astc-4x4-unorm', 'texture-compression-astc', 16],
    [0x93d4, 'astc-6x6-unorm-srgb', 'texture-compression-astc', 16],
  ]) {
    const block = /6x6/.test(format) ? 6 : 4,
      data = sequence(bytes * 4),
      result = parseKTX(
        ktx({
          internal,
          width: block * 2,
          height: block * 2,
          compressed: true,
          rowBytes: (w) => Math.ceil(w / block) * bytes,
          images: [[data]],
        }),
      );
    assert.deepEqual([result.format, result.feature], [format, feature]);
    assert.deepEqual(result.mipmaps[0].data, data);
  }
});

test('KTX refuses malformed and unsupported files with named errors', () => {
  const good = ktx({ internal: 0x8058, width: 1, height: 1, rowBytes: (w) => w * 4, images: [[sequence(4)]] });
  assert.throws(() => parseKTX('KTX'), TypeError);
  failed(() => parseKTX(good.subarray(0, 40)), /identifier is missing/);
  const ktx2 = good.slice();
  ktx2[5] = 0x32;
  failed(() => parseKTX(ktx2), /identifier is missing/);
  const endian = good.slice();
  endian[12] = 9;
  failed(() => parseKTX(endian), /endianness/);
  failed(() => parseKTX(good.subarray(0, good.length - 2)), /ends inside mip 0/);
  failed(
    () =>
      parseKTX(
        ktx({ internal: 0x8058, width: 1, height: 1, rowBytes: (w) => w * 4, images: [[sequence(4)]], imageSize: [8] }),
      ),
    /imageSize 8 should be 4/,
  );
  failed(
    () => parseKTX(ktx({ internal: 0x8d9f, width: 1, height: 1, rowBytes: (w) => w * 4, images: [[sequence(4)]] })),
    /glInternalFormat 0x8d9f/,
  );
  failed(
    () =>
      parseKTX(
        ktx({ internal: 0x8058, width: 1, height: 1, depth: 2, rowBytes: (w) => w * 4, images: [[sequence(8)]] }),
      ),
    /3D texture/,
  );
  failed(
    () => parseKTX(ktx({ internal: 0x8058, width: 1, height: 0, rowBytes: (w) => w * 4, images: [[sequence(4)]] })),
    /1D texture/,
  );
  failed(
    () =>
      parseKTX(
        ktx({ internal: 0x8058, width: 2, height: 1, faces: 6, rowBytes: (w) => w * 4, images: [[sequence(8)]] }),
      ),
    /not square/,
  );
});

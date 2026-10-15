import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseHDR,
  parseEXR,
  parseEnvironmentImage,
  halfToFloat,
  floatToHalf,
  shBasis,
  evaluateSH,
  projectEquirectSH,
  radianceToIrradianceSH,
  SH_BASIS,
  Environment,
  EnvironmentBackground,
  Skybox,
  IBL_WGSL,
  iblLayoutEntries,
} from '../dist/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name) => readFileSync(fixtures + name);
const reference = JSON.parse(readFileSync(fixtures + 'reference.json', 'utf8'));
const digest = (data) => {
  const copy = new Float32Array(data),
    bits = new Uint32Array(copy.buffer);
  for (let i = 0; i < copy.length; i++) if (Number.isNaN(copy[i])) bits[i] = 0x7fc00000;
  return createHash('sha256').update(new Uint8Array(copy.buffer)).digest('hex');
};
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

// ------------------------------------------------------------------ half floats and inflate

test('binary16 round trip covers every finite and special half value', () => {
  for (let bits = 0; bits < 65536; bits++) {
    const value = halfToFloat(bits);
    if (Number.isNaN(value)) {
      assert.ok((bits & 0x7c00) === 0x7c00 && bits & 0x3ff);
      assert.ok(Number.isNaN(halfToFloat(floatToHalf(value))));
      continue;
    }
    assert.equal(floatToHalf(value), bits, `half ${bits.toString(16)}`);
  }
  assert.equal(floatToHalf(65520), 0x7c00, 'rounds to infinity past the largest half');
  assert.equal(floatToHalf(65519), 0x7bff);
  assert.equal(floatToHalf(2 ** -25), 0, 'ties to even at the smallest subnormal');
  assert.equal(floatToHalf(1 + 2 ** -11), 0x3c00, 'ties to even');
  assert.equal(floatToHalf(1 + 3 * 2 ** -11), 0x3c02);
});

// ------------------------------------------------------------------ OpenEXR

const COMPRESSIONS = ['none', 'rle', 'zips', 'zip', 'piz'];
test('OpenEXR synthetic fixtures decode bit-exactly for every compression and channel layout', () => {
  let files = 0;
  for (const config of ['half-rgba', 'float-rgb', 'half-y', 'mixed']) {
    const expected = new Float32Array(new Uint8Array(fixture(`synthetic-${config}.f32`)).buffer);
    for (const compression of COMPRESSIONS) {
      const image = parseEXR(fixture(`synthetic-${config}-${compression}.exr`));
      assert.equal(image.compression, compression.toUpperCase());
      assert.equal(image.width, 37);
      assert.equal(image.height, 45);
      assert.equal(image.layout, config === 'half-y' ? 'Y' : config === 'float-rgb' ? 'RGB' : 'RGBA');
      assert.equal(image.data.length, expected.length);
      for (let i = 0; i < expected.length; i++)
        if (!same(image.data[i], expected[i]))
          assert.fail(`${config}/${compression} value ${i}: ${image.data[i]} != ${expected[i]}`);
      files++;
    }
  }
  assert.equal(files, 20);
  const mixed = parseEXR(fixture('synthetic-mixed-piz.exr'));
  assert.deepEqual(
    mixed.channels.map((c) => `${c.name}:${c.type}`),
    ['A:HALF', 'B:UINT', 'G:FLOAT', 'R:HALF', 'Z:FLOAT'],
  );
  const halfInfinity = parseEXR(fixture('synthetic-half-rgba-zip.exr'));
  assert.equal(halfInfinity.data[(10 * 37 + 20) * 4 + 1], Infinity, 'HALF overflow stays infinite in parsed data');
});

for (const [name, compression] of [
  ['BrightRings.exr', 'ZIP'],
  ['AllHalfValues.exr', 'PIZ'],
]) {
  test(`real OpenEXR file ${name} (${compression}) matches the reference OpenEXR library`, {
    skip: !existsSync(fixtures + name) && 'fixture missing',
  }, () => {
    const image = parseEXR(fixture(name));
    assert.equal(image.compression, compression);
    assert.equal(image.width, reference[name].width);
    assert.equal(image.height, reference[name].height);
    assert.equal(digest(image.data), reference[name].sha256);
  });
}

// A small writer for NONE, RLE, ZIPS and ZIP so the decoder is also checked against an encoder written here.
function writeEXR({ width, height, channels, compression, lineOrder = 0, rawWhenLarger = true, zlib = {} }) {
  const names = Object.keys(channels).sort();
  const types = names.map((n) => channels[n].type);
  const sizes = types.map((t) => (t === 'HALF' ? 2 : 4));
  const linesPerBlock = { NONE: 1, RLE: 1, ZIPS: 1, ZIP: 16 }[compression];
  const code = { NONE: 0, RLE: 1, ZIPS: 2, ZIP: 3 }[compression];
  const header = [];
  const str = (s) => {
    for (const ch of s) header.push(ch.charCodeAt(0));
    header.push(0);
  };
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    header.push(...b);
  };
  const attribute = (name, type, bytes) => {
    str(name);
    str(type);
    i32(bytes.length);
    header.push(...bytes);
  };
  const chlist = [];
  for (let i = 0; i < names.length; i++) {
    for (const ch of names[i]) chlist.push(ch.charCodeAt(0));
    chlist.push(0);
    const b = Buffer.alloc(16);
    b.writeInt32LE(['UINT', 'HALF', 'FLOAT'].indexOf(types[i]), 0);
    b.writeInt32LE(1, 8);
    b.writeInt32LE(1, 12);
    chlist.push(...b);
  }
  chlist.push(0);
  const box = (a, b, c, d) => {
    const x = Buffer.alloc(16);
    x.writeInt32LE(a, 0);
    x.writeInt32LE(b, 4);
    x.writeInt32LE(c, 8);
    x.writeInt32LE(d, 12);
    return [...x];
  };
  attribute('channels', 'chlist', chlist);
  attribute('compression', 'compression', [code]);
  attribute('dataWindow', 'box2i', box(0, 0, width - 1, height - 1));
  attribute('displayWindow', 'box2i', box(0, 0, width - 1, height - 1));
  attribute('lineOrder', 'lineOrder', [lineOrder]);
  attribute('pixelAspectRatio', 'float', [0, 0, 128, 63]);
  header.push(0);
  const blocks = Math.ceil(height / linesPerBlock),
    chunks = [];
  for (let block = 0; block < blocks; block++) {
    const y0 = block * linesPerBlock,
      lines = Math.min(linesPerBlock, height - y0);
    const raw = Buffer.alloc(lines * width * sizes.reduce((a, b) => a + b, 0));
    let o = 0;
    for (let y = y0; y < y0 + lines; y++)
      for (let c = 0; c < names.length; c++)
        for (let x = 0; x < width; x++) {
          const v = channels[names[c]].values[y * width + x];
          if (types[c] === 'HALF') {
            raw.writeUInt16LE(floatToHalf(v), o);
            o += 2;
          } else if (types[c] === 'FLOAT') {
            raw.writeFloatLE(v, o);
            o += 4;
          } else {
            raw.writeUInt32LE(v, o);
            o += 4;
          }
        }
    let packed = raw;
    if (compression !== 'NONE') {
      const split = Buffer.alloc(raw.length),
        half = (raw.length + 1) >> 1;
      for (let i = 0, a = 0, b = half; i < raw.length; ) {
        split[a++] = raw[i++];
        if (i < raw.length) split[b++] = raw[i++];
      }
      for (let i = split.length - 1; i > 0; i--) split[i] = (split[i] - split[i - 1] + 128 + 256) & 255;
      if (compression === 'RLE') {
        const out = [];
        for (let i = 0; i < split.length; ) {
          let run = 1;
          while (i + run < split.length && split[i + run] === split[i] && run < 128) run++;
          if (run >= 3) {
            out.push(run - 1, split[i]);
            i += run;
            continue;
          }
          const start = i;
          while (
            i < split.length &&
            i - start < 127 &&
            !(i + 2 < split.length && split[i] === split[i + 1] && split[i] === split[i + 2])
          )
            i++;
          out.push((256 - (i - start)) & 255, ...split.subarray(start, i));
        }
        packed = Buffer.from(out);
      } else packed = deflateSync(split, zlib);
      if (rawWhenLarger && packed.length >= raw.length) packed = raw;
    }
    const chunk = Buffer.alloc(8 + packed.length);
    chunk.writeInt32LE(y0, 0);
    chunk.writeInt32LE(packed.length, 4);
    packed.copy(chunk, 8);
    chunks.push(chunk);
  }
  if (lineOrder === 1) chunks.reverse();
  const tableStart = 8 + header.length,
    offsets = Buffer.alloc(blocks * 8);
  let offset = tableStart + offsets.length;
  const order = lineOrder === 1 ? [...Array(blocks).keys()].reverse() : [...Array(blocks).keys()];
  const positions = new Array(blocks);
  for (let i = 0; i < chunks.length; i++) {
    positions[order[i]] = offset;
    offset += chunks[i].length;
  }
  positions.forEach((p, i) => offsets.writeBigUInt64LE(BigInt(p), i * 8));
  const magic = Buffer.alloc(8);
  magic.writeUInt32LE(20000630, 0);
  magic.writeUInt32LE(2, 4);
  return Buffer.concat([magic, Buffer.from(header), offsets, ...chunks]);
}

test('OpenEXR decoder agrees with an independent in-test writer (NONE, RLE, ZIPS, ZIP, raw fallback, decreasing Y)', () => {
  const width = 19,
    height = 23,
    n = width * height;
  const R = Array.from({ length: n }, (_, i) => (i % 7) * 0.25),
    G = Array.from({ length: n }, (_, i) => Math.sin(i) * 100),
    B = Array.from({ length: n }, (_, i) => i * 3);
  const channels = { R: { type: 'HALF', values: R }, G: { type: 'FLOAT', values: G }, B: { type: 'UINT', values: B } };
  for (const compression of ['NONE', 'RLE', 'ZIPS', 'ZIP'])
    for (const lineOrder of [0, 1])
      for (const rawWhenLarger of [true, false]) {
        if (compression === 'NONE' && !rawWhenLarger) continue;
        const image = parseEXR(writeEXR({ width, height, channels, compression, lineOrder, rawWhenLarger }));
        for (let i = 0; i < n; i++) {
          assert.equal(image.data[i * 4], halfToFloat(floatToHalf(R[i])));
          assert.equal(image.data[i * 4 + 1], Math.fround(G[i]));
          assert.equal(image.data[i * 4 + 2], B[i]);
          assert.equal(image.data[i * 4 + 3], 1);
        }
      }
  // A constant image compresses well, so every compressor path (not the raw fallback) is exercised.
  const flat = {
    R: { type: 'HALF', values: new Array(n).fill(2) },
    G: { type: 'HALF', values: new Array(n).fill(0.5) },
    B: { type: 'HALF', values: new Array(n).fill(0) },
  };
  for (const compression of ['RLE', 'ZIPS', 'ZIP']) {
    const bytes = writeEXR({ width, height, channels: flat, compression });
    assert.ok(bytes.length < 1200, `${compression} did not compress`);
    const image = parseEXR(bytes);
    assert.deepEqual([...image.data.subarray(0, 4)], [2, 0.5, 0, 1]);
  }
});

test('ZIP chunks inflate correctly from stored, fixed-Huffman and dynamic-Huffman deflate streams', () => {
  const width = 64,
    height = 16,
    n = width * height;
  let seed = 99;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const values = Array.from({ length: n }, (_, i) => (i % 50 < 25 ? Math.floor(random() * 4) : random() * 1000));
  const channels = {
    R: { type: 'FLOAT', values },
    G: { type: 'HALF', values },
    B: { type: 'HALF', values: values.map((v) => v / 2) },
  };
  for (const zlib of [
    { level: 0 },
    { level: 9, strategy: constants.Z_FIXED },
    { level: 9 },
    { level: 1, strategy: constants.Z_HUFFMAN_ONLY },
    { level: 6, strategy: constants.Z_RLE },
  ]) {
    const image = parseEXR(writeEXR({ width, height, channels, compression: 'ZIP', rawWhenLarger: false, zlib }));
    for (let i = 0; i < n; i++) {
      assert.equal(image.data[i * 4], Math.fround(values[i]));
      assert.equal(image.data[i * 4 + 1], halfToFloat(floatToHalf(values[i])));
    }
  }
});

test('OpenEXR rejects unsupported and malformed files with errors instead of crashing or hanging', () => {
  const base = fixture('synthetic-half-rgba-piz.exr');
  const patched = (mutate) => {
    const copy = Buffer.from(base);
    mutate(copy);
    return copy;
  };
  assert.throws(() => parseEXR(Buffer.from('not an exr')), /magic/);
  assert.throws(() => parseEXR(patched((b) => b.writeUInt32LE(2 | 0x200, 4))), /tiled/);
  assert.throws(() => parseEXR(patched((b) => b.writeUInt32LE(2 | 0x1000, 4))), /multi-part/);
  assert.throws(() => parseEXR(patched((b) => b.writeUInt32LE(2 | 0x800, 4))), /deep/);
  const compressionAt = base.indexOf(Buffer.from('compression\0compression\0')) + 28;
  for (const [value, label] of [
    [5, 'PXR24'],
    [6, 'B44'],
    [8, 'DWAA'],
    [9, 'DWAB'],
  ])
    assert.throws(
      () =>
        parseEXR(
          patched((b) => {
            b[compressionAt] = value;
          }),
        ),
      new RegExp(`compression ${label}`),
    );
  // Truncation anywhere must fail cleanly.
  for (const name of [
    'synthetic-mixed-piz.exr',
    'synthetic-mixed-zip.exr',
    'synthetic-mixed-rle.exr',
    'synthetic-float-rgb-zips.exr',
  ]) {
    const bytes = fixture(name);
    for (let cut = 0; cut < bytes.length; cut += 37)
      assert.throws(() => parseEXR(bytes.subarray(0, cut)), Error, `${name} cut at ${cut}`);
  }
  // Random corruption of the pixel data either decodes to the right size or throws an Error.
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let rejected = 0,
    survived = 0;
  for (const name of [
    'synthetic-mixed-piz.exr',
    'synthetic-half-rgba-zip.exr',
    'synthetic-half-y-rle.exr',
    'AllHalfValues.exr',
  ]) {
    if (!existsSync(fixtures + name)) continue;
    const bytes = fixture(name),
      headerEnd = bytes.indexOf(Buffer.from('\0\0', 'binary'), 300);
    for (let trial = 0; trial < 60; trial++) {
      const copy = Buffer.from(bytes);
      for (let k = 0; k < 4; k++)
        copy[Math.floor(headerEnd + random() * (copy.length - headerEnd))] = Math.floor(random() * 256);
      try {
        const image = parseEXR(copy);
        assert.equal(image.data.length, image.width * image.height * 4);
        survived++;
      } catch (error) {
        assert.ok(
          error instanceof Error &&
            !(error instanceof RangeError && /Invalid array length|Maximum call stack/.test(error.message)),
          String(error),
        );
        rejected++;
      }
    }
  }
  assert.ok(rejected > 20, `only ${rejected} corrupt files rejected (${survived} decoded)`);
});

// ------------------------------------------------------------------ Radiance HDR

const rgbe = (m, e) => m * 2 ** (e - 136);
function writeHDR({ width, height, pixels, mode, orientation = '-Y' }) {
  const parts = [
    Buffer.from(
      `#?RADIANCE\n# test\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=2\nEXPOSURE=1.5\n\n${orientation} ${height} +X ${width}\n`,
      'latin1',
    ),
  ];
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * width * 4, (y + 1) * width * 4);
    if (mode === 'flat') {
      parts.push(Buffer.from(row));
      continue;
    }
    if (mode === 'old-rle') {
      const out = [];
      for (let x = 0; x < width; ) {
        out.push(...row.subarray(x * 4, x * 4 + 4));
        let run = 0;
        while (
          x + 1 + run < width &&
          row.subarray((x + 1 + run) * 4, (x + 2 + run) * 4).every((v, i) => v === row[x * 4 + i])
        )
          run++;
        x++;
        if (run > 0) {
          for (let shift = 0, left = run; left > 0; shift += 8) {
            const count = left & 255;
            if (count || left > 255) out.push(1, 1, 1, count);
            left >>= 8;
          }
          x += run;
        }
      }
      parts.push(Buffer.from(out));
      continue;
    }
    const out = [2, 2, width >> 8, width & 255];
    for (let c = 0; c < 4; c++) {
      const channel = Array.from({ length: width }, (_, x) => row[x * 4 + c]);
      for (let x = 0; x < width; ) {
        let run = 1;
        while (x + run < width && channel[x + run] === channel[x] && run < 127) run++;
        if (run >= 3) {
          out.push(128 + run, channel[x]);
          x += run;
          continue;
        }
        const start = x;
        while (
          x < width &&
          x - start < 128 &&
          !(x + 2 < width && channel[x] === channel[x + 1] && channel[x] === channel[x + 2])
        )
          x++;
        out.push(x - start, ...channel.slice(start, x));
      }
    }
    parts.push(Buffer.from(out));
  }
  return Buffer.concat(parts);
}

test('Radiance HDR decodes adaptive RLE, flat and old-style run scanlines and both Y orientations', () => {
  for (const [width, height] of [
    [40, 7],
    [5, 3],
    [300, 2],
  ]) {
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const runs = Math.floor(i / 5) % 3;
      pixels.set(
        runs === 0 ? [128, 64, 32, 129] : runs === 1 ? [i & 255, (i * 7) & 255, 255, 140] : [0, 0, 0, 0],
        i * 4,
      );
    }
    for (const mode of ['rle', 'flat', 'old-rle'])
      for (const orientation of ['-Y', '+Y']) {
        if (mode === 'rle' && width < 8) continue;
        const image = parseHDR(writeHDR({ width, height, pixels, mode, orientation }));
        assert.equal(image.width, width);
        assert.equal(image.height, height);
        assert.equal(image.exposure, 3);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const source = ((orientation === '+Y' ? height - 1 - y : y) * width + x) * 4,
              target = (y * width + x) * 4,
              e = pixels[source + 3];
            const expected = e ? [0, 1, 2].map((c) => rgbe(pixels[source + c], e)) : [0, 0, 0];
            assert.deepEqual(
              [...image.data.subarray(target, target + 4)],
              [...expected, 1],
              `${mode} ${orientation} ${width}x${height} pixel ${x},${y}`,
            );
          }
      }
  }
});

test('real Radiance file spot1Lux.hdr matches an independent reference decoder', {
  skip: !existsSync(fixtures + 'spot1Lux.hdr') && 'fixture missing',
}, () => {
  const image = parseHDR(fixture('spot1Lux.hdr'));
  assert.equal(image.width, 1024);
  assert.equal(image.height, 512);
  assert.equal(digest(image.data), reference['spot1Lux.hdr'].sha256);
  let max = 0;
  for (let i = 0; i < image.data.length; i += 4)
    max = Math.max(max, image.data[i], image.data[i + 1], image.data[i + 2]);
  assert.equal(max, reference['spot1Lux.hdr'].max);
  assert.equal(parseEnvironmentImage(fixture('spot1Lux.hdr')).width, 1024);
  assert.equal(parseEnvironmentImage(fixture('synthetic-half-y-zip.exr')).width, 37);
  assert.throws(() => parseEnvironmentImage(Buffer.from('GIF89a')), /Unrecognized/);
});

test('Radiance HDR rejects malformed input', () => {
  const pixels = new Uint8Array(16 * 2 * 4).fill(100);
  const good = writeHDR({ width: 16, height: 2, pixels, mode: 'rle' });
  assert.throws(() => parseHDR(Buffer.from('P6\n')), /signature/);
  assert.throws(() => parseHDR(Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n\0\0\0\0')), /xyze/);
  assert.throws(() => parseHDR(Buffer.from('#?RADIANCE\n\n+X 4 -Y 4\n')), /resolution/);
  assert.throws(() => parseHDR(Buffer.from('#?RADIANCE\n\n-Y 4 -X 4\n')), /mirrored/);
  assert.throws(() => parseHDR(Buffer.from('#?RADIANCE\n\n-Y 100000 +X 100000\n')), /size/);
  assert.throws(() => parseHDR(Buffer.from('#?RADIANCE\n')), /header/);
  for (let cut = 30; cut < good.length; cut += 3) assert.throws(() => parseHDR(good.subarray(0, cut)), Error);
  const mismatch = Buffer.from(good);
  mismatch[mismatch.indexOf(Buffer.from([2, 2, 0, 16])) + 3] = 17;
  assert.throws(() => parseHDR(mismatch), /width mismatch/);
  const overrun = Buffer.from(good);
  overrun[overrun.indexOf(Buffer.from([2, 2, 0, 16])) + 4] = 128 + 120;
  assert.throws(() => parseHDR(overrun), /bad run/);
});

// ------------------------------------------------------------------ spherical harmonics and module safety

test('CPU SH projection: constant radiance is L0 only and reconstructs exactly', () => {
  const width = 256,
    height = 128,
    data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([0.5, 1.25, 3, 1], i * 4);
  const sh = projectEquirectSH({ width, height, data });
  const scale = 2 * Math.sqrt(Math.PI);
  [0.5, 1.25, 3].forEach((c, i) => assert.ok(Math.abs(sh[i] - c * scale) < 1e-5 * scale));
  for (let k = 3; k < 27; k++) assert.ok(Math.abs(sh[k]) < 1e-4, `coefficient ${k} = ${sh[k]}`);
  const irradiance = radianceToIrradianceSH(sh);
  for (const d of [
    [0, 1, 0],
    [1, 0, 0],
    [0.3, -0.5, 0.8],
  ])
    evaluateSH(irradiance, d).forEach((v, i) => assert.ok(Math.abs(v - [0.5, 1.25, 3][i]) < 1e-4));
  const basis = shBasis(0, 0, 1);
  assert.equal(basis[2], SH_BASIS[2]);
  assert.ok(Math.abs(basis[6] - 2 * SH_BASIS[6]) < 1e-12);
});

test('module is SSR safe and validates without a GPU', async () => {
  const source = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(window|document)\./);
  assert.equal(Skybox, EnvironmentBackground);
  assert.match(IBL_WGSL, /fn iblShade/);
  globalThis.GPUShaderStage ??= { FRAGMENT: 2 };
  assert.equal(iblLayoutEntries(3).at(-1).binding, 7);
  await assert.rejects(Environment.create({}, { width: 2, height: 1, data: new Float32Array(8) }), /WebGPU/);
  await assert.rejects(
    Environment.create({ createTexture() {} }, { width: 2, height: 1, data: new Float32Array(4) }),
    TypeError,
  );
  for (const [width, height] of [
    [1.5, 2],
    [2, 1.5],
  ])
    await assert.rejects(Environment.create({}, { width, height, data: new Float32Array(12) }), /Equirect FloatImage/);
  const fake = { rotation: 0, device: null, disposed: false, roughnessToLod: () => 0 };
  const background = new EnvironmentBackground(fake, { exposure: 2, blur: 0.5 });
  assert.equal(background.exposure, 2);
  assert.throws(() => {
    background.blur = 2;
  }, RangeError);
  assert.throws(() => new EnvironmentBackground(fake, { order: 0 }), RangeError);
  assert.throws(() => background.setup({ backend: 'webgl2' }), /WebGPU/);
});

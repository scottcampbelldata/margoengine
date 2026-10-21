// parseHDR options: every Radiance scan order, RGB output, bounds, FORMAT checks and diagnostics; plus compatibility
// with Margo Voxel Studio's bounded importer (its fixtures, and a generated corpus whose digest its decoder produced).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseHDR } from '../dist/index.js';

const encode = (text) => new TextEncoder().encode(text);
const hdr = (resolution, body, header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n') =>
  new Uint8Array([...encode(`${header}${resolution}\n`), ...body]);
// Margo Voxel Studio's import profile: RGB, every scan order, FORMAT required, 128 MiB, 4096 x 2048, 32 KiB header.
const STUDIO = {
  channels: 3,
  orientation: 'all',
  requireFormat: true,
  limits: {
    maxBytes: 128 * 1024 * 1024,
    maxWidth: 4096,
    maxHeight: 2048,
    maxPixels: 8_388_608,
    maxHeaderBytes: 40_962,
  },
};
const code = (pattern) => (error) => error.name === 'MargoError' && pattern.test(error.code);

test('Studio fixtures: flat RGBE keeps linear high range, +Y and -X orders flip', () => {
  const map = parseHDR(hdr('-Y 1 +X 2', [128, 64, 32, 129, 32, 64, 128, 130]), STUDIO);
  assert.deepEqual([...map.data], [1, 0.5, 0.25, 0.5, 1, 2]);
  assert.equal(map.channels, 3);
  assert.deepEqual([...parseHDR(hdr('+Y 2 -X 1', [128, 0, 0, 129, 0, 128, 0, 129]), STUDIO).data], [0, 1, 0, 1, 0, 0]);
});

test('Studio fixtures: planar RLE literal and run packets, without row bleed', () => {
  const data = [2, 2, 0, 8, 136, 128, 8, 0, 16, 32, 48, 64, 80, 96, 112, 136, 0, 136, 129];
  const map = parseHDR(hdr('-Y 1 +X 8', data), STUDIO);
  assert.equal(map.data[0], 1);
  assert.equal(map.data[22], 0.875);
  assert.deepEqual(map.diagnostics.scanlines, { flat: 0, legacyRLE: 0, planarRLE: 1 });
  for (const bad of [data.slice(0, -1), [2, 2, 0, 8, 137, 128], [2, 2, 0, 8, 0]])
    assert.throws(() => parseHDR(hdr('-Y 1 +X 8', bad), STUDIO), code(/failed/));
});

test('Studio fixtures: malformed headers and oversized allocations fail before decoding', () => {
  assert.throws(() => parseHDR(hdr('-Y 2049 +X 4096', []), STUDIO), RangeError);
  assert.throws(() => parseHDR(hdr('-Y 2 +X 0', []), STUDIO), RangeError);
  assert.throws(() => parseHDR(hdr('nonsense', []), STUDIO), /resolution/);
  assert.throws(() => parseHDR(encode('not hdr'), STUDIO), /signature|header/);
});

test('Studio fixtures: legacy extended repeats and X-major scan order', () => {
  const map = parseHDR(hdr('-Y 1 +X 257', [128, 0, 0, 129, 1, 1, 1, 0, 1, 1, 1, 1]), STUDIO);
  assert.equal(map.data.length, 771);
  assert.equal(map.data[768], 1);
  assert.deepEqual(map.diagnostics.scanlines, { flat: 0, legacyRLE: 1, planarRLE: 0 });
  const columns = parseHDR(hdr('+X 1 -Y 2', [128, 0, 0, 129, 0, 128, 0, 129]), STUDIO);
  assert.deepEqual([...columns.data], [1, 0, 0, 0, 1, 0]);
  assert.equal(columns.diagnostics.scanAxis, 'Y');
});

test('all eight scan orders land as row 0 at the top and column 0 at the left', () => {
  const width = 3,
    height = 2,
    // Pixel (x, y) of the picture has red x * 16 + 16 and green y * 16 + 16 at exponent 136 (scale 1).
    pixel = (x, y) => [x * 16 + 16, y * 16 + 16, 0, 136];
  for (const majorY of [true, false])
    for (const majorSign of ['-', '+'])
      for (const minorSign of ['-', '+']) {
        const major = majorY ? height : width,
          minor = majorY ? width : height,
          body = [];
        for (let m = 0; m < major; m++)
          for (let n = 0; n < minor; n++) {
            // Inverse of the decoder's placement: -Y and +X store forwards.
            const fixed = majorY ? (majorSign === '-' ? m : height - 1 - m) : majorSign === '+' ? m : width - 1 - m,
              moving = majorY ? (minorSign === '+' ? n : width - 1 - n) : minorSign === '-' ? n : height - 1 - n;
            body.push(...(majorY ? pixel(moving, fixed) : pixel(fixed, moving)));
          }
        const resolution = majorY
          ? `${majorSign}Y ${height} ${minorSign}X ${width}`
          : `${majorSign}X ${width} ${minorSign}Y ${height}`;
        const image = parseHDR(hdr(resolution, body), { orientation: 'all' });
        assert.equal(image.width, width, resolution);
        assert.equal(image.height, height, resolution);
        assert.equal(image.diagnostics.orientation, resolution);
        assert.equal(image.diagnostics.scanAxis, majorY ? 'X' : 'Y');
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            assert.deepEqual(
              [...image.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)],
              [x * 16 + 16, y * 16 + 16, 0, 1],
              `${resolution} pixel ${x},${y}`,
            );
      }
});

test('without options parseHDR keeps its contract: RGBA, standard orders only', () => {
  const image = parseHDR(hdr('-Y 1 +X 2', [128, 64, 32, 129, 32, 64, 128, 130]));
  assert.equal(image.channels, 4);
  assert.deepEqual([...image.data], [1, 0.5, 0.25, 1, 0.5, 1, 2, 1]);
  assert.throws(() => parseHDR(hdr('-Y 1 -X 2', [])), code(/unsupported/));
  assert.throws(() => parseHDR(hdr('+X 1 -Y 2', [])), /resolution/);
  // A file without FORMAT is RGBE unless requireFormat is set.
  const bare = hdr('-Y 1 +X 1', [128, 0, 0, 129], '#?RADIANCE\n\n');
  assert.equal(parseHDR(bare).diagnostics.format, '');
  assert.throws(() => parseHDR(bare, { requireFormat: true }), code(/unsupported/));
});

test('XYZE and unknown formats are refused with the conversion to make', () => {
  const xyze = hdr('-Y 1 +X 1', [0, 0, 0, 0], '#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n');
  assert.throws(
    () => parseHDR(xyze, STUDIO),
    (error) =>
      error.name === 'MargoError' && error.code === 'unsupported' && /XYZE.*convert.*RGBE/i.test(error.message),
  );
  assert.throws(() => parseHDR(hdr('-Y 1 +X 1', [], '#?RADIANCE\nFORMAT=8-bit_rgb\n\n')), code(/unsupported/));
});

test('bounds are checked before the image is allocated', () => {
  const big = hdr('-Y 2048 +X 4096', []);
  assert.throws(() => parseHDR(big, { limits: { maxPixels: 1 << 20 } }), RangeError);
  assert.throws(() => parseHDR(big, { limits: { maxWidth: 4095 } }), /4095/);
  assert.throws(() => parseHDR(big, { limits: { maxHeight: 2047 } }), /2047/);
  assert.throws(() => parseHDR(big, { limits: { maxBytes: 16 } }), /16-byte limit/);
  const comments = `#?RADIANCE\n${'# note\n'.repeat(100)}FORMAT=32-bit_rle_rgbe\n\n`;
  assert.throws(
    () => parseHDR(hdr('-Y 1 +X 1', [1, 1, 1, 128], comments), { limits: { maxHeaderBytes: 512 } }),
    /header/,
  );
  assert.equal(parseHDR(hdr('-Y 1 +X 1', [128, 0, 0, 129], comments)).diagnostics.headerBytes, comments.length + 10);
  assert.throws(() => parseHDR(hdr('-Y 1 +X 1', [], `#?RADIANCE\n#${'x'.repeat(9000)}\n\n`)), /longer than 8192/);
  for (const limits of [{ maxPixels: 0 }, { maxPixels: 2 ** 27 }, { maxWidth: 1.5 }, { maxBytes: -1 }])
    assert.throws(() => parseHDR(hdr('-Y 1 +X 1', [128, 0, 0, 129]), { limits }), RangeError);
  assert.throws(() => parseHDR(hdr('-Y 1 +X 1', []), { channels: 2 }), RangeError);
  assert.throws(() => parseHDR(hdr('-Y 1 +X 1', []), { orientation: 'mirrored' }), TypeError);
});

test('damage reports the scanline and byte, and trailing bytes are counted', () => {
  const good = [2, 2, 0, 8, 136, 128, 136, 0, 136, 0, 136, 129];
  assert.throws(() => parseHDR(hdr('-Y 2 +X 8', [...good, 2, 2, 0, 9])), /scanline 1 \(byte \d+\)/);
  assert.throws(() => parseHDR(hdr('-Y 1 +X 2', [1, 1, 1, 1, 0, 0, 0, 0])), /run with no previous pixel at scanline 0/);
  assert.equal(parseHDR(hdr('-Y 1 +X 8', [...good, 7, 7])).diagnostics.trailingBytes, 2);
});

// Seeded corpus: 600 files over every scan order and scanline encoding. The expected digest is the SHA-256 of the
// RGB floats Margo Voxel Studio's own decoder (src/io/hdr.ts at Studio 4ec10f5) produced for the same files, each
// followed by its width and height; refused files contribute their index.
function corpus() {
  let seed = 20261020;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32,
    int = (n) => Math.floor(random() * n),
    files = [];
  for (let t = 0; t < 600; t++) {
    const majorY = random() < 0.5,
      width = 1 + int(40),
      height = 1 + int(12),
      major = majorY ? height : width,
      minor = majorY ? width : height,
      signs = [random() < 0.5 ? '-' : '+', random() < 0.5 ? '-' : '+'],
      resolution = majorY
        ? `${signs[0]}Y ${height} ${signs[1]}X ${width}`
        : `${signs[0]}X ${width} ${signs[1]}Y ${height}`,
      body = [];
    for (let m = 0; m < major; m++) {
      const pixels = [];
      let last = [int(256), int(256), int(256), 120 + int(20)];
      for (let n = 0; n < minor; n++) {
        if (random() < 0.4) last = [int(256), int(256), int(256), random() < 0.1 ? 0 : 110 + int(30)];
        pixels.push(...last);
      }
      const mode = int(3);
      if (mode === 2 && minor >= 8) {
        body.push(2, 2, minor >> 8, minor & 255);
        for (let c = 0; c < 4; c++)
          for (let x = 0; x < minor; ) {
            let run = 1;
            while (x + run < minor && pixels[(x + run) * 4 + c] === pixels[x * 4 + c] && run < 127) run++;
            if (run >= 3) {
              body.push(128 + run, pixels[x * 4 + c]);
              x += run;
              continue;
            }
            const count = Math.min(minor - x, 1 + int(128));
            body.push(count);
            for (let i = 0; i < count; i++) body.push(pixels[(x + i) * 4 + c]);
            x += count;
          }
        continue;
      }
      for (let x = 0; x < minor; ) {
        body.push(...pixels.slice(x * 4, x * 4 + 4));
        let run = 0;
        while (x + 1 + run < minor && [0, 1, 2, 3].every((i) => pixels[(x + 1 + run) * 4 + i] === pixels[x * 4 + i]))
          run++;
        x++;
        if (mode === 1 && run > 0) {
          for (let left = run; left > 0; left >>= 8) body.push(1, 1, 1, left & 255);
          x += run;
        }
      }
    }
    let bytes = hdr(resolution, body, '#?RADIANCE\n# corpus\nFORMAT=32-bit_rle_rgbe\n\n');
    if (t % 7 === 6) {
      bytes = bytes.slice();
      for (let i = int(5); i >= 0; i--) bytes[36 + int(bytes.length - 36)] = int(256);
      if (random() < 0.3) bytes = bytes.slice(0, int(bytes.length));
    }
    files.push(bytes);
  }
  return files;
}

test("a generated corpus decodes bit-identically to Margo Voxel Studio's decoder", () => {
  const hash = createHash('sha256');
  let decoded = 0;
  for (const [index, bytes] of corpus().entries()) {
    let image;
    try {
      image = parseHDR(bytes, STUDIO);
      // Studio's validateEnvironmentMap, which stays in the application, refuses radiance over 1e30 after decoding.
      if (image.data.some((value) => value > 1e30)) throw new RangeError('radiance over 1e30');
    } catch {
      hash.update(`refused ${index}\n`);
      continue;
    }
    decoded++;
    hash.update(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength));
    hash.update(`${image.width}x${image.height}\n`);
  }
  assert.equal(decoded, CORPUS_DECODED);
  assert.equal(hash.digest('hex'), CORPUS_SHA256);
});
const CORPUS_DECODED = 544;
const CORPUS_SHA256 = '75e5c1a7ea5aa793c0eac808f84bffb2e48fe6afea43b50808ccd71488e7424e';

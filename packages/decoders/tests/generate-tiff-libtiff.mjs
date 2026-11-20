// Writes tests/fixtures/tiff-libtiff/: TIFF files made by the libtiff command-line tools (tiffcp, raw2tiff; run as
// programs, their source never read) from sources this script builds with the test encoder, and tiff2rgba's RGBA
// output for the lossy and colour-converted ones. Run by hand with libtiff 4.7 tools on PATH; the tests only read the
// committed files. node packages/decoders/tests/generate-tiff-libtiff.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bilevel, colour } from './support/tiff-sources.js';
import { tiff } from './support/texture-encoders.js';

const out = fileURLToPath(new URL('./fixtures/tiff-libtiff/', import.meta.url)),
  work = mkdtempSync(join(tmpdir(), 'tiff-libtiff-')),
  run = (tool, ...args) => execFileSync(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
mkdirSync(out, { recursive: true });
const source = (name, options) => {
  const path = join(work, name);
  writeFileSync(path, tiff(options));
  return path;
};
/** tiff2rgba's RGBA (uncompressed, one strip), saved raw, top row first. */
const rgbaOf = (file, name) => {
  const target = join(work, `${name}.rgba.tif`);
  run('tiff2rgba', '-c', 'none', '-r', '100000', join(out, file), target);
  const bytes = readFileSync(target),
    view = new DataView(bytes.buffer, bytes.byteOffset),
    ifd = view.getUint32(4, true),
    count = view.getUint16(ifd, true);
  let offset = 0,
    size = 0;
  for (let e = 0; e < count; e++) {
    const at = ifd + 2 + e * 12,
      id = view.getUint16(at, true);
    if (id === 273) offset = view.getUint32(at + 8, true);
    if (id === 279) size = view.getUint32(at + 8, true);
  }
  writeFileSync(join(out, `${name}.rgba`), bytes.subarray(offset, offset + size));
};
try {
  // Bilevel: CCITT Group 3 (1D, 2D, 2D with byte-aligned EOLs), Group 4, strips, tiles and FillOrder 2.
  const { width, height, samples } = bilevel();
  const fax = source('fax.tif', { width, height, spp: 1, bits: 1, photometric: 0, samples });
  for (const [name, args] of Object.entries({
    'g3-1d': ['-c', 'g3:1d'],
    'g3-2d': ['-c', 'g3:2d', '-r', '16'],
    'g3-2d-fill': ['-c', 'g3:2d:fill', '-r', '8'],
    'g4-strips': ['-c', 'g4', '-r', '7'],
    'g4-tiles': ['-c', 'g4', '-t', '-w', '256', '-l', '16'],
    'g4-lsb2msb': ['-c', 'g4', '-f', 'lsb2msb'],
    'g3-lsb2msb': ['-c', 'g3:2d', '-f', 'lsb2msb'],
  }))
    run('tiffcp', ...args, fax, join(out, `${name}.tif`));
  // Continuous tone: JPEG (YCbCr 2 x 2 in strips and tiles, RGB, grey, CMYK), and LZW CMYK.
  const rgb = colour(48, 32, 3),
    rgbFile = source('rgb.tif', { width: 48, height: 32, spp: 3, bits: 8, photometric: 2, samples: rgb });
  const grey = source('grey.tif', {
    width: 48,
    height: 32,
    spp: 1,
    bits: 8,
    photometric: 1,
    samples: colour(48, 32, 1),
  });
  const cmyk = source('cmyk.tif', {
    width: 48,
    height: 32,
    spp: 4,
    bits: 8,
    photometric: 5,
    samples: colour(48, 32, 4),
  });
  for (const [name, args, from] of [
    ['jpeg-ycbcr-strips', ['-c', 'jpeg:90', '-r', '16'], rgbFile],
    ['jpeg-ycbcr-tiles', ['-c', 'jpeg:90', '-t', '-w', '32', '-l', '16'], rgbFile],
    ['jpeg-rgb', ['-c', 'jpeg:r:90', '-r', '8'], rgbFile],
    ['jpeg-rgb-planar', ['-c', 'jpeg:r:90', '-r', '16', '-p', 'separate'], rgbFile],
    ['jpeg-grey', ['-c', 'jpeg:90', '-r', '16'], grey],
    ['jpeg-cmyk', ['-c', 'jpeg:90', '-r', '16'], cmyk],
    ['cmyk', ['-c', 'lzw'], cmyk],
  ]) {
    run('tiffcp', ...args, from, join(out, `${name}.tif`));
    rgbaOf(`${name}.tif`, name);
  }
  // LZMA (34925), Zstandard (50000) and WebP (50001) as libtiff writes them: strips and tiles, Predictor 2 on 8 and
  // 16-bit RGB, the floating point predictor on 32-bit float grey, lossless WebP (level 100) RGB and RGBA, and lossy
  // WebP, whose reference is tiff2rgba's. The lossless ones are checked against the files they were made from.
  const rgb16 = source('rgb16.tif', {
      width: 48,
      height: 32,
      spp: 3,
      bits: 16,
      photometric: 2,
      samples: Array.from(rgb, (v, i) => v * 257 + (i % 7)),
    }),
    rgbaFile = source('rgba.tif', {
      width: 48,
      height: 32,
      spp: 4,
      bits: 8,
      photometric: 2,
      extra: 2,
      samples: colour(48, 32, 4),
    }),
    floatFile = source('float.tif', {
      width: 48,
      height: 32,
      spp: 1,
      bits: 32,
      float: true,
      photometric: 1,
      samples: Array.from(colour(48, 32, 1), (v, i) => v / 255 - 0.25 + i * 1e-4),
    });
  for (const [name, args, from] of [
    ['lzma-strips', ['-c', 'lzma', '-r', '7'], rgbFile],
    ['lzma-tiles-predictor', ['-c', 'lzma:2', '-t', '-w', '32', '-l', '16'], rgb16],
    ['lzma-float', ['-c', 'lzma:3', '-r', '9'], floatFile],
    ['zstd-strips', ['-c', 'zstd:2', '-r', '5'], rgbFile],
    ['zstd-tiles', ['-c', 'zstd', '-t', '-w', '32', '-l', '16'], rgb16],
    ['zstd-float', ['-c', 'zstd:3', '-t', '-w', '16', '-l', '16'], floatFile],
    ['webp-lossless', ['-c', 'webp:p100', '-r', '16'], rgbFile],
    ['webp-rgba-tiles', ['-c', 'webp:p100', '-t', '-w', '32', '-l', '16'], rgbaFile],
  ])
    run('tiffcp', ...args, from, join(out, `${name}.tif`));
  for (const [name, from] of [
    ['source-rgb', rgbFile],
    ['source-rgb16', rgb16],
    ['source-rgba', rgbaFile],
    ['source-float', floatFile],
  ])
    run('tiffcp', '-c', 'none', from, join(out, `${name}.tif`));
  run('tiffcp', '-c', 'webp:80', '-r', '16', rgbFile, join(out, 'webp-lossy.tif'));
  rgbaOf('webp-lossy.tif', 'webp-lossy');
  // Old-style JPEG (Compression 6): one interchange datastream from cjpeg, named by JPEGInterchangeFormat. The test
  // encoder stores the one strip at offset 8. Its reference is djpeg's output.
  const ppm = join(work, 'rgb.ppm');
  writeFileSync(ppm, Buffer.concat([Buffer.from('P6 48 32 255\n'), Uint8Array.from(rgb)]));
  const jpeg = run('cjpeg', '-quality', '90', '-sample', '2x2', ppm);
  writeFileSync(
    join(out, 'ojpeg.tif'),
    tiff({
      width: 48,
      height: 32,
      spp: 3,
      bits: 8,
      photometric: 6,
      compression: 6,
      samples: rgb,
      raw: [jpeg],
      tags: [
        [513, 4, [8]],
        [514, 4, [jpeg.length]],
      ],
    }),
  );
  writeFileSync(join(work, 'o.jpg'), jpeg);
  const pnm = run('djpeg', '-pnm', join(work, 'o.jpg')),
    pixels = pnm.subarray(pnm.length - 48 * 32 * 3);
  writeFileSync(
    join(out, 'ojpeg.rgba'),
    Uint8Array.from({ length: 48 * 32 * 4 }, (_, i) => (i % 4 === 3 ? 255 : pixels[(i >> 2) * 3 + (i % 4)])),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

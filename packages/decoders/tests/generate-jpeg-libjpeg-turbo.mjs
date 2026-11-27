// Writes tests/fixtures/jpeg-libjpeg-turbo/: lossless and 12-bit JPEG files made by the libjpeg-turbo command-line tools
// (cjpeg and djpeg, run as programs, their source never read) from images this script computes. A lossless file is
// checked against its source image, so only the .jpg is kept; a DCT file also keeps djpeg's floating point decode,
// gzipped. Run by hand with libjpeg-turbo 3 on PATH or in LIBJPEG_TURBO_BIN; the tests only read the committed files.
// node packages/decoders/tests/generate-jpeg-libjpeg-turbo.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { cases, image } from './support/jpeg-sources.js';

const out = fileURLToPath(new URL('./fixtures/jpeg-libjpeg-turbo/', import.meta.url)),
  work = mkdtempSync(join(tmpdir(), 'jpeg-ljt-')),
  bin = process.env.LIBJPEG_TURBO_BIN,
  run = (tool, ...args) => execFileSync(bin ? join(bin, tool) : tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
mkdirSync(out, { recursive: true });
/** Writes a binary PGM or PPM of the image's samples, two bytes each (most significant first) above 8 bits. */
function pnm(path, { width, height, components, precision, data }) {
  const max = 2 ** precision - 1,
    head = Buffer.from(`P${components === 1 ? 5 : 6}\n${width} ${height}\n${max}\n`),
    body = Buffer.alloc(data.length * (precision > 8 ? 2 : 1));
  data.forEach((value, i) => {
    if (precision > 8) body.writeUInt16BE(value, i * 2);
    else body[i] = value;
  });
  writeFileSync(path, Buffer.concat([head, body]));
}
/** The samples of a binary PGM or PPM, as little-endian 16-bit words. */
function samplesOf(path) {
  const bytes = readFileSync(path),
    head = /^P[56]\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(bytes.toString('latin1', 0, 40)),
    body = bytes.subarray(head[0].length),
    wide = Number(head[3]) > 255,
    out = Buffer.alloc(wide ? body.length : body.length * 2);
  for (let i = 0; i < out.length / 2; i++) out.writeUInt16LE(wide ? body.readUInt16BE(i * 2) : body[i], i * 2);
  return out;
}
try {
  for (const [name, entry] of Object.entries(cases)) {
    const source = join(work, `${name}.pnm`),
      target = join(out, `${name}.jpg`);
    pnm(source, image(entry));
    run('cjpeg', '-precision', String(entry.precision), ...entry.args, '-outfile', target, source);
    if (entry.args.includes('-lossless')) continue;
    const decoded = join(work, `${name}.out.pnm`);
    run('djpeg', '-dct', 'float', '-pnm', '-outfile', decoded, target);
    writeFileSync(join(out, `${name}.samples.gz`), gzipSync(samplesOf(decoded), { level: 9 }));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

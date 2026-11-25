// Packs NGA's EGM96 15-minute geoid grid (WW15MGH.GRD, ASCII metres) into packages/controls/data/egm96-15.bin: 721 rows
// (90 N to 90 S) x 1441 columns (0 to 360 E), little-endian int16 centimetres, 2,077,922 bytes, for
// @margoengine/controls/geoid. The source is public domain (NGA); see THIRD-PARTY-NOTICES.md. This script downloads
// nothing: fetch WW15MGH.GRD yourself and pass its path.
//   node scripts/geoid/pack-egm96.mjs path/to/WW15MGH.GRD [out.bin]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [source, out = resolve(import.meta.dirname, '../../packages/controls/data/egm96-15.bin')] = process.argv.slice(2);
if (!source) {
  console.error('usage: node scripts/geoid/pack-egm96.mjs path/to/WW15MGH.GRD [out.bin]');
  process.exit(2);
}
const ROWS = 721,
  COLUMNS = 1441;
const numbers = (await readFile(source, 'utf8')).trim().split(/\s+/).map(Number);
// Header: south north west east dlat dlon, then heights row by row from the north edge, west to east.
const [south, north, west, east, dlat, dlon] = numbers,
  heights = numbers.slice(6);
if (south !== -90 || north !== 90 || west !== 0 || east !== 360 || dlat !== 0.25 || dlon !== 0.25)
  throw new Error(
    `${source}: header ${numbers.slice(0, 6).join(' ')} is not the EGM96 15' grid (-90 90 0 360 .25 .25)`,
  );
if (heights.length !== ROWS * COLUMNS || !heights.every(Number.isFinite))
  throw new Error(`${source}: ${heights.length} heights, expected ${ROWS * COLUMNS} finite values`);
const bytes = Buffer.alloc(ROWS * COLUMNS * 2);
heights.forEach((m, i) => {
  const cm = Math.round(m * 100);
  if (cm < -32768 || cm > 32767) throw new Error(`${source}: ${m} m does not fit int16 centimetres`);
  bytes.writeInt16LE(cm, i * 2);
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, bytes);
console.log(
  `${out}: ${bytes.length} bytes, ${ROWS} x ${COLUMNS}, min ${Math.min(...heights)} m, max ${Math.max(...heights)} m`,
);

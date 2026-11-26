// scripts/geoid/pack-egm96.mjs on a grid of the real size (721 x 1441). It once ended by spreading every height into
// Math.min, which overflows the call stack on a full grid, so the pack failed after writing its file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/geoid/pack-egm96.mjs', import.meta.url));
const ROWS = 721,
  COLUMNS = 1441;

test('pack-egm96 packs a full-size grid, reports its range and writes int16 centimetres', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-egm96-'));
  try {
    const heights = Array.from({ length: ROWS * COLUMNS }, (_, i) => ((i % 20001) - 10000) / 100);
    writeFileSync(join(dir, 'grid.grd'), `-90 90 0 360 .25 .25\n${heights.join(' ')}\n`);
    const out = join(dir, 'out.bin');
    const log = execFileSync(process.execPath, [script, join(dir, 'grid.grd'), out], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(log, /2077922 bytes, 721 x 1441, min -100 m, max 100 m/);
    const bytes = readFileSync(out);
    assert.equal(bytes.length, ROWS * COLUMNS * 2);
    assert.equal(bytes.readInt16LE(0), -10000);
    assert.equal(bytes.readInt16LE(20000 * 2), 10000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

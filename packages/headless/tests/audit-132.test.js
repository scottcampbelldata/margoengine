// Regressions for the batch 132 audit of @margoengine/headless. Each test fails on the code before the audit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from '../../shared/crc32.js';
import { encodePNG } from '../dist/index.js';
import { decodePNG } from '../dist/compare.js';

test('decodePNG refuses a file whose first chunk is not IHDR (PNG specification, 5.6)', async () => {
  const width = 3,
    height = 2,
    file = await encodePNG({ width, height, data: new Uint8Array(width * height * 4).fill(200) });
  assert.equal((await decodePNG(file)).width, width);
  // The same 13 bytes under an ancillary name, with a CRC that matches, so only the chunk order is wrong.
  const renamed = file.slice();
  renamed.set([0x61, 0x48, 0x44, 0x52], 12); // 'aHDR'
  new DataView(renamed.buffer).setUint32(29, crc32(renamed.subarray(12, 29)));
  await assert.rejects(decodePNG(renamed), /Not a PNG file/);
});

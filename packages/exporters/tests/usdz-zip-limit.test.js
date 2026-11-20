// The USDZ ZIP writer: its end record counts entries in 16 bits (PKWARE APPNOTE 4.4.21, 4.4.22), so a package of
// more than 65,535 files must be refused, not written with a count that wraps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { storedZIP } from '../dist/usdz-write.js';

const entries = (n) => Array.from({ length: n }, (_, i) => [`t/${i}.png`, new Uint8Array(0)]);

test('a USDZ ZIP of 65,535 files records every one; 65,536 are refused', () => {
  const zip = storedZIP(entries(0xffff)),
    view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength),
    end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 8, true), 0xffff);
  assert.equal(view.getUint16(end + 10, true), 0xffff);
  assert.throws(() => storedZIP(entries(0x10000)), {
    name: 'RangeError',
    message: /65536 files, over the ZIP32 limit of 65,535/,
  });
});

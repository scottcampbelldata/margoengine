// ZIP entry names against the PKWARE APPNOTE.TXT 6.3.10 (2022): UTF-8 only with general purpose bit 11 (4.4.4),
// IBM Code Page 437 otherwise (appendix D.1).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readZipDirectory, readZipEntry, crc32 } from '../dist/common.js';

/** A one-entry stored archive whose name is `nameBytes` and whose general purpose flags are `flags`. */
function archive(nameBytes, flags, data = new Uint8Array([1, 2, 3])) {
  const local = new Uint8Array(30 + nameBytes.length + data.length),
    lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(6, flags, true);
  lv.setUint32(14, crc32(data), true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length),
    cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(8, flags, true);
  cv.setUint32(16, crc32(data), true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

test('a name without bit 11 reads as Code Page 437, with it as UTF-8', async () => {
  // 0x82 0x84 0x94 are e-acute, a-umlaut, o-umlaut in Code Page 437; as UTF-8 they are invalid and read as U+FFFD.
  const cp437 = archive(new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2f, 0x84, 0x94, 0x2e, 0x70, 0x6e, 0x67]), 0);
  const [entry] = readZipDirectory(cp437);
  assert.equal(entry.name, 'café/äö.png');
  assert.deepEqual([...(await readZipEntry(cp437, entry))], [1, 2, 3]);
  const utf8 = archive(new TextEncoder().encode('café/中.png'), 0x800);
  assert.equal(readZipDirectory(utf8)[0].name, 'café/中.png');
  assert.equal(readZipDirectory(archive(new TextEncoder().encode('plain/a.txt'), 0))[0].name, 'plain/a.txt');
});

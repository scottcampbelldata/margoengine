import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo, loadMargo } from '../dist/index.js';

const source = await readFile(new URL('./fixtures/triangle.margo', import.meta.url));
const bytes = () => Uint8Array.from(source);

// Every decode failure names the subject, the problem and the fix after a '; '.
test('decodeMargo errors name their fix', () => {
  const cases = [
    [() => decodeMargo('nope'), TypeError, /^Expected \.margo bytes; pass an ArrayBuffer/],
    [() => decodeMargo(bytes().subarray(1)), TypeError, /aligned.*; pass an ArrayBuffer/],
    [() => decodeMargo(bytes().subarray(0, 63)), RangeError, /^Invalid \.margo size; .*re-export/],
    [
      () => {
        const data = bytes();
        new DataView(data.buffer).setUint32(4, 2, true);
        return decodeMargo(data);
      },
      TypeError,
      /^Invalid \.margo header\/version\/stride; .*export it again/,
    ],
  ];
  for (const [run, type, message] of cases)
    assert.throws(run, (error) => error instanceof type && message.test(error.message));
});

test('loadMargo rejects non-HTTP(S) URLs with the fix', async () => {
  await assert.rejects(loadMargo({}, 'file:///scene.margo'), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /must use HTTP\(S\); pass an http: or https: URL/);
    return true;
  });
});

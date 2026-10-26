import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFBX } from '../dist/index.js';

// DX pass: a rejected FBX names its fix after a '; ' clause, and a damaged file is a coded error.
test('convertFBX rejects a tiny buffer with the accepted size range', async () => {
  await assert.rejects(
    () => convertFBX(new ArrayBuffer(4)),
    (error) => error instanceof RangeError && /; pass a 32 byte to 64 MiB FBX file$/.test(error.message),
  );
});

test('convertFBX reports a damaged binary file as a coded error that says how to recover', async () => {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode('Kaydara FBX Binary  \0'));
  await assert.rejects(
    () => convertFBX(bytes),
    (error) => error.name === 'MargoError' && error.code === 'failed' && /; re-export/.test(error.message),
  );
});

// Runs a package's built parser worker (dist/workers/*.js) in-process and returns its reply as the main thread would
// receive it: the request and the reply both go through structuredClone with the same transfer lists the browser uses,
// so a missing or duplicate transferable fails here. ImageBitmaps are stubbed in Node and travel as clones.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transferables } from '../../packages/shared/worker.js';

export async function runParseWorker(path, message) {
  const code = await readFile(path, 'utf8');
  let reply;
  const self = {
    postMessage(data, transfer = []) {
      reply = { data, transfer };
    },
  };
  new Function('self', code)(self);
  assert.equal(typeof self.onmessage, 'function', 'worker did not install onmessage');
  const request = structuredClone(message, { transfer: [...transferables(message)] });
  await self.onmessage({ data: request });
  assert.ok(reply, 'worker did not reply');
  if (reply.data.error) throw Object.assign(new Error(reply.data.error.message), reply.data.error);
  // Every buffer in the reply must be on the transfer list (moved, not copied).
  const buffers = reply.transfer.filter((item) => item instanceof ArrayBuffer),
    reachable = [...transferables(reply.data)].filter((item) => item instanceof ArrayBuffer);
  assert.ok(
    reachable.every((buffer) => buffers.includes(buffer)),
    'a reply buffer would be copied',
  );
  return structuredClone(reply.data, { transfer: buffers }).result;
}

/** Bytes of a typed array (or ArrayBuffer) as a Buffer view, for byte-for-byte comparison. */
export const bytes = (data) =>
  data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** Deep equality where every typed array must match byte for byte. */
export function assertSameBytes(actual, expected, path = 'value') {
  if (ArrayBuffer.isView(expected) || expected instanceof ArrayBuffer) {
    assert.equal(actual?.constructor, expected.constructor, `${path}: type`);
    assert.ok(bytes(actual).equals(bytes(expected)), `${path}: bytes differ`);
    return;
  }
  if (expected instanceof Map) {
    assertSameBytes([...actual], [...expected], path);
    return;
  }
  if (!expected || typeof expected !== 'object') {
    assert.ok(Object.is(actual, expected), `${path}: ${actual} !== ${expected}`);
    return;
  }
  assert.equal(Array.isArray(actual), Array.isArray(expected), `${path}: array`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`);
  for (const key of Object.keys(expected)) assertSameBytes(actual[key], expected[key], `${path}.${key}`);
}

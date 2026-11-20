// Shared readBytes / readResponse hold each chunk once (KB-LOADBYTES1). The proofs are counts, never timings: the
// bytes loading.js allocates while it reads, and the bytes still held in ArrayBuffers after a full collection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { readBytes, readResponse } from '../packages/shared/loading.js';

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc');
const heldBytes = () => {
  collect();
  collect();
  return process.memoryUsage().arrayBuffers;
};
const MiB = 1024 * 1024,
  Bytes = Uint8Array;

// Counts the bytes of every Uint8Array that loading.js itself makes while `run` goes. The global is swapped for a
// proxy that constructs the real Uint8Array (so instanceof and every result stay real), and a construction counts
// when loading.js is on its stack. The streams below make their chunks with the saved constructor, so they never count.
async function loaderAllocations(run) {
  let bytes = 0;
  globalThis.Uint8Array = new Proxy(Bytes, {
    construct(target, args, newTarget) {
      const made = Reflect.construct(target, args, newTarget === globalThis.Uint8Array ? target : newTarget);
      if (made.byteLength >= 1024 && /shared[\\/]loading\.js/.test(new Error().stack)) bytes += made.byteLength;
      return made;
    },
  });
  try {
    const result = await run();
    return { result, bytes };
  } finally {
    globalThis.Uint8Array = Bytes;
  }
}

// A 100 MiB stand-in, in fresh 1 MiB chunks so the stream holds none of it. `peak` records the bytes held after a full
// collection at every pull, the reader's copies included.
function streamed(chunks, peak) {
  const base = heldBytes();
  return new ReadableStream({
    pull(controller) {
      if (peak) peak.max = Math.max(peak.max, heldBytes() - base);
      if (chunks-- > 0) controller.enqueue(new Bytes(MiB).fill(chunks & 255));
      else controller.close();
    },
  });
}
const pattern = (chunks) => {
  const bytes = new Bytes(chunks * MiB);
  for (let i = 0; i < chunks; i++) bytes.fill((chunks - 1 - i) & 255, i * MiB, (i + 1) * MiB);
  return bytes;
};

test('a declared 100 MiB response is read straight into one buffer: no copy, held once (KB-LOADBYTES1)', async () => {
  const peak = { max: 0 },
    response = new Response(streamed(100, peak), { headers: { 'content-length': String(100 * MiB) } }),
    { result, bytes } = await loaderAllocations(() => readResponse(response, { maxBytes: 512 * MiB }));
  assert.equal(result.byteLength, 100 * MiB);
  assert.equal(result.buffer.byteLength, 100 * MiB);
  assert.equal(result.byteOffset, 0);
  assert.deepEqual(result, pattern(100));
  // The old reader copied every chunk as it arrived and again into the result: 209,715,200 B made, 2x the file
  // held at the end. Now one buffer of the declared size is made and handed back as is.
  assert.equal(bytes, 100 * MiB, `${bytes} bytes made by the reader for a 100 MiB file`);
  assert.ok(peak.max < 102 * MiB, `${peak.max} bytes held while reading 100 MiB`);
});

test('an undeclared 100 MiB stream keeps each chunk once and copies it once, into the result (KB-LOADBYTES1)', async () => {
  const { result, bytes } = await loaderAllocations(() => readBytes(streamed(100), { maxBytes: 512 * MiB }));
  assert.equal(result.byteLength, 100 * MiB);
  assert.equal(result.buffer.byteLength, 100 * MiB);
  assert.deepEqual(result, pattern(100));
  assert.equal(bytes, 100 * MiB, `${bytes} bytes made by the reader for a 100 MiB stream`);
});

const chunked = (...chunks) =>
  new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
  });

test('a declared length that is wrong, coded or a view still gives the exact bytes (KB-LOADBYTES1)', async () => {
  // Fewer bytes than declared: the exact bytes, in a buffer of their own size.
  const short = await readResponse(
    new Response(chunked(new Bytes([1, 2, 3])), { headers: { 'content-length': '8' } }),
    {
      maxBytes: 8,
    },
  );
  assert.deepEqual(short, new Bytes([1, 2, 3]));
  assert.equal(short.buffer.byteLength, 3);
  // More bytes than declared (a decoded body): what was filled, then the rest.
  const long = await readResponse(
    new Response(chunked(new Bytes([1, 2]), new Bytes([3, 4, 5]), new Bytes([6])), {
      headers: { 'content-length': '3' },
    }),
    { maxBytes: 8 },
  );
  assert.deepEqual(long, new Bytes([1, 2, 3, 4, 5, 6]));
  assert.equal(long.buffer.byteLength, 6);
  // A coded body's length counts the coded bytes, so it is not trusted for the decoded ones.
  const coded = await readResponse(
    new Response(chunked(new Bytes([9, 8, 7, 6])), { headers: { 'content-length': '2', 'content-encoding': 'gzip' } }),
    { maxBytes: 8 },
  );
  assert.deepEqual(coded, new Bytes([9, 8, 7, 6]));
  // A chunk that views part of a larger buffer is copied, so the source changing later does not change the result.
  const source = new Bytes([0, 1, 2, 3, 4, 5, 6, 7]),
    viewed = readBytes(chunked(source.subarray(2, 5), new Bytes([9])), { maxBytes: 8 });
  const result = await viewed;
  source.fill(0);
  assert.deepEqual(result, new Bytes([2, 3, 4, 9]));
  // Zero declared bytes and an empty body.
  assert.deepEqual(
    await readResponse(new Response(new Bytes(0), { headers: { 'content-length': '0' } }), { maxBytes: 4 }),
    new Bytes(0),
  );
});

test('a declared response keeps its budget, abort and reader release at the same points (KB-LOADBYTES1)', async () => {
  // Over budget mid-stream, with a declared length inside the budget.
  const over = chunked(new Bytes(3), new Bytes(3));
  await assert.rejects(
    readResponse(new Response(over, { headers: { 'content-length': '4' } }), { maxBytes: 4 }),
    /byte budget exceeded/,
  );
  // Declared over budget: refused before any byte is read.
  await assert.rejects(
    readResponse(new Response(chunked(new Bytes(1)), { headers: { 'content-length': '5' } }), { maxBytes: 4 }),
    /byte budget exceeded/,
  );
  // Aborted between chunks: the abort reason, and the stream is unlocked.
  const controller = new AbortController(),
    stream = new ReadableStream({
      pull(c) {
        c.enqueue(new Bytes(2));
        controller.abort('stop');
      },
    });
  await assert.rejects(
    readBytes(stream, { maxBytes: 64, expected: 8, signal: controller.signal }),
    (error) => error === 'stop',
  );
  assert.equal(stream.locked, false);
  // A non-byte chunk is refused as before.
  await assert.rejects(readBytes(chunked('text'), { maxBytes: 8, expected: 4 }), /requires byte chunks/);
});

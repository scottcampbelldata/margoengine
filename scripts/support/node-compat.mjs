// What test files use in place of the Node APIs that Node 22.12 (the engines minimum) lacks. A static
// import by name of registerHooks from node:module or of zstdCompressSync from node:zlib fails the whole file
// at link time there with "does not provide an export named" (KB-NODE22-TESTS1), so the APIs are read from the module
// namespaces here and each has a stand-in:
//   moduleHooks         module.registerHooks, or module.register with the same rules (node-compat-hooks.mjs)
//   zstdDecompressSync  node:zlib's, or the engine's own decoder (packages/shared/zstd.js)
//   zstdCompressSync    node:zlib's, or a writer that stores the input in raw blocks (zstd-store.mjs): a valid frame
//                       every decoder reads, with the content size, checksum and window parameters the tests pass
//   zstdConstants       zlib.constants' ZSTD_c_* parameter numbers, which Node 22.12 lacks too
//   zstdFixture         a stream with compressed blocks: Node's own, or a checked-in file made by it, for the tests
//                       of Huffman, FSE and match decoding that a stored frame would not exercise
//   createZstdDecompress  node:zlib's; there is no streaming stand-in, so elsewhere it throws when called
// No test is skipped for a missing API: `{ skip: noZstd }` (2026-11-26, PR 483) left 13 tests unrun on Node 22.12.
// MARGO_NODE_COMPAT=fallback takes the stand-ins on any Node, which is how tests/node-apis.test.js checks them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import * as zlib from 'node:zlib';
import { decompressZstdSync } from '../../packages/shared/zstd.js';
import * as hooks from './node-compat-hooks.mjs';
import { ZSTD_PARAMS, zstdStoreSync } from './zstd-store.mjs';

const native = (api) => (process.env.MARGO_NODE_COMPAT === 'fallback' ? undefined : api);
const registerHooks = native(nodeModule.registerHooks);

const compressNative = native(zlib.zstdCompressSync);

export const zstdCompressSync = compressNative ?? zstdStoreSync;
export const zstdDecompressSync = native(zlib.zstdDecompressSync) ?? decompressZstdSync;
/** ZSTD_c_compressionLevel, ZSTD_c_windowLog, ZSTD_c_contentSizeFlag and ZSTD_c_checksumFlag, for `params` keys. */
export const zstdConstants = compressNative ? zlib.constants : ZSTD_PARAMS;
export const createZstdDecompress =
  native(zlib.createZstdDecompress) ??
  (() => {
    throw new Error(`Streaming Zstandard decompression needs Node 22.15 or newer; this is Node ${process.version}.`);
  });

/**
 * A Zstandard frame of `bytes` with compressed blocks (for a list of inputs, their frames one after another), for a
 * test of entropy or match decoding. Where node:zlib has
 * Zstandard it is compressed now with `params` (ZSTD_c_* numbers), and the checked-in file at `url` must still decode
 * to `bytes`, so a fixture cannot drift from its test. Elsewhere it is the checked-in file, which Node made once:
 * MARGO_ZSTD_FIXTURES=write writes every file the tests ask for.
 */
export function zstdFixture(url, bytes, params = {}) {
  if (!compressNative) return readFileSync(url);
  const parts = Array.isArray(bytes) ? bytes : [bytes],
    fresh = Buffer.concat(parts.map((part) => compressNative(part, { params })));
  if (process.env.MARGO_ZSTD_FIXTURES === 'write') writeFileSync(url, fresh);
  if (!existsSync(url)) throw new Error(`${url} is missing; run the test with MARGO_ZSTD_FIXTURES=write to make it.`);
  if (!zstdDecompressSync(readFileSync(url)).equals(Buffer.concat(parts)))
    throw new Error(`${url} no longer decodes to its test's input; run the test with MARGO_ZSTD_FIXTURES=write.`);
  return fresh;
}

let registered = false;
/** Applies module hook rules (see node-compat-hooks.mjs) to every module imported after the returned promise settles. */
export async function moduleHooks(rules) {
  if (!registerHooks)
    return void nodeModule.register(new URL('./node-compat-hooks.mjs', import.meta.url), { data: rules });
  await hooks.add(rules);
  if (!registered) registerHooks({ resolve: hooks.resolve, load: hooks.load });
  registered = true;
}

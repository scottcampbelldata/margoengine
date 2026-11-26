// What test files use in place of the Node APIs that Node 22.12 (the engines minimum) lacks. A static
// `import { registerHooks } from 'node:module'` or `import { zstdCompressSync } from 'node:zlib'` fails the whole file
// at link time there with "does not provide an export named" (KB-NODE22-TESTS1), so the APIs are read from the module
// namespaces here and each has a stand-in:
//   moduleHooks         module.registerHooks, or module.register with the same rules (node-compat-hooks.mjs)
//   zstdDecompressSync  node:zlib's, or the engine's own decoder (packages/shared/zstd.js)
//   zstdCompressSync    node:zlib's, or undefined: the engine has no JavaScript encoder, so a test that needs
//                       Node-made streams passes `{ skip: noZstd }`, which is false on every Node that has the API
// MARGO_NODE_COMPAT=fallback takes the stand-ins on any Node, which is how tests/node-apis.test.js checks them.
import * as nodeModule from 'node:module';
import * as zlib from 'node:zlib';
import { decompressZstdSync } from '../../packages/shared/zstd.js';
import * as hooks from './node-compat-hooks.mjs';

const native = (api) => (process.env.MARGO_NODE_COMPAT === 'fallback' ? undefined : api);
const registerHooks = native(nodeModule.registerHooks);

export const zstdCompressSync = native(zlib.zstdCompressSync);
export const zstdDecompressSync = native(zlib.zstdDecompressSync) ?? decompressZstdSync;
/** False where node:zlib compresses Zstandard; elsewhere the reason a test that needs it is skipped. */
export const noZstd = zstdCompressSync ? false : `Node ${process.version} has no Zstandard in node:zlib`;

let registered = false;
/** Applies module hook rules (see node-compat-hooks.mjs) to every module imported after the returned promise settles. */
export async function moduleHooks(rules) {
  if (!registerHooks)
    return void nodeModule.register(new URL('./node-compat-hooks.mjs', import.meta.url), { data: rules });
  await hooks.add(rules);
  if (!registered) registerHooks({ resolve: hooks.resolve, load: hooks.load });
  registered = true;
}

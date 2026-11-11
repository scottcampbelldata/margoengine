import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

/** The committed raw-deflate bytes and the kernel they inflate to, from a blueprint module's source (packages/core/src/wasm.ts). */
export function readBlueprint(source) {
  const match = /wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(source);
  assert.ok(match, 'no wasmBase64 blueprint in the source');
  const compressed = Buffer.from(match[1], 'base64');
  return { compressed, wasm: inflateRawSync(compressed) };
}

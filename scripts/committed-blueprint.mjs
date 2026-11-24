// The compressed bytes of a committed Wasm blueprint, kept when they still hold the wasm just built.
//
// Raw deflate and gzip bytes are not defined by their settings: Node's zlib (Chromium's fork) and stock zlib give different
// sizes for the same input and levels, and Chromium's hashes with CPU specific instructions, so two machines can deflate
// one kernel into two different strings. A rebuild that rewrote the blueprint with the host's zlib therefore changed the
// committed bytes, the embedded string and every size measured from it (KB-SIZE-PLATFORM1). The builds ask this module
// first: when the committed string inflates to exactly the wasm they built, that string is the answer on every machine,
// and only a changed kernel is compressed again.
import { existsSync, readFileSync } from 'node:fs';

/**
 * @param file The TypeScript module that holds the blueprint.
 * @param name The exported constant that holds its base64 string.
 * @param wasm The wasm just built.
 * @param inflate Undoes the compression of the committed string (raw deflate or gunzip).
 * @param compress Compresses `wasm` when the committed string no longer holds it.
 */
export function committedBlueprint(file, name, wasm, inflate, compress) {
  if (existsSync(file)) {
    const base64 = new RegExp(`${name}(?::\\s*string)?\\s*=\\s*'([^']+)'`).exec(readFileSync(file, 'utf8'))?.[1];
    if (base64) {
      const packed = Buffer.from(base64, 'base64');
      try {
        if (inflate(packed).equals(wasm)) return packed;
      } catch {
        // A string that does not inflate is a stale blueprint: compress again.
      }
    }
  }
  return compress(wasm);
}

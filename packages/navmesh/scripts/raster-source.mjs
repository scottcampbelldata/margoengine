import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
/** Hash the exact clean-room source and compilation flags, independent of checkout line endings. */
export function rasterSourceHash() {
  const hash = createHash('sha256').update('-C target-feature=+simd128');
  for (const file of ['Cargo.toml', 'Cargo.lock', 'src/lib.rs'])
    hash
      .update(file)
      .update(readFileSync(new URL('../native/raster/' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
  return hash.digest('hex');
}
/** Hash binary bytes so the distributed kernel cannot silently diverge from its recorded artifact. */
export const binaryHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

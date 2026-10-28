// A generator module for tests: flat stone up to y = 7, except that chunks of column (1, 0) fail. With
// VOXEL_NET_FLAKY=once each of those chunks fails on its first try only (a marker folder per chunk under
// VOXEL_NET_FLAKY_DIR, made atomically, so the generator threads agree); with VOXEL_NET_FLAKY=always it always fails.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default function flaky(chunk, cx, cy, cz, { blocks }) {
  if (cx === 1 && cz === 0) {
    if (process.env.VOXEL_NET_FLAKY === 'always') throw new Error(`flaky generator: chunk ${cx},${cy},${cz} fails`);
    let first = true;
    try {
      mkdirSync(join(process.env.VOXEL_NET_FLAKY_DIR, `${cx}_${cy}_${cz}`));
    } catch {
      first = false; // the folder exists: this chunk failed once already
    }
    if (first) throw new Error(`flaky generator: chunk ${cx},${cy},${cz} fails once`);
  }
  const stone = blocks.findIndex((type) => type.name === 'stone');
  if (cy !== 0) return;
  for (let z = 0; z < 32; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) chunk.set(x, y, z, stone);
}

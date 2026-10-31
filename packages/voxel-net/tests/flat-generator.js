// A generator module for tests: flat stone up to y = 7. While the file named by VOXEL_NET_FLAT_FAIL exists it throws.
import { existsSync } from 'node:fs';

export default function flat(chunk, cx, cy, cz, { blocks }) {
  const marker = process.env.VOXEL_NET_FLAT_FAIL;
  if (marker && existsSync(marker)) throw new Error(`flat generator: chunk ${cx},${cy},${cz} fails`);
  const stone = blocks.findIndex((type) => type.name === 'stone');
  if (cy !== 0) return 7;
  for (let z = 0; z < 32; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) chunk.set(x, y, z, stone);
  return 7;
}

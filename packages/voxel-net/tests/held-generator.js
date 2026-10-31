// A generator module for tests: flat stone that returns only once the file VOXEL_NET_HELD_DIR/release exists
// (VOXEL_NET_HELD_FOREVER: never). `started` says a job is in it; `ended-*` is written as the thread ends by itself and
// holds how many jobs it had finished. A terminated thread writes nothing.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.VOXEL_NET_HELD_DIR;
let finished = 0;
process.on('exit', () => writeFileSync(join(dir, `ended-${Math.random()}`), String(finished)));

export default async function held(chunk, cx, cy, cz, { blocks }) {
  writeFileSync(join(dir, 'started'), '');
  while (process.env.VOXEL_NET_HELD_FOREVER || !existsSync(join(dir, 'release')))
    await new Promise((done) => setTimeout(done, 5));
  const stone = blocks.findIndex((type) => type.name === 'stone');
  for (let z = 0; z < 32; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) chunk.set(x, y, z, stone);
  finished++;
}

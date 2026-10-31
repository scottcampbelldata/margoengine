// A plain local VoxelServer for play.browser.mjs, in its own process so the test can kill it: same blocks and terrain as
// server.mjs, players spawning side by side so they meet. Prints {"port": n} when it listens.
import { VoxelServer } from '@margoengine/voxel-net/server';
import { defineBlocks } from '../src/blocks.ts';

let joined = 0;
const server = new VoxelServer({
  blocks: defineBlocks().blocks,
  generator: new URL('../src/server-generator.ts?seed=1', import.meta.url),
  flight: true,
  origins: '*',
  workers: 1,
  // Close enough for name tags, far enough apart to see each other.
  spawn: () => [2 + 6 * joined++, 2],
});
const address = await server.listen(0, '127.0.0.1');
console.log(JSON.stringify({ port: address.port }));

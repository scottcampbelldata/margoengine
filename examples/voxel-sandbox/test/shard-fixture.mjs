// A plain local VoxelServer for play.browser.mjs, in its own process so the test can kill it: same blocks and terrain as
// server.mjs, players spawning side by side so they meet. Prints {"port": n} when it listens.
//   --heartbeat=ms, --client-timeout=ms and --resume-timeout=ms set the server's own timers (short ones, for the ping test);
//   --watch also prints {"watch":{"players":n,"bytesIn":n}} every 100 ms, for a test that must see the server's side.
import { VoxelServer } from '@margoengine/voxel-net/server';
import { defineBlocks } from '../src/blocks.ts';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
let joined = 0;
const server = new VoxelServer({
  blocks: defineBlocks().blocks,
  generator: new URL('../src/server-generator.ts?seed=1', import.meta.url),
  flight: true,
  origins: '*',
  workers: 1,
  ...(arg('heartbeat') ? { heartbeatInterval: Number(arg('heartbeat')) } : {}),
  ...(arg('client-timeout') ? { clientTimeout: Number(arg('client-timeout')) } : {}),
  ...(arg('resume-timeout') ? { resumeTimeout: Number(arg('resume-timeout')) } : {}),
  // Close enough for name tags, far enough apart to see each other.
  spawn: () => [2 + 6 * joined++, 2],
});
const address = await server.listen(0, '127.0.0.1');
console.log(JSON.stringify({ port: address.port }));
if (process.argv.includes('--watch'))
  setInterval(
    () => console.log(JSON.stringify({ watch: { players: server.counts.players, bytesIn: server.metrics.bytesIn } })),
    100,
  );

// The bench's server process (bench/run.mjs forks it): a VoxelServer on the sandbox's terrain settings with the
// scenario's spawn rule. It reports its port, then on 'start' and 'stop' measures a window and sends the numbers back.
import { VoxelServer } from '../dist/server.js';
import { testBlocks } from '../tests/blocks.js';
import { measureServer } from './server-window.mjs';

const { scenario, workers } = JSON.parse(process.argv[2]);
// A per-player random column: spread over a disc of 1,024 blocks, or a crowd within 32 blocks of the origin.
const radius = scenario === 'crowd' ? 32 : 1024;
function spawn(id) {
  let h = Math.imul(id, 0x9e3779b1) ^ 0x5bd1e995;
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const r = radius * Math.sqrt(next()),
    a = 2 * Math.PI * next();
  return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
}

const server = new VoxelServer({
  blocks: testBlocks(),
  generator: { seed: 1, seaLevel: 0, height: 8, amplitude: 32, scale: 192, caves: 0.3, trees: 0.012 },
  spawn,
  maxPlayers: 5000,
  // Every bot connects from 127.0.0.1, so the per-address cap on joining connections would throttle the join rate.
  maxPerAddress: 1000,
  maxPending: 1000,
  ...(workers ? { workers } : {}),
});
const { port } = await server.listen(0, '127.0.0.1');
measureServer(server, port);

// The sandbox's multiplayer server: one shared world with the same blocks and terrain as single player.
//   node examples/voxel-sandbox/server.mjs [--port=8787] [--host=127.0.0.1] [--seed=1] [--origins=a,b or *]
// then open the sandbox with ?server=ws://127.0.0.1:8787 in several tabs, or on several machines with --host=0.0.0.0.
// The page comes from the Vite dev server, another origin than this server, so its origins are allowed by name:
// by default the dev server at 127.0.0.1:5173 and localhost:5173. Pass --origins for another page, --origins=* for any.
// Run `npm run build:packages` first: it imports the built packages.
import { VoxelServer } from '@margoengine/voxel-net/server';
import { defineBlocks } from './src/blocks.ts';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const port = Number(arg('port', 8787)),
  host = arg('host', '127.0.0.1'),
  seed = Number(arg('seed', 1)) | 0,
  originList = arg('origins', 'http://127.0.0.1:5173,http://localhost:5173'),
  origins = originList === '*' ? '*' : originList.split(',').filter(Boolean);

const server = new VoxelServer({
  blocks: defineBlocks().blocks,
  generator: new URL(`./src/server-generator.ts?seed=${seed}`, import.meta.url),
  flight: true,
  origins,
  spawn: () => [Math.floor(Math.random() * 33) - 16, Math.floor(Math.random() * 33) - 16],
});
const address = await server.listen(port, host);
console.log(`voxel-net server, seed ${seed}, on ws://${host}:${address.port}`);
console.log(`Open the sandbox with ?server=ws://${host === '0.0.0.0' ? 'this-machine' : host}:${address.port}`);
setInterval(() => {
  const { players, worldChunks, cachedChunks } = server.counts,
    times = server.metrics.tickTimes.splice(0).sort((a, b) => a - b);
  server.metrics.tickStarts.length = 0;
  if (players)
    console.log(
      `${players} players, ${worldChunks} chunks held, ${cachedChunks} cached, ` +
        `tick p95 ${times[Math.floor(times.length * 0.95)]?.toFixed(1)} ms`,
    );
}, 10_000).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close().then(() => process.exit(0)));

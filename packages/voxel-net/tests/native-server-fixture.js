import { serveVoxelBun, serveVoxelDeno } from '../dist/server-runtimes.js';
import { testBlocks } from './blocks.js';
const limit = setTimeout(() => {
  console.error('native fixture exceeded 60 seconds');
  process.exit(1);
}, 60000);
const controller = new AbortController();
const serve = globalThis.Bun ? serveVoxelBun : serveVoxelDeno;
const host = await serve(
  {
    blocks: testBlocks(),
    workers: 1,
    generator: new URL('./flat-generator.js', import.meta.url),
    spawn: () => [16, 16],
    helloTimeout: 1000,
    maxPending: 2,
    maxPerAddress: 1,
    authenticate: (request) =>
      request.headers.cookie === 'access=allow' ||
      new URL(request.url, 'http://native').searchParams.get('token') === 'allow'
        ? 'native-account'
        : false,
  },
  { signal: controller.signal },
);
host.server.onApp((player, data) => host.server.send(player, data));
console.log(JSON.stringify({ url: host.url }));
process.stdin.on('data', async () => {
  controller.abort();
  await host.close();
  process.stdin.destroy();
  clearTimeout(limit);
  console.log('native fixture closed');
});

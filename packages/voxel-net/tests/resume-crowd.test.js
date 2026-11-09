// A CDN restart: a hundred players cut in the same moment all come back in place, with nothing sent again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelBot } from '../dist/bot.js';
import { VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';
import { cutProxy, until } from './cut-proxy.js';

const CROWD = 100,
  blocks = testBlocks();

test('100 bots cut at once: all resumed within 10 s, no full resend, no chunk sent again on a quiet world', {
  timeout: 120_000,
}, async (t) => {
  const server = new VoxelServer({
      blocks,
      workers: 1,
      generator: new URL('./flat-generator.js', import.meta.url),
      spawn: () => [0, 0],
      view: 2,
      flight: true,
      maxPlayers: CROWD,
      maxPending: 256,
      maxPerAddress: 256,
      // A bot takes its time to get here under this load; none is dropped for it before the cut.
      clientTimeout: 60_000,
    }),
    { port } = await server.listen(0),
    proxy = await cutProxy(port),
    bots = [];
  server.onError = () => {};
  const quietControls = {keys: 0, yaw: 0, pitch: 0};
  const driving = setInterval(() => {
    // Keep sending and simulating inputs without the bot AI walking into new chunk views.
    for (const bot of bots) bot.client.update(0.016, quietControls);
  }, 16);
  t.after(async () => {
    clearInterval(driving);
    for (const bot of bots) bot.close();
    proxy.close();
    await server.close();
  });
  for (let i = 0; i < CROWD; i += 10)
    bots.push(
      ...(await Promise.all(
        Array.from({ length: 10 }, (_, n) =>
          VoxelBot.connect({
            url: `ws://127.0.0.1:${proxy.port}`,
            blocks,
            editInterval: 0,
            view: 2,
            name: `b${i + n}`,
          }),
        ),
      )),
    );
  await until('every bot to have its view', () => bots.every((bot) => bot.client.loaded && bot.client.spawned), 60_000);
  for (const bot of bots) {
    bot.client.update(0.016, quietControls);
    assert.deepEqual([bot.client.player.position[0], bot.client.player.position[2]], [0.5, 0.5],
      'the zero-resend fixture must stay in its spawn column');
  }
  assert.equal(server.counts.players, CROWD);
  const ids = bots.map((bot) => bot.client.welcome.id),
    joins = server.metrics.joins;

  const cutAt = performance.now();
  proxy.cut();
  await until('every bot to come back', () => bots.every((bot) => bot.client.stats.resumes === 1), 10_000);
  const took = performance.now() - cutAt;
  console.log(`${CROWD} bots back in ${Math.round(took)} ms`);

  assert.equal(server.counts.parked, 0);
  assert.equal(server.counts.players, CROWD);
  assert.equal(server.metrics.resumed, CROWD);
  assert.equal(server.metrics.resumeFailed.unknown + server.metrics.resumeFailed.expired, 0);
  assert.equal(server.metrics.fullResends, 0);
  assert.equal(server.metrics.chunksResent, 0);
  assert.equal(server.metrics.joins, joins, 'nobody joined again');
  assert.deepEqual(
    bots.map((bot) => bot.client.welcome.id),
    ids,
    'every player is the one it was',
  );
  assert.equal(bots.filter((bot) => bot.resumeFailed).length, 0);
});

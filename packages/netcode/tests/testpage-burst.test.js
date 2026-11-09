import test from 'node:test';
import assert from 'node:assert/strict';
import { GameClient, GameServer, LoopbackNetwork, CloseCode } from '../dist/index.js';
import { game } from './arena.js';

for (const count of [50, 65])
  test(`test-page 34: burst of ${count} joins counts each accepted peer once`, async () => {
    const network = new LoopbackNetwork({ latency: 1 });
    const now = () => network.time;
    const server = new GameServer(game, { maxPlayers: 64, now });
    const initialBoxes = server.state.boxes.size;
    network.listen().onconnection = (connection) => server.accept(connection);
    const pending = Array.from({ length: count }, () =>
      GameClient.join(game, network.connect(), { now, input: () => ({ x: 0, y: 0, boost: false }) }),
    );
    const settled = Promise.allSettled(pending);
    try {
      network.advance(10);
      assert.equal(server.tick, 0, 'all hellos are delivered before the first simulation tick');
      assert.equal(server.players.length, Math.min(count, 64));
      assert.equal(new Set(server.players).size, server.players.length);
      for (let i = 0; i < 10; i++) {
        server.step();
        network.advance(100);
        await null;
      }
      const results = await settled;
      const joined = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      assert.equal(joined.length, Math.min(count, 64));
      assert.equal(server.state.boxes.size, initialBoxes + Math.min(count, 64));
      for (const result of results.filter((r) => r.status === 'rejected'))
        assert.match(result.reason.message, new RegExp(`${CloseCode.full} server full`));
      joined[0].close();
      network.advance(10);
      const replacement = GameClient.join(game, network.connect(), {
        now,
        input: () => ({ x: 0, y: 0, boost: false }),
      });
      const replacementResult = Promise.allSettled([replacement]);
      network.advance(10);
      assert.equal(server.players.length, joined.length, 'leaving frees exactly one slot before a tick');
      for (let i = 0; i < 10; i++) {
        server.step();
        network.advance(100);
        await null;
      }
      assert.equal((await replacementResult)[0].status, 'fulfilled');
      assert.equal(server.state.boxes.size, initialBoxes + joined.length);
    } finally {
      server.close();
      network.advance(10);
      await settled;
    }
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync, LoopbackNetwork, messages } from '../dist/index.js';

// Sends `count` numbered messages from a client to the server and returns what arrived, in order, with times.
function exchange(options, channel, count = 2000) {
  const network = new LoopbackNetwork(options),
    listener = network.listen(),
    got = [];
  listener.onconnection = (server) => (server.onmessage = (data) => got.push([data[0] | (data[1] << 8), network.time]));
  const client = network.connect();
  for (let i = 0; i < count; i++) {
    client.send(new Uint8Array([i & 255, i >> 8]), channel);
    network.advance(5);
  }
  network.flush();
  return { got, stats: network.stats };
}

test('the same seed gives the same deliveries; another seed differs', () => {
  const options = { latency: 30, jitter: 20, loss: 0.1, duplicate: 0.05, reorder: 0.1 };
  const a = exchange({ ...options, seed: 5 }, 'unreliable'),
    b = exchange({ ...options, seed: 5 }, 'unreliable'),
    c = exchange({ ...options, seed: 6 }, 'unreliable');
  assert.deepEqual(a.got, b.got);
  assert.notDeepEqual(a.got, c.got);
});

test('unreliable: loss, duplication and reordering at about the asked rates; latency and jitter bound the delay', () => {
  const { got, stats } = exchange({ latency: 40, jitter: 10, loss: 0.1, duplicate: 0.05, seed: 2 }, 'unreliable', 4000);
  assert.ok(Math.abs(stats.lost / 4000 - 0.1) < 0.02, `lost ${stats.lost}`);
  assert.ok(Math.abs(stats.duplicated / (4000 - stats.lost) - 0.05) < 0.015, `duplicated ${stats.duplicated}`);
  assert.equal(got.length, 4000 - stats.lost + stats.duplicated);
  let reordered = 0;
  for (let i = 1; i < got.length; i++) if (got[i][0] < got[i - 1][0]) reordered++;
  assert.ok(reordered > 0, 'jitter reorders some');
  for (const [n, at] of got) assert.ok(at - n * 5 >= 40 && at - n * 5 <= 50 + 1e-9, `message ${n} took ${at - n * 5}`);
});

test('reliable: every message once and in order, even at 30% loss (resends add delay)', () => {
  const { got, stats } = exchange({ latency: 40, jitter: 30, loss: 0.3, seed: 8 }, 'reliable', 1000);
  assert.deepEqual(
    got.map(([n]) => n),
    Array.from({ length: 1000 }, (_, i) => i),
  );
  assert.ok(stats.resent > 250, `resent ${stats.resent}`);
  for (let i = 1; i < got.length; i++) assert.ok(got[i][1] >= got[i - 1][1]);
});

test('close reaches the other end after the reliable messages already sent', () => {
  const network = new LoopbackNetwork({ latency: 20 }),
    listener = network.listen(),
    events = [];
  listener.onconnection = (server) => {
    server.onmessage = (data) => events.push(['message', data[0]]);
    server.onclose = (code, reason) => events.push(['close', code, reason]);
  };
  const client = network.connect();
  client.send(new Uint8Array([1]));
  client.close(4001, 'bye');
  client.send(new Uint8Array([2]));
  assert.equal(client.open, false);
  network.advance(100);
  assert.deepEqual(events, [
    ['message', 1],
    ['close', 4001, 'bye'],
  ]);
  // No listener: the connection closes with 1006.
  const empty = new LoopbackNetwork(),
    lonely = empty.connect();
  let code = 0;
  lonely.onclose = (c) => (code = c);
  empty.advance(1);
  assert.equal(lonely.open, false);
  assert.equal(code, 1006);
  assert.throws(() => new LoopbackNetwork({ loss: 1 }), /loss is 1; pass a number from 0 to 0.99/);
  assert.throws(() => network.advance(-1), RangeError);
});

test('messages() iterates a connection until it closes or the signal aborts', async () => {
  const network = new LoopbackNetwork({ latency: 1 }),
    listener = network.listen();
  let server;
  listener.onconnection = (s) => (server = s);
  const client = network.connect();
  client.send(new Uint8Array([7]));
  client.send(new Uint8Array([8]), 'unreliable');
  network.advance(5);
  client.close();
  network.advance(5);
  // Iterating a closed connection ends at once (messages before the iterator started had no reader).
  const seen = [];
  for await (const { data, channel } of messages(server)) seen.push([data[0], channel]);
  assert.deepEqual(seen, []);
  // Messages that arrive while iterating are yielded; aborting ends the loop.
  const network2 = new LoopbackNetwork(),
    listener2 = network2.listen();
  let server2;
  listener2.onconnection = (s) => (server2 = s);
  const client2 = network2.connect(),
    controller = new AbortController(),
    loop = (async () => {
      const out = [];
      for await (const { data, channel } of messages(server2, { signal: controller.signal }))
        out.push([data[0], channel]);
      return out;
    })();
  client2.send(new Uint8Array([1]));
  client2.send(new Uint8Array([2]), 'unreliable');
  network2.advance(1);
  await null;
  controller.abort();
  assert.deepEqual(await loop, [
    [1, 'reliable'],
    [2, 'unreliable'],
  ]);
});

test('clock sync trusts the fastest round trip and reports the spread as jitter', () => {
  const clock = new ClockSync(1000 / 30);
  assert.equal(clock.synced, false);
  assert.ok(Number.isNaN(clock.serverTick(0)));
  // Server tick n starts at n * 33.3 ms; one-way delays vary from 20 to 60 ms.
  const tickMs = 1000 / 30;
  for (const [sent, up, down] of [
    [0, 60, 50],
    [500, 20, 20],
    [1000, 40, 60],
  ]) {
    const serverTime = sent + up,
      tick = Math.floor(serverTime / tickMs);
    clock.add(sent, sent + up + down, tick, serverTime / tickMs - tick);
  }
  assert.equal(clock.rtt, 40);
  assert.equal(clock.jitter, (110 - 40) / 2);
  // At local time 2000 the server is at tick 60 (same clock here, symmetric best sample: exact).
  assert.ok(Math.abs(clock.serverTick(2000) - 2000 / tickMs) < 1e-9);
  assert.throws(() => new ClockSync(0), RangeError);
});

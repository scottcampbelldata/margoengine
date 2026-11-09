// @margoengine/voxel-net/webtransport: movement over datagrams that are lost, repeated and reordered. The link is a
// stand-in for a WebTransport session (netcode's Connection with 'reliable' and 'unreliable' channels, in memory);
// the real session is netcode's openWebTransport and acceptWebTransport, proved in @margoengine/netcode.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { encodeClientMessage, Keys } from '../dist/index.js';
import { VoxelServer } from '../dist/server.js';
import { joinOver, voxelNetServerConnection, voxelNetTransport } from '../dist/webtransport.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, done, ms = 10_000) {
  const end = performance.now() + ms;
  while (!done()) {
    assert.ok(performance.now() < end, `timed out waiting for ${what}`);
    await wait(10);
  }
}
// Two netcode Connections joined in memory. `lose(n)` says whether the n-th datagram each way is lost; every
// `swap`-th datagram that survives is held back and delivered after the next one (reordered). Reliable messages always
// arrive, in order.
function link({ lose = () => false, swap = 0 } = {}) {
  const ends = [0, 1].map(() => ({ open: true, onmessage: null, onclose: null, sent: { reliable: 0, unreliable: 0 } }));
  for (const [i, end] of ends.entries()) {
    const peer = ends[1 - i];
    let n = 0,
      held;
    end.send = (data, channel = 'reliable') => {
      if (!end.open) return;
      end.sent[channel]++;
      const copy = data.slice();
      const deliver = (bytes) => queueMicrotask(() => peer.open && peer.onmessage?.(bytes, channel));
      if (channel === 'reliable') return deliver(copy);
      if (lose(++n)) return;
      if (swap && n % swap === 0 && !held) return void (held = copy);
      deliver(copy);
      if (held) {
        deliver(held);
        held = undefined;
      }
    };
    end.close = (code = 1000, reason = '') => {
      if (!end.open) return;
      end.open = peer.open = false;
      end.onclose?.(code, reason);
      peer.onclose?.(code, reason);
    };
  }
  return ends;
}
async function start(t) {
  const server = new VoxelServer({ blocks, workers: 1, generator: flat, spawn: () => [16, 16] });
  t.after(() => server.close());
  await server.start();
  return server;
}
function join(t, server, options, name = 'Ada', clientOptions = {}) {
  const [near, far] = link(options);
  server.accept(voxelNetServerConnection(far));
  const client = joinOver(near, new VoxelWorld({ blocks }), { view: 2, name, ...clientOptions });
  client.onError = (error) => assert.fail(error);
  t.after(() => client.close());
  return { client, near };
}
// Runs the client's loop for `ms` with `keys` held, at about 60 frames a second.
async function walk(client, keys, ms) {
  let last = performance.now();
  const end = last + ms;
  while (performance.now() < end) {
    await wait(16);
    const now = performance.now();
    client.update((now - last) / 1000, { keys, yaw: 0, pitch: 0 });
    last = now;
  }
}

test('the client sends inputs as datagrams and the server sends players snapshots as datagrams, the rest reliably', () => {
  const [near, far] = link(),
    server = voxelNetServerConnection(far),
    sent = [];
  far.send = (data, channel) => sent.push([data[0], channel]);
  server.send(Uint8Array.of(21, 0)); // players
  server.send(Uint8Array.of(20, 0)); // anything else
  assert.deepEqual(sent, [
    [21, 'unreliable'],
    [20, 'reliable'],
  ]);
  assert.equal(server.datagrams, true);
  const out = [];
  near.send = (data, channel) => out.push(channel);
  const transport = voxelNetTransport(near);
  transport.send(
    encodeClientMessage({
      type: 'input',
      step: 1,
      acked: 0,
      runs: [{ steps: 1, keys: 0, yaw: 0, pitch: 0 }],
      position: [0, 0, 0],
    }),
  );
  transport.send(encodeClientMessage({ type: 'edit', x: 0, y: 0, z: 0, state: 0 }));
  assert.deepEqual(out, ['unreliable', 'reliable']);
  assert.throws(() => voxelNetServerConnection(undefined), TypeError);
});

test('a player walks through lost and reordered datagrams with no step lost and no stall', async (t) => {
  const server = await start(t),
    // a third of the datagrams lost each way, every 5th survivor delivered late
    { client, near } = join(t, server, { lose: (n) => n % 3 === 0, swap: 5 }),
    other = join(t, server, {}, 'Bo').client;
  await until('spawn', () => client.spawned && other.spawned && server.players.every((p) => p.spawned));
  const before = server.players.find((p) => p.name === 'Ada').character.position[2];
  await walk(client, Keys.forward, 1500);
  await walk(client, 0, 300);
  const ada = server.players.find((p) => p.name === 'Ada');
  assert.ok(
    before - ada.character.position[2] > 3,
    `the server moved the player ${before - ada.character.position[2]} blocks`,
  );
  assert.equal(server.metrics.stepsLost, 0, 'each input came with copies of the last three, so none was lost');
  const dz = client.player.position[2] - ada.character.position[2];
  assert.ok(Math.abs(dz) < 0.05, `client and server agree on where the player is (${dz})`);
  assert.ok(
    near.sent.unreliable >= 30,
    `inputs went as datagrams, one per 20 Hz flush over 1.8 s (${near.sent.unreliable})`,
  );
  // Bo sees Ada through full snapshots: each one decodes alone, over a link that lost a third of them to Ada too.
  await until('Bo sees Ada', () => [...other.samplePlayers().values()].some((p) => p.name === 'Ada'));
  await until('Ada sees Bo', () => [...client.samplePlayers().values()].some((p) => p.name === 'Bo'));
  assert.equal(server.players.length, 2, 'nobody was closed');
});

test('with no copies a lost input becomes a gap the server fills with the keys last held, and corrects the client', async (t) => {
  const server = await start(t),
    { client } = join(t, server, { lose: (n) => n % 4 === 0 }, 'Ada', { inputCopies: 0 });
  await until('spawn', () => client.spawned && server.players[0]?.spawned);
  await walk(client, Keys.forward, 1000);
  await walk(client, 0, 500);
  assert.ok(server.metrics.stepsLost > 0, 'steps were lost');
  assert.equal(server.players.length, 1, 'a gap is mended, not closed as an out-of-order input');
  const p = server.players[0].character.position,
    q = client.player.position;
  assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) < 0.05, 'the client ends where the server has it');
});

test('a repeated or late input is cut, not closed, over datagrams; over a WebSocket it is still a protocol error', async (t) => {
  const server = await start(t),
    [near, far] = link();
  server.accept(voxelNetServerConnection(far));
  const closes = [];
  near.onclose = (code) => closes.push(code);
  const send = (m) => near.send(encodeClientMessage(m), m.type === 'input' ? 'unreliable' : 'reliable');
  send({ type: 'hello', version: (await import('../dist/index.js')).PROTOCOL_VERSION, view: 2, name: 'Cy' });
  await until('spawn', () => server.players[0]?.spawned);
  const run = { steps: 6, keys: 0, yaw: 0, pitch: 0 },
    input = (step) => ({ type: 'input', step, acked: 0, runs: [run], position: server.players[0].character.position });
  send(input(1));
  send(input(1)); // the same again
  send(input(7));
  send(input(4)); // half old: steps 4 to 6 are cut, 7 to 9 already in, so nothing new
  await walk({ update() {} }, 0, 200);
  assert.deepEqual(closes, []);
  assert.equal(server.metrics.stepsLost, 0);
  assert.throws(() => server.accept({}), TypeError);
  const idle = new VoxelServer({ blocks, workers: 1, generator: flat });
  t.after(() => idle.close());
  assert.throws(() => idle.accept(voxelNetServerConnection(link()[1])), /await server.start/);
});

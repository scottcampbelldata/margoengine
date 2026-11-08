// @margoengine/voxel-net/entities: server-run mobs and items, sent to each player by interest management, over real sockets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { decodeServerMessage, encodeServerMessage, VoxelNetClient } from '../dist/index.js';
import { VoxelEntities, VoxelEntityView, wander } from '../dist/entities.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function start(t, spawn = () => [16, 16]) {
  const server = new VoxelServer({ blocks, workers: 1, generator: flat, spawn }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}
async function join(t, url) {
  const conn = await connectWebSocket(url),
    client = new VoxelNetClient(
      new VoxelWorld({ blocks }),
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name: 'Ada' },
    );
  client.onError = (error) => assert.fail(error);
  conn.onmessage = (d) => client.receive(d);
  t.after(() => conn.close());
  return { client, conn };
}
async function until(what, done) {
  const end = performance.now() + 10_000;
  while (!done()) {
    assert.ok(performance.now() < end, `timed out waiting for ${what}`);
    await wait(10);
  }
}

test('an entities message round-trips through the codec, full or delta', () => {
  for (const full of [true, false]) {
    const data = Uint8Array.of(2, 9, 8, 7),
      bytes = encodeServerMessage({ type: 'entities', tick: 300, full, data }),
      m = decodeServerMessage(bytes);
    assert.deepEqual(m, { type: 'entities', tick: 300, full, data });
  }
  assert.throws(() => decodeServerMessage(Uint8Array.of(26)), RangeError);
  assert.throws(() => decodeServerMessage(Uint8Array.of(26, 1, 2)), RangeError, 'a full flag other than 0 or 1');
});

test('items fall onto the ground, a mob wanders, and a client sees both where the server has them', async (t) => {
  const { server, url } = await start(t),
    entities = new VoxelEntities(server, { radius: 32 }),
    { client } = await join(t, url),
    view = new VoxelEntityView(client),
    entered = [];
  view.onEnter = (e) => entered.push(e.kind);
  await until('spawn', () => server.players[0]?.spawned);
  const item = entities.spawn({ kind: 7, position: [20.5, 12, 20.5], state: 3 }),
    mob = entities.spawn({ kind: 1, position: [12.5, 8, 12.5], brain: wander({ seed: 5, every: 0.5, rest: 0 }) });
  // The flat world's top is y = 8: the item lands there.
  await until('the item to land', () => item.body.onGround);
  assert.ok(Math.abs(item.position[1] - 8) < 1e-6, `item at y ${item.position[1]}`);
  const from = [...mob.position];
  await until('the mob to walk', () => Math.hypot(mob.position[0] - from[0], mob.position[2] - from[2]) > 1);
  await until('the client to hear of both', () => view.entities.size === 2);
  assert.deepEqual(entered.sort(), [1, 7]);
  const seen = view.entities.get(item.id);
  assert.equal(seen.kind, 7);
  assert.equal(seen.state, 3);
  item.state = 4;
  await until('the state change', () => seen.state === 4);
  // The item rests, so its newest state is where the server has it; sampling past the delay draws it there.
  await until('the client to hold the resting item', () => seen.last && Math.abs(seen.last.position[1] - 8) < 0.01);
  view.sample(performance.now() / 1000 + 1);
  for (const [i, v] of seen.snapshot.position.entries())
    assert.ok(Math.abs(v - item.position[i]) < 0.01, 'item position');
  // Removed on the server: gone on the client.
  const left = [];
  view.onLeave = (e) => left.push(e.id);
  entities.remove(mob);
  await until('the mob to leave', () => left.includes(mob.id));
  assert.equal(entities.size, 1);
});

test('interest management: a player gets only entities near it, and keeps one until it is past leaveRadius', async (t) => {
  const { server, url } = await start(t),
    entities = new VoxelEntities(server, { radius: 20, leaveRadius: 30 }),
    { client } = await join(t, url),
    view = new VoxelEntityView(client);
  await until('spawn', () => server.players[0]?.spawned);
  const p = server.players[0].character.position,
    near = entities.spawn({ kind: 1, position: [p[0] + 10, 8, p[2]], body: false }),
    far = entities.spawn({ kind: 2, position: [p[0] + 25, 8, p[2]], body: false });
  // Both were spawned before one tick, so the message that brought the near one would have brought the far one.
  await until('the near one', () => view.entities.has(near.id));
  assert.ok(!view.entities.has(far.id), 'outside radius: not sent');
  // Inside leaveRadius but past radius: kept, no flicker.
  near.position = [p[0] + 25, 8, p[2]];
  const moved = () => Math.abs(view.entities.get(near.id)?.last?.position[0] - (p[0] + 25)) < 0.01;
  await until('the move to reach the client', () => moved() || !view.entities.has(near.id));
  assert.ok(view.entities.has(near.id), 'between radius and leaveRadius: kept');
  near.position = [p[0] + 35, 8, p[2]];
  await until('the near one to leave', () => !view.entities.has(near.id));
  far.position = [p[0] + 5, 8, p[2]];
  await until('the far one to come', () => view.entities.has(far.id));
  assert.deepEqual(
    entities.near(p, 6).map((e) => e.id),
    [far.id],
  );
});

test('maxPerPlayer sends the nearest; dispose empties the client; bad input is refused with a fix', async (t) => {
  const { server, url } = await start(t),
    entities = new VoxelEntities(server, { radius: 40, maxPerPlayer: 3 }),
    { client } = await join(t, url),
    view = new VoxelEntityView(client);
  await until('spawn', () => server.players[0]?.spawned);
  const p = server.players[0].character.position,
    list = [8, 2, 6, 4, 10].map((d) => entities.spawn({ kind: d, position: [p[0] + d, 8, p[2]], body: false }));
  // One message brings all of them, so three is the whole set.
  await until('three entities', () => view.entities.size === 3);
  assert.deepEqual(
    [...view.entities.values()].map((e) => e.kind).sort((a, b) => a - b),
    [2, 4, 6],
  );
  entities.dispose();
  await until('the client to drop them', () => view.entities.size === 0);
  assert.equal(entities.size, list.length, 'the server keeps its entities readable');
  const bad = [
    () => entities.spawn({ kind: 1, position: [0, 0, 0] }),
    () => new VoxelEntities(server, { radius: 0 }),
    () => new VoxelEntities(server, { radius: 10, leaveRadius: 5 }),
    () => new VoxelEntities({}),
    () => wander({ rest: 2 }),
  ];
  for (const make of bad)
    assert.throws(make, (e) => (e instanceof TypeError || e instanceof RangeError) && /; \S/.test(e.message));
  const fresh = new VoxelEntities(server, { maxEntities: 1 });
  t.after(() => fresh.dispose());
  fresh.spawn({ kind: 0, position: [0, 9, 0] });
  for (const make of [
    () => fresh.spawn({ kind: 0, position: [0, 9, 0] }),
    () => new VoxelEntities(server).spawn({ kind: 70000, position: [0, 9, 0] }),
    () => new VoxelEntities(server).spawn({ kind: 1, position: [0, Number.NaN, 0] }),
  ])
    assert.throws(make, RangeError);
});

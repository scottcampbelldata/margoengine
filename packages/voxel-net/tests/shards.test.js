// @margoengine/voxel-net/shards: one world over two servers, a player handed from one to the next over real sockets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelServer } from '../dist/server.js';
import {
  connectShards,
  decodeShardHandoff,
  ShardMap,
  signShardTicket,
  verifyShardTicket,
  VoxelShard,
} from '../dist/shards.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  secret = 'a shared secret of the shards',
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, done) {
  const end = performance.now() + 10_000;
  while (!done()) {
    assert.ok(performance.now() < end, `timed out waiting for ${what}`);
    await wait(10);
  }
}
// Two shards on loopback: x >= 0 is shard 0, x < 0 is shard 1, regions of 32 blocks.
async function pair(t, ports) {
  const map = new ShardMap({
      shards: ports.map((p) => `ws://127.0.0.1:${p}`),
      regionSize: 32,
      assign: (rx) => (rx >= 0 ? 0 : 1),
    }),
    shards = [0, 1].map((index) => new VoxelShard({ map, index, secret, margin: 8 })),
    servers = shards.map((shard, i) => {
      const server = new VoxelServer(
        shard.options({ blocks, workers: 1, generator: flat, spawn: () => (i === 0 ? [16, 16] : [-16, 16]) }),
      );
      shard.attach(server);
      t.after(() => server.close());
      return server;
    });
  for (const [i, s] of servers.entries()) await s.listen(ports[i]);
  return { map, shards, servers };
}
async function freePorts(n) {
  const ports = [];
  for (let i = 0; i < n; i++) {
    const s = new VoxelServer({ blocks, workers: 1, generator: flat });
    ports.push((await s.listen(0)).port);
    await s.close();
  }
  return ports;
}

test('the map gives every column one shard, spreads regions by hash, and refuses bad options', () => {
  const map = new ShardMap({ shards: ['ws://a:1', 'ws://b:1', 'ws://c:1'] }),
    count = [0, 0, 0];
  for (let rx = -20; rx < 20; rx++) for (let rz = -20; rz < 20; rz++) count[map.shardAt(rx * 256, rz * 256)]++;
  for (const n of count) assert.ok(n > 1600 / 3 - 120 && n < 1600 / 3 + 120, `regions per shard ${count}`);
  assert.equal(map.shardAt(10, 10), map.shardAt(255, 0), 'one region, one shard');
  assert.deepEqual(map.regionOf(-1, 256), [-1, 1]);
  assert.throws(() => new ShardMap({ shards: [] }), TypeError);
  assert.throws(() => new ShardMap({ shards: ['http://a'] }), /ws:\/\//);
  assert.throws(() => new ShardMap({ shards: ['ws://a'], regionSize: 100 }), RangeError);
  assert.throws(() => new ShardMap({ shards: ['ws://a'], assign: () => 3 }).shardAt(0, 0), /shard index/);
  const two = new ShardMap({ shards: ['ws://a', 'ws://b'], regionSize: 32, assign: (rx) => (rx >= 0 ? 0 : 1) });
  assert.equal(two.outside(0, -8, 0, 8), false, 'within the margin');
  assert.equal(two.outside(0, -10, 0, 8), true, 'past the margin');
  assert.throws(() => new VoxelShard({ map: two, index: 0, secret: 'short' }), /16 characters/);
  assert.throws(() => new VoxelShard({ map: two, index: 2, secret }), RangeError);
  assert.throws(() => new VoxelShard({ map: two, index: 0, secret, margin: 17 }), /half the regionSize/);
});

test('a ticket checks out only as signed and before it expires', async () => {
  const ticket = { name: 'Ada', position: [1, 2, 3], to: 1, expires: Date.now() + 1000, nonce: 'ab' },
    token = await signShardTicket(secret, ticket);
  assert.deepEqual(await verifyShardTicket(secret, token), ticket);
  assert.equal(await verifyShardTicket('another secret of sixteen', token), undefined, 'another key');
  const [body, mac] = token.split('.'),
    forged = btoa(JSON.stringify({ ...ticket, to: 0 })).replaceAll('=', '');
  assert.equal(await verifyShardTicket(secret, `${forged}.${mac}`), undefined, 'a changed body');
  assert.equal(await verifyShardTicket(secret, `${body}.${mac}`, ticket.expires), undefined, 'expired');
  assert.equal(await verifyShardTicket(secret, 'nonsense'), undefined);
  assert.equal(decodeShardHandoff(Uint8Array.of(1, 2, 3)), undefined, 'an app message of yours');
});

test('a player past its shard is handed to the next one, spawns where it left, and its old chunks leave the world', async (t) => {
  const ports = await freePorts(2),
    { map, shards, servers } = await pair(t, ports),
    world = new VoxelWorld({ blocks }),
    follower = connectShards(map, world, { view: 2, name: 'Ada' }),
    moves = [];
  t.after(() => follower.close());
  follower.onError = (error) => assert.fail(error);
  follower.onHandoff = (url) => moves.push(url);
  await until('spawn on shard 0', () => servers[0].players[0]?.spawned);
  await until('chunks on the client', () => world.getChunk(0, 0, 0) && world.getChunk(2, 0, 0));
  const first = follower.client,
    p = servers[0].players[0];
  assert.equal(p.name, 'Ada');
  p.character.position = [-11.5, 8, 16.5]; // walked 12 blocks over the border, past the 8-block margin
  await until('spawn on shard 1', () => servers[1].players[0]?.spawned);
  assert.deepEqual(moves, [map.shards[1]]);
  assert.notEqual(follower.client, first);
  const q = servers[1].players[0];
  assert.equal(q.name, 'Ada');
  assert.deepEqual(q.character.position.slice(0, 1), [-11.5], 'spawned at the x it left');
  assert.equal(q.character.position[2], 16.5, 'and the z');
  await until('shard 0 lets go', () => servers[0].players.length === 0);
  assert.deepEqual([shards[0].stats.handedOff, shards[1].stats.arrived, shards[1].stats.refused], [1, 1, 0]);
  await until('shard 1 chunks', () => world.getChunk(-1, 0, 0));
  assert.equal(world.getChunk(2, 0, 0), undefined, 'a chunk only shard 0 sent left with it');
});

test('a used, forged or misaddressed ticket is refused, and a shard refuses edits outside its regions', async (t) => {
  const ports = await freePorts(2),
    { map, shards, servers } = await pair(t, ports),
    token = await signShardTicket(secret, {
      name: 'Ada',
      position: [-11.5, 8, 16.5],
      to: 1,
      expires: Date.now() + 5000,
      nonce: '01',
    }),
    closes = [];
  const open = (url) =>
    new Promise((done) => {
      const ws = new WebSocket(url);
      ws.addEventListener('close', ({ code }) => done(code));
      t.after(() => ws.close());
      ws.addEventListener('open', () => (ws.onopen = null));
    });
  const ok = new WebSocket(`${map.shards[1]}?shard-ticket=${token}`);
  t.after(() => ok.close());
  await until('first use accepted', () => shards[1].stats.arrived === 1);
  closes.push(await open(`${map.shards[1]}?shard-ticket=${token}`)); // used before
  closes.push(await open(`${map.shards[0]}?shard-ticket=${token}`)); // for shard 1, not 0
  closes.push(await open(`${map.shards[1]}?shard-ticket=${token.slice(0, -3)}AAA`)); // forged
  assert.deepEqual(closes, [1008, 1008, 1008]);
  assert.equal(shards[1].stats.refused + shards[0].stats.refused, 3);
  const rules = shards[0].options({ blocks, allowEdit: (_p, _x, y) => y < 100 });
  assert.equal(rules.allowEdit(undefined, 5, 7, 5, 0, 1), true, 'its own region');
  assert.equal(rules.allowEdit(undefined, -5, 7, 5, 0, 1), false, 'shard 1 owns x < 0');
  assert.equal(rules.allowEdit(undefined, 5, 120, 5, 0, 1), false, 'your rule still runs');
  assert.equal(servers.length, 2);
});

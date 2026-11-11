import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelLobby } from '../dist/rooms.js';
import { connectVoxelNet } from '../dist/index.js';
import { connectWebSocket } from '../dist/server.js';
import { verifyShardTicket } from '../dist/shards.js';
import { testBlocks } from './blocks.js';

const secret = 'a room secret kept on the server',
  blocks = testBlocks();
const base = { blocks, workers: 1, generator: new URL('./flat-generator.js', import.meta.url), spawn: () => [16, 16] };
async function until(fn) {
  const signal = AbortSignal.timeout(10000);
  while (!fn()) await delay(10, undefined, { signal });
}
function setup(t, options = {}) {
  const lobby = new VoxelLobby({ secret, ...options });
  t.after(() => lobby.close());
  return lobby;
}
test('isolated worlds, listings, join codes, capacity and consumed shard tickets', { timeout: 30000 }, async (t) => {
  const lobby = setup(t);
  const a = await lobby.create({ server: base, code: 'ONE', capacity: 1 });
  await lobby.create({ server: base, code: 'TWO', private: true });
  assert.deepEqual(
    lobby.list().map((r) => r.code),
    ['ONE'],
  );
  assert.equal(lobby.get('TWO').players, 0);
  assert.notEqual(lobby.server('ONE').world, lobby.server('TWO').world);
  const results = await Promise.allSettled([lobby.join('ONE'), lobby.join('ONE')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const seat = results.find((r) => r.status === 'fulfilled').value;
  assert.equal((await verifyShardTicket(secret, seat.ticket)).to, 0);
  assert.equal(lobby.get('ONE').reserved, 1);
  const client = connectVoxelNet(seat.url, new VoxelWorld({ blocks }), { view: 2 });
  t.after(() => client.close());
  client.onError = (e) => assert.fail(e);
  await until(() => client.spawned);
  assert.equal(lobby.get('ONE').players, 1);
  assert.equal(lobby.get('ONE').reserved, 0);
  assert.equal(lobby.get('ONE').locked, true);
  assert.equal(lobby.get('TWO').players, 0);
  const connection = await connectWebSocket(seat.url);
  t.after(() => connection.close());
  const closed = new Promise((resolve) => {
    connection.onclose = (code) => resolve(code);
  });
  assert.equal(await closed, 1008, 'used ticket cannot bypass a full room');
  client.close();
  await until(() => lobby.get('ONE').players === 0);
  assert.equal(lobby.get('ONE').locked, false);
  lobby.lock('ONE');
  await assert.rejects(lobby.join('ONE'), /locked/);
  lobby.lock('ONE', false);
  assert.equal(lobby.get('ONE').locked, false);
  assert.equal(a.code, 'ONE');
});
test('reservations expire, cancellation leaves no seat, removal invalidates tickets', { timeout: 30000 }, async (t) => {
  const lobby = setup(t, { reservationLife: 30 });
  await lobby.create({ server: base, code: 'A', capacity: 1 });
  const seat = await lobby.join('A');
  await delay(40);
  assert.equal(lobby.get('A').reserved, 0);
  assert.equal(await verifyShardTicket(secret, seat.ticket), undefined);
  await assert.rejects(lobby.join('A', '', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(lobby.get('A').reserved, 0);
  await assert.rejects(lobby.create({ server: base, code: 'A' }), /unique/);
  await assert.rejects(lobby.create({ server: base, code: 'ABORT', signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(lobby.get('ABORT'), undefined);
  await lobby.remove('A');
  assert.deepEqual(lobby.list(), []);
  await assert.rejects(lobby.join('A'), /Unknown/);
});
test('matchmaking reuses available worlds and creates when full', { timeout: 30000 }, async (t) => {
  const lobby = setup(t);
  const options = { server: base, capacity: 1, name: 'Survival' };
  const first = await lobby.joinOrCreate(options);
  const second = await lobby.joinOrCreate(options);
  assert.notEqual(first.code, second.code);
  assert.equal(lobby.list().length, 2);
  await lobby.close();
  await assert.rejects(lobby.joinOrCreate(options), /closed/);
});
test('invalid options reject before starting worlds', () => {
  assert.throws(() => new VoxelLobby({ secret: '' }), /16/);
  assert.throws(() => new VoxelLobby({ secret, reservationLife: Infinity }), /positive/);
});

test('a used room URL takes back its own parked player, and nothing else (KB5499a)', { timeout: 30000 }, async (t) => {
  const { decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION } = await import('../dist/index.js'),
    { cutProxy } = await import('./cut-proxy.js');
  // A short reservation life: the come-back happens after the ticket's own expiry, as a real reconnect does.
  const lobby = setup(t, { reservationLife: 2000 });
  const room = await lobby.create({ server: base, code: 'BACK', capacity: 2 });
  const proxy = await cutProxy(Number(new URL(room.url).port));
  t.after(() => proxy.close());
  const seat = await lobby.join('BACK', 'ann'),
    viaProxy = new URL(seat.url);
  viaProxy.port = String(proxy.port);
  const hello = async (resume) => {
    const conn = await connectWebSocket(viaProxy.href),
      p = { conn, messages: [], closed: undefined };
    conn.onmessage = (bytes) => p.messages.push(decodeServerMessage(bytes));
    conn.onclose = (code, reason) => (p.closed = { code, reason });
    conn.send(
      encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name: 'ann', ...(resume ? { resume } : {}) }),
    );
    return p;
  };
  const first = await hello();
  // Playing (spawned, chunks loaded): only a playing player is parked on a drop.
  await until(() => first.messages.some((m) => m.type === 'state' && m.spawn));
  await until(() => first.messages.some((m) => m.type === 'loaded'));
  const token = first.messages.find((m) => m.type === 'welcome').resume;
  assert.ok(token, 'the welcome carries a resume token');
  proxy.cut();
  const player = lobby.server('BACK').players[0];
  await until(() => player.connected === false);
  await delay(2100); // fixed-wait: the ticket's 2,000 ms reservation life passes while the player is parked
  // A plain hello on the used URL would be a second player in one seat: refused.
  const twin = await hello();
  await until(() => twin.closed);
  assert.equal(twin.closed.code, 1008);
  // The resume on the same URL takes the parked player back (before the fix: 1008 on the upgrade).
  const back = await hello({ token, chunks: 0, stale: [] });
  t.after(() => back.conn.close());
  await until(() => player.connected === true || back.closed);
  assert.equal(back.closed, undefined, JSON.stringify(back.closed));
  assert.equal(lobby.get('BACK').players, 1);
  assert.equal(lobby.server('BACK').metrics.resumed, 1);
});

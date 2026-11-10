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

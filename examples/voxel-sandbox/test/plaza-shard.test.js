// One shard, in this process, over real sockets on a free port: the edit rule, names, identity, snapshots and rollback.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { Keys, VoxelNetClient } from '@margoengine/voxel-net';
import { connectWebSocket } from '@margoengine/voxel-net/server';
import { defineBlocks } from '../src/blocks.ts';
import { FIRST_WORDS, isPlazaName, SECOND_WORDS } from '../src/names.ts';
import { isPlazaProtected, plazaSpawnRing } from '../src/plaza.ts';
import { readSnapshot } from '../server/snapshots.mjs';
import { HOST, IDLE_CLOSE_CODE, IDLE_REASON, PlazaShard } from '../server/shard.mjs';

const { blocks } = defineBlocks(),
  BRICKS = blocks.id('bricks'),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  // A fixed world, so that these tests stand on the same ground every run; (0, 30) is dry in it.
  SEED = 5,
  closes = (conn) => new Promise((done) => (conn.onclose = (code, reason) => done({ code, reason })));

function dataDir(t) {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'plaza-shard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startShard(t, options = {}) {
  const clock = { now: 1_000_000 },
    shard = new PlazaShard({
      index: 0,
      dataDir: options.dataDir ?? dataDir(t),
      origins: '*',
      now: () => clock.now,
      log: () => {},
      beatMs: 3_600_000,
      seed: SEED,
      snapshotMs: 3_600_000,
      ...options,
    });
  t.after(() => shard.shutdown());
  assert.equal(await shard.start(), true);
  return { shard, clock, url: `ws://${HOST}:${shard.address.port}` };
}

async function join(url, options = {}, headers = {}) {
  const conn = await connectWebSocket(url, { headers }),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(
      world,
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name: 'Amber Lantern', ...options },
    );
  conn.onmessage = (d) => client.receive(d);
  return { client, conn, world };
}

// Updates clients at 60 per second until `until()` holds or 15 s pass.
async function drive(clients, until) {
  const end = performance.now() + 15_000;
  let last = performance.now();
  while (!until()) {
    if (performance.now() > end) return false;
    await wait(16);
    const now = performance.now();
    for (const c of clients) c.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
  return true;
}
const standing = (shard, c) => {
  const [x, y, z] = shard.server.players.find((p) => p.id === c.client.welcome?.id)?.character.position ?? [];
  return x === undefined ? undefined : [Math.floor(x), Math.floor(y), Math.floor(z)];
};
async function joined(shard, url, options, headers) {
  const c = await join(url, options, headers);
  assert.ok(
    await drive([c.client], () => {
      const at = c.client.spawned && standing(shard, c);
      return at && c.client.world.getChunk(at[0] >> 5, at[1] >> 5, at[2] >> 5);
    }),
    'spawned with its chunk',
  );
  return c;
}
// An air cell in reach of the player, off the player's own body.
function airNear(c, at) {
  for (let up = 1; up <= 2; up++)
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
        const cell = [at[0] + dx, at[1] + up, at[2] + dz];
        if (c.world.getChunk(cell[0] >> 5, cell[1] >> 5, cell[2] >> 5) && c.world.getBlock(...cell) === 0) return cell;
      }
  throw new Error(`No air near ${at}`);
}

test('an edit on the plaza is refused and sent back; an edit 30 blocks out lands', async (t) => {
  const { shard, url } = await startShard(t, { spawn: () => [22, 0] }),
    a = await joined(shard, url),
    at = standing(shard, a),
    floor = shard.world.floor;
  // The player stands on the disc's edge. A refused edit comes back as the old state.
  const cell = [at[0] - 2, floor + 2, 0];
  assert.ok(isPlazaProtected(...cell, floor));
  assert.equal(a.world.getBlock(...cell), 0);
  assert.ok(a.client.edit(...cell, BRICKS), 'the client predicts it');
  assert.ok(
    await drive([a.client], () => shard.server.metrics.editsDenied > 0 && a.world.getBlock(...cell) === 0),
    'refused and put back on the client',
  );
  assert.equal(shard.server.world.getBlock(...cell), 0);
  a.client.close();

  const second = await startShard(t, { spawn: () => [0, 30] }),
    b = await joined(second.shard, second.url),
    spot = standing(second.shard, b),
    free = airNear(b, spot);
  assert.ok(!isPlazaProtected(...free, second.shard.world.floor), `${free} is open`);
  assert.ok(b.client.edit(...free, BRICKS));
  assert.ok(await drive([b.client], () => second.shard.server.metrics.editsAccepted > 0), 'accepted');
  assert.equal(second.shard.server.world.getBlock(...free) & 0xffff, BRICKS);
  b.client.close();
});

test('a name off the lists is replaced; a name on them stands', async (t) => {
  const { shard, url } = await startShard(t),
    good = `${FIRST_WORDS[0]} ${SECOND_WORDS[0]}`,
    a = await joined(shard, url, { name: good }),
    b = await joined(shard, url, { name: 'rude free text' }),
    names = shard.server.players.map((p) => p.name);
  assert.ok(names.includes(good));
  assert.ok(!names.includes('rude free text'));
  assert.ok(names.every(isPlazaName), names.join());
  a.client.close();
  b.client.close();
});

test('the shard listens on 127.0.0.1 only', async (t) => {
  const { shard } = await startShard(t);
  assert.equal(shard.address.address, '127.0.0.1');
});

test('a forged header cannot change identity, behind the proxy or without it', async (t) => {
  const forged = {
    'X-Forwarded-For': '198.51.100.1',
    Forwarded: 'for=198.51.100.2',
    'CF-Connecting-IP': '198.51.100.3',
    'True-Client-IP': '198.51.100.4',
    'X-Client-IP': '198.51.100.5',
  };
  // What nginx overwrites stands for the client; what the client adds beside it changes nothing.
  const proxied = await startShard(t, { proxied: true }),
    idOf = (shard, c) => shard.server.players.find((p) => p.id === c.client.welcome.id).identity,
    honest = await joined(proxied.shard, proxied.url, {}, { 'X-Real-IP': '203.0.113.50' }),
    faker = await joined(proxied.shard, proxied.url, {}, { 'X-Real-IP': '203.0.113.50', ...forged }),
    other = await joined(proxied.shard, proxied.url, {}, { 'X-Real-IP': '203.0.113.51', ...forged });
  assert.match(idOf(proxied.shard, honest), /^[0-9a-f]{24}$/);
  assert.equal(idOf(proxied.shard, faker), idOf(proxied.shard, honest));
  assert.notEqual(idOf(proxied.shard, other), idOf(proxied.shard, honest));
  for (const c of [honest, faker, other]) c.client.close();

  // A connection that did not come through nginx has no identity, whatever it claims: it is refused.
  const refused = await join(proxied.url, {}, forged);
  assert.equal((await closes(refused.conn)).code, 1008);

  // Without the proxy, even the proxy's own header is only something a client wrote.
  const direct = await startShard(t),
    plain = await joined(direct.shard, direct.url),
    claiming = await joined(direct.shard, direct.url, {}, { 'X-Real-IP': '198.51.100.9', ...forged });
  assert.equal(idOf(direct.shard, claiming), idOf(direct.shard, plain));
  plain.client.close();
  claiming.client.close();
});

test('one identity holds at most perIdentity places', async (t) => {
  const { shard, url } = await startShard(t, { perIdentity: 2 }),
    a = await joined(shard, url),
    b = await joined(shard, url),
    third = await join(url);
  assert.equal((await closes(third.conn)).code, 1008);
  a.client.close();
  b.client.close();
});

test('snapshot then rollback restores the 3 x 3 areas and nothing else, then the area refuses edits for 5 minutes', async (t) => {
  const { shard, clock, url } = await startShard(t, {}),
    a = await joined(shard, url),
    at = standing(shard, a),
    { world } = shard.server,
    first = airNear(a, at);
  let done = shard.server.metrics.editsAccepted;
  const place = async (cell) => {
    assert.ok(a.client.edit(...cell, BRICKS));
    done++;
    assert.ok(await drive([a.client], () => shard.server.metrics.editsAccepted >= done), `placed ${cell}`);
  };
  await place(first);
  clock.now += 60_000;
  await shard.snapshot();
  const taken = clock.now;
  assert.equal((await shard.snapshots()).length, 1);

  // The griefing, after the snapshot.
  clock.now += 60_000;
  const second = [first[0], first[1] + 1, first[2]];
  await place(second);
  assert.equal(world.getBlock(...second) & 0xffff, BRICKS);

  // An edit far away, made by importing: it must survive a rollback of this area.
  const edits = await shard.server.exportEdits(),
    template = [...edits.values()][0];
  edits.set('20,0,20', template);
  await shard.server.importEdits(edits);

  clock.now += 1000;
  const result = await shard.rollback({ cx: first[0] >> 5, cz: first[2] >> 5 }, taken + 1);
  assert.equal(result.at, taken);
  assert.equal(world.getBlock(...first) & 0xffff, BRICKS, 'what the snapshot held stays');
  assert.equal(world.getBlock(...second), 0, 'what came after it is gone');
  assert.ok((await shard.server.exportEdits()).has('20,0,20'), 'another area is untouched');
  assert.ok(await drive([a.client], () => a.world.getBlock(...second) === 0), 'the client sees it');

  // Frozen for 5 minutes, and only there.
  assert.equal(shard.canEdit(second[0], second[1] + 3, second[2]), false);
  assert.equal(shard.canEdit(640, 200, 640), true);
  clock.now += 5 * 60_000;
  assert.equal(shard.canEdit(second[0], second[1] + 3, second[2]), true);

  // With nothing that old, the area goes back to the generator's.
  await shard.rollback({ cx: first[0] >> 5, cz: first[2] >> 5 }, 0);
  assert.equal(world.getBlock(...first), 0);
  a.client.close();
});

test('no edit lands anywhere while a rollback is running, so none is lost to it', async (t) => {
  const { shard } = await startShard(t);
  assert.equal(shard.canEdit(640, 200, 640), true);
  const running = shard.rollback(undefined, 0);
  // The rollback runs in the queue: once it has started, the gate is shut until it is done.
  await Promise.resolve();
  await Promise.resolve();
  const shut = shard.canEdit(640, 200, 640);
  await running;
  assert.equal(shut, false);
  assert.equal(shard.canEdit(640, 200, 640), true);
});

test('a snapshot keeps the last 6 hours and skips when nothing changed', async (t) => {
  const { shard, clock, url } = await startShard(t, {}),
    a = await joined(shard, url),
    cell = airNear(a, standing(shard, a));
  await shard.snapshot();
  assert.equal((await shard.snapshots()).length, 0, 'nothing edited, nothing written');
  assert.ok(a.client.edit(...cell, BRICKS));
  assert.ok(await drive([a.client], () => shard.server.metrics.editsAccepted > 0));
  await shard.snapshot();
  const firstAt = clock.now;
  assert.deepEqual(await shard.snapshots(), [firstAt]);
  await shard.snapshot();
  assert.deepEqual(await shard.snapshots(), [firstAt], 'unchanged');
  const other = [cell[0], cell[1] + 1, cell[2]];
  assert.ok(a.client.edit(...other, BRICKS));
  assert.ok(await drive([a.client], () => shard.server.metrics.editsAccepted > 1));
  clock.now += 6 * 3600_000 + 1;
  await shard.snapshot();
  assert.deepEqual(await shard.snapshots(), [clock.now], 'the old one is past 6 hours');
  a.client.close();
});

test('a world comes back from its newest good snapshot after a crash, with the same seed, end and edits', async (t) => {
  const dir = dataDir(t),
    first = await startShard(t, { dataDir: dir }),
    a = await joined(first.shard, first.url),
    cell = airNear(a, standing(first.shard, a));
  assert.ok(a.client.edit(...cell, BRICKS));
  assert.ok(await drive([a.client], () => first.shard.server.metrics.editsAccepted > 0));
  await first.shard.snapshot();
  const world = { ...first.shard.world };
  a.client.close();
  await first.shard.shutdown();

  // A newer snapshot that never got written whole is passed over.
  const worldDir = pathJoin(dir, 'shard-0', world.id),
    damaged = pathJoin(worldDir, `snap-${first.clock.now + 5000}.bin`);
  writeFileSync(damaged, 'not a snapshot');
  const said = [],
    second = await startShard(t, { dataDir: dir, log: (line) => said.push(line) });
  assert.equal(second.shard.world.id, world.id);
  assert.equal(second.shard.world.seed, world.seed);
  assert.equal(second.shard.world.endsAt, world.endsAt);
  assert.ok(
    said.some((line) => line.includes('damaged')),
    said.join('\n'),
  );
  assert.equal((await second.shard.server.exportEdits()).size, 1);
  const c = await joined(second.shard, second.url);
  assert.ok(
    await drive([c.client], () => second.shard.server.world.getChunk(cell[0] >> 5, cell[1] >> 5, cell[2] >> 5)),
  );
  assert.equal(second.shard.server.world.getBlock(...cell) & 0xffff, BRICKS);
  c.client.close();
});

test('a world past its end when the shard starts ends at once from its snapshot', async (t) => {
  const dir = dataDir(t),
    first = await startShard(t, { dataDir: dir, spanMs: 60_000 }),
    a = await joined(first.shard, first.url),
    cell = airNear(a, standing(first.shard, a));
  assert.ok(a.client.edit(...cell, BRICKS));
  assert.ok(await drive([a.client], () => first.shard.server.metrics.editsAccepted > 0));
  await first.shard.snapshot();
  const { id } = first.shard.world;
  a.client.close();
  await first.shard.shutdown();

  const ended = [],
    second = new PlazaShard({
      index: 0,
      dataDir: dir,
      origins: '*',
      log: () => {},
      now: () => first.clock.now + 120_000,
    });
  second.onEnded = (info) => ended.push(info);
  assert.equal(await second.start(), false);
  assert.deepEqual(ended, [{ id, finished: true }]);
  assert.equal((await readSnapshot(pathJoin(dir, 'final', `${id}.bin`))).size, 1);
  assert.equal(existsSync(pathJoin(dir, 'shard-0', 'state.json')), false);
  assert.deepEqual(readdirSync(pathJoin(dir, 'shard-0')), []);
});

test('the end of a span writes the final snapshot and closes clients with 1001; a world without edits leaves no final', async (t) => {
  const dir = dataDir(t),
    { shard, url } = await startShard(t, { dataDir: dir }),
    a = await joined(shard, url),
    cell = airNear(a, standing(shard, a));
  assert.ok(a.client.edit(...cell, BRICKS));
  assert.ok(await drive([a.client], () => shard.server.metrics.editsAccepted > 0));
  const ended = new Promise((done) => (shard.onEnded = done)),
    closed = closes(a.conn),
    { id } = shard.world;
  await shard.endWorld();
  assert.deepEqual(await ended, { id, finished: true });
  assert.equal((await closed).code, 1001);
  assert.equal((await readSnapshot(pathJoin(dir, 'final', `${id}.bin`))).size, 1);
  assert.equal(shard.canEdit(640, 200, 640), false);

  const empty = dataDir(t),
    idle = await startShard(t, { dataDir: empty });
  await idle.shard.endWorld();
  assert.equal(existsSync(pathJoin(empty, 'final')), false);
});

test('players spawn on the ring when no test says otherwise, never on a sea floor', async (t) => {
  const { shard, url } = await startShard(t, { spawn: undefined }),
    a = await joined(shard, url),
    [x, y, z] = standing(shard, a),
    ring = plazaSpawnRing(SEED, blocks.table);
  assert.ok(
    ring.some(([rx, rz]) => rx === x && rz === z),
    `${x},${z} is on the ring`,
  );
  assert.ok(y > 0, `standing at ${y}, above the sea`);
  a.client.close();
});

test('a new world gets a seed with a dry ring', async (t) => {
  const shard = new PlazaShard({ index: 0, dataDir: dataDir(t), origins: '*', quiet: true, beatMs: 3_600_000 });
  t.after(() => shard.shutdown());
  await shard.start();
  assert.ok(plazaSpawnRing(shard.world.seed, blocks.table).length >= 32);
});

test('a player with no movement and no edit is closed with 4410 idle and its place freed; movers and builders stay', async (t) => {
  // The real clock and a short limit, in a room for three: the idle one goes, the mover and the builder do not.
  const { shard, url } = await startShard(t, {
      now: Date.now,
      idleMs: 700,
      idleCheckMs: 40,
      capacity: 3,
      spawn: () => [0, 30],
    }),
    sleeper = await joined(shard, url),
    mover = await joined(shard, url),
    builder = await joined(shard, url),
    full = await join(url);
  assert.equal((await closes(full.conn)).code, 1013, 'the room is full');
  for (const c of [sleeper, mover, builder]) c.conn.onclose = (code, reason) => (c.ended = { code, reason });
  let placed = 0,
    nextEdit = 0,
    last = performance.now();
  // One frame of all three: the mover alternates forward and back, the builder places and breaks a block, the sleeper
  // only sends its steady input with no keys.
  const frame = async (live) => {
    await wait(16);
    const now = performance.now(),
      dt = (now - last) / 1000;
    last = now;
    for (const c of live)
      c.client.update(dt, {
        keys: c === mover ? (Math.floor(now / 150) % 2 ? Keys.forward : Keys.back) : 0,
        yaw: 0,
        pitch: 0,
      });
    if (live.includes(builder) && now > nextEdit) {
      nextEdit = now + 100;
      builder.client.edit(...airNear(builder, standing(shard, builder)), placed++ % 2 ? 0 : BRICKS);
    }
  };
  for (const end = performance.now() + 15_000; !sleeper.ended && performance.now() < end; )
    await frame([sleeper, mover, builder]);
  assert.deepEqual(sleeper.ended, { code: IDLE_CLOSE_CODE, reason: IDLE_REASON });
  assert.equal(IDLE_CLOSE_CODE, 4410);
  // Twice the limit more, still busy: the other two are there.
  for (const stay = performance.now() + 1400; performance.now() < stay; ) await frame([mover, builder]);
  assert.equal(mover.ended, undefined);
  assert.equal(builder.ended, undefined);
  assert.equal(shard.server.players.length, 2, 'its place is free');
  const again = await joined(shard, url);
  assert.ok(again.client.spawned, 'a new player takes the place');
  for (const c of [mover, builder, again]) c.client.close();
});

test('idleMs 0 turns the limit off', async (t) => {
  const { shard, url } = await startShard(t, { now: Date.now, idleMs: 0, idleCheckMs: 20 }),
    a = await joined(shard, url);
  assert.equal(shard.closeIdle(), 0);
  assert.equal(shard.server.players.length, 1);
  a.client.close();
});

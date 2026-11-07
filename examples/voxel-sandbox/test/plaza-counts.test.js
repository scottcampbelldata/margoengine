// The finds in a real shard, over real sockets: what a client earns, what it is refused, what a restart keeps and what a
// world's end does. The cells a test digs are stamped straight into the server's world, which is how an ore looks to the
// rules: a counted block nobody placed. The one test of a real gem uses a gem of the seed, close under the surface.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '@margoengine/voxel-net';
import { connectWebSocket } from '@margoengine/voxel-net/server';
import { HOST, PlazaShard } from '../server/shard.mjs';
import { defineBlocks } from '../src/blocks.ts';
import { decodeCounts } from '../src/counts.ts';
import { plazaFinds } from '../src/finds.ts';
import { COUNTED_BLOCKS, GEM_TOTAL } from '../src/plaza-area.ts';

const { blocks } = defineBlocks(),
  TIN = blocks.id('tin_ore'),
  OPAL = blocks.id('opal'),
  BRICKS = blocks.id('bricks'),
  TIN_SLOT = COUNTED_BLOCKS.indexOf('tin_ore'),
  OPAL_SLOT = COUNTED_BLOCKS.indexOf('opal'),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  SEED = 5;

// The shards each test started. Hooks run in the order they were added and a test makes its folder before its shard, so
// the folder's hook stops the shards first: one still running would write into a folder that is gone, or make it again.
const shardsOf = new WeakMap();

function dataDir(t) {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'plaza-counts-'));
  t.after(async () => {
    for (const shard of shardsOf.get(t) ?? []) await shard.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
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
      countsSaveMs: 3_600_000,
      greetMs: 20,
      spawn: () => [0, 30],
      proxied: true,
      ...options,
    });
  shardsOf.set(t, [...(shardsOf.get(t) ?? []), shard]);
  assert.equal(await shard.start(), true);
  return { shard, clock, url: `ws://${HOST}:${shard.address.port}` };
}

// Updates clients at 60 per second until `until()` holds or 15 s pass.
async function drive(clients, until) {
  const end = performance.now() + 15_000;
  let last = performance.now();
  while (!until()) {
    if (performance.now() > end) return false;
    await wait(16);
    const now = performance.now();
    for (const c of clients) c.client.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
  return true;
}

// A player at address `ip`, spawned with its chunk, that has had its first counts.
async function player(shard, url, ip, options = {}) {
  const conn = await connectWebSocket(url, { headers: { 'X-Real-IP': ip } }),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(
      world,
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name: 'Amber Lantern', ...options },
    ),
    c = { client, conn, world, ip, messages: [], last: undefined };
  client.onApp = (data) => {
    const message = decodeCounts(data);
    c.messages.push(message);
    c.last = message;
    if (message.counts) c.counts = message.counts;
    c.found = message.found;
  };
  conn.onmessage = (d) => client.receive(d);
  c.closed = new Promise((done) => {
    conn.onclose = (code) => {
      c.closeCode = code;
      c.messagesAtClose = c.messages.length;
      done(code);
    };
  });
  assert.ok(await drive([c], () => client.spawned && c.counts), 'spawned, and the first counts came');
  return c;
}
const server = (shard, c) => shard.server.players.find((p) => p.id === c.client.welcome.id),
  at = (shard, c) => [...server(shard, c).character.position].map(Math.floor);

// Air cells near the player, off its own body and every other in the list, inside loaded chunks on both sides.
function cellsNear(shard, c, count) {
  const [x, y, z] = at(shard, c),
    found = [];
  for (let up = 1; up <= 2; up++)
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
        const cell = [x + dx, y + up, z + dz];
        if (c.world.getChunk(cell[0] >> 5, cell[1] >> 5, cell[2] >> 5) && shard.server.world.getBlock(...cell) === 0)
          found.push(cell);
        if (found.length === count) return found;
      }
  throw new Error(`Only ${found.length} cells near ${[x, y, z]}`);
}
// Stamps an ore in both worlds, as the generator would have.
// Puts `state` at `cell` in the server's world and in each client's copy. It waits until every client holds the cell's
// chunk first: setBlock adds a chunk that is missing, and the server's copy arriving after that finds one already there.
async function stamp(shard, clients, cell, state) {
  const [cx, cy, cz] = cell.map((v) => v >> 5);
  assert.ok(
    await drive(clients, () => clients.every((c) => c.world.getChunk(cx, cy, cz))),
    `every client holds chunk ${cx},${cy},${cz}`,
  );
  shard.server.world.setBlock(...cell, state);
  for (const c of clients) c.world.setBlock(...cell, state);
}
const landed = (shard, n) => (shard.server.metrics.editsAccepted ?? 0) >= n;
const denied = (shard, n) => (shard.server.metrics.editsDenied ?? 0) >= n;
const tinOf = (c) => c.counts[TIN_SLOT];

test('one player: digging an ore counts and tells the page; placing without a count is refused and sent back', async (t) => {
  const { shard, url } = await startShard(t),
    a = await player(shard, url, '203.0.113.1');
  assert.deepEqual([...a.counts], [0, 0, 0, 0, 0]);
  assert.equal(a.last.total, GEM_TOTAL);
  assert.equal(a.last.found, 0);
  assert.equal(a.last.ended, false);
  const [ore, spot] = cellsNear(shard, a, 2);

  // A client claims a place with nothing to place.
  assert.ok(a.client.edit(...spot, TIN));
  assert.ok(await drive([a], () => denied(shard, 1) && a.world.getBlock(...spot) === 0), 'refused and put back');
  assert.equal(shard.server.world.getBlock(...spot), 0);
  assert.equal(tinOf(a), 0);

  await stamp(shard, [a], ore, TIN);
  assert.ok(a.client.edit(...ore, 0));
  assert.ok(await drive([a], () => tinOf(a) === 1), 'the dig came back as a count');
  assert.equal(shard.server.world.getBlock(...ore), 0);

  // Now it holds one, it may place it, and only it.
  assert.ok(a.client.edit(...spot, TIN));
  assert.ok(await drive([a], () => tinOf(a) === 0), 'placing spends it');
  assert.equal(shard.server.world.getBlock(...spot) & 0xffff, TIN);
  // And taking it back earns exactly what placing cost.
  assert.ok(a.client.edit(...spot, 0));
  assert.ok(await drive([a], () => tinOf(a) === 1));
  a.client.close();
});

test('a placed rare block breaks for its owner only; another player is refused and earns nothing', async (t) => {
  const { shard, url } = await startShard(t),
    a = await player(shard, url, '203.0.113.1'),
    b = await player(shard, url, '203.0.113.2'),
    [ore, spot] = cellsNear(shard, a, 2);
  await stamp(shard, [a, b], ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive([a, b], () => tinOf(a) === 1));
  a.client.edit(...spot, TIN);
  assert.ok(await drive([a, b], () => tinOf(a) === 0 && b.world.getBlock(...spot) === TIN), 'placed, both see it');

  const before = shard.server.metrics.editsDenied;
  assert.ok(b.client.edit(...spot, 0));
  assert.ok(
    await drive([a, b], () => denied(shard, before + 1) && b.world.getBlock(...spot) === TIN),
    'refused, put back',
  );
  assert.equal(shard.server.world.getBlock(...spot) & 0xffff, TIN);
  assert.equal(tinOf(b), 0);
  a.client.close();
  b.client.close();
});

test('stamp waits for a client still loading: every chunk in a client world is one the server sent', async (t) => {
  const { shard, url } = await startShard(t),
    a = await player(shard, url, '203.0.113.1'),
    [ore] = cellsNear(shard, a, 1),
    [cx, cy, cz] = ore.map((v) => v >> 5),
    // Connected, and nothing received yet: the late tab of the race seen under load.
    conn = await connectWebSocket(url, { headers: { 'X-Real-IP': '203.0.113.2' } }),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(
      world,
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name: 'Amber Lantern' },
    ),
    late = { client, conn, world },
    errors = [];
  let fromServer = false;
  conn.onmessage = (d) => client.receive(d);
  client.onError = (error) => errors.push(error);
  // A chunk the client put in its world is one whose message it had already counted; one setBlock made is not.
  world.onChunk((x, y, z, chunk) => {
    if (chunk && x === cx && y === cy && z === cz && client.stats.chunks > 0) fromServer = true;
  });
  assert.equal(world.getChunk(cx, cy, cz), undefined);
  await stamp(shard, [a, late], ore, TIN);
  assert.equal(world.getBlock(...ore) & 0xffff, TIN);
  assert.ok(await drive([late], () => errors.length > 0 || fromServer), 'the server sent the chunk, or it failed');
  assert.deepEqual(errors, []);
  assert.equal(fromServer, true);
  a.client.close();
  client.close();
});

test('same address, same counts, on every tab; another address has its own', async (t) => {
  const { shard, url } = await startShard(t),
    a = await player(shard, url, '203.0.113.1'),
    tab = await player(shard, url, '203.0.113.1'),
    other = await player(shard, url, '203.0.113.2'),
    [ore] = cellsNear(shard, a, 1);
  await stamp(shard, [a, tab, other], ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive([a, tab, other], () => tinOf(a) === 1 && tinOf(tab) === 1), 'both tabs told');
  await wait(100);
  assert.equal(tinOf(other), 0);
  const heard = other.messages.length;
  assert.equal(heard, 1, 'nothing about someone else s ore');
  a.client.close();
  tab.client.close();
  other.client.close();
});

test('a real gem of the seed: the world count moves for everyone, exactly once, and GEM_TOTAL holds', async (t) => {
  const finds = plazaFinds(SEED);
  assert.equal([...finds.gems.values()].flat().length, GEM_TOTAL);
  let gem;
  const shallow = [...finds.gems.values()].flat().sort(([, a], [, b]) => b - a);
  // Highest first: one close under its surface is in reach of a player standing beside it.
  for (const candidate of shallow.slice(0, 60)) {
    const { shard, url } = await startShard(t, { spawn: () => [candidate[0], candidate[2] + 1] });
    const a = await player(shard, url, '203.0.113.1', { view: 3 }),
      p = server(shard, a).character.position,
      reach = Math.hypot(candidate[0] + 0.5 - p[0], candidate[1] + 0.5 - p[1] - 1.62, candidate[2] + 0.5 - p[2]);
    if (reach > 6.5) {
      a.client.close();
      await shard.shutdown();
      continue;
    }
    gem = candidate;
    const b = await player(shard, url, '203.0.113.2', { view: 3 });
    assert.equal(shard.server.world.getBlock(...gem) & 0xffff, OPAL, 'the generator stamped it');
    assert.ok(a.client.edit(...gem, 0));
    assert.ok(await drive([a, b], () => a.counts[OPAL_SLOT] === 1 && b.found === 1), 'dug, and everyone heard');
    assert.equal(shard.found, 1);
    assert.equal(b.counts[OPAL_SLOT], 0);
    assert.equal(a.last.total, GEM_TOTAL);
    // Put it back and take it again: the world count stays.
    assert.ok(a.client.edit(...gem, OPAL));
    assert.ok(await drive([a, b], () => a.counts[OPAL_SLOT] === 0));
    assert.ok(a.client.edit(...gem, 0));
    assert.ok(await drive([a, b], () => a.counts[OPAL_SLOT] === 1));
    assert.equal(shard.found, 1);
    a.client.close();
    b.client.close();
    break;
  }
  assert.ok(gem, 'a gem in reach of the ground');
});

test('the limit on edited chunks refuses after the rule said yes: a dig that did not land earns nothing, again and again', async (t) => {
  // One edited chunk at most. The first edit fills it; the ore in another chunk cannot land.
  const { shard, url } = await startShard(t, { maxEditedChunks: 1 }),
    a = await player(shard, url, '203.0.113.1'),
    // The player stands at x = 0, on a chunk border, so these cells lie in two chunks.
    cells = cellsNear(shard, a, 40),
    first = cells[0],
    other = cells.find((c) => c[0] >> 5 !== first[0] >> 5);
  a.client.edit(...first, BRICKS);
  assert.ok(await drive([a], () => landed(shard, 1)));
  // Not through setBlock: this ore must look generated, in a chunk with no edit, as a dig past the limit finds it.
  const chunk = shard.server.world.getChunk(other[0] >> 5, other[1] >> 5, other[2] >> 5);
  chunk.set(other[0] & 31, other[1] & 31, other[2] & 31, TIN);
  a.world.getChunk(other[0] >> 5, other[1] >> 5, other[2] >> 5).set(other[0] & 31, other[1] & 31, other[2] & 31, TIN);
  for (let i = 1; i <= 3; i++) {
    const before = shard.server.metrics.editsDenied;
    assert.ok(a.client.edit(...other, 0));
    assert.ok(await drive([a], () => denied(shard, before + 1) && a.world.getBlock(...other) === TIN), `refused ${i}`);
    assert.equal(tinOf(a), 0);
  }
  await wait(60);
  assert.equal(tinOf(a), 0);
  a.client.close();
});

test('a clean restart keeps counts, owners and dug cells, and the same address gets them back', async (t) => {
  const dir = dataDir(t),
    first = await startShard(t, { dataDir: dir }),
    a = await player(first.shard, first.url, '203.0.113.1'),
    [ore1, ore2, spot] = cellsNear(first.shard, a, 3);
  for (const ore of [ore1, ore2]) {
    await stamp(first.shard, [a], ore, TIN);
    const want = tinOf(a) + 1;
    a.client.edit(...ore, 0);
    assert.ok(await drive([a], () => tinOf(a) === want));
  }
  a.client.edit(...spot, TIN);
  assert.ok(await drive([a], () => tinOf(a) === 1));
  await first.shard.shutdown();

  const second = await startShard(t, { dataDir: dir }),
    back = await player(second.shard, second.url, '203.0.113.1');
  assert.equal(tinOf(back), 1, 'the count came back');
  assert.ok(second.shard.world.id === first.shard.world.id, 'the same world');
  assert.equal(second.shard.server.world.getBlock(...spot) & 0xffff, TIN);
  const stranger = await player(second.shard, second.url, '203.0.113.9');
  assert.equal(tinOf(stranger), 0);
  const denials = second.shard.server.metrics.editsDenied;
  stranger.client.edit(...spot, 0);
  assert.ok(await drive([stranger], () => denied(second.shard, denials + 1)), 'its owner is remembered');
  back.client.edit(...spot, 0);
  assert.ok(await drive([back], () => tinOf(back) === 2));
  back.client.close();
  stranger.client.close();
});

test('a crash: at most the last save of counts is lost, a placed block the old snapshot lacks goes back to its owner', async (t) => {
  const dir = dataDir(t),
    first = await startShard(t, { dataDir: dir, countsSaveMs: 30 }),
    a = await player(first.shard, first.url, '203.0.113.1'),
    [ore, spot] = cellsNear(first.shard, a, 2);
  await stamp(first.shard, [a], ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive([a], () => tinOf(a) === 1));
  a.client.edit(...spot, TIN);
  assert.ok(await drive([a], () => tinOf(a) === 0));
  // Saved by the 30 ms timer; no snapshot was ever taken, so the world restarts without the block.
  const file = pathJoin(dir, 'shard-0', 'state.json');
  assert.ok(
    await drive([a], () => JSON.parse(readFileSync(file, 'utf8')).counts?.placed.length === 1),
    'the counts reached the disk',
  );
  a.client.close();
  // The crash: this process keeps nothing, and a new shard reads what is on disk. The old one must not write again.
  await first.shard.server.close();

  const second = await startShard(t, { dataDir: dir, countsSaveMs: 3_600_000 }),
    back = await player(second.shard, second.url, '203.0.113.1');
  assert.equal(second.shard.server.world.getBlock(...spot), 0, 'the world came back older');
  assert.equal(tinOf(back), 1, 'so the block went back to its owner');
  assert.equal(second.shard.found, 0);
  back.client.close();
  await first.shard.shutdown().catch(() => {});
});

test('a rollback gives back what it removes, keeps what it restores, and dug cells do not pay again', async (t) => {
  const { shard, clock, url } = await startShard(t),
    a = await player(shard, url, '203.0.113.1'),
    cells = cellsNear(shard, a, 3),
    [ore, keep, gone] = cells,
    area = { cx: keep[0] >> 5, cz: keep[2] >> 5 };
  await stamp(shard, [a], ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive([a], () => tinOf(a) === 1));
  a.client.edit(...keep, TIN);
  assert.ok(await drive([a], () => tinOf(a) === 0));
  clock.now += 60_000;
  await shard.snapshot();
  const taken = clock.now;

  // After the snapshot: the owner takes `keep` back and places it at `gone`.
  clock.now += 60_000;
  a.client.edit(...keep, 0);
  assert.ok(await drive([a], () => tinOf(a) === 1));
  a.client.edit(...gone, TIN);
  assert.ok(await drive([a], () => tinOf(a) === 0));

  clock.now += 1000;
  await shard.rollback(area, taken + 1, 0);
  assert.equal(shard.server.world.getBlock(...gone), 0, 'the block at gone was not in the snapshot');
  assert.equal(shard.server.world.getBlock(...keep) & 0xffff, TIN, 'the block at keep came back');
  assert.ok(await drive([a], () => tinOf(a) === 1), 'gone paid its owner back, and the owner hears');

  // keep was already taken back once: breaking it now pays nothing, whoever does it.
  assert.ok(await drive([a], () => a.world.getBlock(...keep) === TIN));
  const count = shard.server.metrics.editsAccepted;
  a.client.edit(...keep, 0);
  assert.ok(await drive([a], () => landed(shard, count + 1)));
  await wait(60);
  assert.equal(tinOf(a), 1);
  a.client.close();
});

test('a full world: every player has its counts, the next is refused, and a find reaches them all', async (t) => {
  const { shard, url } = await startShard(t, { capacity: 4 }),
    players = [];
  for (let i = 0; i < 4; i++) players.push(await player(shard, url, `203.0.113.${i + 1}`));
  const conn = await connectWebSocket(url, { headers: { 'X-Real-IP': '203.0.113.99' } }),
    extra = new VoxelNetClient(
      new VoxelWorld({ blocks }),
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name: 'Amber Lantern' },
    ),
    closed = new Promise((done) => (conn.onclose = done));
  conn.onmessage = (d) => extra.receive(d);
  extra.onError = () => {};
  assert.notEqual(await closed, 1000, 'the world is full');
  const [a] = players,
    [ore] = cellsNear(shard, a, 1);
  await stamp(shard, players, ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive(players, () => tinOf(a) === 1));
  for (const c of players) c.client.close();
});

test('a world end sends each player its last counts before 1001; the counts die with the state file, the goal stays in the final', async (t) => {
  const dir = dataDir(t),
    { shard, url } = await startShard(t, { dataDir: dir, countsSaveMs: 30 }),
    a = await player(shard, url, '203.0.113.1'),
    b = await player(shard, url, '203.0.113.2'),
    [ore] = cellsNear(shard, a, 1),
    identity = server(shard, a).identity;
  await stamp(shard, [a, b], ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive([a, b], () => tinOf(a) === 1));
  assert.ok(
    await drive([a, b], () => readFileSync(pathJoin(dir, 'shard-0', 'state.json'), 'utf8').includes(identity)),
    'state.json holds the salted identity while the world lives',
  );
  for (const raw of ['203.0.113.1', readFileSync(pathJoin(dir, 'identity.salt'), 'utf8')])
    assert.ok(
      !readFileSync(pathJoin(dir, 'shard-0', 'state.json'), 'utf8').includes(raw),
      'never the address or the salt',
    );

  await shard.endWorld();
  assert.equal(await a.closed, 1001);
  assert.equal(await b.closed, 1001);
  assert.equal(a.last.ended, true);
  assert.equal(tinOf(a), 1);
  assert.equal(b.last.ended, true);
  assert.equal(tinOf(b), 0);

  assert.equal(existsSync(pathJoin(dir, 'shard-0', 'state.json')), false, 'the state file is gone');
  const name = readdirSync(pathJoin(dir, 'final')).find((f) => f.endsWith('.json')),
    text = readFileSync(pathJoin(dir, 'final', name), 'utf8'),
    final = JSON.parse(text);
  assert.equal(final.found, 0);
  assert.equal(final.total, GEM_TOTAL);
  assert.ok(!text.includes(identity), 'the final names nobody');

  // The next world starts from nothing.
  const next = await startShard(t, { dataDir: dir }),
    again = await player(next.shard, next.url, '203.0.113.1');
  assert.deepEqual([...again.counts], [0, 0, 0, 0, 0]);
  assert.notEqual(next.shard.world.id, undefined);
  again.client.close();
});

test('nothing the client gets, and nothing the shard logs or hands the router, holds an identity or the salt', async (t) => {
  const dir = dataDir(t),
    lines = [],
    beats = [],
    { shard, url } = await startShard(t, { dataDir: dir, log: (line) => lines.push(line), countsSaveMs: 30 });
  shard.onBeat = (beat) => beats.push(beat);
  const a = await player(shard, url, '203.0.113.1'),
    [ore] = cellsNear(shard, a, 1),
    identity = server(shard, a).identity,
    salt = readFileSync(pathJoin(dir, 'identity.salt'), 'utf8');
  const seen = [];
  a.conn.onmessage = (d) => {
    seen.push(Buffer.from(d).toString('latin1'));
    a.client.receive(d);
  };
  await stamp(shard, [a], ore, TIN);
  a.client.edit(...ore, 0);
  assert.ok(await drive([a], () => tinOf(a) === 1));
  const handed = JSON.stringify({ world: shard.world, found: shard.found }),
    everything = [...seen, ...lines, handed].join('\n');
  for (const secret of [identity, salt, '203.0.113.1']) assert.ok(!everything.includes(secret), secret);
  a.client.close();
});

test('a test stops its shard before removing its folder, so the shard writes its last save into a folder still there', async (t) => {
  let dir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await t.test('a shard with an edit it has not saved', async (inner) => {
    dir = dataDir(inner);
    const { shard, url } = await startShard(inner, { dataDir: dir }),
      a = await player(shard, url, '203.0.113.1'),
      [ore] = cellsNear(shard, a, 1);
    await stamp(shard, [a], ore, TIN);
    a.client.edit(...ore, 0);
    assert.ok(await drive([a], () => tinOf(a) === 1));
    a.client.close();
  });
  // In the other order the shard's last save makes the removed folder again.
  assert.equal(existsSync(dir), false);
});

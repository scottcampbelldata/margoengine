// Resuming a dropped player on the server, over real sockets through a proxy that can cut them: what is kept while it is
// parked, what goes out again, and what is never resumed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeServerMessage, encodeClientMessage, Keys, PROTOCOL_VERSION } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';
import { cutProxy, until, wait } from './cut-proxy.js';

const blocks = testBlocks(),
  flat = new URL('./flat-generator.js', import.meta.url),
  slow = new URL('./slow-generator.js', import.meta.url);

// A client by hand: every message it got, in order.
async function peer(port, name, resume, view = 2) {
  const conn = await connectWebSocket(`ws://127.0.0.1:${port}`),
    p = { conn, name, messages: [], closed: undefined, step: 0, acked: 0 };
  conn.onmessage = (bytes) => p.messages.push(decodeServerMessage(bytes));
  conn.onclose = (code, reason) => (p.closed = { code, reason });
  conn.send(
    encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view, name, ...(resume ? { resume } : {}) }),
  );
  p.of = (type) => p.messages.filter((m) => m.type === type);
  p.welcome = () => p.of('welcome').at(-1);
  p.spawn = () => p.of('state').find((m) => m.spawn);
  p.spawned = () => until(`${name} spawned`, p.spawn);
  p.loaded = () => until(`${name} loaded`, () => p.of('loaded').length);
  p.chunkKeys = () => p.of('chunk').map((m) => `${m.cx},${m.cy},${m.cz}`);
  p.input = (position, keys = 0, yaw = 0, steps = 6) => {
    conn.send(
      encodeClientMessage({
        type: 'input',
        step: p.step + 1,
        acked: p.acked,
        runs: [{ steps, keys, yaw, pitch: 0 }],
        position,
      }),
    );
    p.step += steps;
  };
  return p;
}
const backFrom = (old, chunks = old.of('chunk').length, stale = []) => ({ token: old.welcome().resume, chunks, stale });

async function start(t, options = {}) {
  const server = new VoxelServer({
      blocks,
      workers: 1,
      generator: flat,
      spawn: () => [0, 0],
      flight: true,
      tickRate: 60,
      ...options,
    }),
    { port } = await server.listen(0),
    proxy = await cutProxy(port);
  server.onError = () => {};
  t.after(async () => {
    proxy.close();
    await server.close();
  });
  return { server, port, proxy, parked: () => until('the park', () => server.counts.parked >= 1) };
}
// One player joined through the proxy, its whole view received.
async function joined(s, name = 'ann') {
  const p = await peer(s.proxy.port, name);
  await p.spawned();
  await p.loaded();
  return p;
}

test('a FIN parks the player: same id, same place, same chunks, nothing sent again on a quiet world', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    id = ann.welcome().id,
    player = s.server.players[0],
    { position } = ann.spawn(),
    refs = s.server.counts.worldChunks,
    joins = s.server.metrics.joins;
  assert.equal(ann.welcome().resume.length, 16);
  assert.equal(player.connected, true);
  s.proxy.cut();
  await until('the park', () => player.connected === false);
  assert.equal(s.server.metrics.parked.socket, 1);
  assert.equal(s.server.players.length, 1, 'still counted');
  assert.equal(s.server.counts.parked, 1);
  assert.equal(s.server.counts.worldChunks, refs, 'its chunks stay loaded');
  await wait(100); // fixed-wait: the parked player stays parked while time passes
  const back = await peer(s.port, 'ann again', backFrom(ann));
  await back.spawned();
  assert.equal(back.welcome().id, id);
  assert.equal(back.welcome().resent, 0);
  assert.notDeepEqual(back.welcome().resume, ann.welcome().resume, 'the token changes on every resume');
  assert.equal(back.spawn().step, 0);
  assert.deepEqual(back.spawn().position, position, 'the spot it had');
  await back.loaded();
  assert.equal(back.of('chunk').length, 0, 'no chunk went out again');
  assert.equal(s.server.players[0], player, 'the same player object');
  assert.equal(player.connected, true);
  assert.equal(player.name, 'ann', 'the name it joined with');
  assert.equal(s.server.counts.parked, 0);
  assert.equal(s.server.counts.pending, 0, 'the new connection holds no joining place');
  assert.equal(s.server.metrics.resumed, 1);
  assert.equal(s.server.metrics.joins, joins, 'not a join');
  assert.equal(s.server.metrics.fullResends, 0);
  // It carries on where it stopped, with no correction loop or step error.
  for (let i = 0; i < 5; i++) {
    back.input(position);
    await wait(20);
  }
  assert.equal(back.closed, undefined);
  assert.equal(s.server.metrics.corrections, 0);
});

test('a resume carries on from the step the server had, and its corrections reach the client', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    { position } = ann.spawn();
  for (let i = 0; i < 4; i++) ann.input(position);
  await wait(100); // fixed-wait: server ticks run those inputs; nothing exposes the step they reached
  s.proxy.cut();
  await s.parked();
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  assert.equal(back.spawn().step, 24, 'the step it reached');
  back.step = 24;
  back.acked = 24;
  back.input([position[0] + 5, position[1], position[2]]);
  const fix = await until('a correction', () => back.of('state').find((m) => !m.spawn));
  assert.equal(fix.step, 30);
  assert.equal(back.closed, undefined);
});

test('others see the figure go at once and come back, name included', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    bob = await peer(s.port, 'bob');
  await bob.spawned();
  await until('bob hears ann', () => bob.of('names').length);
  const annId = ann.welcome().id;
  await wait(100); // fixed-wait: nobody moves, so the players messages stop after a while
  const heard = bob.of('players').length;
  s.proxy.cut();
  await s.parked();
  // The next players message tells bob ann is gone: it is a change, so it goes out though nobody moved.
  await until('a players message without ann', () => bob.of('players').length > heard);
  const names = bob.of('names').length,
    back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  await until('ann named again', () => bob.of('names').length > names);
  assert.deepEqual(bob.of('names').at(-1).names, [{ id: annId, name: 'ann' }]);
  // The one who came back gets a whole players message against an empty baseline, and bob's name with it.
  await until('bob named to ann', () => back.of('names').some((m) => m.names.some((n) => n.name === 'bob')));
  assert.ok(back.of('players').length);
});

test('a resume always gets a players message, so figures who left in the gap do not stay on its screen', async (t) => {
  const s = await start(t),
    ann = await joined(s);
  s.proxy.cut();
  await s.parked();
  const back = await peer(s.port, 'ann', backFrom(ann)),
    message = await until('a players message, with nobody near', () => back.of('players')[0]);
  assert.equal(message.data.length, 1, 'an empty list');
});

test('the bytes a cut lost: only the chunks the client did not get go out again', async (t) => {
  const s = await start(t, { maxView: 4, view: 4 }),
    ann = await peer(s.proxy.port, 'ann', undefined, 4);
  await ann.spawned();
  // Everything from here on is lost: the view keeps going out and nobody hears it.
  s.proxy.dropDown();
  await until('the server to send its whole view', () => s.server.metrics.bytesOut.loaded > 0);
  s.proxy.cut();
  await s.parked();
  const have = ann.chunkKeys(),
    back = await peer(s.port, 'ann', backFrom(ann), 4);
  await back.spawned();
  await back.loaded();
  const again = back.chunkKeys();
  assert.ok(again.length > 0, 'bytes were lost');
  assert.equal(back.welcome().resent, again.length);
  for (const key of again) assert.ok(!have.includes(key), `${key} had arrived and went out again`);
  assert.equal(new Set([...have, ...again]).size, have.length + again.length, 'each of them once');
  assert.equal(s.server.metrics.fullResends, 0);
  assert.equal(s.server.metrics.chunksResent, again.length);
});

test('cut in the middle of the chunk stream: the view still arrives whole, and `loaded` too', async (t) => {
  const s = await start(t, { maxView: 4, view: 4 }),
    first = await peer(s.port, 'first', undefined, 4);
  await first.spawned();
  await first.loaded();
  const whole = new Set(first.chunkKeys()),
    bea = await peer(s.proxy.port, 'bea', undefined, 4);
  await bea.spawned();
  s.proxy.dropDown();
  await wait(50); // fixed-wait: ticks at 60 a second write into the lost direction
  s.proxy.cut();
  await s.parked();
  const back = await peer(s.port, 'bea', backFrom(bea), 4);
  await back.spawned();
  await back.loaded(); // a `loaded` the dead socket swallowed comes again
  assert.equal(bea.of('loaded').length, 0, 'the first socket never got it');
  assert.deepEqual(new Set([...bea.chunkKeys(), ...back.chunkKeys()]), whole);
});

test('a count that makes no sense resends the whole view; a count the ring still covers resends those', async (t) => {
  for (const [chunks, full] of [
    [1_000_000, 1],
    [0, 0],
  ]) {
    const s = await start(t),
      ann = await joined(s),
      size = ann.of('chunk').length;
    s.proxy.cut();
    await s.parked();
    const back = await peer(s.port, 'ann', backFrom(ann, chunks));
    await back.spawned();
    await back.loaded();
    assert.equal(s.server.metrics.fullResends, full, `${chunks} chunks`);
    assert.equal(back.of('chunk').length, size);
    assert.equal(new Set(back.chunkKeys()).size, size);
  }
});

test('more lost than the ring remembers resends the whole view', async (t) => {
  const s = await start(t, { maxView: 6, view: 6 }),
    ann = await peer(s.proxy.port, 'ann', undefined, 6);
  await ann.spawned();
  await ann.loaded();
  const size = ann.of('chunk').length;
  assert.ok(size > 512, `a view of ${size} chunks`);
  s.proxy.cut();
  await s.parked();
  const back = await peer(s.port, 'ann', backFrom(ann, 0), 6);
  await back.spawned();
  await back.loaded();
  assert.equal(s.server.metrics.fullResends, 1);
  assert.equal(back.of('chunk').length, size);
});

test('half-open: the old socket is closed with `replaced`, its bytes ignored, and nothing was parked', async (t) => {
  const s = await start(t, { clientTimeout: 60_000 }),
    ann = await joined(s),
    { position } = ann.spawn();
  s.proxy.freeze();
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  assert.equal(back.welcome().id, ann.welcome().id);
  assert.equal(s.server.metrics.replaced, 1);
  assert.equal(s.server.metrics.parked.socket, 0);
  assert.equal(s.server.players.length, 1);
  assert.equal(s.server.players[0].connected, true);
  back.input(position);
  await wait(50); // fixed-wait: a stale socket ending would show within this time
  assert.equal(back.closed, undefined);
  assert.equal(s.server.counts.parked, 0, 'the old socket ending parks nothing');
});

test('the old socket hears 1000 replaced', async (t) => {
  const s = await start(t),
    ann = await peer(s.port, 'ann'); // straight to the server: this old socket is still heard both ways
  await ann.spawned();
  await ann.loaded();
  const { position } = ann.spawn(),
    back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  await until('the old socket to close', () => ann.closed);
  assert.deepEqual(ann.closed, { code: 1000, reason: 'replaced' });
  assert.deepEqual([...s.server.players[0].character.position], position);
  assert.equal(s.server.counts.parked, 0);
});

test('a token works once; unknown, used and expired tokens get 1008 resume-unknown and touch nothing', async (t) => {
  const s = await start(t, { resumeTimeout: 300 }),
    ann = await joined(s);
  s.proxy.cut();
  await s.parked();
  const stranger = await peer(s.port, 'x', { token: new Uint8Array(16).fill(1), chunks: 0, stale: [] });
  await until('the refusal', () => stranger.closed);
  assert.deepEqual(stranger.closed, { code: 1008, reason: 'resume-unknown' });
  assert.equal(stranger.of('welcome').length, 0);
  assert.equal(s.server.counts.parked, 1, 'nothing else touched');
  assert.equal(s.server.metrics.resumeFailed.unknown, 1);
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  const again = await peer(s.port, 'x', backFrom(ann));
  await until('the refusal of a used token', () => again.closed);
  assert.equal(again.closed.reason, 'resume-unknown');
  assert.equal(back.closed, undefined);
  // Parked past its time: freed, with its chunks, and the token dies with it.
  const cat = await peer(s.proxy.port, 'cat');
  await cat.spawned();
  s.proxy.cut();
  await s.parked();
  await until('the expiry', () => s.server.metrics.resumeFailed.expired === 1);
  assert.equal(s.server.counts.parked, 0);
  assert.equal(s.server.players.length, 1, 'only ann is left');
  const late = await peer(s.port, 'cat', backFrom(cat));
  await until('the refusal of an expired token', () => late.closed);
  assert.equal(late.closed.reason, 'resume-unknown');
});

test('resumeTimeout 0 turns it off: no token, and a cut frees the player at once', async (t) => {
  const s = await start(t, { resumeTimeout: 0 }),
    ann = await joined(s);
  assert.equal(ann.welcome().resume.length, 0);
  s.proxy.cut();
  await until('the leave', () => s.server.players.length === 0);
  assert.equal(s.server.metrics.parked.socket, 0);
  assert.throws(() => new VoxelServer({ blocks, resumeTimeout: -1 }), RangeError);
  assert.throws(() => new VoxelServer({ blocks, resumeTimeout: 'soon' }), TypeError);
});

test('a player who left on purpose or was closed by the server is never parked, and its token dies', async (t) => {
  const s = await start(t),
    refused = async (old) => {
      const late = await peer(s.port, old.name, backFrom(old));
      await until('its token refused', () => late.closed);
      assert.equal(late.closed.reason, 'resume-unknown');
    },
    gone = async () => {
      await until('the leave', () => s.server.players.length === 0);
      assert.equal(s.server.counts.parked, 0);
    };
  const a = await joined(s, 'a');
  a.conn.close(1000);
  await gone();
  await refused(a);
  const b = await joined(s, 'b');
  b.conn.send(new Uint8Array([99])); // unreadable: 1002
  await gone();
  await refused(b);
  const c = await joined(s, 'c');
  s.server.players[0].conn.close(4410, 'idle'); // as the Plaza shard's idle limit does
  await gone();
  await refused(c);
});

test('a player who never spawned has nothing to come back to', async (t) => {
  const s = await start(t, { generator: slow }),
    d = await peer(s.proxy.port, 'd');
  await until('its welcome', () => d.welcome());
  assert.equal(d.spawn(), undefined);
  s.proxy.cut();
  await until('the leave', () => s.server.players.length === 0);
  assert.equal(s.server.counts.parked, 0);
  assert.equal(s.server.metrics.parked.socket, 0);
});

test('a server closing frees its parked players', async (t) => {
  const s = await start(t);
  await joined(s);
  s.proxy.cut();
  await s.parked();
  await s.server.close();
  assert.equal(s.server.players.length, 0);
  assert.equal(s.server.counts.parked, 0);
});

test('client-silent parks as well, under its own count', async (t) => {
  const s = await start(t, { heartbeatInterval: 50, clientTimeout: 200 }),
    ann = await joined(s),
    player = s.server.players[0];
  s.proxy.freeze();
  await until('the park', () => player.connected === false);
  assert.equal(s.server.metrics.parked.clientSilent, 1);
  assert.equal(s.server.metrics.parked.socket, 0);
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  assert.equal(s.server.metrics.resumed, 1);
});

test('what changed in the gap comes back: edits while parked, edits written into the dead socket', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    bob = await peer(s.port, 'bob');
  await bob.spawned();
  await bob.loaded();
  // Both players stand at x 0.5: cell x 0 is in chunk 0, cell x -1 in the chunk next to it.
  const y = 7,
    edit = (x) => bob.conn.send(encodeClientMessage({ type: 'edit', x, y, z: 0, state: 0 }));
  s.proxy.dropDown();
  edit(0);
  await until('the edit', () => s.server.metrics.editsAccepted === 1);
  await wait(50); // fixed-wait: ticks at 60 a second: its blocks message goes into the lost direction
  s.proxy.cut();
  await s.parked();
  edit(-1);
  await until('the second edit', () => s.server.metrics.editsAccepted === 2);
  await wait(50); // fixed-wait: ticks at 60 a second send the second edit while parked
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  await back.loaded();
  assert.deepEqual(back.chunkKeys().sort(), ['-1,0,0', '0,0,0'], 'those two and nothing else');
  assert.equal(back.welcome().resent, 2);
  assert.equal(ann.of('blocks').length, 0, 'the first socket never heard the edit');
});

test('a refused edit written into the dead socket: its chunk comes back too', async (t) => {
  const s = await start(t, { allowEdit: () => false }),
    ann = await joined(s);
  s.proxy.dropDown();
  ann.conn.send(encodeClientMessage({ type: 'edit', x: 0, y: 7, z: 0, state: 0 }));
  await until('the refusal', () => s.server.metrics.editsDenied === 1);
  await wait(50); // fixed-wait: ticks at 60 a second: the refusal goes into the lost direction
  s.proxy.cut();
  await s.parked();
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  await back.loaded();
  assert.deepEqual(back.chunkKeys(), ['0,0,0']);
  assert.equal(back.welcome().resent, 1);
});

test("the client's own edits that may never have arrived: the chunks it lists go out again", async (t) => {
  const s = await start(t),
    ann = await joined(s);
  s.proxy.cut();
  await s.parked();
  const stale = [
      [0, 0, 0],
      [999, 999, 999],
    ],
    back = await peer(s.port, 'ann', backFrom(ann, undefined, stale));
  await back.spawned();
  await back.loaded();
  assert.deepEqual(back.chunkKeys(), ['0,0,0'], 'the one it has; a chunk it never had changes nothing');
});

test('an unload the dead socket swallowed is said again', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    { position } = ann.spawn();
  s.proxy.dropDown();
  // Flies along -z, far enough to leave chunks behind, sending inputs the server still hears.
  for (let i = 0; i < 2000 && !s.server.metrics.bytesOut.unload; i++) {
    ann.input(position, Keys.forward | Keys.fly);
    await wait(8);
  }
  assert.ok(s.server.metrics.bytesOut.unload > 0, 'it moved far enough');
  await wait(50); // fixed-wait: ticks at 60 a second: the unloads go into the lost direction
  s.proxy.cut();
  await s.parked();
  assert.equal(ann.of('unload').length, 0, 'none got through');
  const back = await peer(s.port, 'ann', backFrom(ann)),
    unloads = await until('the unloads again', () => back.of('unload').length && back.of('unload'));
  assert.ok(
    unloads.some((m) => ann.chunkKeys().includes(`${m.cx},${m.cy},${m.cz}`)),
    'a chunk it holds and would have kept for good',
  );
});

test('app messages queued during the park go out in order, after the state', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    player = s.server.players[0];
  s.proxy.cut();
  await s.parked();
  assert.equal(s.server.send(player, Uint8Array.of(1)), true);
  assert.equal(s.server.broadcast(Uint8Array.of(2)), 1);
  await wait(30);
  const back = await peer(s.port, 'ann', backFrom(ann));
  await until('both', () => back.of('app').length === 2);
  assert.deepEqual(
    back.of('app').map((m) => m.data[0]),
    [1, 2],
  );
  const order = back.messages.map((m) => m.type);
  assert.ok(order.indexOf('welcome') < order.indexOf('state'));
  assert.ok(order.indexOf('state') < order.indexOf('app'));
});

test('a parked player whose queue passes what a live socket may hold is freed, not kept growing', async (t) => {
  const s = await start(t),
    ann = await joined(s),
    player = s.server.players[0];
  s.proxy.cut();
  await s.parked();
  const big = new Uint8Array(16384);
  for (let i = 0; i < 600; i++) s.server.send(player, big); // 9.8 MB
  await until('the free', () => s.server.counts.parked === 0);
  assert.equal(s.server.players.length, 0);
  assert.equal(s.server.metrics.resumeFailed.expired, 1);
  const late = await peer(s.port, 'ann', backFrom(ann));
  await until('the refusal', () => late.closed);
  assert.equal(late.closed.reason, 'resume-unknown');
});

test('a parked player holds its place in maxPlayers, and its chunks go when it is freed', async (t) => {
  const s = await start(t, { maxPlayers: 1, resumeTimeout: 300 });
  await joined(s);
  assert.ok(s.server.counts.worldChunks > 0);
  s.proxy.cut();
  await s.parked();
  const other = await peer(s.port, 'other');
  await until('server full', () => other.closed);
  assert.equal(other.closed.code, 1013);
  await until('the expiry', () => s.server.counts.parked === 0);
  assert.equal(s.server.counts.worldChunks, 0);
});

test('the new connection brings the identity: a phone that changed networks is still that player', async (t) => {
  let identity = 'home';
  const s = await start(t, { authenticate: () => identity }),
    ann = await joined(s),
    player = s.server.players[0];
  assert.equal(player.identity, 'home');
  s.proxy.cut();
  await s.parked();
  identity = 'phone';
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  assert.equal(player.identity, 'phone');
  assert.equal(s.server.counts.pending, 0);
});

test('a resume still has to pass authenticate, and a refused one leaves the player parked', async (t) => {
  let open = true;
  const s = await start(t, { authenticate: () => open }),
    ann = await joined(s);
  s.proxy.cut();
  await s.parked();
  open = false;
  const refused = await peer(s.port, 'ann', backFrom(ann));
  await until('the refusal', () => refused.closed);
  assert.equal(refused.closed.reason, 'not authorized');
  assert.equal(s.server.counts.parked, 1);
  open = true;
  const back = await peer(s.port, 'ann', backFrom(ann));
  await back.spawned();
  assert.equal(s.server.metrics.resumed, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseCode, LoopbackNetwork } from '../dist/index.js';
import { RollbackSession } from '../dist/rollback.js';
import { relayPeers, RollbackRelay, RollbackSpectator } from '../dist/relay.js';
import { game } from './arena.js';

const steering = (player) => (frame) => {
  const phase = Math.floor(frame / 12) + player * 13;
  return { x: Math.sin(phase), y: Math.cos(phase * 1.7), boost: phase % 5 === 0 };
};

/** Peers on one virtual clock, each with one link to the relay. */
function world(players, conditions = { latency: 30, seed: 2 }, options = {}) {
  const network = new LoopbackNetwork(conditions),
    relay = new RollbackRelay({ players, ...options }),
    confirmed = new Map(players.map((p) => [p, new Map()])),
    desyncs = [],
    watchers = [],
    links = new Map(),
    peers = new Map();
  const connect = () => {
    const [near, far] = network.pair();
    relay.accept(far);
    return near;
  };
  const sessions = players.map((local) => {
    const link = connect();
    links.set(local, link);
    peers.set(local, relayPeers(link, { players, local }));
    return new RollbackSession(game, {
      players,
      local,
      peers: peers.get(local),
      input: steering(local),
      now: () => network.time,
      onconfirm: (frame, sum) => confirmed.get(local).set(frame, sum),
      ondesync: (event) => desyncs.push(event),
    });
  });
  const run = (ms) => {
    for (const end = network.time + ms; network.time < end; ) {
      network.advance(1000 / 60);
      for (const session of sessions) session.update();
      for (const watcher of watchers) watcher.update();
    }
  };
  const watch = (token) => {
    const sums = new Map(),
      watcher = new RollbackSpectator(game, connect(), { token, onconfirm: (frame, sum) => sums.set(frame, sum) });
    watchers.push(watcher);
    return { watcher, sums };
  };
  return { confirmed, connect, desyncs, links, network, peers, relay, run, sessions, watch };
}

test('relay: 16 peers on one link each stay in step, and a spectator sees every confirmed frame the same', () => {
  const players = Array.from({ length: 16 }, (_, i) => i + 1),
    w = world(players),
    { sums, watcher } = w.watch();
  w.run(4000);
  const frames = Math.min(...w.sessions.map((s) => s.confirmed));
  assert.ok(frames > 100, `confirmed ${frames} frames`);
  assert.ok(watcher.frame > 100, `the spectator ran ${watcher.frame} frames`);
  assert.deepEqual(w.desyncs, []);
  const seen = Math.min(frames, watcher.frame);
  for (let frame = 1; frame <= seen; frame++) {
    const sum = w.confirmed.get(1).get(frame);
    for (const player of players) assert.equal(w.confirmed.get(player).get(frame), sum, `peer ${player} frame ${frame}`);
    assert.equal(sums.get(frame), sum, `the spectator at frame ${frame}`);
  }
  assert.ok(w.relay.stats.forwarded > 1000);
  assert.equal(w.relay.watching, 1);
});

test('relay: it holds under latency, jitter, loss and reordering', () => {
  const players = [1, 2, 3, 4],
    w = world(players, { latency: 40, jitter: 15, loss: 0.1, duplicate: 0.02, reorder: 0.05, seed: 8 }),
    { sums, watcher } = w.watch();
  w.run(10_000);
  assert.deepEqual(w.desyncs, []);
  const seen = Math.min(watcher.frame, ...w.sessions.map((s) => s.confirmed));
  assert.ok(seen > 200, `compared ${seen} frames`);
  for (let frame = 1; frame <= seen; frame++) assert.equal(sums.get(frame), w.confirmed.get(2).get(frame));
});

test('relay: a late spectator starts from the first frame, and spectatorDelay keeps it behind', () => {
  const players = [1, 2],
    w = world(players, undefined, { spectatorDelay: 30 });
  w.run(3000);
  const { sums, watcher } = w.watch();
  w.run(3000);
  assert.ok(watcher.frame > 100, `${watcher.frame} ran at 30 frames a second`);
  assert.ok(w.relay.frame - watcher.frame >= 30, `${w.relay.frame} against ${watcher.frame}`);
  for (let frame = 1; frame <= watcher.frame; frame++) assert.equal(sums.get(frame), w.confirmed.get(1).get(frame));
});

test('relay: a player who leaves is gone for the others; a second link for a seat and a stranger are refused', () => {
  const w = world([1, 2, 3]);
  w.run(500);
  const closes = [];
  const taken = w.connect();
  relayPeers(taken, { players: [1, 2, 3], local: 2 }).get(1).onclose = (code) => closes.push(code);
  const stranger = w.connect();
  relayPeers(stranger, { players: [1, 2, 9], local: 9 }).get(1).onclose = (code) => closes.push(code);
  w.run(200);
  assert.deepEqual(closes, [CloseCode.full, CloseCode.protocol]);
  assert.equal(w.peers.get(1).get(2).open, true);
  w.links.get(2).close();
  w.run(300);
  assert.equal(w.peers.get(1).get(2).open, false, 'the others see the player go');
  assert.equal(w.peers.get(1).get(3).open, true, 'and keep the rest');
  w.relay.close();
  assert.throws(() => w.relay.accept(w.connect()), { code: 'disposed' });
});

test('relay: authorize, maxSpectators and history refuse; junk closes the sender', () => {
  const w = world([1, 2], undefined, {
    authorize: (player, token) => player !== undefined || token === 'ticket',
    maxSpectators: 1,
    history: 10,
  });
  const closes = [];
  const denied = w.watch('wrong');
  w.run(100);
  assert.equal(denied.watcher.open, false);
  const first = w.watch('ticket');
  w.run(50);
  assert.equal(w.relay.watching, 1);
  const second = w.watch('ticket');
  w.run(50);
  assert.equal(second.watcher.open, false);
  assert.equal(first.watcher.open, true);
  w.run(2000);
  first.watcher.close();
  w.run(50);
  const late = w.watch('ticket');
  w.run(50);
  assert.equal(late.watcher.open, false, 'the session passed the history');
  const junk = w.connect();
  junk.onclose = (code) => closes.push(code);
  junk.send(new Uint8Array([200]), 'reliable');
  w.run(100);
  assert.deepEqual(closes, [CloseCode.protocol]);
  assert.throws(() => new RollbackRelay({ players: [] }), TypeError);
  assert.throws(() => new RollbackRelay({ players: [1], inputDelay: -1 }), RangeError);
  assert.throws(() => relayPeers(null, { players: [1], local: 1 }), TypeError);
  assert.throws(() => relayPeers(w.connect(), { players: [1], local: 2 }), TypeError);
  assert.throws(() => new RollbackSpectator(game, w.connect(), { maxFrames: 0 }), RangeError);
});

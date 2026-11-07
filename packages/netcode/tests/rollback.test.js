import test from 'node:test';
import assert from 'node:assert/strict';
import { defineGame, LoopbackNetwork } from '../dist/index.js';
import { RollbackSession } from '../dist/rollback.js';
import { game, schema } from './arena.js';

const checksum = (bytes) => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
};
const steering = (seed) => {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const memo = new Map();
  // The same frame always gives the same input, whoever asks and whenever.
  return (frame) => {
    const key = Math.floor(frame / 12);
    if (!memo.has(key)) memo.set(key, { x: next(), y: next(), boost: next() > 0.6 });
    return memo.get(key);
  };
};

// The game run once, offline, with every player's real input at every frame: what a perfect network would give.
function reference(players, inputs, delay, frames) {
  let state = game.initial();
  for (const p of [...players].sort((a, b) => a - b)) game.join(state, p);
  state = schema.clone('State', state);
  const sums = [0];
  for (let f = 1; f <= frames; f++) {
    const map = new Map();
    if (f > delay) for (const p of players) map.set(p, schema.clone('Input', inputs.get(p)(f)));
    game.step(state, map, f, 1 / game.tickRate);
    const bytes = schema.encode('State', state);
    state = schema.decode('State', bytes);
    sums.push(checksum(bytes));
  }
  return sums;
}

// A full mesh of peers on one virtual clock; `frame()` advances 1/60 s and updates every session.
function mesh(players, conditions, options = {}) {
  const network = new LoopbackNetwork(conditions),
    links = new Map(players.map((p) => [p, new Map()]));
  for (const a of players)
    for (const b of players)
      if (a < b) {
        const [ab, ba] = network.pair();
        links.get(a).set(b, ab);
        links.get(b).set(a, ba);
      }
  const inputs = new Map(players.map((p) => [p, steering(p * 7919)])),
    confirmed = new Map(players.map((p) => [p, new Map()])),
    desyncs = [];
  const sessions = players.map(
    (p) =>
      new RollbackSession(options.games?.get(p) ?? game, {
        players,
        local: p,
        peers: links.get(p),
        input: inputs.get(p),
        now: () => network.time,
        onconfirm: (frame, sum) => confirmed.get(p).set(frame, sum),
        ondesync: (event) => desyncs.push({ at: p, ...event }),
        ...options.session,
      }),
  );
  const run = (ms) => {
    for (const end = network.time + ms; network.time < end; ) {
      network.advance(1000 / 60);
      for (const s of sessions) s.update();
    }
  };
  return { network, sessions, inputs, confirmed, desyncs, run };
}

test('rollback: every confirmed frame of every peer equals the offline result, under latency, jitter and loss', (t) => {
  const players = [1, 2, 3, 4],
    world = mesh(players, { latency: 50, jitter: 20, loss: 0.1, duplicate: 0.02, reorder: 0.05, seed: 3 });
  world.run(20_000);
  const frames = Math.min(...world.sessions.map((s) => s.confirmed));
  assert.ok(frames > 500, `confirmed ${frames} frames`);
  const truth = reference(players, world.inputs, 2, frames);
  for (const p of players)
    for (let f = 1; f <= frames; f++)
      assert.equal(world.confirmed.get(p).get(f), truth[f], `peer ${p} frame ${f} equals the offline simulation`);
  const rollbacks = world.sessions.reduce((n, s) => n + s.stats.rollbacks, 0);
  assert.ok(rollbacks > 50, `rollbacks ${rollbacks}`);
  t.diagnostic(
    `${frames} frames confirmed on 4 peers; rollbacks ${rollbacks}, frames resimulated ${world.sessions.reduce((n, s) => n + s.stats.resimulated, 0)}, deepest ${Math.max(...world.sessions.map((s) => s.stats.deepest))}, checksums compared ${world.sessions.reduce((n, s) => n + s.stats.checked, 0)}`,
  );
  assert.deepEqual(world.desyncs, []);
  assert.ok(world.sessions.every((s) => s.stats.checked > 0));
  // Peers stay level: none runs far ahead of the slowest.
  const spread = Math.max(...world.sessions.map((s) => s.frame)) - Math.min(...world.sessions.map((s) => s.frame));
  assert.ok(spread <= 8, `frame spread ${spread}`);
});

test('input delay longer than the latency means no rollback at all', () => {
  const world = mesh([1, 2], { latency: 30, seed: 4 }, { session: { inputDelay: 4 } });
  world.run(5_000);
  assert.ok(world.sessions.every((s) => s.stats.rollbacks === 0 && s.stats.waits === 0 && s.stats.frames > 140));
  const frames = Math.min(...world.sessions.map((s) => s.confirmed)),
    truth = reference([1, 2], world.inputs, 4, frames);
  assert.equal(world.confirmed.get(1).get(frames), truth[frames]);
});

test('time sync: a peer that started early waits until the other catches up', () => {
  const network = new LoopbackNetwork({ latency: 40, seed: 9 }),
    [a, b] = network.pair(),
    now = () => network.time,
    input = () => ({ x: 1, y: 0, boost: false });
  const early = new RollbackSession(game, { players: [1, 2], local: 1, peers: new Map([[2, a]]), now, input });
  const late = new RollbackSession(game, { players: [1, 2], local: 2, peers: new Map([[1, b]]), now, input });
  for (let i = 0; i < 600; i++) {
    network.advance(1000 / 60);
    early.update();
    if (i >= 12) late.update(); // starts 200 ms (6 frames) later
  }
  assert.ok(early.stats.waits >= 4, `waits ${early.stats.waits}`);
  assert.ok(Math.abs(early.frame - late.frame) <= 3, `frames ${early.frame} and ${late.frame}`);
  assert.equal(early.stats.desyncs + late.stats.desyncs, 0);
});

test('desync detection: a peer whose step differs is caught by the checksum exchange', () => {
  const broken = defineGame({
    schema,
    state: 'State',
    input: 'Input',
    tickRate: 30,
    initial: game.initial,
    join: game.join,
    leave: game.leave,
    step(state, inputs, frame, dt) {
      game.step(state, inputs, frame, dt);
      if (frame === 100) state.boxes.get(100000).x += 0.5; // not deterministic across peers
    },
  });
  const world = mesh([1, 2], { latency: 20, seed: 5 }, { games: new Map([[2, broken]]) });
  world.run(8_000);
  assert.ok(world.desyncs.length >= 2, JSON.stringify(world.desyncs));
  assert.equal(world.desyncs[0].frame, 120);
  assert.notEqual(world.desyncs[0].local, world.desyncs[0].remote);
});

test('a silent peer stalls the session after maxRollback frames instead of running away', () => {
  const network = new LoopbackNetwork(),
    [a] = network.pair();
  const session = new RollbackSession(game, {
    players: [1, 2],
    local: 1,
    peers: new Map([[2, a]]),
    input: () => ({ x: 0, y: 0, boost: false }),
    maxRollback: 6,
  });
  let ran = 0;
  for (let i = 0; i < 40; i++) if (session.advance()) ran++;
  // Frames 1 and 2 (the input delay) need no input; then 6 more may run on predictions.
  assert.equal(ran, 8);
  assert.equal(session.stats.stalls, 32);
  assert.throws(
    () => new RollbackSession(game, { players: [1, 2], local: 3, peers: new Map(), input: () => ({}) }),
    /not in players/,
  );
  assert.throws(
    () => new RollbackSession(game, { players: [1, 2], local: 1, peers: new Map(), input: () => ({}) }),
    /no connection to player 2/,
  );
  session.close();
  assert.equal(a.open, false);
  // Bytes that are not a rollback message close that peer's connection with a protocol error.
  const [c, d] = network.pair();
  let code = 0;
  d.onclose = (closed) => (code = closed);
  new RollbackSession(game, { players: [1, 2], local: 1, peers: new Map([[2, c]]), input: () => ({}) });
  d.send(new Uint8Array([32, 255, 255]));
  network.advance(10);
  assert.equal(code, 4001);
  assert.throws(
    () => session.advance(),
    (e) => e.code === 'disposed',
  );
});

test('rollback: peers come back from an outage longer than the redundancy', () => {
  const network = new LoopbackNetwork({ latency: 30, seed: 9 }),
    [ab, ba] = network.pair();
  let down = false;
  for (const link of [ab, ba]) {
    const send = link.send.bind(link);
    link.send = (data, channel) => {
      if (!down || channel !== 'unreliable') send(data, channel);
    };
  }
  const session = (local, other, link) =>
    new RollbackSession(game, {
      players: [1, 2],
      local,
      peers: new Map([[other, link]]),
      input: (frame) => ({ x: Math.sin(frame / 9 + local), y: 0, boost: false }),
      now: () => network.time,
    });
  const sessions = [session(1, 2, ab), session(2, 1, ba)];
  const run = (ms) => {
    for (const end = network.time + ms; network.time < end; ) {
      network.advance(1000 / 60);
      for (const s of sessions) s.update();
    }
  };
  run(1000);
  down = true;
  run(1000);
  const during = Math.min(...sessions.map((s) => s.confirmed));
  down = false;
  run(2000);
  const after = Math.min(...sessions.map((s) => s.confirmed));
  assert.ok(after > during + 60, `confirmed ${during} during the outage and ${after} after it`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSchema, LoopbackNetwork } from '../dist/index.js';
import { HostMigration } from '../dist/migrate.js';

const schema = defineSchema({ types: { State: { score: 'uint', label: 'string' } } });
function mesh(count = 3, conditions = {}) {
  const network = new LoopbackNetwork({ latency: 10, ...conditions });
  const links = Array.from({ length: count }, () => new Map());
  for (let a = 0; a < count; a++)
    for (let b = a + 1; b < count; b++) {
      const [one, two] = network.pair();
      links[a].set(b + 1, one);
      links[b].set(a + 1, two);
    }
  const sessions = links.map(
    (peers, i) =>
      new HostMigration({ schema, stateType: 'State', local: i + 1, peers, initial: { score: 0, label: 'start' } }),
  );
  const settle = async () => {
    network.advance(5000);
    await Promise.resolve();
  };
  const close = () => {
    for (const session of sessions) session.close();
  };
  return { network, links, sessions, settle, close };
}
test('host loss resumes the last confirmed state and authority continues through successive departures', async (t) => {
  const {
    sessions: [a, b, c],
    settle,
    close,
  } = mesh(3, { loss: 0.1, jitter: 5, seed: 256 });
  t.after(close);
  const pending = a.confirm({ score: 9, label: 'confirmed' }, 10);
  await settle();
  await pending;
  const copy = b.confirmed;
  copy.state.score = 999;
  assert.equal(b.confirmed.state.score, 9);
  a.close();
  await settle();
  assert.equal(b.isHost, true);
  assert.equal(c.host, 2);
  assert.deepEqual(await b.waitForHost(), { host: 2, epoch: 1, frame: 10, state: { score: 9, label: 'confirmed' } });
  const next = b.confirm({ score: 12, label: 'next' }, 20);
  await settle();
  await next;
  b.close();
  await settle();
  assert.equal(c.isHost, true);
  assert.equal(c.confirmed.frame, 20);
  assert.equal(c.confirmed.state.score, 12);
});

test('partial commit on host loss restores the newest checkpoint common to survivors', async (t) => {
  const {
    sessions: [a, b, c],
    links,
    settle,
    close,
  } = mesh();
  t.after(close);
  const first = a.confirm({ score: 1, label: 'safe' }, 1);
  await settle();
  await first;
  const toC = links[0].get(3),
    send = toC.send.bind(toC);
  toC.send = (data, delivery) => {
    if (data[0] === 112 && data[1] === 3) return;
    send(data, delivery);
  };
  const pending = a.confirm({ score: 999, label: 'unfinished' }, 2);
  const rejected = assert.rejects(pending, /closed/);
  await settle();
  assert.equal(b.confirmed.frame, 2);
  assert.equal(c.confirmed.frame, 1);
  a.close();
  await rejected;
  await settle();
  assert.equal(b.isHost, true);
  assert.deepEqual(b.confirmed, { frame: 1, state: { score: 1, label: 'safe' } });
  assert.deepEqual(c.confirmed, b.confirmed);
});

test('orderly handoff selects any peer, preserves state and rejects old-epoch authority', async (t) => {
  const {
    sessions: [a, b, c],
    links,
    settle,
    close,
  } = mesh();
  t.after(close);
  let stale;
  const toB = links[0].get(2),
    send = toB.send.bind(toB);
  toB.send = (data, delivery) => {
    if (data[0] === 112 && data[1] === 1) stale = data.slice();
    send(data, delivery);
  };
  const checkpoint = a.confirm({ score: 7, label: 'handoff' }, 7);
  await settle();
  await checkpoint;
  const transfer = a.handoff(3);
  assert.equal(a.isHost, false);
  await settle();
  await transfer;
  assert.equal(c.isHost, true);
  assert.equal(a.host, 3);
  assert.equal(b.host, 3);
  links[1].get(1).onmessage(stale, 'reliable');
  assert.equal(b.confirmed.state.score, 7);
  assert.throws(() => a.confirm({ score: 8, label: 'stale' }, 8), /host/);
  const next = c.confirm({ score: 8, label: 'new host' }, 8);
  await settle();
  await next;
  assert.deepEqual(a.confirmed, c.confirmed);
  assert.deepEqual(b.confirmed, c.confirmed);
});

test('host departure during prepare discards speculative state and wait cancellation leaves recovery intact', async (t) => {
  const {
    sessions: [a, b],
    network,
    settle,
    close,
  } = mesh(3);
  t.after(close);
  const pending = a.confirm({ score: 88, label: 'uncommitted' }, 1);
  const rejection = assert.rejects(pending, /closed/);
  network.advance(10);
  a.close();
  network.advance(10); // Deliver host close; survivor reports are still in flight.
  await rejection;
  const abort = new AbortController();
  const waiting = b.waitForHost({ signal: abort.signal });
  abort.abort(new TypeError('cancel wait'));
  await assert.rejects(waiting, /cancel wait/);
  await settle();
  assert.equal(b.isHost, true);
  assert.equal(b.confirmed.state.score, 0);
});

test('aborting confirmation retires uncertain authority and the remaining peer recovers', async (t) => {
  const {
    sessions: [a, b],
    settle,
    close,
  } = mesh(2);
  t.after(close);
  const abort = new AbortController();
  const pending = a.confirm({ score: 8, label: 'aborted' }, 1, { signal: abort.signal });
  abort.abort(new TypeError('cancel confirm'));
  await assert.rejects(pending, /cancel confirm/);
  await settle();
  assert.equal(a.isHost, false);
  assert.equal(b.isHost, true);
  assert.equal(b.confirmed.frame, 0);
});

test('non-migration messages forward, invalid packets close their sender, input limits reject', async (t) => {
  const network = new LoopbackNetwork();
  const [one, two] = network.pair();
  const seen = [];
  let closed = 0;
  two.onmessage = (bytes) => seen.push([...bytes]);
  two.onclose = () => closed++;
  const session = new HostMigration({
    schema,
    stateType: 'State',
    local: 2,
    peers: new Map([[1, two]]),
    initial: { score: 0, label: 'start' },
  });
  t.after(() => session.close());
  one.send(new Uint8Array([7, 9]));
  network.advance(1);
  assert.deepEqual(seen, [[7, 9]]);
  one.send(new Uint8Array([112, 255]));
  network.advance(1);
  assert.equal(closed, 1);
  assert.equal(session.isHost, true);
  assert.throws(() => session.confirm({ score: 1, label: '' }, -1), RangeError);
  assert.throws(() => session.handoff(2), RangeError);
  assert.throws(
    () =>
      new HostMigration({
        schema,
        stateType: 'State',
        local: 1,
        peers: new Map(),
        initial: { score: 0, label: '' },
        maxSnapshotBytes: 1,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      new HostMigration({
        schema,
        stateType: 'State',
        local: 1,
        peers: new Map([[1, one]]),
        initial: { score: 0, label: '' },
      }),
    TypeError,
  );
});

test('hard confirmation deadline closes the session rather than silently retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const {
    sessions: [a],
    close,
  } = mesh(2);
  t.after(close);
  const pending = a.confirm({ score: 1, label: 'timeout' }, 1);
  const failure = assert.rejects(pending, /timed out/);
  t.mock.timers.tick(10000);
  await failure;
  assert.equal(a.isHost, false);
});

test('a departing handoff target rejects transfer and restores authority among survivors', async (t) => {
  const {
    sessions: [a, b, c],
    settle,
    close,
  } = mesh();
  t.after(close);
  const pending = a.handoff(3);
  const failed = assert.rejects(pending, /target left/);
  c.close();
  await settle();
  await failed;
  assert.equal(a.isHost, true);
  assert.equal(b.host, 1);
  assert.equal(a.epoch, 2);
});

test('a peer leaving during resume restarts the recovery barrier for the surviving mesh', async (t) => {
  const {
    sessions: [a, b, c, d],
    network,
    settle,
    close,
  } = mesh(4);
  t.after(close);
  const confirmed = a.confirm({ score: 7, label: 'safe' }, 7);
  await settle();
  await confirmed;
  a.close();
  network.advance(20); // Host close and status exchange; resume is still in flight.
  d.close();
  await settle();
  assert.equal(b.isHost, true);
  assert.equal(c.host, 2);
  assert.equal(b.epoch, 2);
  assert.deepEqual(b.confirmed, c.confirmed);
  assert.equal(b.confirmed.state.score, 7);
});

test('synchronous reliable transports cannot arm a recovery timer after migration has already completed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peers = Array.from({ length: 3 }, () => new Map());
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++) {
      const make = () => ({
        open: true,
        onmessage: null,
        onclose: null,
        peer: null,
        send(bytes, channel = 'reliable') {
          if (this.open) this.peer.onmessage?.(bytes.slice(), channel);
        },
        close(code = 1000, reason = '') {
          if (!this.open) return;
          this.open = false;
          this.peer.open = false;
          this.onclose?.(code, reason);
          this.peer.onclose?.(code, reason);
        },
      });
      const one = make(),
        two = make();
      one.peer = two;
      two.peer = one;
      peers[a].set(b + 1, one);
      peers[b].set(a + 1, two);
    }
  const errors = [];
  const sessions = peers.map(
    (peers, i) =>
      new HostMigration({
        schema,
        stateType: 'State',
        local: i + 1,
        peers,
        initial: { score: 0, label: 'start' },
        onerror: (error) => errors.push(error),
      }),
  );
  t.after(() => {
    for (const session of sessions) session.close();
  });
  sessions[0].close();
  assert.equal(sessions[1].isHost, true);
  assert.equal(sessions[2].host, 2);
  t.mock.timers.tick(10000);
  assert.deepEqual(errors, []);
  assert.equal(sessions[1].isHost, true);
  assert.equal(sessions[2].host, 2);
});

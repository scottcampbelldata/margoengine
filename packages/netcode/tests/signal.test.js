import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseCode, LoopbackNetwork } from '../dist/index.js';
import { PeerMesh, SignalClient, SignalServer } from '../dist/signal.js';

const text = new TextEncoder();

function world(options = {}) {
  const network = new LoopbackNetwork({ latency: 5 }),
    signals = new SignalServer({ now: () => network.time, ...options }),
    pump = setInterval(() => network.advance(10), 1);
  network.listen().onconnection = (connection) => signals.accept(connection);
  return { network, signals, stop: () => (clearInterval(pump), signals.close()) };
}
const until = async (check) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(check(), 'it happened in time');
};
const join = (w, room, options) => SignalClient.join(w.network.connect(), room, options);

test('signal: peers in a room learn of each other and pass messages; the server says who sent them', async (t) => {
  const w = world();
  t.after(w.stop);
  const one = await join(w, 'lobby');
  assert.deepEqual([...one.peers], []);
  const two = await join(w, 'lobby');
  assert.deepEqual([...two.peers], [one.id]);
  await until(() => one.peers.has(two.id));
  const got = [];
  one.onsignal = (from, data) => got.push([from, data]);
  two.send(one.id, { hello: [1, 2] });
  await until(() => got.length === 1);
  assert.deepEqual(got, [[two.id, { hello: [1, 2] }]]);
  assert.equal(w.signals.peers('lobby'), 2);
  const left = [];
  one.onleft = (id) => left.push(id);
  two.close();
  await until(() => left.length === 1);
  assert.deepEqual(left, [two.id]);
  assert.equal(one.peers.size, 0);
  one.close();
  await until(() => w.signals.roomCount === 0);
});

test('signal: a message never crosses into another room, and a forged sender is ignored', async (t) => {
  const w = world();
  t.after(w.stop);
  const one = await join(w, 'a'),
    two = await join(w, 'b'),
    three = await join(w, 'a');
  const got = [];
  two.onsignal = (from, data) => got.push([from, data]);
  one.onsignal = (from, data) => got.push([from, data]);
  three.send(two.id, 'over the wall');
  const raw = w.network.connect();
  const liar = await SignalClient.join(raw, 'a');
  raw.send(text.encode(JSON.stringify({ kind: 'signal', to: one.id, from: three.id, data: 'not me' })));
  await until(() => got.length === 1);
  assert.deepEqual(got, [[liar.id, 'not me']]);
});

test('signal: a full room, too many rooms, a refused token and a bad join are told so', async (t) => {
  const w = world({
    maxPeers: 1,
    maxRooms: 1,
    authorize: (room, token) => room !== 'secret' || token === 'open',
  });
  t.after(w.stop);
  await join(w, 'x');
  await assert.rejects(join(w, 'x'), { code: 'failed', message: /room is full/ });
  await assert.rejects(join(w, 'y'), /most rooms/);
  await assert.rejects(join(w, 'secret'), /not allowed/);
  const closes = [];
  const raw = w.network.connect();
  raw.onclose = (code) => closes.push(code);
  raw.send(text.encode('{"kind":"join"}'));
  const bad = w.network.connect();
  bad.onclose = (code) => closes.push(code);
  bad.send(text.encode('not json'));
  await until(() => closes.length === 2);
  assert.deepEqual(closes, [CloseCode.protocol, CloseCode.protocol]);
});

test('signal: an over-long message and a flood close the sender; a silent connection times out', async (t) => {
  const w = world({ maxMessageBytes: 256, messagesPerSecond: 1, burst: 3, joinTimeout: 5 });
  t.after(w.stop);
  const one = await join(w, 'r'),
    closes = [];
  one.onclose = (code) => closes.push(code);
  one.send(one.id, 'x'.repeat(300));
  await until(() => closes.length === 1);
  assert.deepEqual(closes, [CloseCode.rateLimit]);
  const two = await join(w, 'r'),
    flood = [];
  two.onclose = (code) => flood.push(code);
  for (let i = 0; i < 6; i++) two.send(two.id, i);
  await until(() => flood.length === 1);
  assert.deepEqual(flood, [CloseCode.rateLimit]);
  const silent = w.network.connect(),
    timed = [];
  silent.onclose = (code) => timed.push(code);
  await until(() => timed.length === 1);
  assert.deepEqual(timed, [CloseCode.timeout]);
});

test('signal: joins abort, and close says goodbye to everyone', async (t) => {
  const w = world();
  t.after(w.stop);
  const stop = new AbortController();
  stop.abort(new Error('nope'));
  await assert.rejects(join(w, 'r', { signal: stop.signal }), /nope/);
  const later = new AbortController(),
    joining = SignalClient.join(w.network.connect(), 'r', { signal: later.signal });
  later.abort(new Error('changed'));
  await assert.rejects(joining, /changed/);
  const dead = w.network.connect();
  dead.close();
  await assert.rejects(SignalClient.join(dead, 'r'), { code: 'failed' });
  const one = await join(w, 'r'),
    closes = [];
  one.onclose = (code) => closes.push(code);
  w.signals.close();
  await until(() => closes.length === 1);
  assert.deepEqual(closes, [CloseCode.removed]);
  assert.throws(() => w.signals.accept(w.network.connect()), { code: 'disposed' });
  assert.throws(() => new SignalServer({ maxPeers: 0 }), RangeError);
});

/** A stand-in for the browser's class: it records the steps; the real one is proved in tests/browser/signal.mjs. */
class FakePeer extends EventTarget {
  static made = [];
  log = [];
  connectionState = 'new';
  channels = [];
  constructor(configuration) {
    super();
    this.configuration = configuration;
    FakePeer.made.push(this);
  }
  createDataChannel(label) {
    const channel = new EventTarget();
    Object.assign(channel, { label, readyState: 'connecting', close() {}, send() {} });
    this.channels.push(channel);
    return channel;
  }
  async setLocalDescription() {
    const type = this.remote ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `${type} sdp` };
    this.log.push(`local ${type}`);
    const event = new Event('icecandidate');
    event.candidate = { toJSON: () => ({ candidate: `from ${type}` }) };
    this.dispatchEvent(event);
  }
  async setRemoteDescription(description) {
    // fixed-wait: a stand-in for how long a real peer takes
    await new Promise((r) => setTimeout(r, 3));
    this.remote = description;
    this.log.push(`remote ${description.type}`);
  }
  async addIceCandidate(candidate) {
    this.log.push(`candidate after ${this.remote?.type}: ${candidate.candidate}`);
    if (!this.remote) throw new Error('no remote description yet');
  }
  close() {
    this.log.push('close');
  }
  open() {
    for (const channel of this.channels) {
      channel.readyState = 'open';
      channel.dispatchEvent(new Event('open'));
    }
  }
}

test('mesh: the newcomer offers, each step waits for the one before it, and channels become connections', async (t) => {
  const w = world();
  t.after(w.stop);
  FakePeer.made = [];
  const one = await join(w, 'mesh'),
    linked = [],
    errors = [];
  const options = (me) => ({
    RTCPeerConnection: FakePeer,
    configuration: { iceServers: [{ urls: 'stun:example.test' }] },
    onconnection: (peer, connection) => linked.push([me, peer, connection]),
    onerror: (_peer, error) => errors.push(error),
  });
  const first = new PeerMesh(one, options('one')),
    two = await join(w, 'mesh'),
    second = new PeerMesh(two, options('two'));
  await until(() => FakePeer.made.length === 2);
  const [offerer, answerer] = FakePeer.made;
  assert.deepEqual(offerer.configuration.iceServers[0], { urls: 'stun:example.test' });
  await until(() => offerer.log.includes('remote answer') && answerer.log.some((l) => l.startsWith('candidate')));
  await until(() => offerer.log.some((l) => l.startsWith('candidate')));
  assert.deepEqual(errors, []);
  assert.equal(offerer.log[0], 'local offer');
  assert.deepEqual(answerer.log.slice(0, 2), ['remote offer', 'local answer']);
  assert.ok(answerer.log.some((l) => l === 'candidate after offer: from offer'), 'the candidate waited for the offer');
  offerer.open();
  answerer.open();
  assert.deepEqual(linked.map(([me, peer]) => [me, peer]).sort(), [['one', two.id], ['two', one.id]]);
  assert.equal(first.connections.get(two.id).open, true);
  two.close();
  await until(() => !one.peers.has(two.id));
  assert.equal(first.connections.get(two.id).open, true, 'a link that is up outlives the room');
  second.close();
  assert.ok(offerer.log.includes('close'));
  // The newcomer offered, so `first` holds the answerer: its channels closing ends the link.
  answerer.channels[0].dispatchEvent(new Event('close'));
  assert.equal(first.connections.size, 0);
  assert.ok(answerer.log.includes('close'));
  first.close();
});

test('mesh: junk from a peer goes to onerror, a failed link is dropped, and no class says so', async (t) => {
  const w = world();
  t.after(w.stop);
  FakePeer.made = [];
  const one = await join(w, 'mesh'),
    two = await join(w, 'mesh'),
    errors = [],
    mesh = new PeerMesh(two, { RTCPeerConnection: FakePeer, onerror: (peer, error) => errors.push([peer, error]) });
  await until(() => FakePeer.made.length === 1);
  one.send(two.id, 'junk');
  await until(() => errors.length === 1);
  assert.ok(errors[0][1] instanceof TypeError);
  const peer = FakePeer.made[0];
  peer.connectionState = 'failed';
  peer.dispatchEvent(new Event('connectionstatechange'));
  assert.equal(errors[1][1].code, 'failed');
  assert.ok(peer.log.includes('close'));
  one.send(two.id, { description: { type: 'answer', sdp: 'late' } });
  await until(() => FakePeer.made.length === 2);
  one.close();
  await until(() => FakePeer.made[1].log.includes('close')); // a link not up yet goes with the peer
  // fixed-wait: room for a late step to run, which must not come
  await new Promise((r) => setTimeout(r, 10));
  mesh.close();
  const left = await join(w, 'other');
  const before = globalThis.RTCPeerConnection;
  delete globalThis.RTCPeerConnection;
  assert.throws(() => new PeerMesh(left), { code: 'unsupported' });
  if (before) globalThis.RTCPeerConnection = before;
});

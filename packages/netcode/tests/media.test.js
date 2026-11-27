import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackNetwork } from '../dist/index.js';
import { PeerMesh, SignalClient, SignalServer } from '../dist/signal.js';
import { MediaSession, SpeakingDetector } from '../dist/media.js';

// Fakes of the browser objects: the real ones are proved by tests/browser/media.mjs (Chromium fake devices).
class Track extends EventTarget {
  enabled = true;
  stopped = false;
  constructor(kind) {
    super();
    this.kind = kind;
  }
  stop() {
    this.stopped = true;
  }
}
class Stream extends EventTarget {
  constructor(tracks) {
    super();
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
class Peer extends EventTarget {
  static made = [];
  log = [];
  senders = [];
  signalingState = 'stable';
  connectionState = 'new';
  channels = [];
  constructor() {
    super();
    Peer.made.push(this);
  }
  createDataChannel() {
    const channel = new EventTarget();
    Object.assign(channel, { readyState: 'connecting', close() {}, send() {} });
    this.channels.push(channel);
    return channel;
  }
  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    this.log.push(`add ${track.kind}`);
    queueMicrotask(() => this.dispatchEvent(new Event('negotiationneeded')));
    return sender;
  }
  removeTrack(sender) {
    this.senders.splice(this.senders.indexOf(sender), 1);
    this.log.push(`remove ${sender.track.kind}`);
    queueMicrotask(() => this.dispatchEvent(new Event('negotiationneeded')));
  }
  getSenders() {
    return this.senders;
  }
  async setLocalDescription() {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    this.localDescription = { type, sdp: `${type} sdp` };
    this.log.push(`local ${type}`);
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.log.push(`remote ${description.type}`);
  }
  async addIceCandidate() {}
  close() {}
  open() {
    for (const channel of this.channels) {
      channel.readyState = 'open';
      channel.dispatchEvent(new Event('open'));
    }
  }
}

const until = async (check) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(check(), 'it happened in time');
};
function world() {
  const network = new LoopbackNetwork({ latency: 5 }),
    signals = new SignalServer({ now: () => network.time }),
    pump = setInterval(() => network.advance(10), 1);
  network.listen().onconnection = (connection) => signals.accept(connection);
  return { network, stop: () => (clearInterval(pump), signals.close()) };
}
const join = (w) => SignalClient.join(w.network.connect(), 'media');

/** Devices that hand out fake streams and remember them. */
function devices() {
  const d = { asked: [], streams: [] };
  d.getUserMedia = async (constraints) => {
    d.asked.push(constraints);
    const stream = new Stream([new Track('audio')]);
    d.streams.push(stream);
    return stream;
  };
  d.getDisplayMedia = async (constraints) => {
    d.asked.push(constraints);
    const stream = new Stream([new Track('video')]);
    d.streams.push(stream);
    return stream;
  };
  return d;
}

/** An audio context whose analyser reads whatever level the test sets. */
function audio() {
  const context = { level: 0, nodes: [], destination: { name: 'destination' } };
  const node = (extra = {}) => {
    const n = { connected: [], connect: (to) => (n.connected.push(to), to), disconnect() {}, ...extra };
    context.nodes.push(n);
    return n;
  };
  context.createMediaStreamSource = (stream) => node({ stream });
  context.createGain = () => node({ gain: { value: 1 } });
  context.createAnalyser = () =>
    node({
      fftSize: 0,
      getFloatTimeDomainData(samples) {
        samples.fill(context.level);
      },
    });
  return context;
}

test('media: voice tracks go on every link and renegotiate, late links get them, dispose stops them', async (t) => {
  const w = world();
  t.after(w.stop);
  Peer.made = [];
  const one = await join(w),
    mesh = new PeerMesh(one, { RTCPeerConnection: Peer }),
    two = await join(w),
    mesh2 = new PeerMesh(two, { RTCPeerConnection: Peer });
  await until(() => Peer.made.length === 2);
  const [offerer, answerer] = Peer.made;
  await until(() => offerer.log.includes('remote answer') && answerer.log.includes('local answer'));
  offerer.open();
  answerer.open();
  const d = devices(),
    media = new MediaSession(mesh2, { mediaDevices: d, pollMs: 0, audioContext: audio() });
  const offers = () => offerer.log.filter((l) => l === 'local offer').length,
    before = offers();
  await media.startVoice();
  assert.deepEqual(d.asked[0], {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  assert.deepEqual(
    offerer.log.filter((l) => l.startsWith('add')),
    ['add audio'],
  );
  await until(() => offers() === before + 1);
  assert.equal(offerer.senders[0].track, d.streams[0].tracks[0]);
  await offerer.setRemoteDescription({ type: 'answer' }); // the far end answers, so the link is stable again
  await assert.rejects(media.startVoice(), { code: 'state' });
  media.stopVoice();
  assert.deepEqual(offerer.senders, []);
  assert.equal(d.streams[0].tracks[0].stopped, true, 'the microphone is released');
  await until(() => offers() === before + 2);
  await offerer.setRemoteDescription({ type: 'answer' });
  // A third peer joins after voice and screen are on: its link gets the tracks too.
  await media.startVoice();
  await media.startScreenShare();
  const three = await join(w),
    mesh3 = new PeerMesh(three, { RTCPeerConnection: Peer });
  await until(() => Peer.made.length === 4);
  await until(() => mesh2.peerConnections.size === 2);
  const late = [...mesh2.peerConnections.values()].find((p) => p !== offerer);
  assert.deepEqual(late.log.filter((l) => l.startsWith('add')).sort(), ['add audio', 'add video']);
  media.dispose();
  assert.equal(d.streams.at(-1).tracks[0].stopped, true);
  assert.equal(late.senders.length, 0);
  mesh.close();
  mesh2.close();
  mesh3.close();
});

test('media: mute, push-to-talk and the screen ending by itself', async () => {
  const peers = new Map(),
    mesh = { peerConnections: peers, onlink: null, onunlink: null };
  const d = devices(),
    media = new MediaSession(mesh, { mediaDevices: d, pollMs: 0, pushToTalk: true, audioContext: audio() });
  await media.startVoice();
  const mic = d.streams[0].tracks[0];
  assert.equal(mic.enabled, false, 'push-to-talk starts closed');
  media.talk(true);
  assert.equal(mic.enabled, true);
  media.setMuted(true);
  assert.equal(mic.enabled, false, 'mute beats the talk key');
  media.setMuted(false);
  media.talk(false);
  assert.equal(mic.enabled, false);
  media.setPushToTalk(false);
  assert.equal(mic.enabled, true);

  const peer = new Peer();
  peers.set(7, peer);
  mesh.onlink(7, peer);
  const ended = [];
  media.addEventListener('screenended', (e) => ended.push(e.detail));
  await media.startScreenShare();
  const video = d.streams[1].tracks[0];
  assert.ok(peer.senders.some((s) => s.track === video));
  video.dispatchEvent(new Event('ended'));
  assert.deepEqual(ended, [{ peer: 'self' }]);
  assert.ok(!peer.senders.some((s) => s.track === video), 'the ended share left the link');
  media.dispose();
  assert.equal(mesh.onlink, null);
  await assert.rejects(media.startVoice(), { code: 'disposed' });
});

test('media: an abort rejects with its reason and releases a capture that finishes late', async () => {
  const mesh = { peerConnections: new Map(), onlink: null, onunlink: null };
  let finish;
  const late = new Stream([new Track('audio')]);
  const media = new MediaSession(mesh, {
    mediaDevices: {
      getUserMedia: () => new Promise((r) => (finish = () => r(late))),
      getDisplayMedia: devices().getDisplayMedia,
    },
    pollMs: 0,
    audioContext: audio(),
  });
  const stop = new AbortController();
  const started = media.startVoice({ signal: stop.signal });
  stop.abort(new Error('give up'));
  await assert.rejects(started, /give up/);
  finish();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(late.tracks[0].stopped, true);
  await assert.rejects(media.startVoice({ signal: AbortSignal.abort(new Error('already')) }), /already/);
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  assert.throws(() => new MediaSession(mesh, { mediaDevices: undefined }), { code: 'unsupported' });
  void navigator;
  media.dispose();
});

test('media: remote voice and screen arrive, play through volume and spatial nodes, and are told apart by video', async () => {
  let clock = 0;
  const peers = new Map(),
    mesh = { peerConnections: peers, onlink: null, onunlink: null },
    context = audio(),
    spatialCalls = [],
    panner = { name: 'panner' };
  const media = new MediaSession(mesh, {
    mediaDevices: devices(),
    audioContext: context,
    pollMs: 0,
    now: () => clock,
    spatial: (peer, volume) => (spatialCalls.push([peer, volume]), panner),
  });
  const peer = new Peer();
  peers.set(3, peer);
  mesh.onlink(3, peer);
  const seen = [];
  media.addEventListener('remote', (e) => seen.push([e.detail.kind, e.detail.active]));
  const speech = [];
  media.addEventListener('speaking', (e) => speech.push([e.detail.peer, e.detail.speaking]));
  const voice = new Stream([new Track('audio')]),
    screen = new Stream([new Track('video'), new Track('audio')]);
  for (const stream of [voice, screen]) {
    const event = new Event('track');
    Object.assign(event, { streams: [stream], track: stream.tracks[0] });
    peer.dispatchEvent(event);
  }
  assert.deepEqual(seen, [
    ['voice', true],
    ['screen', true],
  ]);
  assert.equal(media.remotes.get(3).voice, voice);
  assert.equal(media.remotes.get(3).screen, screen);
  assert.equal(spatialCalls.length, 1, 'only the voice is played');
  const gain = spatialCalls[0][1];
  assert.deepEqual(gain.connected, [panner]);
  media.setVolume(3, 0.25);
  assert.equal(gain.gain.value, 0.25);
  media.mutePeer(3, true);
  assert.equal(gain.gain.value, 0);
  media.mutePeer(3, false);
  assert.equal(gain.gain.value, 0.25);
  assert.throws(() => media.setVolume(3, -1), RangeError);
  // Speaking: on above 0.04, off only after 250 ms under 0.02; a muted peer is still seen speaking.
  media.mutePeer(3, true);
  context.level = 0.1;
  media.poll();
  assert.deepEqual(speech, [[3, true]]);
  assert.equal(media.remotes.get(3).speaking, true);
  context.level = 0.03; // between the lines: holds
  clock = 1000;
  media.poll();
  context.level = 0;
  clock = 1100;
  media.poll();
  clock = 1300;
  media.poll();
  assert.equal(speech.length, 1, 'still inside the hang time');
  clock = 1400;
  media.poll();
  assert.deepEqual(speech.at(-1), [3, false]);
  // The peer removes its screen on renegotiation: the stream loses its tracks.
  screen.tracks.splice(0);
  screen.dispatchEvent(new Event('removetrack'));
  assert.deepEqual(seen.at(-1), ['screen', false]);
  assert.equal(media.remotes.get(3).screen, null);
  // The iterator sees the next event and ends on abort.
  const stop = new AbortController(),
    got = [];
  const reader = (async () => {
    for await (const event of media.events('remote', { signal: stop.signal })) got.push(event.kind);
  })();
  await new Promise((r) => setTimeout(r, 1));
  mesh.onunlink(3, peer);
  await until(() => got.length === 1);
  assert.deepEqual(got, ['voice']);
  stop.abort();
  await reader;
  assert.equal(media.remotes.has(3), false);
  media.dispose();
});

/** Sets browser globals for one test and puts back what was there. */
function globals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => (before ? Object.defineProperty(globalThis, name, before) : delete globalThis[name]));
  }
}

const arrive = (peer, stream) => {
  const event = new Event('track');
  Object.assign(event, { streams: [stream], track: stream.tracks[0] });
  peer.dispatchEvent(event);
};

test('media: a muted element plays each remote voice, so the browser decodes it (KB-NETCODE-VOICESILENT1)', async (t) => {
  const elements = [];
  let refuse = false;
  globals(t, {
    Audio: class {
      muted = false;
      srcObject = null;
      playing = false;
      constructor() {
        elements.push(this);
      }
      play() {
        this.playing = true;
        return refuse ? Promise.reject(new Error('cannot play')) : Promise.resolve();
      }
      pause() {
        this.playing = false;
      }
    },
  });
  const peers = new Map(),
    mesh = { peerConnections: peers, onlink: null, onunlink: null },
    media = new MediaSession(mesh, { mediaDevices: devices(), pollMs: 0, audioContext: audio() }),
    errors = [];
  media.addEventListener('error', (e) => errors.push([e.detail.peer, e.detail.error.message]));
  const peer = new Peer();
  peers.set(3, peer);
  mesh.onlink(3, peer);
  const voice = new Stream([new Track('audio')]);
  arrive(peer, voice);
  arrive(peer, new Stream([new Track('video')]));
  assert.equal(elements.length, 1, 'the screen needs no sink');
  assert.deepEqual([elements[0].muted, elements[0].srcObject, elements[0].playing], [true, voice, true]);
  mesh.onunlink(3, peer);
  assert.deepEqual([elements[0].srcObject, elements[0].playing], [null, false]);
  // A play() that a leaving voice interrupted says nothing; one that fails while the voice is on is an error.
  refuse = true;
  mesh.onlink(3, peer);
  arrive(peer, new Stream([new Track('audio')]));
  mesh.onunlink(3, peer);
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(errors, []);
  mesh.onlink(3, peer);
  arrive(peer, new Stream([new Track('audio')]));
  await until(() => errors.length === 1);
  assert.deepEqual(errors, [[3, 'cannot play']]);
  media.dispose();
  assert.ok(elements.every((e) => !e.playing && e.srcObject === null));
});

test('media: the context a session makes resumes on a gesture and closes with it (KB-NETCODE-VOICEGESTURE1)', async (t) => {
  const page = new EventTarget(),
    made = [];
  globals(t, {
    document: page,
    AudioContext: function () {
      const context = Object.assign(audio(), {
        state: 'suspended',
        resumed: 0,
        closed: false,
        async resume() {
          context.resumed++;
          context.state = 'running';
        },
        async close() {
          context.closed = true;
        },
      });
      made.push(context);
      return context;
    },
  });
  const mesh = { peerConnections: new Map(), onlink: null, onunlink: null },
    media = new MediaSession(mesh, { mediaDevices: devices(), pollMs: 0 });
  await media.startVoice();
  assert.equal(made[0].resumed, 0, 'nothing resumes before a gesture');
  page.dispatchEvent(new Event('pointerdown'));
  await new Promise((r) => setTimeout(r, 1));
  page.dispatchEvent(new Event('keydown'));
  assert.equal(made[0].resumed, 1, 'once running, the listeners are gone');
  media.dispose();
  assert.equal(made[0].closed, true);
  // A session disposed while still suspended leaves no listener behind.
  const second = new MediaSession(mesh, { mediaDevices: devices(), pollMs: 0 });
  await second.startVoice();
  second.dispose();
  page.dispatchEvent(new Event('pointerdown'));
  assert.equal(made[1].resumed, 0);
  // A context passed in stays the caller's.
  const own = Object.assign(audio(), { state: 'suspended', close: () => assert.fail('closed a passed context') }),
    third = new MediaSession(mesh, { mediaDevices: devices(), pollMs: 0, audioContext: own });
  await third.startVoice();
  third.dispose();
});

test('speaking detector: hysteresis and range check', () => {
  const d = new SpeakingDetector(0.1, 0.05, 100);
  assert.equal(d.update(0.2, 0), true);
  assert.equal(d.update(0.2, 10), false);
  assert.equal(d.update(0.07, 20), false); // between the lines
  assert.equal(d.update(0.01, 30), false);
  assert.equal(d.update(0.07, 90), false); // back between the lines resets the hang
  assert.equal(d.update(0.01, 100), false);
  assert.equal(d.update(0.01, 199), false);
  assert.equal(d.update(0.01, 200), true);
  assert.equal(d.speaking, false);
  assert.throws(() => new SpeakingDetector(0.1, 0.1), RangeError);
});

test('mesh: perfect negotiation, only the polite end gives way to a colliding offer', async (t) => {
  const w = world();
  t.after(w.stop);
  Peer.made = [];
  const errors = [],
    onerror = (_peer, error) => errors.push(error),
    one = await join(w),
    meshOne = new PeerMesh(one, { RTCPeerConnection: Peer, onerror }),
    two = await join(w), // the higher id is the polite end
    meshTwo = new PeerMesh(two, { RTCPeerConnection: Peer, onerror });
  await until(() => Peer.made.length === 2);
  assert.ok(two.id > one.id);
  const [atTwo, atOne] = Peer.made; // two offered to one
  await until(() => atOne.log.includes('local answer') && atTwo.log.includes('remote answer'));
  // Both ends offer at once: each holds its own offer when the other's arrives.
  const accepted = (peer) => peer.log.filter((l) => l === 'remote offer').length,
    first = [accepted(atOne), accepted(atTwo)];
  atOne.signalingState = atTwo.signalingState = 'have-local-offer';
  one.send(two.id, { description: { type: 'offer', sdp: 'x' } });
  two.send(one.id, { description: { type: 'offer', sdp: 'y' } });
  await until(() => accepted(atTwo) === first[1] + 1);
  await new Promise((r) => setTimeout(r, 30)); // fixed-wait: room for a wrong accept at the other end
  assert.equal(accepted(atOne), first[0], 'the impolite end ignored the offer');
  assert.equal(accepted(atTwo), first[1] + 1, 'the polite end took it');
  assert.deepEqual(errors, []);
  meshOne.close();
  meshTwo.close();
});

// Buses, mute and solo, sends, ducking, effects, emitters, loading and offline setup, on a fake Web Audio context that
// records graph edges and parameter automation. Property and fuzz tests cover the solo rule and the bus tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Mixer,
  audibleBuses,
  createEffect,
  dbToGain,
  loadImpulse,
  rampParam,
  renderOffline,
  setListenerPose,
} from '../dist/index.js';
import { FakeContext, FakeNode, FakeParam, reaches } from './fakes.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const random = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gateOf = (mixer, name) => mixer.bus(name).gate.gain.last();

test('a retained disposed bus releases its owned insert references after bus or mixer disposal', () => {
  for (const disposeMixer of [false, true]) {
    const context = new FakeContext(),
      mixer = new Mixer(context),
      bus = mixer.createBus('insert owner');
    let disposed = 0;
    const stage = {
      input: context.createGain(),
      output: context.createGain(),
      dispose() {
        disposed++;
        this.input.disconnect();
        this.output.disconnect();
      },
    };
    stage.input.connect(stage.output);
    const detach = bus.insert(stage);
    const retainsInsert = () => {
      const seen = new Set();
      const visit = (value) => {
        if (value === stage || value === stage.input || value === stage.output) return true;
        // Context and mixer are borrowed owners; native nodes are leaves, not JavaScript owner containers.
        if (!value || typeof value !== 'object' || value === context || value === mixer || value instanceof FakeNode || seen.has(value))
          return false;
        seen.add(value);
        const children = value instanceof Map ? [...value.keys(), ...value.values()]
          : value instanceof Set ? [...value] : Object.values(value);
        return children.some(visit);
      };
      return visit(bus);
    };
    assert.equal(retainsInsert(), true, 'the probe observes active insert ownership');
    if (disposeMixer) mixer.dispose();
    else bus.dispose();
    assert.equal(disposed, 1);
    assert.equal(stage.input.outputs.size, 0);
    assert.equal(stage.output.outputs.size, 0);
    assert.equal(retainsInsert(), false, 'holding the dead bus must not retain its former insert or nodes');
    detach();
    bus.dispose();
    mixer.dispose();
    assert.equal(disposed, 1);
    assert.equal(retainsInsert(), false);
  }
});

test('buses connect child to parent and master to the destination', () => {
  const context = new FakeContext(),
    mixer = new Mixer(context, { buses: { music: {}, sfx: {}, footsteps: { parent: 'sfx' } } });
  assert.ok(mixer.master.output.outputs.has(context.destination));
  assert.ok(mixer.bus('music').output.outputs.has(mixer.master.input));
  assert.ok(mixer.bus('footsteps').output.outputs.has(mixer.bus('sfx').input));
  const source = new FakeNode(context, 'source');
  mixer.route(source, 'footsteps');
  assert.ok(reaches(source, context.destination));
  assert.deepEqual(
    mixer.buses().map((b) => b.name),
    ['master', 'music', 'sfx', 'footsteps'],
  );
  const custom = new FakeNode(context, 'listener'),
    other = new Mixer(context, { destination: custom });
  assert.ok(other.master.output.outputs.has(custom));
});

test('bus errors name the fix and carry a code', () => {
  const mixer = new Mixer(new FakeContext(), { buses: { a: {}, b: { parent: 'a' } } });
  assert.throws(() => mixer.bus('nope'), { name: 'MargoError', code: 'state', message: /createBus\("nope"\)/ });
  assert.throws(() => mixer.createBus('a'), { code: 'state', message: /already exists/ });
  assert.throws(() => mixer.createBus('c', { parent: 'zzz' }), { code: 'state', message: /parent "zzz"/ });
  assert.throws(() => mixer.createBus(''), TypeError);
  assert.throws(() => mixer.removeBus('a'), { code: 'state', message: /child "b"/ });
  assert.throws(() => mixer.removeBus('master'), { code: 'state' });
  assert.throws(() => new Mixer(null), TypeError);
  assert.throws(() => mixer.bus('a').setGain(NaN), TypeError);
  assert.throws(() => mixer.bus('a').setGain('loud'), TypeError);
  assert.throws(() => mixer.route({}, 'a'), TypeError);
  mixer.removeBus('b');
  assert.equal(mixer.has('b'), false);
  mixer.removeBus('a');
});

test('route moves a source off its old connections and works with getOutput()', () => {
  const context = new FakeContext(),
    mixer = new Mixer(context, { buses: { music: {}, sfx: {} } }),
    node = new FakeNode(context, 'gain'),
    old = new FakeNode(context, 'old');
  node.connect(old);
  const undo = mixer.route({ getOutput: () => node }, 'music');
  assert.equal(node.outputs.has(old), false);
  assert.ok(node.outputs.has(mixer.bus('music').input));
  mixer.route(node, 'sfx');
  assert.equal(node.outputs.has(mixer.bus('music').input), false);
  undo();
  assert.ok(node.outputs.has(mixer.bus('sfx').input));
});

test('fader: dB to gain, silence at -Infinity, immediate on a context that has not started, smooth on a running one', () => {
  const idle = new FakeContext({ state: 'suspended' }),
    a = new Mixer(idle, { buses: { m: { gain: -6 } } });
  near(a.bus('m').fader.gain.value, dbToGain(-6));
  a.bus('m').setGain(-12);
  assert.equal(a.bus('m').fader.gain.last().kind, 'set');
  near(a.bus('m').fader.gain.last().value, dbToGain(-12));
  assert.equal(a.bus('m').gain, -12);
  a.bus('m').setGain(-Infinity);
  assert.equal(a.bus('m').fader.gain.last().value, 0);
  const live = new FakeContext(),
    b = new Mixer(live, { buses: { m: {} } });
  b.bus('m').setGain(-3, { at: 2, seconds: 0.2 });
  const event = b.bus('m').fader.gain.last();
  assert.deepEqual([event.kind, event.time, event.constant], ['target', 2, 0.05]);
  b.bus('m').setGain(0, { seconds: 0 });
  assert.equal(b.bus('m').fader.gain.last().kind, 'set');
  assert.throws(() => rampParam(live, new FakeParam(), 1, { seconds: -1 }), RangeError);
  assert.throws(() => rampParam(live, new FakeParam(), Infinity), RangeError);
});

test('rejected numeric fades preserve bus targets, gates and duck membership', () => {
  for (const options of [{ seconds: -1 }, { seconds: NaN }, { seconds: Infinity }, { at: -1 }, { at: NaN }, { at: Infinity }]) {
    using mixer = new Mixer(new FakeContext(), { buses: { a: {}, b: {} } });
    const bus = mixer.bus('a');
    assert.throws(() => bus.setGain(-12, options), RangeError);
    assert.equal(bus.gain, 0, 'failed fader change preserves target');
    assert.throws(() => bus.setMuted(true, options), RangeError);
    assert.equal(bus.muted, false, 'failed mute preserves state');
    assert.throws(() => bus.setSolo(true, options), RangeError);
    assert.equal(bus.solo, false, 'failed solo preserves state');
    assert.throws(() => bus.duck({ attack: options.seconds ?? 0.05, at: options.at }), RangeError);
    const duck = bus.duck({ amount: 3 });
    duck.release({ seconds: 0 });
    assert.equal(bus.duckNode.gain.last().value, 1, 'failed duck leaves no orphan holding the gain down');
  }
  using mixer = new Mixer(new FakeContext(), { buses: { a: {} } });
  const bus = mixer.bus('a');
  for (const db of [Infinity, 1000]) {
    assert.throws(() => bus.setGain(db), RangeError);
    assert.equal(bus.gain, 0);
  }
  const duck = bus.duck();
  assert.throws(() => duck.release({ seconds: -1 }), RangeError);
  assert.equal(duck.active, true, 'failed release leaves the handle active and usable');
  duck.release({ seconds: undefined });
  assert.equal(duck.active, false);
  assert.equal(bus.duckNode.gain.last().constant, 0.1, 'undefined release duration keeps the documented 0.4 second default');
  bus.setMuted(true);
  assert.equal(bus.gate.gain.last().constant, 0.0025, 'the existing default 10 ms mute fade is preserved');
  bus.setMuted(false, { seconds: undefined });
  assert.equal(bus.gate.gain.last().constant, 0.0025, 'undefined keeps the gate default');
});

test('invalid parameter values and times never cancel existing automation', () => {
  const context = new FakeContext(), param = new FakeParam();
  rampParam(context, param, 0.5, { at: 1, seconds: 0.2 });
  const before = JSON.stringify(param);
  for (const [value, options] of [[1e100, {}], [1, { at: -1 }], [1, { at: NaN }], [1, { seconds: -1 }]]) {
    assert.throws(() => rampParam(context, param, value, options), RangeError);
    assert.equal(JSON.stringify(param), before);
  }
  assert.throws(() => rampParam(context, param, '0.5'), TypeError);
  assert.equal(JSON.stringify(param), before);
});

test('mute closes the gate and unmute opens it; a muted parent silences its children by the graph', () => {
  const mixer = new Mixer(new FakeContext(), { buses: { sfx: {}, steps: { parent: 'sfx' } } });
  mixer.bus('sfx').setMuted(true);
  assert.equal(gateOf(mixer, 'sfx').value, 0);
  assert.equal(gateOf(mixer, 'steps').value, 1); // the child's own gate stays open; the parent's gate cuts the sound
  mixer.bus('sfx').setMuted(false);
  assert.equal(gateOf(mixer, 'sfx').value, 1);
  assert.equal(mixer.bus('sfx').muted, false);
});

test('solo: siblings close, ancestors, descendants and solo-safe buses stay open', () => {
  const mixer = new Mixer(new FakeContext(), {
    buses: { music: {}, sfx: {}, steps: { parent: 'sfx' }, room: { soloSafe: true } },
  });
  mixer.bus('sfx').setSolo(true);
  assert.deepEqual(
    ['master', 'music', 'sfx', 'steps', 'room'].map((n) => gateOf(mixer, n).value),
    [1, 0, 1, 1, 1],
  );
  mixer.bus('sfx').setSolo(false);
  assert.deepEqual(
    ['master', 'music', 'sfx', 'steps', 'room'].map((n) => gateOf(mixer, n).value),
    [1, 1, 1, 1, 1],
  );
  mixer.bus('steps').setSolo(true);
  assert.equal(gateOf(mixer, 'music').value, 0);
  assert.equal(gateOf(mixer, 'sfx').value, 1); // ancestor of the soloed bus
});

test('audibleBuses: muted beats solo, cycles and unknown parents throw', () => {
  const bus = (name, parent, extra = {}) => ({ name, parent, muted: false, solo: false, soloSafe: false, ...extra });
  const result = audibleBuses([
    bus('master', null),
    bus('a', 'master', { solo: true, muted: true }),
    bus('b', 'master'),
  ]);
  assert.equal(result.get('a'), false);
  assert.equal(result.get('b'), false);
  assert.throws(() => audibleBuses([bus('a', 'b'), bus('b', 'a')]), TypeError);
  assert.throws(() => audibleBuses([bus('a', 'ghost')]), TypeError);
});

test('property: audibleBuses equals the definition on random trees', () => {
  const rnd = random(31337);
  for (let n = 0; n < 200; n++) {
    const count = 1 + Math.floor(rnd() * 12),
      buses = [{ name: 'b0', parent: null }];
    for (let i = 1; i < count; i++) buses.push({ name: `b${i}`, parent: `b${Math.floor(rnd() * i)}` });
    for (const b of buses) Object.assign(b, { muted: rnd() < 0.2, solo: rnd() < 0.2, soloSafe: rnd() < 0.1 });
    const up = (name) => {
      const out = [];
      for (let at = buses.find((b) => b.name === name).parent; at; at = buses.find((b) => b.name === at).parent)
        out.push(at);
      return out;
    };
    const soloed = buses.filter((b) => b.solo).map((b) => b.name);
    const result = audibleBuses(buses);
    for (const b of buses) {
      const related = soloed.some((s) => s === b.name || up(s).includes(b.name) || up(b.name).includes(s));
      const expected = !b.muted && (soloed.length === 0 || b.soloSafe || related);
      assert.equal(result.get(b.name), expected, `${b.name} in tree ${n}`);
    }
    if (soloed.length === 0) for (const b of buses) assert.equal(result.get(b.name), !b.muted);
  }
});

test('effects chain order: input, then each effect, then the fader; setEffects replaces and disposes the old chain', () => {
  const context = new FakeContext(),
    mixer = new Mixer(context),
    bus = mixer.createBus('fx', {
      effects: [{ type: 'filter', filter: 'highpass', frequency: 80 }, { type: 'compressor' }],
    });
  const [first, second] = bus.effects;
  assert.ok(bus.input.outputs.has(first.input));
  assert.ok(first.output.outputs.has(second.input));
  assert.ok(second.output.outputs.has(bus.preTap));
  assert.ok(reaches(bus.input, context.destination));
  bus.setEffects([{ type: 'limiter' }]);
  assert.equal(first.output.outputs.size, 0, 'old effect disconnected');
  assert.equal(bus.effects.length, 1);
  assert.ok(reaches(bus.input, context.destination));
  assert.throws(() => bus.setEffects([{ type: 'limiter' }, { type: 'nonsense' }]), TypeError);
  assert.equal(bus.effects.length, 1, 'a failed replacement keeps the old chain');
  assert.ok(reaches(bus.input, context.destination));
  bus.setEffects([]);
  assert.ok(bus.input.outputs.has(bus.preTap));
});

test('effect settings are validated and mapped to node parameters', () => {
  const context = new FakeContext();
  const comp = createEffect(context, { type: 'compressor', threshold: -30, ratio: 8 });
  assert.equal(comp.kind, 'compressor');
  assert.equal(comp.params.threshold.value, -30);
  assert.equal(comp.params.ratio.value, 8);
  const limiter = createEffect(context, { type: 'limiter', ceiling: -3 });
  assert.equal(limiter.params.threshold.value, -3);
  assert.equal(limiter.input.ratio.value, 20);
  assert.equal(limiter.input.knee.value, 0);
  const eq = createEffect(context, {
    type: 'eq',
    bands: [
      { type: 'lowshelf', frequency: 100, gain: 4 },
      { frequency: 3000, q: 2, gain: -3 },
    ],
  });
  assert.equal(eq.params.gain0.value, 4);
  assert.equal(eq.params.q1.value, 2);
  assert.equal(eq.input.type, 'lowshelf');
  assert.equal(eq.output.type, 'peaking');
  const filter = createEffect(context, { type: 'filter', filter: 'lowpass', frequency: 900 });
  near(filter.params.q.value, -3.0103, 1e-4);
  for (const bad of [
    [{ type: 'eq', bands: [] }, RangeError],
    [{ type: 'eq', bands: [{ frequency: 1e9 }] }, RangeError],
    [{ type: 'eq', bands: [{ frequency: 'low' }] }, TypeError],
    [{ type: 'compressor', ratio: 99 }, RangeError],
    [{ type: 'limiter', ceiling: 3 }, RangeError],
    [{ type: 'delay', time: -1 }, RangeError],
    [{ type: 'delay', time: 0.001 }, RangeError],
    [{ type: 'delay', time: 1, feedback: 1 }, RangeError],
    [{ type: 'reverb', seconds: 0 }, RangeError],
    [{ type: 'reverb', mix: 2 }, RangeError],
    [{ type: 'filter', filter: 'wobble', frequency: 100 }, TypeError],
    [{ type: 'chorus' }, TypeError],
    [null, TypeError],
  ])
    assert.throws(() => createEffect(context, bad[0]), bad[1], JSON.stringify(bad[0]));
  assert.throws(() => createEffect({}, { type: 'limiter' }), TypeError);
});

test('delay: feedback loop, wet and dry gains and setMix', () => {
  const context = new FakeContext({ state: 'suspended' }),
    delay = createEffect(context, { type: 'delay', time: 0.25, feedback: 0.5, mix: 0.4 });
  near(delay.params.wet.value, 0.4);
  near(delay.params.dry.value, 0.6);
  const loop = context.nodes.filter((n) => n.kind === 'delay');
  near(loop[0].delayTime.value, 128 / 48000); // fixed pre-delay of one render quantum
  near(loop[1].delayTime.value, 0.25 - 128 / 48000); // the loop delay, so echo k lands at k * time
  assert.equal(delay.params.feedback.value, 0.5);
  delay.setMix(1, 3);
  assert.equal(delay.params.wet.last().value, 1);
  assert.equal(delay.params.dry.last().value, 0);
  assert.equal(delay.params.wet.last().time, 3);
  assert.throws(() => delay.setMix(2), RangeError);
  assert.ok(reaches(delay.input, delay.output));
});

test('reverb: a deterministic synthetic room, no normalising, or a given impulse', () => {
  const context = new FakeContext({ sampleRate: 8000 }),
    a = createEffect(context, { type: 'reverb', seconds: 0.5, seed: 4 }),
    b = createEffect(context, { type: 'reverb', seconds: 0.5, seed: 4 });
  const convolver = (fx) => [...context.nodes].find((n) => n.kind === 'convolver' && reaches(fx.input, n));
  const ca = convolver(a),
    cb = convolver(b);
  assert.equal(ca.normalize, false);
  assert.equal(ca.buffer.length, 4000);
  assert.equal(ca.buffer.numberOfChannels, 2);
  assert.deepEqual(ca.buffer.getChannelData(0), cb.buffer.getChannelData(0));
  const own = context.createBuffer(1, 10, 8000);
  const c = createEffect(context, { type: 'reverb', impulse: own });
  assert.equal(convolver(c).buffer, own);
});

test('dispose disconnects effects; using disposes a mixer; use after dispose throws code disposed', () => {
  const context = new FakeContext();
  let leaked;
  {
    using mixer = new Mixer(context, { buses: { a: { effects: [{ type: 'limiter' }] } } });
    leaked = mixer.bus('a');
    leaked.send('master');
  }
  assert.equal(leaked.input.outputs.size, 0);
  assert.equal(leaked.output.outputs.size, 0);
  assert.throws(() => leaked.setGain(0), { code: 'disposed' });
  const mixer = new Mixer(context);
  mixer.dispose();
  mixer.dispose();
  assert.throws(() => mixer.createBus('x'), { code: 'disposed' });
  const fx = createEffect(context, { type: 'limiter' });
  fx.dispose();
  fx.dispose();
  assert.equal(fx.input.outputs.size, 0);
});

test('sends: post by default (after the mute gate), pre taps before the fader, removable, loops refused', () => {
  const context = new FakeContext(),
    mixer = new Mixer(context, { buses: { music: {}, room: {}, deep: { parent: 'room' } } }),
    music = mixer.bus('music');
  const post = music.send('room', { gain: -6 });
  const tap = [...music.output.outputs].find((n) => n.kind === 'gain' && n !== mixer.master.input);
  assert.ok(tap && tap.outputs.has(mixer.bus('room').input));
  near(tap.gain.value, dbToGain(-6));
  post.setGain(-12);
  near(tap.gain.last().value, dbToGain(-12));
  assert.throws(() => post.setGain('x'), TypeError);
  post.remove();
  assert.equal(tap.outputs.size, 0);
  assert.equal(music.output.outputs.has(tap), false);
  const pre = music.send('room', { pre: true });
  assert.ok([...music.preTap.outputs].some((n) => n.kind === 'gain' && n.outputs.has(mixer.bus('room').input)));
  pre.remove();
  assert.throws(() => music.send(music), RangeError);
  mixer.bus('room').send('music');
  assert.throws(() => music.send('room'), RangeError, 'room already feeds music, so music -> room would loop');
  assert.throws(
    () => mixer.bus('room').send('deep'),
    RangeError,
    'deep feeds room through its parent, so room -> deep would loop',
  );
});

test('ducking: attack, deepest of overlapping ducks wins, release goes back, release is idempotent', () => {
  const context = new FakeContext(),
    bus = new Mixer(context, { buses: { music: {} } }).bus('music'),
    param = bus.duckNode.gain;
  const a = bus.duck({ amount: 12, attack: 0.08, at: 1 });
  let event = param.last();
  assert.deepEqual([event.kind, event.time, event.constant], ['target', 1, 0.02]);
  near(event.value, dbToGain(-12));
  assert.equal(a.active, true);
  const b = bus.duck({ amount: 20, at: 2 });
  near(param.last().value, dbToGain(-20));
  a.release({ at: 3 });
  near(param.last().value, dbToGain(-20), 1e-12);
  assert.equal(a.active, false);
  b.release({ at: 4, seconds: 1 });
  event = param.last();
  assert.deepEqual([event.value, event.time, event.constant], [1, 4, 0.25]);
  const count = param.events.length;
  b.release();
  assert.equal(param.events.length, count);
  assert.throws(() => bus.duck({ amount: -1 }), RangeError);
  assert.throws(() => bus.duck({ amount: NaN }), RangeError);
  const zero = bus.duck({ amount: 0 });
  assert.equal(param.last().value, 1);
  zero.release();
});

test('peak reads the analyser', () => {
  const context = new FakeContext(),
    bus = new Mixer(context, { buses: { a: {} } }).bus('a');
  assert.equal(bus.peak(), 0);
  const analyser = context.nodes.find((n) => n.kind === 'analyser');
  analyser.samples = new Float32Array(1024).fill(0.25);
  analyser.samples[7] = -0.75;
  assert.equal(bus.peak(), 0.75);
});

test('emitter and listener pose', () => {
  const context = new FakeContext({ state: 'suspended' }),
    mixer = new Mixer(context, { buses: { sfx: {} } }),
    emitter = mixer.emitter('sfx', {
      position: [1, 2, 3],
      refDistance: 2,
      cone: { inner: 60, outer: 120, outerGain: 0.3 },
    });
  assert.ok(emitter.input.outputs.has(mixer.bus('sfx').input));
  assert.deepEqual(
    [emitter.input.positionX.value, emitter.input.positionY.value, emitter.input.positionZ.value],
    [1, 2, 3],
  );
  assert.equal(emitter.input.refDistance, 2);
  assert.equal(emitter.input.coneOuterGain, 0.3);
  emitter.setPosition(4, 5, 6, 0);
  assert.equal(emitter.input.positionZ.last().value, 6);
  emitter.setOrientation(1, 0, 0);
  assert.equal(emitter.input.orientationX.last().value, 1);
  assert.throws(() => emitter.setPosition(NaN, 0, 0), TypeError);
  assert.throws(() => mixer.emitter('sfx', { position: [1, 2] }), TypeError);
  assert.throws(() => mixer.emitter('sfx', { refDistance: 0 }), RangeError);
  assert.throws(() => mixer.emitter('sfx', { rolloffFactor: -1 }), RangeError);
  emitter.dispose();
  assert.throws(() => emitter.setPosition(0, 0, 0), { code: 'disposed' });
  setListenerPose(context, { position: [1, 2, 3], forward: [0, 0, -1] });
  assert.equal(context.listener.positionY.last().value, 2);
  assert.equal(context.listener.upY.last().value, 1);
  assert.throws(() => setListenerPose(context, { position: [0, 0, 0], forward: [0, 0, 0] }), RangeError);
  assert.throws(() => setListenerPose(context, { position: [0, 0], forward: [0, 0, 1] }), TypeError);
});

test('loadImpulse: success, http failure, decode failure, abort before and during', async () => {
  const context = new FakeContext();
  const reply =
    (status, size = 8) =>
    async () => ({ ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(size) });
  const buffer = await loadImpulse(context, '/room.wav', { fetch: reply(200) });
  assert.equal(buffer.length, 8);
  await assert.rejects(loadImpulse(context, '/gone.wav', { fetch: reply(404) }), {
    code: 'failed',
    message: /HTTP 404/,
  });
  await assert.rejects(loadImpulse(context, '/bad.wav', { fetch: reply(200, 0) }), {
    code: 'failed',
    message: /Decoding/,
  });
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(loadImpulse(context, '/room.wav', { fetch: reply(200), signal: controller.signal }), /stop/);
  const late = new AbortController();
  const slow = async (url, init) => {
    late.abort(new Error('cancelled'));
    init.signal.throwIfAborted();
    return reply(200)();
  };
  await assert.rejects(loadImpulse(context, '/room.wav', { fetch: slow, signal: late.signal }), /cancelled/);
  const lateDecode = new AbortController();
  const decodeAborts = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => (lateDecode.abort(new Error('mid')), new ArrayBuffer(4)),
  });
  await assert.rejects(loadImpulse(context, '/x', { fetch: decodeAborts, signal: lateDecode.signal }), /mid/);
  await assert.rejects(loadImpulse(context, '/x', { fetch: 5 }), { code: 'unsupported' });
});

test('renderOffline builds the mixer, runs setup, renders and disposes; arguments and abort are checked', async () => {
  await assert.rejects(
    renderOffline({ seconds: 1 }, () => {}),
    { code: 'unsupported' },
  );
  const rendered = [];
  globalThis.OfflineAudioContext = class extends FakeContext {
    constructor(channels, length, sampleRate) {
      super({ sampleRate, state: 'suspended' });
      this.args = [channels, length, sampleRate];
      rendered.push(this);
    }
    async startRendering() {
      return {
        numberOfChannels: this.args[0],
        length: this.args[1],
        getChannelData: () => new Float32Array(this.args[1]),
      };
    }
  };
  try {
    let seen;
    const buffer = await renderOffline(
      { seconds: 0.5, sampleRate: 8000, channels: 1, mixer: { buses: { a: {} } } },
      async ({ context, mixer }) => {
        await Promise.resolve();
        seen = mixer.has('a') && context === rendered[0];
      },
    );
    assert.ok(seen);
    assert.equal(buffer.length, 4000);
    assert.deepEqual(rendered[0].args, [1, 4000, 8000]);
    assert.equal(rendered[0].destination.outputs.size, 0);
    for (const bad of [
      { seconds: 0 },
      { seconds: NaN },
      { seconds: 1, channels: 0 },
      { seconds: 1, channels: 9 },
      { seconds: 1, sampleRate: 100 },
    ])
      await assert.rejects(
        renderOffline(bad, () => {}),
        RangeError,
      );
    const controller = new AbortController();
    controller.abort(new Error('no'));
    await assert.rejects(
      renderOffline({ seconds: 1, signal: controller.signal }, () => {}),
      /no/,
    );
    const mid = new AbortController();
    await assert.rejects(
      renderOffline({ seconds: 1, signal: mid.signal }, () => mid.abort(new Error('during setup'))),
      /during setup/,
    );
    const before = rendered.length;
    await assert.rejects(
      renderOffline({ seconds: 1 }, () => {
        throw new Error('setup failed');
      }),
      /setup failed/,
    );
    assert.equal(rendered.length, before + 1);
    assert.equal(rendered.at(-1).destination.outputs.size, 0);
  } finally {
    delete globalThis.OfflineAudioContext;
  }
});

test('fuzz: random bus operations keep the graph connected to the destination and never throw anything but the documented errors', () => {
  const rnd = random(5150),
    allowed = (error) =>
      error instanceof RangeError ||
      error instanceof TypeError ||
      (error.name === 'MargoError' && ['state', 'disposed'].includes(error.code));
  for (let round = 0; round < 40; round++) {
    const context = new FakeContext(),
      mixer = new Mixer(context);
    const names = ['master'];
    for (let step = 0; step < 80; step++) {
      const pick = () => names[Math.floor(rnd() * names.length)];
      try {
        const op = Math.floor(rnd() * 8);
        if (op === 0) {
          const name = `b${step}`;
          mixer.createBus(name, {
            parent: rnd() < 0.9 ? pick() : 'ghost',
            gain: rnd() * 20 - 10,
            effects: rnd() < 0.3 ? [{ type: 'limiter' }] : [],
          });
          names.push(name);
        } else if (op === 1) mixer.bus(pick()).setMuted(rnd() < 0.5);
        else if (op === 2) mixer.bus(pick()).setSolo(rnd() < 0.5);
        else if (op === 3) mixer.bus(pick()).setGain(rnd() < 0.2 ? NaN : rnd() * 30 - 20);
        else if (op === 4) mixer.bus(pick()).send(pick(), { gain: rnd() * 10 - 20 });
        else if (op === 5)
          mixer
            .bus(pick())
            .duck({ amount: rnd() * 20, at: rnd() * 5 })
            .release({ at: 6 });
        else if (op === 6) {
          const name = pick();
          mixer.removeBus(name);
          names.splice(names.indexOf(name), 1);
        } else
          mixer.bus(pick()).setEffects(
            rnd() < 0.5
              ? []
              : [
                  { type: 'delay', time: rnd() },
                  { type: 'eq', bands: [{ frequency: 100 + rnd() * 5000 }] },
                ],
          );
      } catch (error) {
        assert.ok(allowed(error), String(error));
      }
    }
    // Every remaining bus still reaches the destination through parents.
    for (const bus of mixer.buses())
      assert.ok(reaches(bus.input, context.destination), `${bus.name} reaches the destination`);
    mixer.dispose();
  }
});

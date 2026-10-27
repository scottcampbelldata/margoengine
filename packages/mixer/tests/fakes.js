// A small Web Audio stand-in for Node: records graph edges and AudioParam automation so tests can check wiring and
// scheduling without a sound card. Real audio is rendered by scripts/test-browser.js.
export class FakeParam {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push({ kind: 'set', value, time });
    this.value = value;
    return this;
  }
  setTargetAtTime(value, time, constant) {
    this.events.push({ kind: 'target', value, time, constant });
    return this;
  }
  cancelScheduledValues(time) {
    this.events.push({ kind: 'cancel', time });
    return this;
  }
  /** The last scheduled value (set or target), or undefined. */
  last() {
    return this.events.filter((e) => e.kind === 'set' || e.kind === 'target').at(-1);
  }
}

export class FakeNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.outputs = new Set();
    this.numberOfInputs = 1;
  }
  connect(node) {
    this.outputs.add(node);
    return node;
  }
  disconnect(node) {
    if (node === undefined) this.outputs.clear();
    else this.outputs.delete(node);
  }
}

class FakeGain extends FakeNode {
  constructor(context) {
    super(context, 'gain');
    this.gain = new FakeParam(1);
  }
}
class FakeBiquad extends FakeNode {
  constructor(context) {
    super(context, 'biquad');
    this.type = 'lowpass';
    this.frequency = new FakeParam(350);
    this.Q = new FakeParam(1);
    this.gain = new FakeParam(0);
  }
}
class FakeCompressor extends FakeNode {
  constructor(context) {
    super(context, 'compressor');
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = new FakeParam(0);
  }
}
class FakeDelay extends FakeNode {
  constructor(context, max) {
    super(context, 'delay');
    this.max = max;
    this.delayTime = new FakeParam(0);
  }
}
class FakeConvolver extends FakeNode {
  constructor(context) {
    super(context, 'convolver');
    this.buffer = null;
    this.normalize = true;
  }
}
class FakePanner extends FakeNode {
  constructor(context) {
    super(context, 'panner');
    for (const name of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ'])
      this[name] = new FakeParam(0);
  }
}
class FakeAnalyser extends FakeNode {
  constructor(context) {
    super(context, 'analyser');
    this.fftSize = 2048;
    this.samples = null;
  }
  getFloatTimeDomainData(array) {
    array.set(this.samples ?? new Float32Array(array.length));
  }
}

export class FakeContext {
  constructor({ sampleRate = 48000, state = 'running' } = {}) {
    this.sampleRate = sampleRate;
    this.state = state;
    this.currentTime = 0;
    this.destination = new FakeNode(this, 'destination');
    this.listener = Object.fromEntries(
      ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map((n) => [
        n,
        new FakeParam(0),
      ]),
    );
    this.nodes = [];
  }
  track(node) {
    this.nodes.push(node);
    return node;
  }
  createGain() {
    return this.track(new FakeGain(this));
  }
  createBiquadFilter() {
    return this.track(new FakeBiquad(this));
  }
  createDynamicsCompressor() {
    return this.track(new FakeCompressor(this));
  }
  createDelay(max) {
    return this.track(new FakeDelay(this, max));
  }
  createConvolver() {
    return this.track(new FakeConvolver(this));
  }
  createPanner() {
    return this.track(new FakePanner(this));
  }
  createAnalyser() {
    return this.track(new FakeAnalyser(this));
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (i) => data[i],
      copyToChannel: (source, i) => data[i].set(source),
    };
  }
  async decodeAudioData(bytes) {
    if (bytes.byteLength === 0) throw new Error('EncodingError');
    return this.createBuffer(1, bytes.byteLength, this.sampleRate);
  }
}

/** True when a path of connections leads from `from` to `to`. */
export function reaches(from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const next of from.outputs) if (reaches(next, to, seen)) return true;
  return false;
}

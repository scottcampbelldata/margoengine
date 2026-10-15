// A small Web Audio stand-in for Node: records graph edges and AudioParam automation so tests can check wiring
// and parameter math without a sound card.
export class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push(['set', value, time]);
    this.value = value;
    return this;
  }
  setTargetAtTime(value, time, constant) {
    this.events.push(['target', value, time, constant]);
    this.target = value;
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this.events.push(['linear', value, time]);
    this.target = value;
    return this;
  }
  cancelScheduledValues(time) {
    this.events.push(['cancel', time]);
    return this;
  }
  last(kind) {
    return this.events.filter((event) => (kind === undefined ? event[0] !== 'cancel' : event[0] === kind)).at(-1);
  }
}

export class FakeNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.outputs = new Set();
  }
  connect(node) {
    this.outputs.add(node);
    return node;
  }
  disconnect(node) {
    if (node === undefined) {
      this.outputs.clear();
      return;
    }
    if (!this.outputs.has(node)) throw new Error('InvalidAccessError: not connected');
    this.outputs.delete(node);
  }
}

class FakeBufferSource extends FakeNode {
  constructor(context) {
    super(context, 'buffer-source');
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new FakeParam(1);
    this.detune = new FakeParam(0);
    this.onended = null;
    this.started = null;
    this.stopped = null;
    context.bufferSources.push(this);
  }
  start(when = 0, offset = 0, duration) {
    this.started = { when, offset, duration };
  }
  stop(when = 0) {
    this.stopped = { when };
  }
  end() {
    this.onended?.();
  }
}

class FakeAnalyser extends FakeNode {
  constructor(context) {
    super(context, 'analyser');
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0.8;
    this.minDecibels = -100;
    this.maxDecibels = -30;
  }
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getByteFrequencyData(array) {
    for (let i = 0; i < array.length; i++) array[i] = i < 4 ? 200 : 0;
  }
  getFloatFrequencyData(array) {
    array.fill(-50);
  }
  getByteTimeDomainData(array) {
    array.fill(128);
  }
  getFloatTimeDomainData(array) {
    array.fill(0);
  }
}

export class FakeAudioContext {
  static created = 0;
  constructor({ state = 'suspended', sampleRate = 48000 } = {}) {
    FakeAudioContext.created++;
    this.state = state;
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new FakeNode(this, 'destination');
    this.bufferSources = [];
    this.calls = [];
    const params = ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'];
    this.listener = Object.fromEntries(
      params.map((name) => [name, new FakeParam(name === 'forwardZ' ? -1 : name === 'upY' ? 1 : 0)]),
    );
  }
  createGain() {
    const node = new FakeNode(this, 'gain');
    node.gain = new FakeParam(1);
    return node;
  }
  createBiquadFilter() {
    const node = new FakeNode(this, 'biquad');
    node.frequency = new FakeParam(350);
    return node;
  }
  createPanner() {
    const node = new FakeNode(this, 'panner');
    Object.assign(node, {
      panningModel: 'equalpower',
      distanceModel: 'inverse',
      refDistance: 1,
      maxDistance: 10000,
      rolloffFactor: 1,
      coneInnerAngle: 360,
      coneOuterAngle: 360,
      coneOuterGain: 0,
    });
    for (const name of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ'])
      node[name] = new FakeParam(name === 'orientationX' ? 1 : 0);
    return node;
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createAnalyser() {
    return new FakeAnalyser(this);
  }
  createMediaElementSource(element) {
    this.calls.push('media');
    const node = new FakeNode(this, 'media-source');
    node.element = element;
    return node;
  }
  createMediaStreamSource(stream) {
    const node = new FakeNode(this, 'stream-source');
    node.stream = stream;
    return node;
  }
  decodeAudioData(bytes) {
    this.calls.push('decode');
    return Promise.resolve({ duration: bytes.byteLength, length: bytes.byteLength, bytes });
  }
  async resume() {
    this.calls.push('resume');
    this.state = 'running';
  }
  async suspend() {
    this.calls.push('suspend');
    this.state = 'suspended';
  }
  async close() {
    this.calls.push('close');
    this.state = 'closed';
  }
}

export class FakeMediaElement extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.loop = false;
    this.playbackRate = 1;
    this.currentTime = 0;
    this.plays = 0;
  }
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

/** Follows single-output edges from `node`, returning the node kinds along the way. */
export function chain(node, limit = 12) {
  const kinds = [];
  for (let current = node, i = 0; current && i < limit; i++) {
    kinds.push(current.kind);
    current = [...current.outputs][0];
  }
  return kinds;
}

/** Minimal engine double: what the plugins read from EngineKernel and engineRuntime(engine). */
export function fakeEngine({ capacity = 8 } = {}) {
  const view = new EventTarget();
  const document = { defaultView: view };
  const passes = [];
  const engine = {
    canvas: { ownerDocument: document },
    camera: { position: [0, 0, 5], target: [0, 0, 0] },
    disposed: false,
    meshes: new Map(),
    store: {
      matrices: new Float32Array(capacity * 16),
      parents: new Float32Array(capacity).fill(-1),
      hidden: new Uint8Array(capacity),
    },
    graph: {
      add(pass) {
        passes.push(pass);
        return () => {};
      },
    },
    passes,
    view,
    frame() {
      for (const pass of passes) pass.execute({});
    },
    createMesh() {
      const id = engine.meshes.size,
        mesh = { id };
      engine.meshes.set(id, mesh);
      engine.store.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], id * 16);
      return mesh;
    },
  };
  return engine;
}

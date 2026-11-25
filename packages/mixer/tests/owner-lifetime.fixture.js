// Owner/lifetime fixture for @margoengine/mixer. The package holds Web Audio graphs, not engine objects: an app hangs a
// mixer or a stage off its engine and releases it with the engine. A graph's lifetime is its edges, its started sources
// and its worklet processors, which no runtime lets a page list, so every entry runs on a recording context (the Node
// stand-in of ./fakes.js with the node kinds the stages use) in both runtimes. After disposal every node the entry made
// must be disconnected, every source it started stopped and every worklet told to stop and its port closed; a bus
// stage must also leave its bus wired straight through. Each stage waits on the app's own signal, which outlives it.
// check:owners runs one leaf per entry: 17 entries are 221 cases, past the 208 a leaf may hold (tests/owner-lifetime.test.js).
export const leafPerEntry = true;
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';
import { FakeContext, FakeNode, FakeParam } from './fakes.js';

class Source extends FakeNode {
  constructor(context) {
    super(context, 'constant');
    this.offset = new FakeParam(1);
    this.started = this.stopped = false;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
class Worklet extends FakeNode {
  constructor(context, name, options = {}) {
    super(context, `worklet:${name}`);
    this.numberOfInputs = options.numberOfInputs ?? 1;
    this.parameters = new Map(Object.entries(options.parameterData ?? {}).map(([k, v]) => [k, new FakeParam(v)]));
    const told = (this.told = []);
    this.port = {
      onmessage: null,
      closed: false,
      postMessage: (data) => told.push(data),
      close() {
        this.closed = true;
      },
    };
    context.track(this);
  }
}
class Recording extends FakeContext {
  sources = [];
  audioWorklet = { addModule: () => new Promise((resolve) => setTimeout(resolve, 0)) };
  createWaveShaper() {
    return this.track(Object.assign(new FakeNode(this, 'shaper'), { curve: null, oversample: 'none' }));
  }
  createConstantSource() {
    const node = this.track(new Source(this));
    this.sources.push(node);
    return node;
  }
  createChannelSplitter(n = 6) {
    return this.track(Object.assign(new FakeNode(this, 'splitter'), { numberOfOutputs: n }));
  }
  createChannelMerger(n = 6) {
    return this.track(Object.assign(new FakeNode(this, 'merger'), { numberOfInputs: n }));
  }
  createStereoPanner() {
    return this.track(Object.assign(new FakeNode(this, 'stereo'), { pan: new FakeParam(0) }));
  }
}
// The worklet constructor the stages call, in place while a stage is built: a browser's own needs a real context.
async function withWorklets(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, writable: true, value: Worklet });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'AudioWorkletNode', had);
    else delete globalThis.AudioWorkletNode;
  }
}
// Nodes made before `from` are the app's own (a bus it keeps): only the entry's nodes must be gone.
function released(context, from, what) {
  const kept = context.nodes.slice(from).filter((node) => node.outputs.size);
  if (kept.length)
    lifetimeFault(`${what} leaves ${kept.length} node(s) connected (${kept.map((n) => n.kind).join(', ')})`);
  const running = context.sources.filter((s) => s.started && !s.stopped);
  if (running.length) lifetimeFault(`${what} leaves ${running.length} source(s) running`);
  const live = context.nodes
    .slice(from)
    .filter((n) => n instanceof Worklet && (!n.told.includes('dispose') || !n.port.closed));
  if (live.length) lifetimeFault(`${what} leaves ${live.length} worklet processor(s) running`);
}
const signal = () => new AbortController().signal;
const fx = [{ type: 'distortion', amount: 0.3 }, { type: 'chorus' }, { type: 'bitcrusher', bits: 6 }];
const effects = [
  { type: 'eq', bands: [{ frequency: 100, type: 'lowshelf', gain: 3 }] },
  { type: 'filter', filter: 'lowpass', frequency: 2000 },
  { type: 'compressor' },
  { type: 'limiter' },
  { type: 'delay', time: 0.1, feedback: 0.3 },
];

export async function fixtures(load = (entry) => import(entry)) {
  const { Mixer, createEffect } = await load('../dist/index.js');
  const { createFXChain, createBusFX } = await load('../dist/fx.js');
  const { createGate, createExpander, createMultibandCompressor, createBusDynamics } =
    await load('../dist/dynamics.js');
  const { createPitchShift, createBusPitchShift } = await load('../dist/pitch.js');
  const { createSidechain } = await load('../dist/sidechain.js');
  const { createDynamics } = await load('../dist/worklet.js');
  const { createAnalyser, createBusAnalyser } = await load('../dist/analyser.js');
  const { createStereo, createBusStereo } = await load('../dist/stereo.js');
  const { createRoomReverb } = await load('../dist/reflections.js');
  const entries = [];
  const owned = (name, make) =>
    entries.push({
      name,
      async create({ scene }) {
        const context = new Recording();
        const { release, check } = await withWorklets(() => make(context));
        return ownedByEngine(scene, name, release, {
          check({ phase }) {
            if (phase === 'disposed') check();
          },
        });
      },
    });
  // A whole mixer: buses with effects, a send, a duck, a routed source and an emitter. Disposal tears down every bus.
  owned('Mixer', (context) => {
    const mixer = new Mixer(context, { buses: { music: { effects }, sfx: {} } });
    mixer.bus('music').send('sfx', { gain: -6 });
    mixer.bus('sfx').duck({ amount: 6 });
    const source = context.createGain();
    mixer.route(source, 'music');
    const emitter = mixer.emitter('sfx');
    return {
      release: () => {
        emitter.dispose();
        mixer.dispose();
      },
      // The routed source is the app's, and so is its edge into the bus: drop it before counting.
      check: () => {
        source.disconnect();
        released(context, 0, 'a disposed mixer');
      },
    };
  });
  // Stages built on a context: the app wires them, so disposal must leave nothing of them connected or running.
  const stages = {
    effect: (c) => createEffect(c, { type: 'reverb', seconds: 0.05, mix: 0.25 }),
    fxChain: (c) => createFXChain(c, fx, { signal: signal() }),
    gate: (c) => createGate(c, { signal: signal() }),
    expander: (c) => createExpander(c, { signal: signal() }),
    multiband: (c) => createMultibandCompressor(c, { signal: signal() }),
    pitch: (c) => createPitchShift(c, { signal: signal() }),
    sidechain: (c) => createSidechain(c, { signal: signal() }),
    dynamics: (c) => createDynamics(c, { signal: signal() }),
    analyser: (c) => createAnalyser(c, { signal: signal() }),
    stereo: (c) => createStereo(c),
    roomReverb: (c) => createRoomReverb(c, { seconds: 0.05 }),
  };
  for (const [name, make] of Object.entries(stages))
    owned(name, async (context) => {
      const stage = await make(context),
        source = context.createGain();
      source.connect(stage.input);
      stage.output.connect(context.destination);
      return {
        release: () => stage.dispose(),
        check: () => {
          // The app's source still feeds the stage's input, which is the app's edge: drop it before counting.
          source.disconnect();
          released(context, 0, `a disposed ${name} stage`);
        },
      };
    });
  // Bus stages: inserted on a bus the app keeps. Disposal removes them and wires the bus straight through again.
  const busStages = {
    busFX: (bus) => createBusFX(bus, fx, { signal: signal() }),
    busGate: (bus) => createBusDynamics(bus, { type: 'gate', signal: signal() }),
    busPitch: (bus) => createBusPitchShift(bus, { signal: signal() }),
    busAnalyser: (bus) => createBusAnalyser(bus, { signal: signal() }),
    busStereo: (bus) => createBusStereo(bus),
  };
  for (const [name, make] of Object.entries(busStages))
    owned(name, async (context) => {
      const mixer = new Mixer(context, { buses: { music: {} } }),
        bus = mixer.bus('music'),
        from = context.nodes.length;
      const stage = await make(bus);
      return {
        release: () => stage.dispose(),
        check: () => {
          released(context, from, `a disposed ${name} stage`);
          if (!bus.gate.outputs.has(bus.output)) lifetimeFault(`a disposed ${name} stage leaves its bus unwired`);
          mixer.dispose();
        },
      };
    });
  return entries;
}

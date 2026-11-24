import vm from 'node:vm';
import { FakeContext, FakeNode, FakeParam } from './fakes.js';

/** Execute our shipped worklet text in a separate realm, with explicit sample rate and recorded messages. */
export function processorHarness(t, sampleRate = 48000) {
  const classes = new Map(), worklets = [];
  const context = new FakeContext({ sampleRate });
  context.createChannelSplitter = () => context.track(new FakeNode(context, 'splitter'));
  context.createWaveShaper = () => context.track(new FakeNode(context, 'waveshaper'));
  context.createConstantSource = () => context.track(Object.assign(new FakeNode(context, 'constant'), {
    offset: new FakeParam(0), start() {}, stop() { this.stopped = true; },
  }));
  context.audioWorklet = { async addModule(url) {
    vm.runInNewContext(await (await fetch(url)).text(), {
      sampleRate,
      AudioWorkletProcessor: class { port = { postMessage() {} }; },
      registerProcessor: (name, Class) => classes.set(name, Class),
    });
  } };
  globalThis.AudioWorkletNode ??= function () {};
  t.mock.method(globalThis, 'AudioWorkletNode', function (ctx, name, options) {
    const node = new FakeNode(ctx, 'worklet');
    node.processor = new (classes.get(name))(options); node.messages = []; node.options = options;
    node.parameters = new Map((classes.get(name).parameterDescriptors ?? []).map(p =>
      [p.name, new FakeParam(options.parameterData?.[p.name] ?? p.defaultValue)]));
    node.processor.testParameters = Object.fromEntries([...node.parameters].map(([k, p]) => [k, Float32Array.of(p.value)]));
    node.port = { onmessage: null, postMessage: data => node.processor.port.onmessage({ data }), close() {} };
    node.processor.port.postMessage = data => { node.messages.push(data); node.port.onmessage?.({ data }); };
    worklets.push(node); return node;
  });
  return { context, worklets };
}

/** Render arbitrary quantum sizes without padding the input. */
export function processAudio(processor, input, block = 128) {
  const output = input.map(c => new Float32Array(c.length));
  for (let at = 0; at < input[0].length; at += block) {
    const data = input.map(c => c.subarray(at, at + block));
    const out = data.map(c => new Float32Array(c.length));
    processor.process([data], [out], processor.testParameters); out.forEach((c, i) => output[i].set(c, at));
  }
  return output;
}

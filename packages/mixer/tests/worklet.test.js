import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDynamics, measureTruePeak } from '@margoengine/mixer/worklet';
import { compressorCurve, dbToGain } from '../dist/index.js';

function harness(t, rate = 48000) {
  const classes = new Map(), nodes = [], sources = [];
  class Node {
    edges = [];
    connect(...args) { this.edges.push(args); return args[0]; }
    disconnect() { this.edges.length = 0; }
  }
  class Worklet extends Node {
    constructor(_context, name, options) {
      super(); this.options = options; this.processor = new (classes.get(name))(options);
      this.port = { postMessage: (data) => this.processor.port.onmessage({ data }), close() {} };
      nodes.push(this);
    }
  }
  t.mock.method(globalThis, 'AudioWorkletNode', function (...args) { return new Worklet(...args); });
  let loads = 0;
  const context = {
    sampleRate: rate, createGain: () => new Node(),
    audioWorklet: { async addModule(url) {
      loads++;
      const source = await (await fetch(url)).text(); sources.push(source);
      vm.runInNewContext(source, {
        sampleRate: rate,
        AudioWorkletProcessor: class { port = {}; },
        registerProcessor: (name, Class) => classes.set(name, Class),
      });
    } },
  };
  return { context, nodes, sources, loads: () => loads };
}

// Node does not expose this browser constructor. Restore the property after each test.
globalThis.AudioWorkletNode ??= function () {};

function render(processor, input, block = 128) {
  const length = input[0].length + 24;
  const output = input.map(() => new Float32Array(length));
  for (let at = 0; at < length; at += block) {
    const count = Math.min(block, length - at);
    const data = input.map((channel) => Float32Array.from({ length: count }, (_, i) => channel[at + i] ?? 0));
    const out = output.map(() => new Float32Array(count));
    processor.process([data], [out]);
    out.forEach((channel, c) => output[c].set(channel, at));
  }
  return output;
}

test('compressor matches the published static curve with no automatic make-up and preserves linked stereo', async (t) => {
  const h = harness(t);
  for (const knee of [0, 6, 30]) {
    for (const db of [-50, -27, -24, -21, -12]) {
      using stage = await createDynamics(h.context, { mode: 'compressor', threshold: -24, knee, ratio: 4, attack: 0, release: 0, ceiling: 0 });
      const input = new Float32Array(256).fill(dbToGain(db));
      const out = render(h.nodes.at(-1).processor, [input, input.map((v) => -v * 0.5)]);
      const expected = dbToGain(compressorCurve(20 * Math.log10(input[0]), { threshold: -24, knee, ratio: 4 }));
      assert.ok(Math.abs(out[0][100] - expected) < 3e-8, `knee ${knee}, input ${db}`);
      assert.ok(out[0].every((v, i) => out[1][i] === -v * 0.5));
      assert.equal(stage.latencyFrames, 11);
      assert.equal(stage.latency, 11 / 48000);
    }
  }
});

test('attack is the stated one-pole recurrence; quiet limiter output is an exact delayed copy', async (t) => {
  const h = harness(t, 48000);
  using comp = await createDynamics(h.context, { mode: 'compressor', threshold: -24, knee: 0, ratio: 4, attack: 0.01, release: 0, ceiling: 0 });
  const input = new Float32Array(1024).fill(0.25);
  const out = render(h.nodes.at(-1).processor, [input, input]);
  const target = dbToGain(compressorCurve(20 * Math.log10(0.25), { threshold: -24, knee: 0, ratio: 4 })) / 0.25;
  for (const i of [0, 1, 100, 479, 900])
    assert.ok(Math.abs(out[0][i + 11] - 0.25 * (target + (1 - target) * Math.exp(-(i + 1) / 480))) < 3e-8);
  using limiter = await createDynamics(h.context, { channels: 1 });
  const quiet = Float32Array.from({ length: 1024 }, (_, i) => 0.1 * Math.sin(i));
  const limited = render(h.nodes.at(-1).processor, [quiet])[0];
  assert.ok(limited.slice(0, 11).every((v) => v === 0));
  assert.deepEqual(limited.slice(11, quiet.length + 11), quiet);
});

test('adversarial peaks respect the FIR ceiling and output is bit-identical across render quantum sizes', async (t) => {
  const h = harness(t);
  let seed = 7;
  const signals = [
    Float32Array.from({ length: 4096 }, (_, i) => 2 * Math.sin(Math.PI * i / 2 + Math.PI / 4)),
    Float32Array.from({ length: 4096 }, (_, i) => i % 127 === 0 ? 20 : 0),
    Float32Array.from({ length: 4096 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 2147483648 - 1) * 10; }),
  ];
  for (const input of signals) {
    for (const release of [0, 0.05]) {
      using a = await createDynamics(h.context, { ceiling: -6, release });
      const first = render(h.nodes.at(-1).processor, [input, input.map((v) => -v * 0.7)]);
      using b = await createDynamics(h.context, { ceiling: -6, release });
      const other = render(h.nodes.at(-1).processor, [input, input.map((v) => -v * 0.7)], 17);
      assert.deepEqual(first, other);
      assert.ok(measureTruePeak(first) <= dbToGain(-6), 'sample and inter-sample ceiling includes all boundaries');
      assert.ok(first.every((c) => c.every(Number.isFinite)));
    }
  }
});

test('true peak detects inter-sample overs and validates inputs; stage errors and disposal are explicit', async (t) => {
  const tone = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(Math.PI * i / 2 + Math.PI / 4));
  const sample = Math.max(...tone.map(Math.abs));
  assert.ok(measureTruePeak([tone]) > sample * 1.38);
  assert.equal(measureTruePeak([new Float32Array(0)]), 0);
  for (const bad of [[], [new Float32Array(1), new Float32Array(2)], [Float32Array.of(NaN)]])
    assert.throws(() => measureTruePeak(bad));
  const h = harness(t);
  for (const options of [{ mode: 'fast' }, { ceiling: 1 }, { ratio: 0 }, { knee: Infinity }, { channels: 1.1 }, { attack: -1 }, { makeup: 25 }])
    await assert.rejects(createDynamics(h.context, options));
  await assert.rejects(createDynamics({}), { code: 'unsupported', message: /https:\/\// });
  using stage = await createDynamics(h.context);
  stage.dispose(); stage.dispose();
  assert.equal(h.nodes.at(-1).processor.process([[]], [[new Float32Array(1), new Float32Array(1)]]), false);
});

test('true peak agrees with an independent non-streaming convolution of the ITU numeric table including both tails', () => {
  const p = [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
    0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125];
  const q = [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375];
  const phases = [p, q, [...p].reverse(), [...q].reverse()];
  for (const length of [1, 7, 12, 31, 128]) {
    const data = Float32Array.from({ length }, (_, i) => Math.sin(i * 2.423) * Math.cos(i * 0.333));
    let expected = Math.max(...data.map(Math.abs));
    for (let i = 0; i < length + 11; i++) for (const phase of phases) {
      let value = 0;
      for (let k = 0; k < 12; k++) value += phase[k] * (data[i - k] ?? 0);
      expected = Math.max(expected, Math.abs(value));
    }
    assert.equal(measureTruePeak([data]), expected);
  }
});

test('abort between cached registration and factory continuation creates no dynamics nodes', async (t) => {
  const h = harness(t);
  using warm = await createDynamics(h.context);
  const count = h.nodes.length;
  const controller = new AbortController();
  const pending = createDynamics(h.context, { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort(new Error('late stop'));
  await assert.rejects(pending, /late stop/);
  assert.equal(h.nodes.length, count);
});


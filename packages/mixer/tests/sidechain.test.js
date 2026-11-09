import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSidechain } from '@margoengine/mixer/sidechain';

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
    createGain: () => new Node(),
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

test('sidechain uses the audio clock, key only, hold and exact one-pole attack/release across blocks', async (t) => {
  const { context, nodes } = harness(t, 1000);
  using stage = await createSidechain(context, { channels: 1, amount: 20, threshold: -20, attack: 0.01, release: 0.02, hold: 0.003 });
  const p = nodes[0].processor;
  function run(key) {
    const out = [new Float32Array(key.length)];
    p.process([[new Float32Array(key.length).fill(0.5)], [Float32Array.from(key)]], [out]);
    return out[0];
  }
  assert.deepEqual([...run([0, 0, 0])], [0.5, 0.5, 0.5]);
  const a = run([0.5, -0.5, 0.5, -0.5, 0.5]);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - 0.5 * (0.1 + 0.9 * Math.exp(-(i + 1) / 10))) < 3e-8);
  const held = run([0, 0, 0]);
  assert.ok(held[2] < held[0], 'hold continues attack across a render boundary');
  const before = p.gain;
  const released = run([0, 0]);
  assert.ok(Math.abs(released[0] - 0.5 * (1 + (before - 1) * Math.exp(-1 / 20))) < 3e-8);
  stage.dispose(); stage.dispose();
  assert.equal(p.process([[], []], [[new Float32Array(1)]]), false);
  assert.equal(stage.input.edges.length, 0);
  assert.equal(stage.sidechain.edges.length, 0);
});

test('zero attack/release, multichannel key, disconnected input and key isolation', async (t) => {
  const { context, nodes } = harness(t);
  using stage = await createSidechain(context, { amount: 20, attack: 0, release: 0, hold: 0 });
  const out = [new Float32Array(4), new Float32Array(4)];
  nodes[0].processor.process([
    [new Float32Array(4).fill(1), new Float32Array(4).fill(-0.5)],
    [new Float32Array(4), Float32Array.from([0, -1, 1, 0])],
  ], [out]);
  assert.deepEqual([...out[0]], [...Float32Array.from([1, 0.1, 0.1, 1])]);
  assert.deepEqual([...out[1]], [...Float32Array.from([-0.5, -0.05, -0.05, -0.5])]);
  nodes[0].processor.process([[], [new Float32Array(4).fill(1)]], [out]);
  assert.ok(out.every((ch) => ch.every((v) => v === 0)), 'key never leaks to output');
  assert.equal(stage.sidechain.edges[0][2], 1);
});

test('registration is shared; unsupported, invalid options and aborted loading are explicit', async (t) => {
  const h = harness(t);
  using a = await createSidechain(h.context);
  using b = await createSidechain(h.context);
  assert.equal(h.loads(), 1);
  for (const options of [{ amount: NaN }, { threshold: 1 }, { attack: -1 }, { channels: 1.5 }, { release: Infinity }, { hold: 11 }])
    await assert.rejects(createSidechain(h.context, options), RangeError);
  await assert.rejects(createSidechain(h.context, { amount: '12' }), TypeError);
  await assert.rejects(createSidechain({}), { code: 'unsupported', message: /https:\/\// });
  const abort = new AbortController(); abort.abort(new Error('stop'));
  await assert.rejects(createSidechain(h.context, { signal: abort.signal }), /stop/);
  let finish;
  const waiting = { audioWorklet: { addModule: () => new Promise((resolve) => { finish = resolve; }) } };
  const controller = new AbortController();
  const pending = createSidechain(waiting, { signal: controller.signal });
  controller.abort(new Error('during load'));
  await assert.rejects(pending, /during load/);
  finish();
});

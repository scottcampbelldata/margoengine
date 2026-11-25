import test from 'node:test';
import assert from 'node:assert/strict';
import { Accumulate } from '../dist/accumulate.js';
import { PostStack } from '../dist/index.js';
import { harness, modules } from './support.js';

const uniforms = (log) =>
  log
    .filter((e) => e[0] === 'writeBuffer' && e[3].length === 32)
    .map((e) => [...new Float32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer)]);
const f = Math.fround;

test('Accumulate folds weighted frames into an rgba32float sum and writes the mean for the display curve', async () => {
  const h = harness(),
    acc = Accumulate.attach(h.engine),
    first = h.gpu.record(() => h.frame());
  assert.ok(!h.view.c.shader.includes('let mapped=pbrNeutral('), 'HDR stage: the stack captures linear light');
  const made = first.filter((e) => e[0] === 'texture').map((e) => e[2].format);
  assert.equal(made.filter((x) => x === 'rgba32float').length, 2, 'two ping-pong sums');
  assert.ok(made.includes('rgba16float'), 'a mean texture');
  assert.equal(acc.texture?.format ?? acc.texture?.descriptor?.format ?? 'rgba16float', 'rgba16float');
  assert.deepEqual(uniforms(first), [[1, 1, 1, 0]], 'the first frame starts the sum: weight 1, fresh, 1 / 1');
  const code = modules(first);
  assert.ok(
    code.some((c) => c.includes('return Folded(sum,sum*fold.z)')),
    'one pass writes sum and mean',
  );
  assert.ok(
    code.some((c) => c.includes('toDisplay(linear.rgb),linear.a')),
    'alone: the mean through the display curve',
  );
  assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[1, 0, 0.5, 0]]);
  acc.weight = 2;
  assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[2, 0, 0.25, 0]]);
  assert.equal(acc.count, 3);
  assert.equal(acc.total, 4);
  acc.begin();
  assert.equal(acc.count, 0);
  assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[2, 1, 0.5, 0]], 'begin starts a new sum');
  acc.weight = 1;
  h.frame();
  assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[1, 0, f(1 / 4), 0]]);
  // Disabled frames pass the input through; enabling again starts a new sum.
  acc.enabled = false;
  const off = h.gpu.record(() => h.frame());
  assert.deepEqual(uniforms(off), []);
  acc.enabled = true;
  assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[1, 1, 1, 0]]);
  // A resize and a device restore start a new sum.
  h.frame();
  h.view.state.width = 320;
  const resized = h.gpu.record(() => h.frame());
  assert.deepEqual(uniforms(resized), [[1, 1, 1, 0]]);
  assert.ok(resized.some((e) => e[0] === 'texture' && e[2].format === 'rgba32float' && e[2].size[0] === 320));
  h.frame();
  h.engine.restore();
  assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[1, 1, 1, 0]]);
  acc.dispose();
  acc.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
});

test('Accumulate before a display effect hands it the mean in linear light', () => {
  const h = harness(),
    seen = [],
    probe = {
      name: 'probe',
      setup() {},
      dispose() {},
      joinStack: () => ({ kind: 'display', render: (_c, input) => seen.push(input) }),
    },
    stack = PostStack.attach(h.engine, [new Accumulate(), probe]),
    log = h.gpu.record(() => h.frame());
  const passes = log.filter((e) => e[0] === 'beginRenderPass' && e[1].colorAttachments.length === 2);
  assert.equal(passes.length, 1, 'one fold pass with two targets');
  assert.equal(h.gpu.snap(seen[0]), passes[0][1].colorAttachments[1].view, 'the display stage reads the mean');
  stack.dispose();
});

test('Accumulate checks its options and lifecycle', () => {
  assert.throws(() => new Accumulate({ weight: -1 }), RangeError);
  assert.throws(() => new Accumulate({ weight: Infinity }), RangeError);
  assert.throws(() => new Accumulate({ enabled: 1 }), TypeError);
  const acc = new Accumulate();
  assert.throws(() => {
    acc.weight = NaN;
  }, RangeError);
  assert.throws(() => {
    acc.enabled = 'yes';
  }, TypeError);
  const h = harness();
  assert.throws(
    () => new Accumulate().setup(h.engine),
    (e) => e.code === 'state',
  );
  const attached = Accumulate.attach(h.engine);
  assert.throws(
    () => PostStack.attach(harness().engine, [attached]),
    (e) => e.code === 'attached',
  );
  attached.options.weight = -2;
  assert.throws(() => h.frame(), RangeError, 'checked every frame');
  attached.options.weight = 1;
  attached[Symbol.dispose]();
  assert.throws(
    () => attached.setup(h.engine),
    (e) => e.code === 'disposed',
  );
});

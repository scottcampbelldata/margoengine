import test from 'node:test';
import assert from 'node:assert/strict';
import { PostStack } from '../dist/index.js';
import { Outline } from '../dist/outline.js';
import { harness } from './support.js';

test('Outline checks its options when built', () => {
  for (const bad of [{ width: 0 }, { width: 17 }, { width: 1.5 }, { depthThreshold: 0 }, { normalThreshold: -1 }])
    assert.throws(() => new Outline(bad), RangeError);
  assert.throws(() => new Outline({ color: [0, 0, 2, 1] }), RangeError);
  assert.throws(() => new Outline({ maskId: 2 }), RangeError);
  assert.throws(() => new Outline({ enabled: 1 }), TypeError);
  assert.throws(() => new Outline({ normal: 'x' }), TypeError);
});

const uniforms = (log) =>
  log
    .filter((e) => e[0] === 'writeBuffer' && e[3].length === 96)
    .map((e) => [...new Float32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer)]);

test('Outline writes its defaults and joins a stack as an LDR effect', () => {
  const h = harness(),
    outline = Outline.attach(h.engine),
    [values] = uniforms(h.gpu.record(() => h.frame()));
  assert.deepEqual(values.slice(0, 4), [0, 0, 0, 1]);
  assert.equal(values[4], 1);
  assert.ok(Math.abs(values[5] - 0.03) < 1e-6);
  assert.ok(Math.abs(values[6] - 0.4) < 1e-6);
  assert.equal(values[7], -1);
  outline.dispose();
  outline.dispose();
});

test('Outline draws no line while its mask has no texture or it is disabled', () => {
  const h = harness(),
    outline = Outline.attach(h.engine, { mask: () => undefined });
  assert.equal(uniforms(h.gpu.record(() => h.frame()))[0][4], 0);
  outline.options.mask = undefined;
  assert.equal(uniforms(h.gpu.record(() => h.frame()))[0][4], 1);
  outline.options.enabled = false;
  assert.equal(uniforms(h.gpu.record(() => h.frame()))[0][4], 0);
  outline.dispose();
});

test('Outline outside a stack is refused and joining twice throws', () => {
  const h = harness(),
    outline = new Outline();
  assert.throws(() => h.engine.use(outline), /PostStack/);
  const stacked = new Outline();
  new PostStack([stacked]);
  assert.throws(() => new PostStack([stacked]), /already attached/);
});

test('The outline entry exports only Outline and stays out of the post root', async () => {
  const entry = await import('@margoengine/post/outline'),
    root = await import('@margoengine/post');
  assert.deepEqual(Object.keys(entry), ['Outline']);
  assert.equal(root.Outline, undefined);
});

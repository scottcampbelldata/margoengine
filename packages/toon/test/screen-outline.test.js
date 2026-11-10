import test from 'node:test';
import assert from 'node:assert/strict';
import { Toon, ModelOutlines } from '../dist/screen-outline.js';
import { Toon as WorldToon } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

test('screen Toon attaches the pixel implementation, uses each viewport and releases uniform copies', async () => {
  const h = optionalGPU(),
    effect = Toon.attach(h.engine, { outline: 24 });
  assert.ok(effect instanceof Toon);
  let draw;
  h.context.draw = (options) => {
    if (options) draw = options;
  };
  h.context.view = { viewport: [0, 0, 320, 200] };
  h.frame();
  const first = draw.bindings[0].resource.buffer;
  assert.deepEqual([...new Float32Array(first.data)].slice(3, 6), [24, 320, 200]);
  assert.match(draw.pipeline.vertex.module.code, /return Output\(clip,/);
  h.context.view = { viewport: [320, 0, 160, 100] };
  h.frame();
  const second = draw.bindings[0].resource.buffer;
  assert.notEqual(first, second);
  assert.deepEqual([...new Float32Array(first.data)].slice(3, 6), [24, 320, 200]);
  assert.deepEqual([...new Float32Array(second.data)].slice(3, 6), [24, 160, 100]);
  effect.dispose();
  await Promise.resolve();
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(() => new Toon({ outline: 1025 }), RangeError);
  assert.throws(() => new WorldToon({ outline: 24 }), RangeError);
});

test('screen model outlines keep smoothing, instancing, paint and live material widths in pixels', () => {
  const h = optionalGPU();
  h.engine.gpu.createPipelineLayout = (d) => d;
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (...args) => ({ ...begin(...args), setViewport() {}, setScissorRect() {} });
  const identity = h.context.camera.matrix,
    model = {
      root: { id: 0 },
      primitives: [
        {
          node: { id: 1, matrix: identity },
          vertices: new Float32Array(60),
          indices: new Uint32Array([0, 1, 2]),
          material: { name: 'body' },
          buffers: { vertex: { usage: 128 }, index: {} },
          instances: {
            count: 2,
            data: new Float32Array([...identity, ...new Float32Array(8), ...identity, ...new Float32Array(8)]),
          },
        },
      ],
    },
    effect = ModelOutlines.attach(h.engine, { models: [model], outline: 18, vertexColors: true });
  assert.ok(effect instanceof ModelOutlines);
  h.context.view = { viewport: [20, 30, 240, 120] };
  effect.materials = { body: { outline: 32, color: [0, 1, 0] } };
  h.frame();
  const frame = h.bufferWrites.find((w) => w.bytes === 80 && w.buffer.size === 80);
  assert.deepEqual([...new Float32Array(frame.buffer.data)].slice(16, 19), [1, 240, 120]);
  const rows = h.bufferWrites.find((w) => w.bytes === 160);
  assert.equal(new Float32Array(rows.buffer.data)[19], 32);
  assert.equal(new Float32Array(rows.buffer.data)[39], 32);
  effect.outline = 1024;
  assert.throws(() => {
    effect.outline = Infinity;
  }, RangeError);
  assert.throws(() => {
    effect.materials = { body: { outline: -1 } };
  }, RangeError);
  effect.dispose();
});

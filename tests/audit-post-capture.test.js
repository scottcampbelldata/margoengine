import test from 'node:test';
import assert from 'node:assert/strict';
import { Bloom, SSAO } from '../packages/post/dist/index.js';
import { DOF } from '../packages/dof/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { TAA } from '../packages/taa/dist/index.js';
import { optionalGPU } from './support/optional-gpu.js';
import { wgsl } from '../packages/core/dist/shaders.js';

for (const Effect of [DOF, Tonemap]) {
  test(`standalone Bloom and ${Effect.name} reject capture ownership in either attachment order`, () => {
    for (const [First, Second] of [
      [Bloom, Effect],
      [Effect, Bloom],
    ]) {
      const h = optionalGPU(),
        first = new First();
      h.engine.use(first);
      try {
        assert.throws(() => h.engine.use(new Second()), /capture|output target/);
      } finally {
        first.dispose();
        h.cleanup();
      }
    }
  });
}

test('DOF rejects a float32 lens overflow before redirecting the frame', () => {
  const h = optionalGPU(),
    effect = new DOF({ aperture: 1e-42 });
  h.engine.use(effect);
  const before = Object.fromEntries(
    ['color', 'depth', 'format', 'descriptor', 'shader'].map((key) => [key, h.context[key]]),
  );
  try {
    assert.throws(() => h.frame(), /lens scale/);
    for (const [key, value] of Object.entries(before)) assert.equal(h.context[key], value, key);
    effect.options.aperture = 2.8;
    h.frame();
    assert.equal(h.context.color, before.color);
  } finally {
    effect.dispose();
    h.cleanup();
  }
});

test('SSAO restores the capture attachments when scene extraction throws', () => {
  const h = optionalGPU(),
    effect = new SSAO();
  h.engine.use(effect);
  const extraction = effect.extractScene,
    failure = new Error('scene extraction failed');
  effect.extractScene = () => {
    throw failure;
  };
  const frame = () => {
    h.context.shader = wgsl;
    h.engine.frameGraph.execute(h.context);
  };
  try {
    assert.throws(frame, (error) => error === failure);
    assert.equal(h.context.color, h.originalColor);
    assert.equal(h.context.depth, h.originalDepth);
    assert.equal(h.context.format, 'bgra8unorm');
    effect.extractScene = extraction;
    frame();
    assert.equal(h.context.color, h.originalColor);
  } finally {
    effect.dispose();
    h.cleanup();
  }
});

test('Bloom retries an interrupted frame without wrapping its own draw function', () => {
  const h = optionalGPU(),
    effect = new Bloom();
  let draws = 0,
    fail = true;
  h.context.draw = () => {
    draws++;
  };
  h.engine.use(effect);
  h.engine.frameGraph.add({
    name: 'audit:draw',
    order: 0,
    execute(c) {
      c.draw();
      if (fail) throw new Error('interrupted frame');
    },
  });
  try {
    assert.throws(() => h.frame(), /interrupted frame/);
    const interruptedDraws = draws;
    fail = false;
    h.frame();
    assert.equal(draws, interruptedDraws * 2);
    assert.equal(h.context.color, h.originalColor);
    assert.equal(h.context.depth, h.originalDepth);
  } finally {
    effect.dispose();
    h.cleanup();
  }
});

test('SSAO ambient replay retains the TAA vertex camera binding without image based lighting', () => {
  const h = optionalGPU(),
    ssao = new SSAO(),
    taa = new TAA({ depth: () => ssao.depthTexture });
  const ambient = [];
  h.context.shader = wgsl;
  h.context.draw = (options) => {
    if (
      options?.pipeline?.fragment.module.code.includes(
        'return vec4f(i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb,1);',
      )
    )
      ambient.push(options);
  };
  h.engine.use(taa);
  h.engine.use(ssao);
  try {
    h.engine.frameGraph.execute(h.context);
    assert.equal(ambient.length, 1);
    const shader = ambient[0].pipeline.vertex.module.code;
    assert.match(shader, /o.clip=taaCamera\*p/);
    const binding = Number(shader.match(/@binding\((\d+)\) var<uniform> taaCamera/)[1]);
    assert.ok(ambient[0].bindings.some((entry) => entry.binding === binding));
  } finally {
    ssao.dispose();
    taa.dispose();
    h.cleanup();
  }
});

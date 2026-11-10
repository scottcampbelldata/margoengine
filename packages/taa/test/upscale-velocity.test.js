import test from 'node:test';
import assert from 'node:assert/strict';
import { TAAUpscaleVelocity } from '@margoengine/taa/upscale-velocity';
import * as root from '@margoengine/taa';
import * as upscale from '@margoengine/taa/upscale';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

function rig(options = {}) {
  const h = optionalGPU(),
    c = h.context,
    rectangles = [];
  let activeResolve;
  h.engine.store.visible = new Uint8Array(16);
  for (const method of ['beginRenderPass', 'beginComputePass']) {
    const begin = c.encoder[method];
    c.encoder[method] = (...args) => ({
      ...begin(...args),
      setViewport(...rect) {
        rectangles.push(rect);
      },
      setScissorRect() {},
      setBindGroup(_index, group) {
        assert.ok(group, 'all passes have their resources');
        if (group.entries?.some((entry) => entry.binding === 7)) activeResolve = group;
      },
    });
  }
  const effect = new TAAUpscaleVelocity({ scale: 0.5, ...options });
  h.engine.use(effect);
  return {
    ...h,
    effect,
    rectangles,
    frame(id, index = 0, viewport = [0, 0, 64, 96]) {
      const view = id === undefined ? undefined : { id, camera: c.camera, viewport, index, count: 2 };
      const camera = c.camera;
      Object.assign(c, {
        view,
        width: 128,
        height: 96,
        color: h.originalColor,
        depth: h.originalDepth,
        shader: wgsl,
        bindings: [],
      });
      h.engine.frameGraph.execute(c);
      assert.equal(c.camera, camera, 'source camera restored');
      assert.equal(c.view, view, 'output view restored');
      assert.equal(c.width, 128);
      assert.equal(c.height, 96);
      const group = activeResolve;
      return { velocity: effect.velocity, group, output: group?.entries.find((e) => e.binding === 5).resource.texture };
    },
  };
}

test('velocity upscaling is optional and validates options, GPU setup and disposal', () => {
  assert.equal(root.TAAUpscaleVelocity, undefined);
  assert.equal(upscale.TAAUpscaleVelocity, undefined);
  assert.throws(() => new TAAUpscaleVelocity({ scale: 0 }), RangeError);
  const effect = new TAAUpscaleVelocity();
  assert.throws(() => effect.setup({ hasPlugin: () => false }), /GPU/);
  assert.throws(() => effect.setup({ gpu: {}, hasPlugin: () => true }), /replaces TAA/);
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.setup({ gpu: {}, hasPlugin: () => false }), /disposed/);
});

test('each engine view resolves its own low-resolution surface motion into its own full-resolution history', async () => {
  const h = rig();
  try {
    const left = h.frame('left'),
      right = h.frame('right', 1, [64, 0, 64, 96]);
    assert.notEqual(left.output, right.output);
    assert.notEqual(left.velocity.texture, right.velocity.texture);
    for (const state of [left, right]) {
      assert.equal(state.velocity.texture.width, 32);
      assert.equal(state.velocity.texture.height, 48);
      assert.equal(state.output.width, 64);
      assert.equal(state.output.height, 96);
      assert.equal(state.group.entries.find((e) => e.binding === 7).resource.texture, state.velocity.texture);
      assert.equal(state.group.entries.find((e) => e.binding === 8).resource.texture, state.velocity.expectedDepth);
    }
    assert.ok(
      h.rectangles.some((r) => r[0] === 64 && r[2] === 64),
      'offset presentation viewport',
    );
    const counts = { ...h.counts };
    for (let i = 0; i < 5; i++) {
      h.frame('left');
      h.frame('right', 1, [64, 0, 64, 96]);
    }
    assert.equal(h.counts.textures, counts.textures, 'stable views allocate no textures');
    assert.equal(h.counts.groups, counts.groups, 'stable views allocate no groups');
    const jitter = new Float32Array(left.group.entries.find((e) => e.binding === 9).resource.buffer.data);
    assert.ok(jitter[0] !== 0 || jitter[1] !== 0, 'jitter difference accompanies surface motion');
    const current = h.frame('left');
    const uploaded = new Float32Array(current.group.entries.find((e) => e.binding === 9).resource.buffer.data);
    assert.deepEqual(
      [...current.velocity.jitter],
      [...uploaded.subarray(0, 2)],
      'public velocity reports the raster jitter used by the upscaler',
    );
    h.effect.reset();
    h.frame('left');
    assert.deepEqual(
      [...new Float32Array(left.group.entries.find((e) => e.binding === 9).resource.buffer.data)],
      [0, 0, 0, 0],
    );
    h.effect.onDeviceRestored(h.engine);
    assert.ok(left.output.destroyed && right.output.destroyed);
    h.frame('left');
  } finally {
    h.effect.dispose();
    await null;
    assert.ok(
      h.resources.every((r) => r.destroyed),
      'all per-view and motion allocations released',
    );
  }
});

test('spatial mode avoids motion work and can switch back to temporal at runtime', () => {
  const h = rig({ temporal: false });
  try {
    h.frame();
    assert.equal(h.effect.velocity, undefined);
    h.effect.options.temporal = true;
    assert.ok(h.frame().velocity.texture);
    h.effect.options.scale = 0.75;
    assert.equal(h.frame().velocity.texture.width, 96);
    h.effect.onPreUpdate(1 / 60);
    h.frame('left');
    h.effect.onPreUpdate(1 / 60);
    h.frame('left');
    h.effect.onPreUpdate(1 / 60);
  } finally {
    h.effect.dispose();
  }
});

test('velocity upscaling rethrows failed resolves, restores the view, and resets history', () => {
  const h = rig();
  try {
    h.frame('left');
    const begin = h.context.encoder.beginComputePass;
    h.context.encoder.beginComputePass = () => {
      throw new Error('injected resolve failure');
    };
    assert.throws(() => h.frame('left'), /injected resolve failure/);
    assert.equal(h.context.width, 128);
    assert.equal(h.context.view.id, 'left');
    h.context.encoder.beginComputePass = begin;
    const next = h.frame('left');
    const jitter = next.group.entries.find((e) => e.binding === 9).resource.buffer;
    assert.deepEqual([...new Float32Array(jitter.data)], [0, 0, 0, 0]);
  } finally {
    h.effect.dispose();
  }
});

test('a failed velocity pass restores the original capture targets and view before rethrowing', () => {
  const h = rig();
  try {
    const begin = h.context.encoder.beginRenderPass;
    h.context.encoder.beginRenderPass = () => {
      throw new Error('injected velocity failure');
    };
    assert.throws(() => h.frame('left'), /injected velocity failure/);
    assert.equal(h.context.color, h.originalColor);
    assert.equal(h.context.depth, h.originalDepth);
    assert.equal(h.context.width, 128);
    assert.equal(h.context.view.id, 'left');
    h.context.encoder.beginRenderPass = begin;
    assert.ok(h.frame('left').velocity);
  } finally {
    h.effect.dispose();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

function rig() {
  const h = optionalGPU(),
    c = h.context;
  h.engine.store.visible = new Uint8Array(16);
  for (const method of ['beginRenderPass', 'beginComputePass']) {
    const begin = c.encoder[method];
    c.encoder[method] = (...args) => ({
      ...begin(...args),
      setViewport() {},
      setScissorRect() {},
      setBindGroup(_index, group) {
        assert.ok(group, 'missing bind group');
      },
    });
  }
  const taa = new TAA();
  h.engine.use(taa);
  return {
    ...h,
    taa,
    frame(id, index = 0, viewport = [0, 0, c.width, c.height]) {
      c.view = { id, viewport, index, count: 2 };
      c.color = h.originalColor;
      c.depth = h.originalDepth;
      c.shader = wgsl;
      c.bindings = [];
      h.engine.frameGraph.execute(c);
      return { ...taa.gpuState, jitter: [...taa.velocity.jitter], binding: c.bindings.find((b) => b.binding === 18) };
    },
  };
}

test('TAA keeps each view history, resolve bindings and jitter sequence independent, and resets every view', async () => {
  const h = rig();
  try {
    const left = h.frame('left'),
      right = h.frame('right', 1);
    assert.deepEqual(right.jitter, [0, 0], 'another view starts without history');
    assert.notEqual(left.history, right.history);
    const again = h.frame('left');
    assert.equal(again.binding, left.binding, 'one stable camera binding per view');
    assert.notEqual(again.history, left.history, 'the view alternates its history pair');
    const counts = { ...h.counts };
    for (let i = 0; i < 12; i++) {
      h.frame('right', 1);
      h.frame('left');
    }
    assert.equal(h.counts.textures, counts.textures);
    assert.equal(h.counts.groups, counts.groups);
    h.taa.reset();
    assert.deepEqual(h.frame('left').jitter, [0, 0]);
    assert.deepEqual(h.frame('right', 1).jitter, [0, 0]);
    h.taa.onDeviceRestored(h.engine);
    assert.ok(left.history.destroyed && right.history.destroyed);
    assert.deepEqual(h.frame('left').jitter, [0, 0]);
    assert.deepEqual(h.frame('right', 1).jitter, [0, 0]);
  } finally {
    h.taa.dispose();
    await null;
    assert.ok(
      h.resources.every((r) => r.destroyed),
      'all view allocations released',
    );
  }
});

test('TAA releases the history of a view that was not drawn for a frame', () => {
  const h = rig();
  try {
    h.frame('left');
    const right = h.frame('right', 1);
    h.taa.onPreUpdate(1 / 60);
    h.frame('left');
    h.taa.onPreUpdate(0);
    assert.equal(right.history.destroyed, false, 'a pick (delta 0) keeps every view');
    h.taa.onPreUpdate(1 / 60);
    assert.ok(right.history.destroyed, 'right was not drawn in the last frame');
    assert.deepEqual(h.frame('right', 1).jitter, [0, 0], 'it starts again without history');
  } finally {
    h.taa.dispose();
  }
});

test('TAA reset restarts the raster sample sequence in every view', () => {
  const h = rig();
  const matrix = (id, index = 0) => {
    const state = h.frame(id, index);
    return [...new Float32Array(state.binding.resource.buffer.data).slice(0, 16)];
  };
  try {
    const first = matrix('left');
    matrix('left');
    const advanced = matrix('left');
    assert.notDeepEqual(advanced, first, 'the scene must have advanced its Halton phase');
    matrix('right', 1);
    matrix('right', 1);
    h.taa.reset('left');
    assert.deepEqual(matrix('left'), first, 'named reset starts at the first sample');
    assert.deepEqual(matrix('right', 1), advanced, 'named reset preserves the other view phase');
    h.taa.reset();
    assert.deepEqual(matrix('left'), first, 'global reset restarts the left view');
    assert.deepEqual(matrix('right', 1), first, 'global reset restarts the right view');
    h.taa.onDeviceRestored(h.engine);
    assert.deepEqual(matrix('left'), first, 'restoration and explicit reset use the same projection');
    assert.deepEqual(matrix('right', 1), first, 'restored views share the initial sample');
  } finally {
    h.taa.dispose();
  }
});

test('TAA previous and inverse projections use full-texture coordinates for an offset viewport', () => {
  const h = rig();
  try {
    const state = h.frame('right', 1, [64, 0, 64, 96]);
    const values = new Float32Array(state.binding.resource.buffer.data);
    const project = (offset, point) =>
      [0, 1, 2, 3].map((r) => point.reduce((sum, v, c) => sum + values[offset + c * 4 + r] * v, 0));
    const world = [0.2, -0.3, 0.5, 1],
      local = project(0, world);
    const global = [local[0] * 0.5 + local[3] * 0.5, local[1], local[2], local[3]];
    const previous = project(16, world),
      recovered = project(32, global);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(previous[i] - global[i]) < 1e-6, 'reprojection points into its own view');
      assert.ok(Math.abs(recovered[i] - world[i]) < 1e-6, 'global pixel reconstructs the original world point');
    }
  } finally {
    h.taa.dispose();
  }
});

test('TAA retries texture and bind-group failures without publishing incomplete capture resources', async () => {
  for (const method of ['createTexture', 'createBindGroup']) {
    const baseline = rig(),
      operation = baseline.engine.gpu[method];
    let total = 0;
    baseline.engine.gpu[method] = (...args) => {
      total++;
      return operation(...args);
    };
    baseline.frame('left');
    baseline.taa.dispose();
    for (let at = 1; at <= total; at++) {
      const h = rig(),
        device = h.engine.gpu,
        original = device[method];
      let calls = 0;
      device[method] = (...args) => {
        if (++calls === at) throw new Error('injected allocation failure');
        return original(...args);
      };
      try {
        assert.throws(() => h.frame('left'), /injected allocation failure/);
        device[method] = original;
        assert.deepEqual(h.frame('left').jitter, [0, 0], 'retry has no partial history');
      } finally {
        device[method] = original;
        h.taa.dispose();
        await null;
        assert.ok(
          h.resources.every((r) => r.destroyed),
          `${method} ${at} leaked a resource`,
        );
      }
    }
  }
});

test('TAA discards temporal history after a failed resolve so a retry never reprojects an unsubmitted frame', () => {
  const h = rig(),
    encoder = h.context.encoder,
    begin = encoder.beginComputePass;
  try {
    h.frame('left');
    encoder.beginComputePass = () => {
      throw new Error('injected resolve failure');
    };
    assert.throws(() => h.frame('left'), /injected resolve failure/);
    encoder.beginComputePass = begin;
    assert.deepEqual(h.frame('left').jitter, [0, 0], 'retry must seed fresh history');
  } finally {
    encoder.beginComputePass = begin;
    h.taa.dispose();
  }
});

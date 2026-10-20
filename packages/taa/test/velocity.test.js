import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA, halton } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';

/** One TAA on the recording mock, a frame driver, and every pass context it saw. */
function rig() {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      meshes: new Map(),
      stats: { drawCalls: 0 },
      removePlugin() {},
      store: { visible: new Uint8Array(1), hidden: new Uint8Array(1), parents: new Int32Array(1).fill(-1) },
    };
  const taa = new TAA();
  taa.setup(engine);
  const run = passes(taa),
    view = context(gpu, { samples: 4, shader: wgsl });
  let index = 0;
  return {
    gpu,
    taa,
    view,
    frame() {
      view.begin(index++);
      run(view.c);
      view.end();
    },
  };
}
// jitterProjection's NDC offset of frame f, in uv.
const offset = (f, w, h) => [(halton((f % 8) + 1, 2) - 0.5) / w, (halton((f % 8) + 1, 3) - 0.5) / h];

test('taa.velocity: the velocity texture, the jitter part of every vector, and the resolved frame', () => {
  const r = rig();
  assert.equal(r.taa.velocity, undefined, 'nothing before the first resolved frame');
  r.frame();
  const first = r.taa.velocity;
  assert.equal(first.texture.format, 'rg16float');
  assert.equal(first.texture, r.taa.gpuState.velocity);
  assert.equal(first.resolved, r.taa.gpuState.history, 'the frame TAA presented');
  assert.deepEqual([...first.jitter], [0, 0], 'no history: both matrices equal, no jitter difference');
  for (let f = 1; f < 12; f++) {
    r.frame();
    const v = r.taa.velocity,
      [x0, y0] = offset(f - 1, 1280, 720),
      [x1, y1] = offset(f, 1280, 720);
    assert.equal(v, first, 'one object, updated in place');
    assert.equal(v.resolved, r.taa.gpuState.history);
    assert.ok(
      Math.abs(v.jitter[0] - Math.fround(x1 - x0)) < 1e-9 && Math.abs(v.jitter[1] - Math.fround(y1 - y0)) < 1e-9,
    );
  }
  r.taa.reset();
  r.frame();
  assert.deepEqual([...r.taa.velocity.jitter], [0, 0], 'reset: no history, no jitter difference');
  r.view.state.width = 640;
  r.frame();
  assert.deepEqual([...r.taa.velocity.jitter], [0, 0], 'resize resets history');
  r.frame();
  assert.ok(r.taa.velocity.jitter[0] !== 0, 'then the difference returns, at the new size');
  r.taa.dispose();
  assert.equal(r.taa.velocity, undefined);
});

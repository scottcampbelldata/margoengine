import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA, halton } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { objectVelocity } from '../src/shader.ts';

/** One TAA on the recording mock, a frame driver, and every pass context it saw. */
function rig(options, samples = 4) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      meshes: new Map(),
      stats: { drawCalls: 0 },
      sceneOf() {
        return undefined;
      },
      removePlugin() {},
      store: { visible: new Uint8Array(1), hidden: new Uint8Array(1), parents: new Int32Array(1).fill(-1) },
    };
  const taa = new TAA(options);
  taa.setup(engine);
  const run = passes(taa),
    view = context(gpu, { samples, shader: wgsl });
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

test('object velocity cuts with the opacity map and leaves vertex alpha out on request', () => {
  const plain = objectVelocity(true, true);
  assert.doesNotMatch(plain, /margoOpacity/);
  assert.match(plain, /o\.alpha=i\.color\.a;/);
  const cut = objectVelocity(true, true, true, true);
  assert.match(cut, /@binding\(5\) var<uniform> margoOpacity/, 'binding 4 is the camera');
  assert.match(cut, /\.a\*margoOpacityAt\(i\.uv\)\*\(1\.0-i\.alpha\)\*f\.alpha\.x/);
  assert.match(cut, /o\.alpha=1\.0-\(1\.0\);/);
});

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

test('velocityOnly: motion vectors with no jitter, capture, history or resolve', () => {
  const stackDepth = { width: 1280, height: 720, format: 'depth24plus', usage: 4, createView: () => ({}) },
    r = rig({ velocityOnly: true, depth: () => stackDepth }, 1);
  const log = r.gpu.record(() => r.frame());
  assert.doesNotMatch(r.view.c.shader, /taaCamera/, 'the scene shader keeps its own camera');
  const made = log.filter((c) => c[0] === 'texture');
  assert.equal(made.filter((c) => c[2].format === 'rg16float').length, 1, 'one velocity target');
  assert.equal(made.filter((c) => c[2].format === 'r32float').length, 1, 'expected depth, and no history depths');
  assert.deepEqual(
    made.filter((c) => c[2].usage & 8),
    [],
    'no storage textures: no history',
  );
  assert.ok(!log.some((c) => c[0] === 'beginComputePass'), 'no history resolve');
  for (let f = 0; f < 3; f++) r.frame();
  const v = r.taa.velocity;
  assert.equal(v.texture.format, 'rg16float');
  assert.equal(v.resolved, undefined, 'MotionBlur then blurs inside the PostStack');
  assert.deepEqual([...v.jitter], [0, 0]);
  assert.throws(() => r.taa.gpuState, { name: 'MargoError', code: 'state' });
});

test('velocityOnly needs depth and a boolean', () => {
  assert.throws(() => new TAA({ velocityOnly: true }), /pass depth/);
  assert.throws(() => new TAA({ velocityOnly: 1, depth: () => undefined }), /true or false/);
  assert.doesNotThrow(() => new TAA({ velocityOnly: false }));
});

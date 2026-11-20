// KB-TAA-CLAMP1: the resolve fetches history by the motion alone. The velocity buffer holds the jitter difference
// between this frame and the history frame as well as the motion (taa.velocity's contract), so the resolve uniform
// carries that difference and every resolve variant adds it back; a still view then reads its history at the same
// pixel instead of a bilinear tap up to 0.8 px away, which blurred it every frame. GPU proof: converge-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { halton } from '../src/jitter.ts';
import { resolve, stochasticResolve, reactiveResolve, varianceResolve, lockResolve } from '../src/shader.ts';

test('every resolve variant fetches history by the motion alone', () => {
  const fetch =
    /let uv=\(vec2f\(id\.xy\)\+0\.5\)\/vec2f\(size\)-textureLoad\(velocity,(p|moved),0\)\.xy\+temporal\.offset\.xy;/;
  assert.match(resolve, /struct Temporal \{[^}]*settings:vec4f,offset:vec4f\}/);
  for (const base of [resolve, stochasticResolve()])
    for (const code of [base, reactiveResolve(base), varianceResolve(base), lockResolve(varianceResolve(base))]) {
      assert.match(code, fetch);
      assert.equal(code.split('textureLoad(velocity,').length, 2, 'one velocity read, taken back by the jitter');
    }
});

test('the resolve uniform carries the jitter difference that taa.velocity reports', () => {
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
  const taa = new TAA();
  taa.setup(engine);
  const run = passes(taa),
    view = context(gpu, { samples: 1, shader: wgsl });
  const offsets = [];
  for (let index = 0; index < 3; index++) {
    const log = gpu.record(() => {
      view.begin(index);
      run(view.c);
      view.end();
    });
    const block = log.find((c) => c[0] === 'writeBuffer' && c[3].length === 56 * 8);
    assert.ok(block, 'one 224-byte resolve uniform a frame');
    const values = new Float32Array(Uint8Array.from(Buffer.from(block[3], 'hex')).buffer);
    offsets.push([values[52], values[53]]);
  }
  const { width, height } = view.c,
    jitter = (i) => [(halton(i + 1, 2) - 0.5) / width, (halton(i + 1, 3) - 0.5) / height];
  // The first frame has no history and no difference; then this phase's offset minus the last one's, in uv.
  assert.deepEqual(offsets[0], [0, 0]);
  for (const i of [1, 2])
    for (const axis of [0, 1])
      assert.ok(
        Math.abs(offsets[i][axis] - (jitter(i)[axis] - jitter(i - 1)[axis])) < 1e-7,
        `frame ${i} axis ${axis}: ${offsets[i][axis]}`,
      );
});

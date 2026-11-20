// Still-view settling (KB-TAA-STILL1, src/settle.ts) on the mock GPU: what it allocates, when it counts a frame as
// still, and how it patches every resolve variant. packages/taa/test/still-browser.mjs measures it on a real GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { TAAUpscale } from '../dist/upscale.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { resolve, stochasticResolve, reactiveResolve, varianceResolve, lockResolve } from '../src/shader.ts';
import { settleResolve } from '../src/settle.ts';

function rig(Effect, options) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      meshes: new Map(),
      stats: { drawCalls: 0 },
      sceneOf() {
        return undefined;
      },
      hasPlugin: () => false,
      removePlugin() {},
      store: { visible: new Uint8Array(1), hidden: new Uint8Array(1), parents: new Int32Array(1).fill(-1) },
    };
  const effect = new Effect(options);
  effect.setup(engine);
  const run = passes(effect),
    view = context(gpu, { samples: 1, shader: wgsl, width: 96, height: 64 });
  return {
    gpu,
    effect,
    // `at` picks the camera: the same value twice is a still camera.
    frame(at) {
      view.begin(at);
      run(view.c);
      view.end();
    },
  };
}
const textures = (log) => log.filter((c) => c[0] === 'texture').map((c) => c[2]);

test('settleResolve adds the footprint count and the mean before the output store of every resolve variant', () => {
  const variants = [
    resolve,
    stochasticResolve(),
    reactiveResolve(resolve),
    varianceResolve(resolve),
    lockResolve(resolve),
    lockResolve(varianceResolve(reactiveResolve(stochasticResolve()))),
  ];
  for (const code of variants) {
    const settled = settleResolve(code, 'p', 'vec2i(size)-1');
    assert.match(settled, /@group\(1\) @binding\(3\) var settleOutput:texture_storage_2d<rgba16float,write>;/);
    assert.equal(settled.split('result=settled(p,settleFrames,current,result);textureStore(output,p,').length, 2);
    assert.match(settled, /settleFrames=min\(settleFrames,textureLoad\(settleWords,clamp\(p\+vec2i\(sx,sy\)/);
    assert.doesNotMatch(code, /settle/, 'the variants themselves are unchanged');
  }
  assert.throws(() => settleResolve('fn main(){}', 'p', 'top'), /settle patch target missing/);
});

test('a reactive pixel never settles: the share the blend takes from history also zeroes its matched frames', () => {
  for (const code of [reactiveResolve(resolve), lockResolve(varianceResolve(reactiveResolve(stochasticResolve())))]) {
    const settled = settleResolve(code, 'p', 'vec2i(size)-1');
    assert.match(code, /var reactAll=react;/, 'the mask share at pixel scope');
    assert.match(code, /reactAll=max\(react,oldReact\/total\);/, 'now or last frame, as the blend reads it');
    assert.equal(
      settled.split('settleFrames=select(settleFrames,0u,reactAll>0.0);result=settled(p,settleFrames,').length,
      2,
      'before the mean is chosen',
    );
  }
  for (const code of [resolve, stochasticResolve(), varianceResolve(resolve), lockResolve(resolve)])
    assert.doesNotMatch(settleResolve(code, 'p', 'vec2i(size)-1'), /reactAll/, 'no mask, no change');
});

test('TAA settles by default: hash slots, a word, two means and a 16-byte uniform; settle false makes none', () => {
  const on = rig(TAA, {}),
    log = on.gpu.record(() => on.frame(0)),
    made = textures(log);
  const slots = made.find((t) => t.format === 'r32uint' && t.size[2] === 3);
  assert.ok(slots, '8 phases, three hashes a word: 3 layers');
  assert.deepEqual(slots.size, [96, 64, 3]);
  assert.equal(made.filter((t) => t.format === 'r32uint').length, 2, 'the slots and this frame word');
  assert.equal(made.filter((t) => t.label?.startsWith('TAA settle mean')).length, 2);
  assert.ok(log.some((c) => c[0] === 'copyTextureToTexture'), 'the word goes back into its slot');
  const off = rig(TAA, { settle: false }),
    plain = off.gpu.record(() => off.frame(0));
  assert.equal(textures(plain).filter((t) => t.format === 'r32uint' || t.label?.startsWith('TAA settle')).length, 0);
  assert.ok(!plain.some((c) => c[0] === 'copyTextureToTexture'));
  assert.throws(() => new TAA({ settle: 1 }), TypeError);
  on.effect.dispose();
  off.effect.dispose();
});

test('a frame counts as still only with history and the camera exactly as last frame', () => {
  const h = rig(TAA, {}),
    values = () => [...h.effect.settle.values];
  h.frame(0);
  assert.deepEqual(values(), [0, 8, 0, 7], 'the first frame has no history');
  h.frame(0);
  assert.deepEqual(values(), [1, 8, 1, 0], 'phase 1 of 8, still, the last phase 0');
  h.frame(1);
  assert.equal(values()[2], 0, 'the camera moved');
  h.frame(1);
  assert.equal(values()[2], 1);
  h.effect.reset();
  h.frame(1);
  assert.deepEqual(values(), [0, 8, 0, 7], 'a reset starts again with no history');
  h.effect.dispose();
});

test('TAAUpscale keeps a hash per phase at render size and the means at output size', () => {
  const h = rig(TAAUpscale, { scale: 0.5 }),
    made = textures(h.gpu.record(() => h.frame(0)));
  // 0.5: 32 phases, ceil(32 / 3) = 11 slot layers of the 48 x 32 render size.
  assert.deepEqual(made.find((t) => t.format === 'r32uint' && t.size.length === 3).size, [48, 32, 11]);
  for (const mean of made.filter((t) => t.label?.startsWith('TAA settle mean'))) assert.deepEqual(mean.size, [96, 64]);
  h.frame(0);
  assert.deepEqual([...h.effect.settle.values], [1, 32, 1, 0]);
  h.effect.dispose();
  assert.throws(() => new TAAUpscale({ settle: 'yes' }), RangeError);
  const off = rig(TAAUpscale, { scale: 0.5, settle: false });
  assert.ok(!textures(off.gpu.record(() => off.frame(0))).some((t) => t.format === 'r32uint'));
  off.effect.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { resolve, stochasticResolve, reactiveResolve } from '../src/shader.ts';

function rig(options) {
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
    view = context(gpu, { samples: 1, shader: wgsl });
  let index = 0;
  return {
    gpu,
    taa,
    frame() {
      view.begin(index++);
      run(view.c);
      view.end();
    },
  };
}
// The resolve groups of a frame: the bind groups with ten entries (binding 9 is the mask).
const resolveGroups = (log) => log.filter((c) => c[0] === 'group' && c[2].entries.length === 10);

test('reactiveResolve takes the mask share away from the history weight, and only when asked', () => {
  for (const code of [resolve, stochasticResolve()]) {
    const masked = reactiveResolve(code);
    assert.doesNotMatch(code, /reactiveMask/, 'without the option the resolve is the same shader');
    assert.match(masked, /@group\(0\) @binding\(9\) var reactiveMask:texture_2d<f32>;/);
    assert.match(masked, /temporal\.settings\.x\*\(1\.0-max\(react,oldReact\/total\)\)\);/, 'now or last frame');
    assert.match(
      masked,
      /clamp\(textureLoad\(reactiveMask,[^;]+\.r,0\.0,1\.0\)/,
      'a mask value outside 0 to 1 is clamped',
    );
    assert.match(masked, /oldReact\+=h\.a\*weight;/, 'the last mask comes back through the accepted history taps');
    assert.match(masked, /textureStore\(output,p,vec4f\(max\(result,vec3f\(0\)\),react\)\);/, 'and is kept in alpha');
    assert.equal(masked.split('reactiveMask').length - 1, 3, 'declared once, sized once, read once');
  }
  assert.throws(() => reactiveResolve('fn main(){}'), /patch target missing/);
});

test('a reactive TAA binds the mask at binding 9, a black 1 by 1 one when it returns undefined', () => {
  let mask;
  const r = rig({ reactive: () => mask });
  let log = r.gpu.record(() => r.frame());
  const black = log.find((c) => c[0] === 'texture' && c[2].format === 'r8unorm');
  assert.ok(black, 'a 1 by 1 r8unorm stand-in');
  assert.deepEqual(black[2].size, [1, 1]);
  assert.equal(resolveGroups(log).length, 2, 'both history directions');
  log = r.gpu.record(() => r.frame());
  assert.equal(resolveGroups(log).length, 0, 'the same mask keeps its groups');
  mask = r.gpu.device.createTexture({ size: [320, 180], format: 'r8unorm', usage: 4 });
  log = r.gpu.record(() => r.frame());
  const groups = resolveGroups(log);
  assert.equal(groups.length, 2, 'a new mask texture rebuilds the groups');
  assert.ok(!log.some((c) => c[0] === 'texture' && c[2].format === 'r8unorm'), 'no new stand-in');
  log = r.gpu.record(() => r.frame());
  assert.equal(resolveGroups(log).length, 0);
  mask = undefined;
  log = r.gpu.record(() => r.frame());
  assert.equal(resolveGroups(log).length, 2, 'back to the stand-in');
  mask = r.gpu.device.createTexture({ size: [4, 4], format: 'depth24plus', usage: 4 });
  assert.throws(() => r.frame(), { name: 'MargoError', message: /TEXTURE_BINDING usage/ });
  r.taa.dispose();
});

test('a TAA without reactive compiles and binds what it did before', () => {
  const r = rig({});
  const log = r.gpu.record(() => r.frame());
  assert.equal(resolveGroups(log).length, 0);
  assert.equal(log.filter((c) => c[0] === 'group' && c[2].entries.length === 9).length, 2);
  assert.ok(!log.some((c) => c[0] === 'module' && /reactiveMask/.test(c[2].code)));
  assert.ok(!log.some((c) => c[0] === 'texture' && c[2].format === 'r8unorm'));
});

test('reactive takes a function, and not with velocityOnly', () => {
  assert.throws(() => new TAA({ reactive: {} }), /pass a function/);
  assert.throws(() => new TAA({ reactive: () => undefined, velocityOnly: true, depth: () => undefined }), /no effect/);
  assert.doesNotThrow(() => new TAA({ reactive: () => undefined, stochastic: true }));
});

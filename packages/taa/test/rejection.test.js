import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { resolve, stochasticResolve, reactiveResolve, varianceResolve, lockResolve } from '../src/shader.ts';

function rig(options) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      meshes: new Map(),
      stats: { drawCalls: 0 },
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

test('varianceResolve clips toward the centre of mean +- gamma sigma cut to the min/max box', () => {
  for (const code of [resolve, stochasticResolve(), reactiveResolve(resolve)]) {
    const clipped = varianceResolve(code);
    assert.match(clipped, /fn clipHistory\(/);
    assert.match(clipped, /m1\+=sample;m2\+=sample\*sample;/, 'the moments over the same nine samples as the box');
    assert.match(clipped, /\*temporal\.settings\.w;let a=max\(lo,mean-sigma\);let b=min\(hi,mean\+sigma\);/);
    assert.match(clipped, /clipHistory\(ycocg\(old\/total\),lo,hi,m1,m2\)/);
    assert.doesNotMatch(clipped, /clamp\(ycocg\(old\/total\),lo,hi\)/);
  }
  assert.throws(() => varianceResolve('fn main(){}'), /patch target missing/);
});

test('lockResolve keeps history unclipped while a thin-feature lock lasts', () => {
  for (const code of [resolve, varianceResolve(resolve), reactiveResolve(stochasticResolve())]) {
    const locked = lockResolve(code);
    assert.match(locked, /@binding\(10\) var lockHistory:texture_2d<f32>;/);
    assert.match(locked, /@binding\(11\) var lockOutput:texture_storage_2d<r32float,write>;/);
    assert.match(locked, /select\((clamp|clipHistory)\(ycocg\(old\/total\),lo,hi(,m1,m2)?\),ycocg\(old\/total\),lock>0\.0\)/);
    assert.match(locked, /lock=max\(lock,lockOld-0\.125\)/, 'eight frames, the Halton cycle');
    assert.match(locked, /textureStore\(lockOutput,p,vec4f\(lock\)\);/);
    assert.equal(/reactiveMask/.test(code), /\(1\.0-max\(react,oldReact\/total\)\)/.test(locked), 'reactive drops locks');
  }
  assert.throws(() => lockResolve('fn main(){}'), /patch target missing/);
});

test('locks add two r32float storage textures and bind them at 10 and 11; variance only changes the shader', () => {
  const plain = rig({}),
    plainLog = plain.gpu.record(() => plain.frame()),
    storage = (log) => log.filter((c) => c[0] === 'texture' && c[2].usage & 8);
  const locks = rig({ locks: true }),
    log = locks.gpu.record(() => locks.frame());
  assert.equal(storage(log).length, storage(plainLog).length + 2);
  const groups = log.filter((c) => c[0] === 'group' && c[2].entries.some((e) => e.binding === 11));
  assert.equal(groups.length, 2, 'both history directions');
  assert.ok(groups.every((g) => !g[2].entries.some((e) => e.binding === 9)), 'no mask binding without reactive');
  assert.ok(log.some((c) => c[0] === 'module' && /lockOutput/.test(c[2].code)));
  const variance = rig({ rejection: 'variance' }),
    varianceLog = variance.gpu.record(() => variance.frame());
  assert.equal(storage(varianceLog).length, storage(plainLog).length);
  assert.ok(varianceLog.some((c) => c[0] === 'module' && /clipHistory/.test(c[2].code)));
  assert.ok(!plainLog.some((c) => c[0] === 'module' && /clipHistory|lockOutput/.test(c[2].code)), 'defaults unchanged');
  const both = rig({ reactive: () => undefined, locks: true }),
    bothLog = both.gpu.record(() => both.frame());
  const full = bothLog.filter((c) => c[0] === 'group' && c[2].entries.length === 12);
  assert.equal(full.length, 2, 'mask at 9, locks at 10 and 11');
});

test('rejection, clipGamma and locks are checked', () => {
  assert.throws(() => new TAA({ rejection: 'aabb' }), /'clamp' or 'variance'/);
  assert.throws(() => new TAA({ clipGamma: 0.2 }), /0\.5 to 4/);
  assert.throws(() => new TAA({ clipGamma: Number.NaN }), /0\.5 to 4/);
  assert.throws(() => new TAA({ locks: 'yes' }), /true or false/);
  assert.doesNotThrow(() => new TAA({ rejection: 'variance', clipGamma: 1, locks: true, stochastic: true }));
});

// Regression: clipGamma was written into the resolve uniform for every TAA, so the default made different GPU calls
// than before the option (examples/package-benchmarks/proofs/taa-velocity.proof.js).
test('only variance clipping writes clipGamma into the resolve uniform', () => {
  const gammaOf = (options) => {
    const r = rig(options),
      log = r.gpu.record(() => r.frame()),
      block = log.find((c) => c[0] === 'writeBuffer' && c[3].length === 52 * 8);
    return new Float32Array(Uint8Array.from(Buffer.from(block[3], 'hex')).buffer)[51];
  };
  assert.equal(gammaOf({}), 0);
  assert.equal(gammaOf({ locks: true, clipGamma: 2 }), 0);
  assert.equal(gammaOf({ rejection: 'variance' }), 1.25);
  assert.equal(gammaOf({ rejection: 'variance', clipGamma: 2 }), 2);
});

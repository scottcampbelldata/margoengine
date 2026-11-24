// The imposter entry: lod's imposter shader reads scatter's far ring (no matrix buffer), the colour pass skips the far
// ring's mesh while the imposter can draw and draws it again once the imposter is disposed, the strip's instance count
// is the far ring's draw count copied on the GPU, and the options are checked. The pixels are proved on a GPU in
// imposter.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Imposter, imposterShader } from '@margoengine/lod';
import { Scatter } from '../dist/index.js';
import { ImposterScatter, imposterRingCode } from '../dist/imposter.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const atlas = (h) => {
  const frames = 4,
    frameSize = 16,
    size = frames * frameSize;
  return Imposter.fromData(h.engine, {
    frames,
    frameSize,
    center: [0, 0.5, 0],
    radius: 0.9,
    shading: 'core',
    color: new Uint8Array(size * size * 4),
    normal: new Uint16Array(size * size * 4),
  });
};

test('imposterRingCode reads the scatter ring in place of the matrix buffer and keeps the fade mask', () => {
  const code = imposterRingCode(imposterShader);
  assert.match(code, /@group\(0\) @binding\(1\) var<storage,read> ring:array<ScatterInstance>;/);
  assert.doesNotMatch(code, /var<storage,read> instances:/);
  assert.doesNotMatch(code, /instances\[/);
  assert.ok(code.includes('let m=scatterInstance(id).m;'), 'the vertex stage');
  assert.ok(code.includes('let instance=scatterInstance(i.id);'), 'the fragment stage');
  assert.ok(code.includes('fn scatterTurn(') && code.includes('fn scatterGround('), "the mesh pose's turn");
  assert.ok(code.includes('fn lodVisible('));
  const fragment = code.slice(code.indexOf('@fragment fn fragment('));
  assert.match(fragment, /^@fragment fn fragment\(i:Out\)->Pixel \{\n if\(!lodVisible\(i\.clip\.xy,ring\[i\.id\]\.rotation\.zw\)\)\{discard;\}/);
  assert.throws(() => imposterRingCode('@vertex fn vertex(){}'), TypeError);
  assert.throws(() => imposterRingCode(imposterRingCode(imposterShader)), TypeError);
});

test('the far ring draws as one imposter strip while the imposter can draw, and as its mesh after', () => {
  const h = optionalGPU(),
    imposter = atlas(h),
    effect = new ImposterScatter(box(), { count: 64, imposter });
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0]) };
  h.engine.use(effect);
  h.frame();
  const strip = h.pipelines.find((p) => p.vertex?.module.code.includes('fn scatterInstance('));
  assert.ok(strip, 'the imposter pipeline');
  assert.equal(strip.primitive.topology, 'triangle-strip');
  // Two ring meshes indexed indirect, then the strip's indirect draw.
  assert.equal(h.counts.indirect, 3);
  // Ring 2's instance count (byte 44 of the commands) lands in word 1 of the strip's four-vertex draw.
  const commands = new Uint32Array(effect.commands.data);
  commands[11] = 37;
  h.frame();
  const indirect = h.resources.find((b) => b.size === 16 && b.data && new Uint32Array(b.data)[0] === 4);
  assert.ok(indirect, 'the strip command');
  assert.deepEqual([...new Uint32Array(indirect.data)], [4, 37, 0, 0]);
  imposter.dispose();
  const before = h.counts.indirect;
  h.frame();
  assert.equal(h.counts.indirect - before, 3, 'three ring meshes, no strip');
  effect.dispose();
});

test('a plain Scatter draws all three ring meshes; ImposterScatter checks its imposter', () => {
  const h = optionalGPU(),
    plain = new Scatter(box(), { count: 64 });
  h.engine.use(plain);
  h.frame();
  assert.equal(h.counts.indirect, 3);
  assert.ok(!h.pipelines.some((p) => p.vertex?.module.code.includes('fn scatterInstance(')));
  plain.dispose();
  assert.throws(() => new ImposterScatter(box(), {}), TypeError);
  assert.throws(() => new ImposterScatter(box()), TypeError);
  assert.throws(() => new ImposterScatter(box(), { imposter: {} }), /Imposter\.bake/);
});

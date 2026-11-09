// The interact entry: every posing vertex stage (unlit, lit, shadow and the shadow list) reads the push field at the
// binding after its own and turns the instance after its own turn, before the wind; the update kernel runs before the
// distribute pass; options and interactors are checked. The pixels and the field's maths are proved on a GPU in
// interact.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { Scatter } from '../dist/index.js';
import { TrampledScatter, trampledPoseCode, trampleCode } from '../dist/interact.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const vertexCodes = (h) =>
  h.pipelines.filter((p) => p.vertex).map((p) => p.vertex.module.code).filter((c) => c.includes('fn scatterPose('));

test('each posing stage reads the field after its own bindings and turns after the instance turn', () => {
  for (const [options, group] of [
    [{}, 0],
    [{ material: new PbrMaterial({ color: [0.3, 0.6, 0.2] }) }, 1],
  ]) {
    const h = optionalGPU(),
      effect = new TrampledScatter(box(), { count: 64, ...options });
    // The lit stage is core's shader with scatter's vertex, under the standard lighting.
    h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0]) };
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.use(effect);
    // Not h.frame(), which puts its own stand-in shader back.
    h.engine.frameGraph.execute(h.context);
    const pass = h.context.encoder.beginRenderPass({});
    effect.drawShadow({ context: h.context, pass, matrix: h.context.camera.matrix, cascade: 0 });
    effect.prepareShadow({ context: h.context, matrices: new Float32Array(16), cascades: 1 });
    effect.drawShadow({ context: h.context, pass, matrix: h.context.camera.matrix, cascade: 0 });
    const codes = vertexCodes(h);
    assert.equal(codes.length, 3, 'colour, shadow and shadow list');
    const [colour, shadow, list] = codes;
    assert.match(colour, new RegExp(`@group\\(${group}\\) @binding\\(2\\) var<storage,read> trample:array<vec2f>;`));
    assert.match(shadow, /@group\(0\) @binding\(2\) var<storage,read> trample:array<vec2f>;/);
    assert.match(list, /@group\(0\) @binding\(3\) var<storage,read> trample:array<vec2f>;/);
    for (const code of codes) {
      // Inside scatterPose: the wind helpers above it have their own windBend line.
      const at = code.indexOf('fn scatterPose('),
        push = code.indexOf('let push=tramplePush(position.xz);', at);
      assert.ok(push > code.indexOf('var world=scatterTurn(', at), 'after the instance turn');
      assert.ok(push < code.indexOf('let bend=windBend(', at), 'before the wind');
      assert.ok(code.includes('windNormal(trampleTurn(scatterTurn(n,c,s,up),push),bend,wind)'));
    }
    const update = h.pipelines.find((p) => p.compute?.module.code.includes('var<storage,read> movers'));
    assert.ok(update, 'the update kernel');
    effect.dispose();
  }
});

test('a plain Scatter keeps its vertex stages; trampleCode and trampledPoseCode check their input', () => {
  const h = optionalGPU(),
    plain = new Scatter(box(), { count: 64 });
  h.engine.use(plain);
  h.frame();
  for (const code of vertexCodes(h)) assert.doesNotMatch(code, /trample/);
  plain.dispose();
  assert.match(trampleCode(1, 4), /@group\(1\) @binding\(4\)/);
  assert.throws(() => trampledPoseCode('@vertex fn vertex(){}', 0, 2), TypeError);
});

test('options and interactors are checked; the field is made with the first frame', () => {
  const g = box();
  for (const bad of [{ size: 0 }, { resolution: 7 }, { resolution: 9.5 }, { recover: 0 }, { bend: 2 }, { bend: 0 }])
    assert.throws(() => new TrampledScatter(g, {}, bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new TrampledScatter(g, {}, null), TypeError);
  const h = optionalGPU(),
    effect = new TrampledScatter(g, { count: 64 }, { resolution: 16 });
  assert.equal(effect.field, undefined);
  assert.equal(effect.setInteractors([{ position: [0, 0, 0], radius: 1 }]), effect);
  assert.throws(() => effect.setInteractors([{ position: [0, 0], radius: 1 }]), TypeError);
  assert.throws(() => effect.setInteractors([{ position: [0, Number.NaN, 0], radius: 1 }]), RangeError);
  assert.throws(() => effect.setInteractors([{ position: [0, 0, 0], radius: 0 }]), RangeError);
  assert.throws(() => effect.setInteractors([{ position: [0, 0, 0], radius: 1, strength: 2 }]), RangeError);
  assert.throws(() => effect.setInteractors('feet'), RangeError);
  effect.setInteractors(Array.from({ length: 40 }, (_, i) => ({ position: [i, 0, 0], radius: 1 })));
  h.engine.use(effect);
  h.frame();
  assert.equal(effect.field.size, (3 + 16 * 16) * 8);
  effect.onPreUpdate(0.5);
  h.frame();
  effect.dispose();
  assert.equal(effect.field, undefined);
});

test('interaction uploads height and samples the same validated terrain and world rectangle as placement', () => {
  const h = optionalGPU();
  let texture = h.engine.gpu.createTexture({ size: [2, 2], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
  let reads = 0;
  const effect = new TrampledScatter(box(), {
    count: 64, center: [3, 2, -5], bounds: [-8, -8, 8, 8],
    heightmap: () => { reads++; return texture; },
  });
  try {
    effect.setInteractors([{ position: [1, 7, -2], radius: 3, strength: 0.6 }]);
    h.engine.use(effect);
    h.frame();
    assert.equal(reads, 1, 'one heightmap snapshot serves both field and placement');
    const kernel = h.pipelines.find((p) => p.compute?.module.code.includes('var<storage,read> movers'));
    assert.match(kernel.compute.module.code, /surface-m.xyz/);
    const bound = h.groups.find((g) => g.entries[4]?.resource.texture === texture);
    assert.ok(bound, 'the interaction compute pass reads the terrain texture');
    const uniform = new Float32Array(bound.entries[0].resource.buffer.data);
    assert.equal(uniform[9], 2, 'the same height offset as placement');
    assert.deepEqual([...uniform.slice(12, 16)], [-8, -8, 8, 8]);
    const mover = new Float32Array(bound.entries[3].resource.buffer.data);
    assert.deepEqual([...mover.slice(0, 4)], [1, 7, -2, 3], 'the interactor retains Y');
    assert.equal(mover[4], Math.fround(0.6));
    texture = h.engine.gpu.createTexture({ size: [2, 2], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    h.frame();
    assert.equal(reads, 2);
    assert.ok(h.groups.some((g) => g.entries[4]?.resource.texture === texture), 'a replacement map rebinds');
  } finally {
    effect.dispose();
    h.cleanup();
  }
});

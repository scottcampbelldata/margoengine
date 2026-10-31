import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { soft } from '../dist/soft.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const depthTexture = (o = {}) => ({
  format: 'depth32float',
  dimension: '2d',
  width: 64,
  height: 64,
  usage: 4,
  sampleCount: 1,
  createView: (d) => ({ view: d }),
  ...o,
});
const attach = (options, Class = VFX, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  h.context.width = h.context.height = 64;
  const effect = features ? new Class(options, features) : new Class(options);
  h.engine.use(effect);
  return { h, effect };
};
const billboards = (h) => h.pipelines.filter((p) => p.fragment).map((p) => p.vertex.module.code);

test('softness is off by default: the billboard WGSL, bindings and bytes are the ones without the option', () => {
  const { h } = attach({ capacity: 8 });
  h.frame();
  const [plain] = billboards(h);
  assert.doesNotMatch(plain, /soft|sceneDepth|viewDepth/i);
  assert.ok(!h.groups.some((g) => g.entries.some((e) => e.binding === 11 || e.binding === 12)));
  const withZero = attach({ capacity: 8, softness: 0, depth: () => undefined });
  withZero.h.frame();
  assert.equal(billboards(withZero.h)[0], plain, 'softness 0 is the same shader');
});

test('softness patches only the billboard, binds the depth and fades by the view-axis gap', () => {
  const depth = depthTexture(),
    { h } = attach({ capacity: 8, softness: 0.5, depth: () => depth });
  h.frame();
  const code = billboards(h)[0];
  assert.match(code, /@location\(6\) viewDepth:f32/);
  assert.match(code, /texture_depth_2d/);
  assert.match(code, /clamp\(gap\/soft\.softness\.x,0\.0,1\.0\)/);
  assert.match(code, /if\(d<=0\.0\)\{return c;\}/, 'empty depth leaves the particle alone');
  const group = h.groups.findLast((g) => g.entries.some((e) => e.binding === 12)),
    buffer = group.entries.find((e) => e.binding === 11).resource.buffer;
  assert.deepEqual(group.entries.find((e) => e.binding === 12).resource, { view: { aspect: 'depth-only' } });
  assert.equal(buffer.size, 112);
  assert.equal(new Float32Array(buffer.data)[24], 0.5, 'softness is in the uniform');
});

test('softness follows the scene sample count: a multisampled depth takes the nearest sample', () => {
  const { h } = attach({ capacity: 8, softness: 1, depth: () => depthTexture({ sampleCount: 4 }) });
  h.context.descriptor.multisample = { count: 4 };
  h.frame();
  const code = billboards(h).at(-1);
  assert.match(code, /texture_depth_multisampled_2d/);
  assert.match(code, /d=max\(d,textureLoad\(sceneDepth,at,s\)\)/);
});

test('a changed softness is a new uniform value, not a new shader; a new depth texture rebinds', () => {
  let depth = depthTexture();
  const { h, effect } = attach({ capacity: 8, softness: 0.5, depth: () => depth });
  h.frame();
  const count = h.pipelines.length,
    groups = h.groups.length;
  effect.options.softness = 2;
  h.frame();
  assert.equal(h.pipelines.length, count);
  const buffer = h.groups.findLast((g) => g.entries.some((e) => e.binding === 11)).entries.find((e) => e.binding === 11)
    .resource.buffer;
  assert.equal(new Float32Array(buffer.data)[24], 2);
  depth = depthTexture();
  h.frame();
  assert.ok(h.groups.length > groups, 'the bind group is rebuilt for the new texture');
  effect.options.softness = 0;
  h.frame();
  assert.equal(h.pipelines.length, count + 1, 'switching off compiles the plain pipeline once');
  h.frame();
  effect.options.softness = 1;
  h.frame();
  assert.equal(h.pipelines.length, count + 1, 'switching on again reuses the soft pipeline');
});

test('softness errors name the fix', () => {
  assert.throws(
    () => new VFX({ softness: -1, depth: () => undefined }),
    /softness must be a world distance of 0 or more/,
  );
  assert.throws(() => new VFX({ softness: Number.NaN, depth: () => undefined }), RangeError);
  assert.throws(() => new VFX({ softness: 0.5 }), /needs scene depth: add DepthTexture/);
  assert.throws(() => new VFX({ depth: 3 }), /depth must be a function/);
  assert.throws(
    () => new Base({ softness: 0.5, depth: () => undefined }),
    /softness needs soft from @margoengine\/vfx\/soft/,
  );
  assert.doesNotThrow(() => new Base({ softness: 0.5, depth: () => undefined }, { soft }));
});

test('no depth available is a coded error at draw time; a depth that cannot be sampled is a RangeError', () => {
  const { h } = attach({ capacity: 8, softness: 0.5, depth: () => undefined });
  assert.throws(
    () => h.frame(),
    (e) => e.code === 'state' && /DepthTexture/.test(e.message),
  );
  for (const wrong of [{ width: 32 }, { usage: 0 }, { format: 'rgba8unorm' }, { sampleCount: 2 }]) {
    const { h: g } = attach({ capacity: 8, softness: 0.5, depth: () => depthTexture(wrong) });
    assert.throws(() => g.frame(), RangeError, JSON.stringify(wrong));
  }
});

test('the uniform holds the inverse view-projection, the view-axis plane and the view rectangle', () => {
  const { h, effect } = attach({ capacity: 8, softness: 1, depth: () => depthTexture() });
  h.context.camera.matrix = new Float32Array([2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  h.context.camera.position = [0, 0, 5];
  h.context.camera.target = [0, 0, 0];
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {}, setScissorRect() {} });
  h.context.view = { id: 'a', viewport: [8, 16, 32, 24], index: 0, count: 1 };
  h.frame();
  const buffer = h.groups.findLast((g) => g.entries.some((e) => e.binding === 11)).entries.find((e) => e.binding === 11)
      .resource.buffer,
    v = new Float32Array(buffer.data);
  assert.deepEqual(
    [...v.subarray(0, 16)].filter((x) => x),
    [0.5, 0.25, 1, 1],
  );
  // Looking down -z from z = 5: depth along the view axis is 5 - z.
  assert.deepEqual(
    [...v.subarray(16, 20)].map((x) => x + 0),
    [0, 0, -1, 5],
  );
  assert.deepEqual([...v.subarray(20, 24)], [32, 24, 8, 16]);
  assert.ok(effect);
});

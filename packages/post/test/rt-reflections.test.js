import test from 'node:test';
import assert from 'node:assert/strict';
import { tracedHarness as harness, modules, floats } from './traced-harness.js';
import { PostStack, SSR } from '../dist/index.js';
import { RTReflections } from '../dist/rt-reflections.js';

test('RTReflections validates its options', () => {
  const { scene } = harness();
  assert.throws(() => new RTReflections({}), TypeError);
  assert.throws(() => new RTReflections({ scene: {} }), TypeError);
  assert.throws(() => new RTReflections({ scene, shadows: 1 }), TypeError);
  assert.throws(() => new RTReflections({ scene, bias: -1 }), RangeError);
  assert.throws(() => new RTReflections({ scene, bias: Infinity }), RangeError);
  assert.throws(() => new RTReflections({ scene, steps: 0 }), RangeError, "SSR's own options are still checked");
  assert.ok(new RTReflections({ scene, bias: 0, shadows: false }) instanceof SSR);
});

test('RTReflections traces the scene where the screen holds no hit, lit by the engine sun', async () => {
  const h = harness(),
    rt = new RTReflections({ scene: h.scene, bias: 0.02 });
  h.engine.use(new PostStack([rt]));
  const log = h.gpu.record(() => h.frame());
  const composite = modules(log).find((code) => code.includes('var normals:texture_2d<f32>'));
  assert.ok(composite, 'the composite');
  // The scene in group 1 (bindings 0-4) and the light at binding 5.
  assert.match(composite, /@group\(1\) @binding\(0\) var<storage, read> sceneNodes/);
  assert.match(composite, /@group\(1\) @binding\(5\) var<uniform> rt:RTLight;/);
  // The screen's share comes first; the trace adds the rest of the roughness-faded share.
  assert.match(composite, /cover=f;let hc=u\.matrix/);
  assert.match(composite, /if\(cover<rf\)\{let ro=p\+n\*rt\.b\.x;let rh=sceneClosest\(ro,r,0\.0,u\.b\.x\);/);
  assert.match(composite, /c=max\(vec3f\(0\),c\+g\*\(m\.rgb\*rad-e\.rgb\)\);/);
  // Shading is core's BRDF with a shadow ray toward the sun.
  assert.match(composite, /sceneAny\(x\+n\*rt\.b\.x,l,0\.0,SCENE_NEVER\)/);
  assert.match(composite, /return vec4f\(toDisplay\(c\),s\.a\);\s*\}$/);
  const groups = log.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 1);
  assert.equal(groups.length, 1, 'the composite binds the scene in group 1');
  const light = log
    .filter((e) => e[0] === 'writeBuffer' && e[3].length === 64 * 2)
    .map((e) => floats(e[3]))
    .at(-1);
  const k = Math.hypot(3, 5, 4);
  for (const [i, value] of [3 / k, 5 / k, 4 / k, 3, 1, 1, 1, 0.15, 1, 1, 1].entries())
    assert.ok(Math.abs(light[i] - value) < 1e-6, `light word ${i}`);
  assert.deepEqual([light[12], light[13]], [Math.fround(0.02), 1], 'bias and shadows');
  rt.options.shadows = false;
  await null;
  const off = h.gpu.record(() => h.frame());
  assert.equal(floats(off.filter((e) => e[0] === 'writeBuffer' && e[3].length === 128).at(-1)[3])[13], 0);
  assert.equal(modules(off).length, 0, 'a steady frame builds no shader');
  rt.dispose();
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), []);
});

test('RTReflections stochastic rough rays trace too; a disposed scene runs as plain SSR', async () => {
  const h = harness(),
    rt = new RTReflections({ scene: h.scene, stochastic: true });
  h.engine.use(new PostStack([rt]));
  const log = h.gpu.record(() => h.frame());
  const trace = modules(log).find((code) => code.includes('fn pcg3d('));
  assert.match(trace, /out=vec4f\(f\*textureLoad\(scene,hq,0\)\.rgb,f\);cover=f;/);
  assert.match(trace, /out\+=vec4f\(g\*rtShade\(rh,ro\+r\*rh\.distance,r\),g\);/);
  assert.equal(log.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 1).length, 2, 'trace and composite');
  h.scene.disposed = true;
  await null;
  const plain = h.gpu.record(() => h.frame());
  const codes = modules(plain);
  assert.ok(codes.length >= 2 && codes.every((code) => !code.includes('sceneClosest(')), 'rebuilt without tracing');
  assert.equal(plain.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 1).length, 0);
  rt.dispose();
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), []);
});

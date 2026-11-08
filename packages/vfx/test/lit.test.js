import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { lit } from '../dist/lit.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  // Every bind group set on a render pass, as [group, bind group].
  const bound = [],
    begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => {
    const pass = begin(d);
    pass.setBindGroup = (index, group) => bound.push([index, group]);
    return pass;
  };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect, bound };
};
const uniform = (h) => h.resources.find((r) => r.size === 64 && !r.destroyed && new Float32Array(r.data)[7] > 0);
const billboards = (h) => h.pipelines.filter((p) => p.fragment).map((p) => p.vertex.module.code);
// A light source of the test's own, with the shape of Clustered and Shadows: WGSL for a group, and its entries.
const source = (name, fn) => {
  const entries = [{ binding: name === 'lights' ? 4 : 1, resource: { buffer: {} } }];
  return {
    entries,
    pbr: (group) => ({ declarations: `// ${name} in group ${group}\n${fn}\n` }),
    bindings: () => entries,
  };
};

test('lit writes the sun, its colour, the ambient, the wrap and the eye each frame, from the engine lighting', () => {
  const { h, effect } = attach({ capacity: 8, initialCount: 8, lit: {} });
  h.frame();
  const values = () => [...new Float32Array(uniform(h).data)].map((v) => +v.toFixed(5));
  // Sun towards [0, 0.6, 0.8] at intensity 2 times radiance; ambient = radiance.w x ambient; eye = the camera.
  assert.deepEqual(values(), [0, 0.6, 0.8, 0, 2, 1, 0.5, 0.5, 0.2, 0.4, 0.6, 0, 0, 1, 4, 0]);
  effect.options.lit.wrap = 1;
  effect.options.lit.ambient = [0.1, 0, 0];
  h.engine.lighting.direction.set([1, 0, 0, 0]);
  h.frame();
  assert.deepEqual(values(), [0, 0, 0, 0, 0, 0, 0, 1, 0.1, 0, 0, 0, 0, 1, 4, 0], 'no sun at intensity 0');
  const code = billboards(h)[0];
  assert.ok(code.includes('fn lit(i:Out,c:vec4f)') && code.includes('@binding(21) var<uniform> litFrame'));
  assert.ok(!code.includes('clusterLighting') && !code.includes('shadowLit'), 'no sources: the sun and ambient only');
  effect.options.lit = {};
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('effects without lit compile no lit code; lit without the feature or with bad values throws', () => {
  const { h, effect } = attach({ capacity: 8, initialCount: 8 }, {});
  h.frame();
  assert.ok(!billboards(h).some((code) => code.includes('litFrame')));
  effect.dispose();
  assert.throws(() => new Base({ lit: {} }, {}), /needs lit from @margoengine\/vfx\/lit/);
  assert.throws(() => new VFX({ lit: null }), TypeError);
  assert.throws(() => new VFX({ lit: { wrap: 1.5 } }), RangeError);
  assert.throws(() => new VFX({ lit: { ambient: [0, 0] } }), RangeError);
  assert.throws(() => new VFX({ lit: { ambient: [0, 0, 17] } }), RangeError);
  assert.throws(() => new VFX({ lit: { lights: {} } }), /lights must be Clustered/);
  assert.throws(() => new VFX({ lit: { shadows: { pbr() {} } } }), /shadows must be Shadows/);
  new Base({ lit: { wrap: 0, ambient: [16, 0, 0] } }, { lit });
});

test('lights and shadows take bind group 1 of the billboard draw, and group 2 under a transparency hook', () => {
  const lights = source('lights', 'fn clusterLighting(){}'),
    shadows = source('shadows', 'fn shadowLit(){}'),
    { h, effect, bound } = attach({ capacity: 8, initialCount: 8, lit: { lights, shadows } }, { lit });
  h.frame();
  let code = billboards(h).at(-1);
  assert.ok(code.startsWith('// lights in group 1\n') && code.includes('// shadows in group 1'), 'declarations first');
  assert.ok(code.includes('light+=clusterLighting(i.clip.xy,p,n,litFrame.eye.xyz,base,1.0,0.0,vec3f(0.04),1.0);'));
  assert.ok(code.includes('shadowLit(base*litFrame.sunColor.rgb*'), 'the sun goes through the shadow');
  const set = bound.filter(([index]) => index === 1);
  assert.equal(set.length, 1);
  assert.deepEqual(set[0][1].entries, [...lights.entries, ...shadows.entries], 'one group holds both sources');
  const groups = h.counts.groups;
  h.frame();
  assert.equal(h.counts.groups, groups, 'the same entries keep their bind group');
  shadows.entries = [{ binding: 1, resource: { buffer: {} } }];
  shadows.bindings = () => shadows.entries;
  h.frame();
  assert.equal(h.counts.groups, groups + 1, 'new entries make a new group');
  // Under an order-independent pass its declarations take group 1 and the lights move to group 2.
  const passBound = [],
    hook = {
      surface: (group) => `// oit in group ${group}\n`,
      targets: [{ format: 'rgba16float' }],
      bindings: () => [],
      begin: () => ({ setPipeline() {}, setBindGroup: (i, g) => passBound.push([i, g]), drawIndirect() {} }),
    };
  effect.setTransparency(hook);
  h.frame();
  effect.drawTransparent(h.context, hook);
  code = billboards(h).at(-1);
  assert.ok(code.startsWith('// lights in group 2\n') && code.includes('// oit in group 1'));
  assert.deepEqual(
    passBound.map(([i]) => i),
    [0, 1, 2],
  );
  assert.deepEqual(passBound[2][1].entries, [...lights.entries, ...shadows.entries]);
  effect.dispose();
});

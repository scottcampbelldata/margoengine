import test from 'node:test';
import assert from 'node:assert/strict';
import { staticBindings } from '../src/group.ts';
import { extendedPlan, extendedShader, surfaceTintPBR, transmissiveShader } from '../src/shader.ts';
import { transparentPBR, transparentTintPBR } from '../src/shader.ts';

// KB-OIT-BLENDTHICK1: a `layout: 'auto'` pipeline's group layouts hold only the bindings its entry points statically
// use, so a group built for it from the material's maps must leave out a map only another entry reads.
test('staticBindings keeps the bindings reachable from the entry points, through calls, and no other', () => {
  const code = `
@group(0) @binding(0) var<uniform> f:vec4f;
@group(1) @binding(0) var baseMap:texture_2d<f32>;
@group(1) @binding(1) var baseSampler:sampler;
@group(1) @binding(10) var margoMap0:texture_2d<f32>;
@group(1) @binding(11) var margoSampler0:sampler;
@group(2) @binding(3) var<storage,read> rows:array<vec4f>;
fn base(uv:vec2f)->vec4f {return textureSample(baseMap,baseSampler,uv)*f;}
fn thick(uv:vec2f)->f32 {return textureSample(margoMap0,margoSampler0,uv).g;}
fn shade(uv:vec2f)->vec4f {if(f.x>2.0){return vec4f(rows[0]);} return base(uv);}
@vertex fn vertex(@builtin(vertex_index) k:u32)->@builtin(position) vec4f {return vec4f(f32(k));}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return shade(p.xy);}
@fragment fn margoTint(@builtin(position) p:vec4f)->@location(0) vec4f {return base(p.xy)*thick(p.xy);}
`;
  const lit = staticBindings(code, ['vertex', 'fragment']),
    tint = staticBindings(code, ['vertex', 'margoTint']);
  assert.deepEqual([...lit.get(0)], [0]);
  assert.deepEqual([...lit.get(1)].sort((a, b) => a - b), [0, 1], 'the lit entry never reads the thickness map');
  assert.deepEqual([...lit.get(2)], [3], 'a branch that may not run is still a static use');
  assert.deepEqual([...tint.get(1)].sort((a, b) => a - b), [0, 1, 10, 11]);
  assert.deepEqual([...tint.get(2)], [], 'a declared group no reachable function names is empty');
  assert.equal(staticBindings(code, ['vertex', 'fragment']), lit, 'cached by code and entry points');
});

test('the OIT blending transparent entry of a thickness-mapped glass reads no thickness map; its tint does', () => {
  const thicknessTexture = { index: 0 },
    maps = Array.from({ length: 21 }, (_, k) => (k === 20 ? thicknessTexture : undefined)),
    plan = extendedPlan(maps, {}),
    slot = plan.slots[20],
    declarations =
      'struct MargoTransparent {@location(0) c:vec4f}\n' +
      'fn margoTransparent(c:vec4f,i:Out)->MargoTransparent {var o:MargoTransparent;o.c=c;return o;}\n' +
      'fn margoTransparentTint(s:vec4f)->MargoTransparent {var o:MargoTransparent;o.c=s;return o;}\n',
    code = transparentTintPBR(transparentPBR(surfaceTintPBR(transmissiveShader(extendedShader(plan))), declarations)),
    map = 10 + 2 * slot;
  assert.match(code, new RegExp(`@group\\(1\\) @binding\\(${map}\\) var margoMap${slot}:`));
  const drawn = staticBindings(code, ['vertex', 'transparent']).get(1),
    tint = staticBindings(code, ['vertex', 'margoTint']).get(1);
  assert.ok(drawn.has(0) && !drawn.has(map) && !drawn.has(map + 1), `transparent binds ${[...drawn]}`);
  assert.ok(tint.has(map) && tint.has(map + 1), `margoTint binds ${[...tint]}`);
});

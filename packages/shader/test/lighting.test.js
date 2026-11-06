import test from 'node:test';
import assert from 'node:assert/strict';
import { float, positionLocal, uniform, uv, vec3 } from '../dist/index.js';
import {
  LightingMaterial,
  ambientLight,
  environment,
  litColor,
  localLight,
  sunColor,
  sunDirection,
  sunVisibility,
} from '../dist/lighting.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { clusterBrdf } from '../../shared/light-terms.js';

const { pbrShader, extendedPBRShader, physicalShader } = await import('../../gltf-pro/src/shader.ts');
const sources = [pbrShader, extendedPBRShader, physicalShader()];
const hooks = {
  declarations: '',
  direct: (d) => `${d}*margoShadowed(i)`,
  light: 'margoClustered(i,s,v)',
  ambient: 's.base.rgb*0.25*s.occlusion',
};
const lit = (m, source, effects = hooks) => m.relight(lightPBR(m.shader(source, 2), effects));
const fragment = (code) => code.slice(code.indexOf('@fragment fn fragment('), code.indexOf('@fragment fn gbuffer('));

test('lightingNode runs after the effects, before the display steps, and keeps the sum of the light', () => {
  const m = new LightingMaterial({ lightingNode: litColor.add(localLight).add(ambientLight).add(sunColor) });
  for (const source of sources) {
    const body = fragment(lit(m, source)),
      order = ['let margoNodeLocal=margoClustered', 'var color=margoNodeLocal+', 'let margoNodeAmbient=', 'pbrNeutral'];
    const at = order.map((text) => body.indexOf(text));
    assert.ok(at.every((x) => x >= 0) && at.every((x, i) => !i || at[i - 1] < x), `in order: ${at}`);
    assert.equal(body.split('margoClustered').length - 1, 1, 'the clustered lights run once');
    assert.ok(body.includes('direct*margoDirectVisible+ambient(s)'), 'the visibility stays apart from the light');
    assert.ok(body.includes('let margoNodeAmbient=ambient(s)+margoAmbient;'));
  }
  assert.ok(
    fragment(lit(m, physicalShader())).indexOf('color=layers(') < fragment(lit(m, physicalShader())).indexOf('margoNodeAmbient='),
    'the final colour replaces the coated one',
  );
});

test('the sun nodes read what the fragment worked out; without effects the local light is zero', () => {
  const m = new LightingMaterial({ lightingNode: sunColor.mul(sunVisibility).add(sunDirection).add(localLight) }),
    code = m.relight(m.shader(pbrShader, 2));
  assert.ok(code.includes('let margoNodeLocal=vec3f(0);var color=margoNodeLocal+direct+ambient(s)+s.emissive;'));
  assert.match(m.lightingCode + code, /f\.radiance\.rgb\*f\.light\.w \* margoDirectVisible/);
  assert.ok(code.includes('var<private> margoDirectVisible'), 'declared for the compact shader');
  assert.equal(m.shader(pbrShader, 2), m.shader(pbrShader, 2));
});

test('lightModel replaces the sun and every clustered light, and reads stage inputs through the surface', () => {
  const m = new LightingMaterial({
      lightModel: ({ color, normal, direction }) => color.mul(normal.dot(direction).step(0.5)).mul(uv().x),
    }),
    term = `result+=${clusterBrdf}*nl*light.color.rgb`,
    clustered = { declarations: `fn margoClustered(){var result=vec3f(0);${term};${term};}\n`, light: 'vec3f(0)' };
  for (const source of sources) {
    const code = lit(m, source, clustered);
    assert.ok(!code.includes('let direct=direct_light(s,v,l);'));
    assert.ok(code.includes('let direct=margoNodeBrdf(l,v,s.n,s.base.rgb,s.roughness,s.metal)*f.radiance.rgb*f.light.w;'));
    assert.equal(code.split('result+=margoNodeBrdf(l,v,n,base,roughness,metal)*nl').length, 1, 'no second cosine');
    assert.equal(code.split('result+=margoNodeBrdf(l,v,n,base,roughness,metal)*light.color.rgb').length, 3);
    assert.ok(code.includes('fn margoNodeBrdf(') && code.includes('i.uv.xy'));
    assert.equal(lit(m, source, clustered), code, 'cached per source');
  }
});

test('nodes that read varyings or uniforms in either hook reach the vertex stage and the uniform block', () => {
  const u = uniform(0.5),
    m = new LightingMaterial({
      lightingNode: litColor.mul(positionLocal.y).mul(u),
      lightModel: ({ color }) => color.mul(positionLocal.x),
    });
  assert.ok(m.varyingFields.includes('ndv0'));
  assert.equal(m.varyingFields.split('@location').length, 2, 'one varying serves both');
  assert.ok(m.vertexCode.includes('o.ndv0 = i.position.xyz;'));
  assert.ok(m.shader(pbrShader, 2).includes('struct NdUniforms'));
});

test('environment() compiles the ambient hook on a mirror surface, only when a graph reads it', () => {
  const m = new LightingMaterial({ lightingNode: environment(vec3(0, 1, 0), 0.25) }),
    code = lit(m, pbrShader);
  assert.ok(code.includes('fn margoNodeEnvironment(i:Out,surface:Surface,d:vec3f,r:f32)->vec3f {'));
  assert.ok(code.includes('return ambient(s)+s.base.rgb*0.25*s.occlusion;'));
  assert.ok(code.includes('margoNodeEnvironment(i,s,vec3f(0.0, 1.0, 0.0),0.25)'));
  const without = new LightingMaterial({ lightingNode: litColor });
  assert.ok(!lit(without, pbrShader).includes('margoNodeEnvironment'));
  const sky = lit(m, pbrShader, { declarations: '' });
  assert.ok(sky.includes('return ambient(s);'), 'the built-in sky without an ambient hook');
});

test('a LightingMaterial without either option leaves the lit shader alone', () => {
  const m = new LightingMaterial({ colorNode: vec3(1, 0, 0) }),
    code = lightPBR(m.shader(pbrShader, 2), hooks);
  assert.equal(m.relight(code), code);
});

test('the lighting nodes are refused outside lightingNode, and bad options throw', async () => {
  const { NodeMaterial } = await import('../dist/index.js');
  assert.throws(() => new NodeMaterial({ emissiveNode: sunColor }), /sunColor is not available/);
  assert.throws(() => new NodeMaterial({ emissiveNode: environment(vec3(0, 1, 0)) }), /environment is not available/);
  assert.throws(() => new LightingMaterial({ lightModel: () => sunColor }), /sunColor is not available/);
  assert.throws(() => new LightingMaterial({ lightingNode: float(1) }), /vec3f/);
  assert.throws(() => new LightingMaterial({ lightModel: 1 }), /function/);
  assert.throws(() => new LightingMaterial({ shading: 'toon', lightingNode: litColor }), /standard/);
});

test('a shader without the hook points is refused with the fix', () => {
  const m = new LightingMaterial({ lightingNode: litColor, lightModel: ({ color }) => color });
  assert.throws(() => m.relight('fn other() {}'), /direct_light/);
  const finalOnly = new LightingMaterial({ lightingNode: litColor });
  assert.throws(() => finalOnly.relight('fn other() {}'), /var color/);
  assert.throws(() => finalOnly.relight('var color=vec3f(0);'), /direct\+ambient/);
  assert.throws(() => finalOnly.relight('var color=direct+ambient(s);return color;'), /tone map/);
});

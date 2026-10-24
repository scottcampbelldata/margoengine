// A lighting hook that returns its anchor text unchanged (an identity hook) composes instead of reporting a missing
// hook point; a genuinely missing anchor still reports one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lightPBR } from '../packages/shared/pbr-hooks.js';
import {
  pbrShader,
  extendedPBRShader,
  physicalShader,
  factorPhysicalShader,
  transmissiveShader,
} from '../packages/gltf-pro/src/shader.ts';
const variants = [
  ['compact', pbrShader],
  ['extended', extendedPBRShader],
  ['physical', physicalShader()],
  ['factorPhysical', factorPhysicalShader()],
  ['transmissive', transmissiveShader()],
];
for (const [name, code] of variants)
  test('identity direct preserves exact ' + name + ' source and warm cache', () => {
    let calls = 0;
    const hooks = {
      declarations: '',
      direct(expression) {
        assert.equal(this, hooks);
        assert.equal(expression, 'direct');
        calls++;
        return expression;
      },
    };
    assert.equal(lightPBR(code, hooks), code);
    assert.equal(lightPBR(code, hooks), code);
    assert.equal(calls, 1);
  });
// Text replacement controls do not claim that dollar-token expressions are valid WGSL.
for (const value of ['$&', '$$', '$1', '$`', "$'", 'prefix($&+$1+$$)'])
  test('native string replacement expansion preserved: ' + JSON.stringify(value), () => {
    const hooks = {
      declarations: '',
      direct() {
        return value;
      },
    };
    assert.equal(lightPBR(pbrShader, hooks), pbrShader.replace('direct+ambient(s)', value + '+ambient(s)'));
  });
for (const value of ['$&', '$1', '$$', 'all($&,$1,$$)'])
  test('regex ambient replacement function result stays literal: ' + value, () => {
    const hooks = { declarations: '', ambient: value };
    const zero = pbrShader.replace(
      /fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,
      'fn ambient(s:Surface)->vec3f {return vec3f(0);}',
    );
    const want = zero.replace(
      /var color=([^;]+)\+s\.emissive;/,
      (_, terms) => 'let margoAmbient=' + value + ';var color=' + terms + '+s.emissive+margoAmbient;',
    );
    assert.equal(lightPBR(pbrShader, hooks), want);
  });
const unsupported = (anchor) => ({
  name: 'MargoError',
  code: 'unsupported',
  message:
    'PBR lighting hook point missing: ' + anchor + '; use matching @margoengine/gltf-pro and effect package versions',
});
const bad = [
  ['direct', 'let untouched=1;', { direct: (v) => v }, 'direct+ambient(s)'],
  ['light', 'let untouched=1;', { light: 'local(i,s,v)' }, 'var color='],
  [
    'ambient function',
    'var color=direct+ambient(s)+s.emissive;',
    { ambient: 'other(s)' },
    String(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/),
  ],
  [
    'ambient color',
    pbrShader.replace('var color=', 'let color='),
    { ambient: 'other(s)' },
    String(/var color=([^;]+)\+s\.emissive;/),
  ],
  [
    'layered ambient term',
    transmissiveShader().replace(
      'fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}',
      'fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(1);}',
    ),
    { ambient: 'other(s)' },
    'fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}',
  ],
  [
    'output',
    'var color=direct+ambient(s)+s.emissive;',
    { output: (v) => v },
    'if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0)));',
  ],
  [
    'malformed coat',
    'fn margoCoatAmbient(s:Surface,v:vec3f)->vec3f {let x=1.0;return vec3f(x);}',
    { coat: 'other(s)' },
    String(/fn margoCoatAmbient\(s:Surface,v:vec3f\)->vec3f \{return [^;]*;\}/),
  ],
];
for (const [name, code, hooks, anchor] of bad)
  test('genuinely missing ' + name + ' anchor keeps exact error and remains retryable', () => {
    const full = { declarations: '', ...hooks };
    for (let i = 0; i < 2; i++) assert.throws(() => lightPBR(code, full), unsupported(anchor));
  });

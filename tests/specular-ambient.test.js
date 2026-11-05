// KHR_materials_specular and KHR_materials_ior reach ambient and local light: every hook reads the dielectric Fresnel
// ends s.f0 and s.sw on a physical Surface, and the glTF defaults on a Surface without those fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lightPBR } from '../packages/shared/pbr-hooks.js';
import { pbrShader, physicalShader, transmissiveShader } from '../packages/gltf-pro/src/shader.ts';

const hooks = { declarations: '', ambient: 'hook(s.base.rgb,s.f0,s.sw)', light: 'local(s.f0,s.sw)' };
const source = (path) => readFileSync(new URL('../packages/' + path, import.meta.url), 'utf8');

test('a physical surface gives hooks its own F0 and F90', () => {
  for (const code of [physicalShader(), transmissiveShader()]) {
    const lit = lightPBR(code, hooks);
    assert.ok(lit.includes('hook(s.base.rgb,s.f0,s.sw)'));
    assert.ok(lit.includes('local(s.f0,s.sw)'));
  }
});

test('a surface without those fields gives hooks the glTF defaults', () => {
  const lit = lightPBR(pbrShader, hooks);
  assert.ok(lit.includes('hook(s.base.rgb,vec3f(0.04),1.0)'));
  assert.ok(lit.includes('local(vec3f(0.04),1.0)'));
  assert.ok(!/\bs\.(f0|sw)\b/.test(lit));
});

test('every shipped hook passes the Fresnel ends and no lighting term keeps a fixed dielectric F0', () => {
  for (const [path, call] of [
    ['environment/src/lighting.ts', "'s.f0', 's.sw'"],
    ['environment/src/probes.ts', '${ambient},s.f0,s.sw)'],
    ['sky/src/lighting.ts', 's.roughness,s.f0,s.sw)'],
    ['clustered/src/index.ts', 's.metal,s.f0,s.sw)'],
  ])
    assert.ok(source(path).includes(call), path);
  for (const path of ['environment/src/ibl.ts', 'sky/src/lighting.ts', 'clustered/src/shader.ts', 'clustered/src/area.ts'])
    assert.ok(!/mix\(vec3f\(0\.04\),\s*(base|baseColor),\s*(metal|metalness)\)/.test(source(path)), path);
});

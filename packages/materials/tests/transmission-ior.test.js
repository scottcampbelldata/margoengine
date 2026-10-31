// KHR_materials_ior on the transmission extension: the host's reflection F0 follows the IOR, so a fully transmissive
// IOR 1 surface reflects nothing and shows exactly what is behind it (KHR_materials_ior: F0 = ((ior - 1) / (ior + 1))^2).
// Runs gltf-pro's composed lighting WGSL on the CPU. Before the fix the host kept F0 0.04 under any extension IOR, and
// the GPU check "IOR 1 transmission differs from the opaque background" (scripts/materials-transmission-tests.js) found
// a 13-step highlight. Lobes composed over transmission recompute diffuse light, and before the fix did so at full
// strength: a fully transmissive IOR 1 surface with a specular or sheen lobe drew about 148 steps of white.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbrShader } from '../../gltf-pro/src/shader.ts';
import { materialExtensionShader, prepareMaterialExtension } from '../../gltf-pro/src/material-extension.ts';
import { transmission } from '../dist/transmission.js';
import { materialLobes, nodeMaterial } from '../dist/index.js';
import { wgslModule } from './support/wgsl-subset.js';

const f32 = Math.fround;
/** The text of `fn name(...){...}` in `code`, braces balanced. */
function fnText(code, name) {
  const start = code.indexOf('fn ' + name + '(');
  assert.ok(start >= 0, 'missing fn ' + name);
  let depth = 0;
  for (let i = code.indexOf('{', start); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }
  throw new Error('unbalanced fn ' + name);
}
/** Composes the base PBR shader with a transmission extension and returns its lighting and surface-hook F0 on the CPU. */
function compose(options) {
  const extension = transmission({ opaqueColor: {}, factor: 1, ...options }),
    code = materialExtensionShader(pbrShader, extension),
    rows = [];
  for (let k = 0; k < extension.factors.length; k += 4) rows.push([...extension.factors.slice(k, k + 4)]);
  // The surface hook's F0 statement, run as a function that returns the value it stores in s.f0.
  const hook = /\{let materialIorRatio=[^}]*\}/.exec(code)?.[0];
  const source = [
    fnText(code, 'direct_light'),
    fnText(code, 'hemisphere_ambient'),
    hook ? 'fn hookF0()->vec3f ' + hook.replace('s.f0=', 'return ') : 'fn hookF0()->vec3f {return vec3f(0.04);}',
  ].join('\n');
  const shader = wgslModule(source, {
    f: { radiance: [1, 1, 1, 0.03], light: [0, 0, 1, 1] },
    materialFactors: rows,
    sqrt: (x) => f32(Math.sqrt(x)),
  });
  return { extension, code, hook, shader };
}
/** A white, rough, fully transmissive dielectric facing the camera and the light (the GPU fixture's front quad). */
const surface = (f0) => ({
  base: [1, 1, 1, 1],
  n: [0, 0, 1],
  roughness: 0.6,
  metal: 0,
  occlusion: 1,
  emissive: [0, 0, 0],
  tr: 1,
  f0,
});

test('the transmission extension hands its IOR to the host', () => {
  assert.equal(transmission({ opaqueColor: {}, factor: 1, ior: 1 }).ior, 'materialFactors[0].y');
  const glass = {
      type: 'emit',
      color: { type: 'color', value: [1, 1, 1, 1] },
      transmission: { type: 'transmission', factor: { type: 'scalar', value: 1 }, ior: { type: 'scalar', value: 1 } },
    },
    node = nodeMaterial({ nodes: [glass] }, { opaqueColor: {} });
  assert.match(node.ior, /^max\(\w+,1\.0\)$/);
});

test('IOR 1 transmission: no reflection in direct or ambient light, so the surface shows only what is behind it', () => {
  const { code, hook, shader } = compose({ ior: 1 });
  assert.ok(hook, 'the surface hook sets s.f0 from the IOR');
  assert.match(code, /struct Surface \{[^}]*, f0:vec3f\}/);
  for (const name of ['direct_light', 'hemisphere_ambient'])
    assert.ok(!fnText(code, name).includes('vec3f(0.04)'), name + ' still uses F0 0.04');
  const f0 = shader.call('hookF0');
  assert.deepEqual(f0, [0, 0, 0]);
  const s = surface(f0),
    view = [0, 0, 1];
  assert.deepEqual(shader.call('direct_light', s, view, [0, 0, 1]), [0, 0, 0]);
  assert.deepEqual(shader.call('hemisphere_ambient', s), [0, 0, 0]);
});

test('IOR 1.5 keeps F0 0.04: the same light as the host without an extension IOR', () => {
  const { shader } = compose({ ior: 1.5 }),
    f0 = shader.call('hookF0');
  // ((1.5 - 1) / (1.5 + 1))^2 in f32 arithmetic lands one f32 step above the literal 0.04 (as on gltf-pro's native
  // physical path, which computes it the same way); the light it gives matches the fixed-F0 host to within 1e-7.
  for (const value of f0) assert.ok(Math.abs(value - f32(0.04)) <= 2 ** -27, 'F0 at IOR 1.5: ' + value);
  const plain = wgslModule([fnText(pbrShader, 'direct_light'), fnText(pbrShader, 'hemisphere_ambient')].join('\n'), {
    f: { radiance: [1, 1, 1, 0.03], light: [0, 0, 1, 1] },
    sqrt: (x) => f32(Math.sqrt(x)),
  });
  const s = { ...surface(f0), tr: 0 },
    v = [0, 0.6, 0.8],
    l = [0, 0, 1];
  const near = (a, b, label) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= 1e-7, `${label}: ${a} vs ${b}`));
  near(shader.call('direct_light', s, v, l), plain.call('direct_light', s, v, l), 'direct');
  near(shader.call('hemisphere_ambient', s), plain.call('hemisphere_ambient', s), 'ambient');
  assert.ok(plain.call('direct_light', s, v, l)[0] > 0.01, 'the comparison sees a lit surface');
});

test('the host rejects a non-string IOR and a base shader without the F0 it replaces', () => {
  const device = { limits: {} };
  assert.throws(() => prepareMaterialExtension(device, { ior: 1 }), /documented hook/);
  assert.throws(
    () =>
      materialExtensionShader(pbrShader.replaceAll('mix(vec3f(0.04),s.base.rgb,s.metal)', 'vec3f(0.04)'), {
        ior: '1.0',
      }),
    /PBR shader IOR target missing/,
  );
});

test('lobes over transmission scale the diffuse light they recompute by the untransmitted share', () => {
  const lobes = { ior: 1, specular: { factor: 0.5 }, sheen: { colorFactor: [0.5, 0.5, 0.5] } },
    glass = materialLobes(lobes, transmission({ opaqueColor: {}, factor: 1, ior: 1 })),
    opaque = materialLobes(lobes);
  // Direct diffuse (base and specular-extension forms) and the hemisphere diffuse.
  assert.equal(glass.declarations.split('*(1.0-s.tr)').length - 1, 3);
  assert.ok(!opaque.declarations.includes('s.tr'), 'lobes without transmission keep their shader text');
  assert.equal(glass.ior, 'materialFactors[0].y');
  const code = materialExtensionShader(pbrShader, glass);
  assert.match(code, /struct Surface \{[^}]*tr:f32[^}]*f0:vec3f\}/);
});

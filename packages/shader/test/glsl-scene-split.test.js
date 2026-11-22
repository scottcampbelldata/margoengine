// Pay only for what you import: the scene options of ShaderMaterial (lights, fog, velocity) live in shader/glsl-material
// alone. ShaderPass and Shadertoy draw no lit materials, so their entries carry none of that code, and the raw entry
// carries no scene state; their materials are the same program core, which `instanceof ShaderMaterial` accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { bundleBytes } from '../../../scripts/measure-size.js';
import { ShaderMaterial } from '../dist/glsl-material.js';
import { ShaderPass } from '../dist/glsl-pass.js';
import { Shadertoy } from '../dist/shadertoy.js';

const dist = (name) => fileURLToPath(new URL(`../dist/${name}.js`, import.meta.url));
// Text only the scene code holds: the light and fog names, the velocity entry's helpers and shaderScene's checks.
const sceneText = [
  'sunDirection',
  'fogHeightFalloff',
  'margoBeforeNormal',
  'margoKept_',
  'shaderScene needs',
  'setLights needs',
];

test('glsl-pass, shadertoy and raw bundle none of the scene code; glsl-material bundles all of it', async () => {
  const material = (await bundleBytes(dist('glsl-material'))).toString();
  for (const t of sceneText) assert.ok(material.includes(t), `glsl-material lacks ${t}`);
  for (const entry of ['glsl-pass', 'shadertoy', 'raw']) {
    const code = (await bundleBytes(dist(entry))).toString();
    for (const t of sceneText) assert.ok(!code.includes(t), `${entry} bundles scene code: ${t}`);
  }
});

const fragment =
  'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D(tDiffuse, vUv); }';
const image = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, 0.0, 1.0); }';

test('the materials of ShaderPass and Shadertoy are ShaderMaterials to instanceof; a subclass checks as usual', () => {
  const pass = new ShaderPass({ fragmentShader: fragment }),
    toy = new Shadertoy(image),
    own = toy.material();
  assert.ok(pass.material instanceof ShaderMaterial);
  assert.ok(own instanceof ShaderMaterial);
  assert.equal(pass.material.isShaderMaterial, true);
  class Tinted extends ShaderMaterial {}
  assert.equal(pass.material instanceof Tinted, false);
  assert.ok(
    new Tinted({
      vertexShader: 'void main() { gl_Position = vec4(0.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
    }) instanceof Tinted,
  );
  assert.equal({} instanceof ShaderMaterial, false);
  pass.dispose?.();
  toy.dispose();
});

test('the scene options are refused where no scene code is loaded', () => {
  const toy = new Shadertoy(image);
  assert.throws(
    () => toy.material({ lights: true }),
    /lights, fog and velocity are options of ShaderMaterial from shader\/glsl-material/,
  );
  assert.throws(() => toy.material({ velocity: true }), TypeError);
  toy.dispose();
});

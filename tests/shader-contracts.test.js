// Cross-package WGSL contracts (HANDOFF 1g.c, docs/shader-contracts.md). Core's mesh shader is frozen for 1.0, so packages
// that extend it still patch its text (PassContext.shader). Every anchor they rely on is listed here: the test fails, naming
// the package, when an anchor leaves the shader it targets or when the package stops using the listed anchor (update both).
// gltf-pro's own lighting hooks are checked in packages/gltf-pro/tests; terrain mirrors core's lighting lines on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wgsl as core } from '../packages/core/src/shaders.ts';
import { meshVertex } from '../packages/shared/gpu.js';
import { pbrShader, extendedPBRShader } from '../packages/gltf-pro/src/shader.ts';
import { terrainFragment } from '../packages/terrain/src/shader.ts';

const hdr = core.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);');
const targets = { core, hdr, meshVertex, gltf: pbrShader, gltfExtended: extendedPBRShader, terrain: terrainFragment };
const linearBlock = /let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/;
// [package source file, target shader, anchor]; strings must occur in the target, regexes must match it.
const contracts = [
  ['machinery/src/section.ts', 'core', 'let facing='],
  ['shadows/src/index.ts', 'core', 'let linear=direct*'],
  ['shadows/src/index.ts', 'terrain', 'let linear=direct*'],
  ['clustered/src/index.ts', 'core', /let linear=([^;]+);/],
  ['clustered/src/index.ts', 'terrain', /let linear=([^;]+);/],
  ['clustered/src/index.ts', 'terrain', 'let base=terrainColor'],
  ['environment/src/lighting.ts', 'core', /let linear=([^;]+);/],
  ['environment/src/lighting.ts', 'core', 'frame.radiance.w'],
  ['environment/src/lighting.ts', 'core', 'let mapped=linear/(1.0+linear);'],
  ['environment/src/lighting.ts', 'hdr', 'return vec4f(linear,1);'],
  ['sky/src/lighting.ts', 'core', 'frame.radiance.w'],
  ['taa/src/index.ts', 'core', 'o.clip=frame.camera*p'],
  ['tonemap/src/index.ts', 'core', linearBlock],
  ['post/src/stack.ts', 'core', linearBlock],
  ['post/src/bloom.ts', 'core', linearBlock],
  ['post/src/ssao.ts', 'core', linearBlock],
  ['creative/src/post.ts', 'core', linearBlock],
  ['dof/src/index.ts', 'core', linearBlock],
  ['post/src/ssao.ts', 'core', /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/],
  ['post/src/ssao.ts', 'core', /let direct=[\s\S]*return vec4f\([^\n]+\);/],
  ['post/src/ssao.ts', 'core', 'i.color*(1.0-i.material.y)*frame.radiance.w'],
  ['post/src/ssr.ts', 'hdr', /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/],
  ['post/src/ssr.ts', 'hdr', /(@fragment[^{]*)->@location\(0\) vec4f/],
  ['post/src/ssr.ts', 'hdr', 'let n=normalize(i.normal)'],
  ['post/src/ssr.ts', 'hdr', 'let v=normalize(frame.eye.xyz-i.position)'],
  ['creative/src/toon.ts', 'core', /let direct=[^;]+;/],
  ['creative/src/toon.ts', 'core', /let linear=([^;]+);/],
  ['selection/src/picking.ts', 'core', '@location(3) material:vec4f'],
  ['selection/src/picking.ts', 'core', 'o.color=i.color.rgb'],
  [
    'selection/src/picking.ts',
    'core',
    '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f',
  ],
  ['selection/src/picking.ts', 'meshVertex', 'id:u32}'],
  ['selection/src/picking.ts', 'meshVertex', 'u32(i.factors.w))'],
  ['toon/src/index.ts', 'meshVertex', 'let p=model*vec4f(i.position,1);'],
  ['scatter/src/instances.ts', 'core', /struct Frame \{[^}]+\}/],
  ['scatter/src/instances.ts', 'core', /struct Input \{[^}]+\}/],
  ['scatter/src/instances.ts', 'core', /struct Output \{[^}]+\}/],
  ['scatter/src/instances.ts', 'core', 'let p=model*vec4f(i.position,1);'],
  ['scatter/src/instances.ts', 'core', 'o.color=i.color.rgb;'],
  ['scatter/src/instances.ts', 'core', 'i.color*(1.0-i.material.y)*'],
  ['scatter/src/instances.ts', 'core', /let linear=([^;]+);/],
  ['scatter/src/index.ts', 'core', /struct Input \{[^}]+\}/],
  ['scatter/src/index.ts', 'core', '@location(3) material:vec4f'],
  ['scatter/src/index.ts', 'core', /@vertex fn vertex\([\s\S]*?(?=@fragment)/],
  ['scatter/src/index.ts', 'core', /(@fragment fn fragment[^{]+\{)/],
  ['terrain/src/colors.ts', 'core', 'o.color=i.color.rgb;'],
  ['terrain/src/colors.ts', 'core', /struct Output \{[^}]+\}/],
  ['terrain/src/colors.ts', 'core', /let linear=([^;]+);/],
  // Text patches of gltf-pro's shader that stay (they rewrite sampling and the vertex stage, not lighting).
  [
    'materials/src/built-material.ts',
    'gltfExtended',
    /textureSample\((baseMap|mrMap|aoMap|emissiveMap),(\w+),(uv\(i,f\.coords[AB]\.[xyzw]\))\)/g,
  ],
  [
    'materials/src/built-material.ts',
    'gltfExtended',
    /textureSample\(normalMap,normalSampler,(uv\(i,f\.coordsA\.z\))\)\.xyz\*2-1/,
  ],
  ['materials/src/built-material.ts', 'gltfExtended', /@fragment fn fragment\([^{]*\{\s*let s=surface\(i,front\);/],
  ['shader/src/material.ts', 'gltf', /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/],
  ['shader/src/material.ts', 'gltf', 'let p=f.model*vec4f(i.position.xyz,1);'],
  ['shader/src/material.ts', 'gltf', /(struct Out \{[^}]*?)\n\}/],
  ['lod/src/imposter.ts', 'gltf', /@fragment fn fragment\([\s\S]*?let s=surface\(i,front\);/],
];
const sources = new Map();
const source = (file) => {
  if (!sources.has(file)) sources.set(file, readFileSync(new URL(`../packages/${file}`, import.meta.url), 'utf8'));
  return sources.get(file);
};
// A global regex rewrites every match (materials: base, metal-roughness, occlusion and emissive samples); the rest rewrite the first.
const expected = (anchor) => (anchor instanceof RegExp && anchor.global ? 4 : 1);
const count = (code, anchor) =>
  anchor instanceof RegExp ? (code.match(new RegExp(anchor.source, 'g'))?.length ?? 0) : code.split(anchor).length - 1;

for (const [file, target, anchor] of contracts) {
  const text = anchor instanceof RegExp ? anchor.source : anchor;
  test(`${file.split('/')[0]} relies on ${target} shader anchor ${text.slice(0, 70)}`, () => {
    assert.equal(
      count(targets[target], anchor),
      expected(anchor),
      `${file}: anchor must occur ${expected(anchor)}x in the ${target} shader`,
    );
    assert.ok(
      source(file).includes(text),
      `${file} no longer uses this anchor; update tests/shader-contracts.test.js and docs/shader-contracts.md`,
    );
  });
}

test('shared meshVertex mirrors core vertex inputs, frame layout and position transform', () => {
  const squash = (s) => s.replace(/\s+/g, '');
  for (const re of [/struct Frame \{[^}]+\}/, /struct Input \{[^}]+\}/])
    assert.equal(squash(meshVertex.match(re)[0]), squash(core.match(re)[0]));
  for (const line of ['let model=mat4x4f(i.m0,i.m1,i.m2,i.m3);let p=model*vec4f(i.position,1);', 'frame.camera*p']) {
    assert.ok(core.includes(line) && meshVertex.includes(line), line);
  }
});

test('margoAmbient convention: environment names the IBL term, post SSAO replays it from core meshes', () => {
  assert.match(source('environment/src/lighting.ts'), /let margoAmbient=\$\{iblCall\(/);
  assert.match(source('post/src/ssao.ts'), /c\.shader\.includes\('let margoAmbient='\)/);
});

test("SSR replays the IBL specular with environment's own split-sum helpers", () => {
  const ibl = source('environment/src/ibl.ts'),
    ssr = source('post/src/ssr.ts');
  for (const signature of [
    'fn iblBrdfTerms(nv: f32, roughness: f32) -> vec2f',
    'fn iblPrefiltered(specular: texture_cube<f32>, s: sampler, params: vec4f, r: vec3f, roughness: f32) -> vec3f',
    'let specularWeight = f0 * ab.x + ab.y;',
    'radiance * specularWeight) * params.w',
  ])
    assert.ok(ibl.includes(signature), `environment ibl.ts changed: ${signature}`);
  for (const call of [
    'iblBrdfTerms(nv,rough)',
    'iblPrefiltered(iblSpecular,iblSampler,iblParams,reflect(-v,n),rough)*w*iblParams.w',
    "includes('fn iblBrdfTerms(')",
  ])
    assert.ok(ssr.includes(call), `post ssr.ts no longer calls ${call}`);
});

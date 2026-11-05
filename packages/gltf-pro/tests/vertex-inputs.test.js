// A finished shader fetches only the vertex inputs it reads (src/vertex-inputs.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { instancedShader } from '../src/instanced-shader.ts';
import { extendedPBRShader, pbrShader } from '../src/shader.ts';
import { vertexInputs } from '../src/vertex-inputs.ts';

// materials' bareShader: every map read becomes the value of the texture a missing map stands for.
const bare = (code) =>
  code
    .replace(/textureSample\(normalMap,normalSampler,uv\(i,f\.coordsA\.z\)\)/g, 'vec4f(0.5,0.5,1,1)')
    .replace(/textureSample\(\w+Map,\w+Sampler,uv\(i,f\.coords[AB]\.[xyzw]\)\)/g, 'vec4f(1)')
    .replace(/@group\(1\) @binding\(\d+\) var \w+:[^;]+;\n?/g, '');
const noColors = (code) => code.replace('o.uv=i.uv; o.color=i.color;', 'o.uv=i.uv; o.color=vec4f(1);');

test('a shader with maps keeps every input and is not changed', () => {
  const { code, locations } = vertexInputs(pbrShader);
  assert.equal(code, pbrShader);
  assert.deepEqual(locations, [0, 1, 2, 3, 4]);
});

test('a bare material reads position, normal and vertex colour only', () => {
  for (const source of [pbrShader, extendedPBRShader]) {
    const { code, locations } = vertexInputs(bare(source));
    assert.deepEqual(locations, [0, 1, 4]);
    assert.doesNotMatch(code, /i\.tangent|i\.uv|\buv\(i,|o\.uv|o\.tangent/);
    assert.match(code, /s\.n=normalize\(n\);/);
    assert.match(code, /struct Input \{\s*@location\(0\) position:vec4f, @location\(1\) normal:vec4f, @location\(4\) color:vec4f\s*\}/);
  }
});

test('instanced, with vertex colours off, it reads position and normal, and keeps the instance rows', () => {
  const { code, locations } = vertexInputs(instancedShader(noColors(bare(pbrShader))));
  assert.deepEqual(locations, [0, 1]);
  assert.match(code, /o\.color=vec4f\(1\)\*k\.tint; o\.mirror=margoS;/);
  assert.doesNotMatch(code, /k\.uvt|i\.tangent/);
  assert.doesNotMatch(code, /uvt:vec4f/);
  assert.match(code, /@location\(9\) tint:vec4f\}/);
  assert.doesNotMatch(/struct Out \{[^}]*\}/.exec(code)[0], /tangent|uv/);
});

test('code that still needs the frame or the UVs keeps them', () => {
  const lobe = bare(pbrShader).replace('\n  return s;', '\n  s.base=vec4f(t,1);\n  return s;');
  assert.deepEqual(vertexInputs(lobe).locations, [0, 1, 2, 3, 4]);
  const map = bare(pbrShader).replace('\n  return s;', '\n  s.base*=vec4f(i.uv.xy,0,1);\n  return s;');
  const mapped = vertexInputs(map);
  assert.deepEqual(mapped.locations, [0, 1, 3, 4]);
  assert.match(mapped.code, /o\.uv=i\.uv;/);
  const used = bare(pbrShader).replace('\n  return s;', '\n  s.base*=i.tangent;\n  return s;');
  assert.deepEqual(vertexInputs(used).locations, [0, 1, 2, 4]);
});

test('a vertex stage that reads an input keeps it, and one that passes the input on keeps all', () => {
  const displaced = bare(pbrShader).replace('let p=f.model*vec4f(i.position.xyz,1);', 'let p=f.model*vec4f(i.position.xyz+i.uv.xyz,1);');
  assert.deepEqual(vertexInputs(displaced).locations, [0, 1, 3, 4]);
  const whole = bare(pbrShader).replace('let p=f.model*vec4f(i.position.xyz,1);', 'let p=f.model*margoMove(i);');
  assert.deepEqual(vertexInputs(whole).locations, [0, 1, 2, 3, 4]);
});

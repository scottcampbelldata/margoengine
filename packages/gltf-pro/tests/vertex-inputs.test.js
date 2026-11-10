// A finished shader fetches only the vertex inputs it reads (src/vertex-inputs.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { instancedShader } from '../src/instanced-shader.ts';
import { extendedPBRShader, pbrShader } from '../src/shader.ts';
import {
  exactAlphaShader,
  instanceInputs,
  opaqueColours,
  vertexInputs,
  vertexLayout,
  whiteColours,
} from '../src/vertex-inputs.ts';
import { instanceLayout } from '../../shared/instances.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { instancing } from '../dist/instancing.js';
import { instancedGLTF } from '../../../tests/support/instanced-gltf.js';

async function scene() {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  return { gpu, engine, store, view: context(gpu, { samples: 1, format: 'rgba16float', depthFormat: 'depth32float' }) };
}

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

test('a shader whose vertex entry has another name is left alone', () => {
  const renamed = bare(pbrShader).replace('@vertex fn vertex(', '@vertex fn margoVertex(');
  assert.deepEqual(vertexInputs(renamed), { code: renamed, locations: [0, 1, 2, 3, 4], narrow: [] });
});

test('a helper above the structs that opens like the tangent frame does not take them with it', () => {
  const helper = '\nfn margoNode(i:Out,n:vec3f)->vec3f {\n  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);var b=cross(n,t);\n  return b;\n}\n',
    { code, locations } = vertexInputs(helper + bare(pbrShader));
  assert.match(code, /struct Input \{/);
  assert.match(code, /fn margoNode/);
  assert.match(code, /s\.n=normalize\(n\);/);
  assert.deepEqual(locations, [0, 1, 2, 4]);
});

test('a vertex stage that reads an input keeps it, and one that passes the input on keeps all', () => {
  const displaced = bare(pbrShader).replace('let p=f.model*vec4f(i.position.xyz,1);', 'let p=f.model*vec4f(i.position.xyz+i.uv.xyz,1);');
  assert.deepEqual(vertexInputs(displaced).locations, [0, 1, 3, 4]);
  const whole = bare(pbrShader).replace('let p=f.model*vec4f(i.position.xyz,1);', 'let p=f.model*margoMove(i);');
  assert.deepEqual(vertexInputs(whole).locations, [0, 1, 2, 3, 4]);
});

test('a built-in a node graph added to the input stays when attributes are trimmed', () => {
  const source = bare(pbrShader)
      .replace(/(struct Input \{[^}]*?)\n\}/, '$1,\n  @builtin(vertex_index) ndVertex:u32\n}')
      .replace('o.color=i.color;', 'o.color=i.color*f32(i.ndVertex);'),
    { code, locations } = vertexInputs(source);
  assert.deepEqual(locations, [0, 1, 4]);
  assert.match(code, /struct Input \{[^}]*@builtin\(vertex_index\) ndVertex:u32\s*\}/);
});

// Batch 166 job 2: the instanced vertex stage fetches what it reads and no more. Bytes a vertex invocation fetches
// from slot 0 and attributes of slot 1, per case; the shader values are the same constants the buffers hold.
const bytes = { float32x3: 12, float32x4: 16 };
const fetched = (layout) => layout.attributes.reduce((n, a) => n + bytes[a.format], 0);

test('whiteColours finds a colour other than (1, 1, 1, 1) in the whole buffer or a range', () => {
  const vertices = new Float32Array(20 * 4);
  for (let v = 0; v < 4; v++) vertices.fill(1, v * 20 + 16, v * 20 + 20);
  assert.equal(whiteColours(vertices), true);
  vertices[2 * 20 + 19] = 0.5;
  assert.equal(whiteColours(vertices), false);
  assert.equal(whiteColours(vertices, 0, 2), true);
  assert.equal(whiteColours(vertices, 2, 1), false);
  assert.equal(whiteColours(vertices, 3, 1), true);
});

test('opaqueColours finds a colour alpha other than 1, whatever the RGB', () => {
  const vertices = new Float32Array(20 * 3);
  for (let v = 0; v < 3; v++) vertices.fill(1, v * 20 + 16, v * 20 + 20);
  vertices[20 + 16] = 0.25;
  assert.equal(opaqueColours(vertices), true);
  assert.equal(whiteColours(vertices), false);
  vertices[2 * 20 + 19] = 0.99999994;
  assert.equal(opaqueColours(vertices), false);
  assert.equal(opaqueColours(vertices, 0, 2), true);
});

test('exactAlphaShader hands on 1 - alpha and reads 1 minus that in every Out reader', () => {
  const code = exactAlphaShader(pbrShader);
  assert.match(code, /o\.color=margoClearAlpha\(i\.color\);/);
  assert.match(code, /\*f\.base\*margoClearAlpha\(i\.color\);/);
  assert.doesNotMatch(code.slice(code.indexOf('return o;')), /[^(]i\.color\b/);
  assert.match(code, /fn margoClearAlpha\(c:vec4f\)->vec4f \{return vec4f\(c\.rgb,1\.0-c\.a\);\}/);
  // Applied once only, and code that hands `Out` on under another name is left alone.
  assert.equal(exactAlphaShader(code), code);
  const renamed = pbrShader.replace('fn uv(i:Out, coord:f32)', 'fn uv(j:Out, coord:f32)');
  assert.equal(exactAlphaShader(renamed), renamed);
  // The instanced vertex stage keeps its tint inside the flipped write.
  assert.match(exactAlphaShader(instancedShader(bare(pbrShader))), /o\.color=margoClearAlpha\(i\.color\*k\.tint\);/);
});

test('createInstancedMesh boxes (bare material, colours on): 48 B and 6 instance rows become 24 B and 5', () => {
  const source = instancedShader(bare(pbrShader));
  // Before this job: every read input a float32x4 and the whole instance layout.
  const before = vertexInputs(source);
  assert.deepEqual(before.locations, [0, 1, 4]);
  assert.equal(before.locations.length * 16, 48);
  // Coloured vertices: position and normal read as xyz only, the colour whole.
  const coloured = vertexInputs(source, false);
  assert.deepEqual(coloured.narrow, [0, 1]);
  assert.equal(fetched(vertexLayout(coloured)), 40);
  // White vertices (a geometry with no colours): the colour fetch goes, the stage reads the constant it held.
  const white = vertexInputs(source, true);
  assert.deepEqual(white.locations, [0, 1]);
  assert.equal(fetched(vertexLayout(white)), 24);
  assert.match(white.code, /o\.color=vec4f\(1\)\*k\.tint; o\.mirror=margoS;/);
  assert.doesNotMatch(/struct Input \{[^}]*\}/.exec(white.code)[0], /color/);
  // The instance UV row the trimmed shader no longer declares leaves the layout; the stride stays.
  assert.equal(instanceLayout.attributes.length, 6);
  const rows = instanceInputs(white.code, instanceLayout);
  assert.equal(rows.arrayStride, instanceLayout.arrayStride);
  assert.deepEqual(rows.attributes.map((a) => a.shaderLocation), [5, 6, 7, 8, 9]);
  assert.equal(instanceInputs(white.code, instanceLayout), rows, 'one layout object per kept set');
  assert.equal(instanceInputs(instancedShader(pbrShader), instanceLayout), instanceLayout, 'a UV-reading shader keeps it');
});

test('white only replaces vertex-stage reads, and a stage that hands the input on whole keeps every input', () => {
  const source = instancedShader(pbrShader),
    { code, locations, narrow } = vertexInputs(source, true);
  assert.deepEqual(locations, [0, 1, 2, 3]);
  assert.deepEqual(narrow, [0, 1]);
  assert.equal(code.slice(code.indexOf('struct Surface')), source.slice(source.indexOf('struct Surface')));
  const whole = bare(pbrShader).replace('let p=f.model*vec4f(i.position.xyz,1);', 'let p=f.model*margoMove(i);');
  assert.deepEqual(vertexInputs(whole, true), { code: whole, locations: [0, 1, 2, 3, 4], narrow: [] });
  const w = bare(pbrShader).replace('let p=f.model*vec4f(i.position.xyz,1);', 'let p=f.model*vec4f(i.position.xyz,i.position.w);');
  assert.deepEqual(vertexInputs(w).narrow, [1], 'a stage that reads w fetches all four');
});

test('an instanced glTF primitive without COLOR_0 builds the trimmed pipeline; written colours bring the fetch back', async () => {
  const { gpu, engine, store, view } = await scene(),
    model = parseGLTF(engine, ...Object.values(instancedGLTF([{ t: [0, 0, 0] }, { t: [1, 0, 0] }])), [], { instancing });
  store.tick(false);
  const made = [],
    create = gpu.device.createRenderPipeline.bind(gpu.device);
  gpu.device.createRenderPipeline = (desc) => (made.push(desc), create(desc));
  const draw = () => {
    made.length = 0;
    view.begin(0);
    model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    return made.find((desc) => desc.vertex.buffers[1]?.stepMode === 'instance');
  };
  const white = draw();
  assert.deepEqual(white.vertex.buffers[0].attributes.map((a) => `${a.shaderLocation}:${a.format}`), [
    '0:float32x3',
    '1:float32x3',
    '2:float32x4',
    '3:float32x4',
  ]);
  assert.equal(fetched(white.vertex.buffers[0]), 56, 'was 80: five float32x4');
  const p = model.primitives[0],
    vertices = p.vertices.slice();
  vertices[16] = 0.5;
  model.writeGeometry([{ vertices, indices: p.indices }]);
  const coloured = draw();
  assert.deepEqual(coloured.vertex.buffers[0].attributes.map((a) => `${a.shaderLocation}:${a.format}`), [
    '0:float32x3',
    '1:float32x3',
    '2:float32x4',
    '3:float32x4',
    '4:float32x4',
  ]);
  model.dispose();
});

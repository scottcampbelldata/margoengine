import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF, textureTransform } from '../dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { factorPhysicalShader, extendedShader, extendedPlan } from '../src/shader.ts';

async function fixture() {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(32);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  const model = parseGLTF(engine, data.doc, data.buffers),
    context = { ...gpu.context, camera: engine.camera },
    draws = [];
  engine.camera.update(128 / 96, true);
  store.tick(false);
  context.encoder.beginRenderPass = () => {
    let pipeline;
    const groups = [];
    return {
      setPipeline(p) {
        pipeline = p;
      },
      setBindGroup(i, g) {
        groups[i] = g;
      },
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed() {
        draws.push({ pipeline, groups: groups.slice() });
      },
      end() {},
    };
  };
  return {
    ...gpu,
    engine,
    device,
    model,
    context,
    draws,
    frame(mode = 'beauty') {
      model.draw(context, mode, context.color, context.depth);
    },
  };
}

function mapped(f) {
  const buffer = f.device.createBuffer({ size: 560, usage: GPUBufferUsage.UNIFORM }),
    resource = { buffer };
  const shading = {
    replacesTextures: true,
    texturedTint: true,
    shader(source, group) {
      return (
        `@group(${group}) @binding(200) var<uniform> physicalTest:vec4f;\n` +
        source
          .replace(/@group\(1\) @binding\(\d+\) var \w+:[^;]+;\n?/g, '')
          .replace(/textureSample\(\w+Map,\w+Sampler,uv\(i,f\.coords[AB]\.\w\)\)/g, 'physicalTest')
      );
    },
    bindings() {
      return [{ binding: 200, resource }];
    },
  };
  Object.assign(f.model.primitives[0].material, {
    shading,
    extendedFrame: true,
    ext: [0, 1.5, 0, 0],
    uvt: Array.from({ length: 13 }, () => textureTransform()).flat(),
    physical: [1, 0.2, 0.75, 0, 1, 1, 1, 1, 0, 0, 0, 0.3],
  });
  return { shading, resource };
}

test('texture replacement shading leaves native group 1 empty and refreshes its own live group 2', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const { resource } = mapped(f);
  f.frame();
  assert.deepEqual(f.draws[0].groups[1].entries, []);
  assert.equal(f.model.resources[0].views.length, 0);
  const shadow = f.model.shadowPrimitives[0],
    picking = f.model.pickingPrimitives[0];
  assert.equal(shadow.alphaTexture, undefined, 'Auxiliary consumers retain their neutral fallback');
  assert.equal(picking.alphaTexture, undefined);
  assert.equal(shadow.alpha, f.model.primitives[0].material.base[3]);
  assert.equal(picking.alpha, shadow.alpha);
  assert.equal(f.model.resources[0].values[210], 0.75, 'Mapped clearcoat normal keeps its authored scale');
  resource.offset = 256;
  resource.size = 16;
  f.frame();
  assert.equal(f.draws.at(-1).groups[2].entries[0].resource.offset, 256);
  assert.equal(f.draws[0].groups[2].entries[0].resource.offset, undefined);
});

test('mapped tint draws bind the same local, scene and extension resource groups as beauty', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  mapped(f);
  const m = f.model.primitives[0].material;
  m.tint = [0.5, 0.5, 0.5];
  m.volume = [0.2, 0.8, 0.9, 1];
  m.extension = { factors: new Float32Array([1, 0, 0, 0]) };
  const buffer = f.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  f.model.addLighting({
    pbr: () => ({ declarations: '@group(2) @binding(4) var<uniform> sceneTest:vec4f;', light: 'sceneTest.rgb' }),
    bindings: () => [{ binding: 4, resource: { buffer } }],
  });
  f.frame();
  assert.equal(f.draws.length, 2);
  const [tint, beauty] = f.draws;
  assert.equal(tint.pipeline.fragment.entryPoint, 'margoTint');
  for (const index of [0, 1, 2, 3])
    assert.deepEqual(tint.groups[index]?.entries, beauty.groups[index]?.entries, `group ${index}`);
  assert.equal(tint.pipeline.fragment.constants.margoFaceTest, 0);
  const code = tint.pipeline.fragment.module.code;
  assert.match(code, /@fragment fn margoTint\(i:Out,@builtin\(front_facing\) front:bool\)/);
  assert.match(code, /_=&?sceneTest/);
  assert.match(code, /_=&?materialFactors/);
});

test('physical Surface carries a neutral thickness multiplier', () => {
  const code = factorPhysicalShader();
  assert.match(code, /th:f32/);
  assert.match(code, /s\.th=1/);
});

test('physical map shader deduplicates textures and samplers while sampling each logical UV and channel', async () => {
  const module = await import('../../materials/src/physical-maps.ts');
  const slots = Array.from({ length: 17 }, (_, k) => [k % 3, k % 2]);
  const code = module.physicalMapsShader(factorPhysicalShader(), 2, slots);
  assert.equal((code.match(/var \w+:texture_2d<f32>/g) ?? []).length, 3);
  assert.equal((code.match(/var \w+:sampler/g) ?? []).length, 2);
  assert.doesNotMatch(code, /@group\(1\)/);
  assert.match(code, /@group\(2\) @binding\(200\).*var<uniform>/);
  assert.match(code, /uvt:array<vec4f,34>,volume:vec4f/);
  for (const k of [201, 202, 203, 240, 241]) assert.match(code, new RegExp(`@binding\\(${k}\\)`));
  for (const k of Array.from({ length: 13 }, (_, j) => j).concat(16))
    assert.match(code, new RegExp(`margoPhysicalUV\\(i,${k}\\)`));
  assert.match(code, /s\.th=textureSample\([^;]*margoPhysicalUV\(i,16\)\)\.g/);
  assert.match(code, /s\.cn=normalize\(margoPhysicalFrame\(i,n,7\)/);
});

test('advanced physical maps use independent anisotropy and iridescence texture coordinates', async () => {
  const { physicalMapsShader } = await import('../../materials/src/physical-maps.ts');
  const source = extendedShader(extendedPlan([], { iridescence: true, anisotropy: true, diffuseTransmission: false }));
  const slots = Array.from({ length: 17 }, (_, k) => (k >= 13 && k <= 15 ? [0, 0] : null));
  const code = physicalMapsShader(source, 2, slots);
  for (const k of [13, 14, 15]) assert.match(code, new RegExp(`margoPhysicalUV\\(i,${k}\\)`));
  assert.match(code, /margoPhysicalFrame\(i,n,15\)/);
  assert.doesNotMatch(code, /margoAnisotropy\(s\.n,t,b,/);
  assert.match(code, /orientation=sign\(dot\(cross\(dp1,dp2\),n\)\)/);
  assert.match(code, /if\(largest>0\)/);
});

test('removing the anisotropy map restores the authored tangent frame', async () => {
  const { physicalMapsShader } = await import('../../materials/src/physical-maps.ts');
  const source = extendedShader(extendedPlan([], { iridescence: false, anisotropy: true, diffuseTransmission: false }));
  const slots = Array(17).fill(null);
  const untextured = physicalMapsShader(source, 2, slots);
  assert.match(untextured, /margoAnisotropy\(s\.n,t,b,vec4f\(1,0\.5,1,1\)\.xyz\)/);
  slots[15] = [0, 0];
  assert.match(physicalMapsShader(source, 2, slots), /margoAnisotropy\(s\.n,margoPhysicalFrame\(i,n,15\)/);
  slots[15] = null;
  assert.equal(physicalMapsShader(source, 2, slots), untextured);
});

test('mapped tint retains resource declarations with either WGSL attribute order and whitespace', async () => {
  const { texturedTintPBR } = await import('../src/shader.ts');
  const code = texturedTintPBR(`
@binding(7) @group(2) var<uniform> reversed:vec4f;
@group( 3 )\n@binding( 1 ) var<storage, read> spaced:array<vec4f>;
@fragment fn margoTint(i:Out)->@location(0) vec4f {return vec4f(1);}`);
  assert.match(code, /_=&reversed;/);
  assert.match(code, /_=&spaced;/);
});

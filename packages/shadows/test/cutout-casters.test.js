// What a materials mesh hands the shadow passes: the cut-out for a material that tests alpha, nothing new for the rest.
// cutout-casters-browser.mjs measures the pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, Texture, createMesh } from '../../materials/dist/index.js';
import { opacityCode, opacityDepth, opacityEntries, solidVertexDepth } from '../../shared/caster.js';
import { instancedDepth } from '../../shared/instances.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1],
  indices: [0, 1, 2],
};
const texture = () => new Texture({ data: new Uint8Array(4).fill(255), width: 1, height: 1 });

async function scene() {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  return {
    engine,
    caster(options) {
      return createMesh(engine, quad, new Material(options));
    },
    close() {
      engine.dispose();
      h.cleanup();
    },
  };
}

test('a material with a map and alphaTest casts its map, UV rows and threshold', async () => {
  const s = await scene();
  try {
    const material = { map: texture(), alphaTest: 0.4, uvTransform: { offset: [0.25, 0], texCoord: 1 } },
      [p] = s.caster(material).shadowPrimitives;
    assert.equal(p.cutoff, 0.4);
    assert.equal(p.texCoord, 1);
    assert.equal(p.alphaTransform.length, 8);
    assert.equal(p.alphaTransform[2], 0.25);
    assert.equal(p.opacity, undefined);
    assert.equal(p.dynamic, false);
    const white = s.caster({}).shadowPrimitives[0];
    assert.notEqual(p.alphaTexture, white.alphaTexture, 'the map, not the default white');
  } finally {
    s.close();
  }
});

test('an alphaMap reaches the caster as its opacity, which redraws every frame', async () => {
  const s = await scene();
  try {
    const [p] = s.caster({ alphaMap: texture(), alphaTest: 0.5 }).shadowPrimitives;
    assert.ok(p.opacity.buffer && p.opacity.view && p.opacity.sampler);
    assert.equal(p.dynamic, true);
  } finally {
    s.close();
  }
});

test('opaque, blended and triplanar materials keep the plain caster', async () => {
  const s = await scene();
  try {
    const plain = s.caster({}).shadowPrimitives[0];
    assert.equal(plain.cutoff, 0);
    assert.equal(plain.alphaTransform, undefined);
    assert.equal(plain.opacity, undefined);
    // A map without alphaTest: drawn whole, so no mask, no UV rows and no shader variant.
    const mapped = s.caster({ map: texture() }).shadowPrimitives[0];
    assert.equal(mapped.cutoff, 0);
    assert.equal(mapped.alphaTransform, undefined);
    assert.equal(s.caster({ map: texture(), alphaTest: 0.5, transparent: true }).shadowPrimitives.length, 0);
    const triplanar = s.caster({ map: texture(), alphaTest: 0.5, triplanar: true }).shadowPrimitives[0];
    assert.equal(triplanar.alphaTransform, undefined);
  } finally {
    s.close();
  }
});

test('editing a mesh material keeps one mask object, so caster reads allocate nothing new', async () => {
  const s = await scene();
  try {
    const material = new Material({ map: texture(), alphaTest: 0.5 }),
      mesh = createMesh(s.engine, quad, material);
    const first = mesh.shadowPrimitives[0].alphaTransform;
    assert.equal(mesh.shadowPrimitives[0].alphaTransform, first);
    material.setUVTransform({ offset: [0.5, 0] });
    assert.equal(mesh.shadowPrimitives[0].alphaTransform, first);
    assert.equal(first[2], 0.5);
    material.alphaTest = 0;
    assert.equal(mesh.shadowPrimitives[0].alphaTransform, undefined);
  } finally {
    s.close();
  }
});

test('vertexColors false keeps vertex alpha out of a cutting caster, and only a cutting one', async () => {
  const s = await scene();
  try {
    const material = new Material({ alphaTest: 0.5, vertexColors: false }),
      mesh = createMesh(s.engine, quad, material);
    assert.equal(mesh.shadowPrimitives[0].vertexAlpha, false);
    material.vertexColors = true;
    assert.equal(mesh.shadowPrimitives[0].vertexAlpha, undefined);
    assert.equal(s.caster({ vertexColors: false }).shadowPrimitives[0].vertexAlpha, undefined, 'nothing to cut');
  } finally {
    s.close();
  }
});

test('a mesh picks through what its colour pass leaves out', async () => {
  const s = await scene();
  try {
    const material = { map: texture(), alphaTest: 0.4, uvTransform: { offset: [0.25, 0], texCoord: 1 } },
      mesh = s.caster(material),
      [p] = mesh.pickingPrimitives,
      [cast] = mesh.shadowPrimitives;
    assert.equal(p.alphaTexture, cast.alphaTexture, 'the map, not the default white');
    assert.equal(p.alphaSampler, cast.alphaSampler);
    assert.equal(p.texCoord, 1);
    assert.equal(p.alphaTransform[2], 0.25);
    assert.ok(s.caster({ alphaMap: texture(), alphaTest: 0.5 }).pickingPrimitives[0].opacity.view);
    // Blended holes pick through and cast nothing, as before.
    const blended = s.caster({ map: texture(), transparent: true });
    assert.equal(blended.pickingPrimitives[0].alphaTransform?.length, 8);
    assert.equal(blended.pickingPrimitives[0].cutoff, 0.001);
    assert.equal(s.caster({ alphaTest: 0.5, vertexColors: false }).pickingPrimitives[0].vertexAlpha, false);
    const plain = s.caster({}).pickingPrimitives[0];
    assert.equal(plain.alphaTransform, undefined);
    assert.equal(plain.opacity, undefined);
    assert.equal(plain.vertexAlpha, undefined);
  } finally {
    s.close();
  }
});

test('solidVertexDepth takes vertex alpha out, whatever else the caster does', () => {
  const plain = '@location(4) color:vec4f @vertex fn vertex(i:In)->Out {o.alpha=i.color.a;return o;}';
  assert.match(solidVertexDepth(plain), /o\.alpha=1\.0;/);
  // An instance's tint still multiplies in.
  assert.match(solidVertexDepth(instancedDepth(plain)), /o\.alpha=1\.0\*i\.tint\.a;/);
});

test('opacityDepth reads every sampling form the caster passes use', () => {
  const shape = (sample) =>
    `struct PickOut {a:f32}struct Out {b:f32}o.uv=select(i.uv.xy,i.uv.zw,f.x);let alpha=${sample}.a*f.alpha.x;`;
  for (const sample of ['textureSampleLevel(m,s,i.uv,0)', 'textureSample(m,s,i.uv)', 'textureSample(m,s,uv)'])
    assert.match(opacityDepth(shape(sample), 0), /\.a\*margoOpacityAt\(i\.margoUV\)\*f\.alpha\.x/);
  // A pass whose binding 4 is taken moves the map.
  assert.match(opacityCode(0, 5), /@binding\(5\) var<uniform> margoOpacity/);
  assert.deepEqual(
    opacityEntries({ buffer: {}, view: {}, sampler: {} }, 5).map((e) => e.binding),
    [5, 6, 7],
  );
});

test('opacityDepth adds the opacity map to a caster depth shader', () => {
  // The shape the three caster passes share (shadows' shader.ts, clustered's two).
  const fragment =
      '@fragment fn fragment(i:Out){if(textureSampleLevel(alphaMap,alphaSampler,i.uv,0).a*f.alpha.x*i.alpha<f.alpha.y){discard;}}',
    head = 'struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}',
    plain = `${head}@location(4) color:vec4f @vertex fn vertex(i:In)->Out {var o:Out;o.clip=f.camera*f.model*vec4f(i.position.xyz,1);o.uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);o.alpha=i.color.a;return o;}${fragment}`,
    core = `${head}@vertex fn vertex(i:In)->Out {var o:Out;o.uv=vec2f(0);o.alpha=1;return o;}${fragment}`,
    out = opacityDepth(plain, 0);
  assert.match(out, /@group\(0\) @binding\(4\) var<uniform> margoOpacity:MargoOpacity/);
  assert.match(out, /o\.margoUV=i\.uv;o\.uv=select\(/);
  assert.match(out, /\.a\*margoOpacityAt\(i\.margoUV\)\*f\.alpha\.x/);
  assert.match(opacityDepth(instancedDepth(plain), 0), /o\.margoUV=o\.margoUV\*i\.uvt\.xyxy\+i\.uvt\.zwzw;/);
  assert.throws(() => opacityDepth(core, 0), /80-byte/);
  const buffer = {},
    view = {},
    sampler = {};
  assert.deepEqual(
    opacityEntries({ buffer, view, sampler }).map((e) => e.binding),
    [4, 5, 6],
  );
});

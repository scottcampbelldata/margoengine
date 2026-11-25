import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { meshPBR, traceSceneFromGLTF } from '../dist/mesh-pbr.js';
import { fakeEngine, simpleScene } from './support.js';
import { checkWGSL } from '@margoengine/webgl2-compat/wgsl';
import { runComputeOnCPU } from '@margoengine/webgl2-compat/compute';
function scene() {
  return {
    ...simpleScene(),
    meshes: [
      {
        id: 'tri',
        material: 1,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      },
    ],
    pbrMaterials: [
      { id: 1, metallicFactor: 0, baseColorTexture: { width: 1, height: 1, data: new Uint8Array([128, 64, 32, 255]) } },
    ],
  };
}
function packet(h) {
  const w = h.device.buffers.map((b) => new Uint32Array(b.data)).find((w) => w[2] > 0 && w[w[2] + 9] === 0x4d494e53);
  assert.ok(w);
  return w.slice(w[2]);
}
test('PBR builder owns channel packets over the shared BLAS', async () => {
  const h = fakeEngine(),
    s = scene(),
    feature = meshPBR(),
    codes = [];
  const make = h.device.createShaderModule.bind(h.device);
  h.device.createShaderModule = (d) => {
    codes.push(d.code);
    return make(d);
  };
  const p = ComposedVoxelPathTracer.create(h.engine, { scene: s, features: [feature], denoise: false });
  s.pbrMaterials[0].baseColorTexture.data.fill(0);
  const t = await p;
  await t.ready;
  h.frame();
  try {
    const w = packet(h),
      r = w[w[5] + 29];
    assert.equal(w[r], 1);
    const texture = w[r + 16];
    assert.equal(w[w[texture + 2]], 0xff204080);
    const record = w[5];
    assert.ok(w[record + 28] > w[10]);
    assert.equal(t.stats.meshTriangles, 1);
    assert.equal(t.stats.meshInstances, 1);
    const sources = codes.join('\n');
    assert.match(sources, /if\(!pbrVisible\(candidate,back,t\)\)\{continue;\}/);
    assert.match(sources, /m=pbrMaterial\(h,lp,m\)/);
    assert.doesNotMatch(sources, /fn pbrMaterial[\s\S]*?m=pbrMaterial\(h,lp,m\);return m;/);
    for (const code of codes) checkWGSL(code);
    const code = codes.find((s) => s.includes('fn pbrMaterial'));
    const words = h.device.buffers
      .map((b) => new Uint32Array(b.data))
      .find((w) => w[2] > 0 && w[w[2] + 9] === 0x4d494e53);
    const out = new Float32Array(4);
    runComputeOnCPU({
      source:
        code +
        `
@group(3) @binding(0) var<storage,read_write> probe:array<vec4f>;
@compute @workgroup_size(1) fn pbr_probe(){
 let g=scene[2];let placement=g+scene[g+5u];let head=g+scene[placement+24u];
 var h:Hit;h.inst=TRIANGLE;h.value=1u;h.mesh=placement;h.meshHead=head;h.tri=head+scene[head+1u];h.bary=vec2f(.2,.3);
 let m=pbrMaterial(h,vec3f(0.0),material(1u));probe[0]=vec4f(m.color,m.metal);
}`,
      entryPoint: 'pbr_probe',
      workgroups: [1],
      workBudget: 100000,
      buffers: new Map([
        ['0:3', words],
        ['0:1', new Float32Array(8192)],
        ['0:4', new Float32Array(4)],
        ['3:0', out],
      ]),
    });
    const linear = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - linear([128, 64, 32][i] / 255)) < 1e-6);
    assert.equal(out[3], 0);
  } finally {
    t.dispose();
  }
});
test('PBR rejects malformed channels before committing a replacement', async () => {
  const h = fakeEngine(),
    t = await ComposedVoxelPathTracer.create(h.engine, { scene: scene(), features: [meshPBR()] });
  try {
    await t.ready;
    h.frame();
    const old = packet(h);
    const s = scene();
    s.pbrMaterials[0].baseColorTexture.data = new Uint8Array(3);
    await assert.rejects(t.setScene(s), /exact RGBA8/);
    assert.deepEqual(packet(h), old);
  } finally {
    t.dispose();
  }
});

async function probeScene(s, body, size = 16) {
  const h = fakeEngine(),
    codes = [],
    make = h.device.createShaderModule.bind(h.device);
  h.device.createShaderModule = (d) => {
    codes.push(d.code);
    return make(d);
  };
  const t = await ComposedVoxelPathTracer.create(h.engine, { scene: s, features: [meshPBR()], denoise: false });
  try {
    await t.ready;
    h.frame();
    const words = h.device.buffers
      .map((b) => new Uint32Array(b.data))
      .find((w) => w[2] > 0 && w[w[2] + 9] === 0x4d494e53);
    const out = new Float32Array(size),
      code = codes.find((s) => s.includes('fn pbrMaterial'));
    runComputeOnCPU({
      source:
        code +
        `
@group(3) @binding(0) var<storage,read_write> probe:array<vec4f>;
@compute @workgroup_size(1) fn pbr_probe(){
 let g=scene[2];let placement=g+scene[g+5u];let head=g+scene[placement+24u];
 var h:Hit;h.inst=TRIANGLE;h.value=1u;h.mesh=placement;h.meshHead=head;h.tri=head+scene[head+1u];h.bary=vec2f(.2,.3);h.sgn=1.0;
 ${body}
}`,
      entryPoint: 'pbr_probe',
      workgroups: [1],
      workBudget: 100000,
      buffers: new Map([
        ['0:3', words],
        ['0:1', new Float32Array(8192)],
        ['0:4', new Float32Array(4)],
        ['3:0', out],
      ]),
    });
    return out;
  } finally {
    t.dispose();
  }
}
test('PBR data maps remain linear and emission maps decode independently', async () => {
  const s = scene();
  Object.assign(s.pbrMaterials[0], {
    metallicFactor: 0.8,
    roughnessFactor: 0.5,
    metallicRoughnessTexture: { width: 1, height: 1, data: new Uint8Array([0, 128, 64, 255]) },
    emissiveTexture: { width: 1, height: 1, data: new Uint8Array([128, 255, 0, 255]) },
    emissiveFactor: [2, 1, 3],
    emissiveStrength: 4,
  });
  const a = await probeScene(
    s,
    'let m=pbrMaterial(h,vec3f(0.0),material(1u));probe[0]=vec4f(m.emission,m.metal);probe[1]=vec4f(m.alpha);',
  );
  assert.ok(Math.abs(a[0] - 8 * ((128 / 255 + 0.055) / 1.055) ** 2.4) < 2e-6);
  assert.equal(a[1], 4);
  assert.equal(a[2], 0);
  assert.ok(Math.abs(a[3] - (0.8 * 64) / 255) < 1e-6);
  assert.ok(Math.abs(a[4] - ((0.5 * 128) / 255) ** 2) < 1e-6);
});
test('PBR alpha cutoff and sidedness use the same candidate path for all ray kinds', async () => {
  for (const alpha of [127, 128])
    for (const doubleSided of [false, true]) {
      const s = scene();
      Object.assign(s.pbrMaterials[0], { alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided });
      s.pbrMaterials[0].baseColorTexture.data[3] = alpha;
      const a = await probeScene(
        s,
        'probe[0]=vec4f(f32(pbrVisible(h,false,1.0)),f32(pbrVisible(h,true,1.0)),0.0,0.0);',
      );
      assert.equal(a[0], Number(alpha === 128));
      assert.equal(a[1], Number(alpha === 128 && doubleSided));
    }
});
test('PBR BLEND keeps a candidate with probability equal to its coverage (stochastic transparency)', async () => {
  // 4096 rays (rng states); the kept share follows coverage, both ends exactly. Two layers at t 1 and 2 on one ray
  // decide apart (both kept c^2 of the time); two edge-sharing triangles a few ulps apart in t decide alike.
  const body = `var kept=0u;var both=0u;var alike=0u;for(var i=0u;i<4096u;i++){rng=hash(i*2654435761u);
  let a=pbrVisible(h,false,1.0);if(a){kept++;}if(a&&pbrVisible(h,false,2.0)){both++;}
  if(pbrVisible(h,false,3.0)==pbrVisible(h,false,bitcast<f32>(bitcast<u32>(3.0)+2u))){alike++;}}
  probe[0]=vec4f(f32(kept),f32(both),f32(alike),pbrEmitterRadiance(h,vec3f(0.0,0.0,1.0)).x);`;
  for (const [alpha, factor] of [
    [0, 1],
    [255, 0.25],
    [255, 1],
    [64, 1],
  ]) {
    const s = scene();
    Object.assign(s.pbrMaterials[0], {
      alphaMode: 'BLEND',
      alphaCutoff: 0.99,
      baseColorFactor: [1, 1, 1, factor],
      emissiveFactor: [1, 1, 1],
      doubleSided: true,
    });
    s.pbrMaterials[0].baseColorTexture.data[3] = alpha;
    const coverage = (alpha / 255) * factor,
      a = await probeScene(s, body, 4);
    // Binomial: 4 standard deviations of a 4096-ray share is at most 0.032.
    assert.ok(Math.abs(a[0] / 4096 - coverage) < 0.032, `coverage ${coverage}: kept ${a[0] / 4096}`);
    if (coverage === 0) assert.equal(a[0], 0);
    if (coverage === 1) assert.equal(a[0], 4096);
    assert.ok(Math.abs(a[1] / 4096 - coverage ** 2) < 0.032, `layers ${a[1] / 4096} for ${coverage ** 2}`);
    assert.equal(a[2], 4096);
    // A sampled light point emits its expected coverage, not a random part of it.
    assert.ok(Math.abs(a[3] - coverage) < 1e-6, `emission ${a[3]} for coverage ${coverage}`);
  }
});
test('PBR BLEND is written as mode 2 and glTF BLEND materials load as BLEND', async () => {
  const s = scene();
  s.pbrMaterials[0].alphaMode = 'BLEND';
  const a = await probeScene(s, 'let r=pbrRecord(h);probe[0]=vec4f(f32(scene[r+1u]),0.0,0.0,0.0);', 4);
  assert.equal(a[0], 2);
  s.pbrMaterials[0].alphaMode = 'ADD';
  await assert.rejects(
    ComposedVoxelPathTracer.create(fakeEngine().engine, { scene: s, features: [meshPBR()] }),
    /OPAQUE, MASK or BLEND/,
  );
  const vertices = new Float32Array(60);
  for (let i = 0; i < 3; i++) vertices.set([i === 1 ? 1 : 0, i === 2 ? 1 : 0, 0, 1, 0, 0, 1, 0], i * 20);
  const model = {
    asset: { doc: { materials: [{ alphaMode: 'BLEND' }] } },
    primitives: [{ definition: { material: 0 }, material: {} }],
    image: () => undefined,
    readPickingGeometry: async () => [
      { primitiveIndex: 0, vertices, indices: new Uint32Array([0, 1, 2]), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    ],
  };
  const g = await traceSceneFromGLTF(model);
  assert.equal(g.pbrMaterials[0].alphaMode, 'BLEND');
});
test('PBR UV sets, wrap modes, transforms and linear-light bilinear reconstruction', async () => {
  for (const [wrapS, expected] of [
    ['repeat', [0, 0, 1]],
    ['mirror', [1, 0, 0]],
    ['clamp', [1, 0, 0]],
  ]) {
    const s = scene();
    s.meshes[0].uvSets = [s.meshes[0].uvs, new Float32Array([-0.25, 0, -0.25, 0, -0.25, 0])];
    s.pbrMaterials[0].baseColorTexture = {
      width: 2,
      height: 1,
      data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      texCoord: 1,
      wrapS,
      filter: 'nearest',
    };
    const a = await probeScene(s, 'probe[0]=pbrTexture(h,pbrRecord(h),0u,true);');
    assert.deepEqual(Array.from(a.slice(0, 3)), expected);
  }
  const s = scene();
  s.meshes[0].uvs.fill(0);
  s.pbrMaterials[0].baseColorTexture = {
    width: 2,
    height: 1,
    data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
    transform: [1, 0, 0.5, 0, 1, 0],
    filter: 'linear',
  };
  const a = await probeScene(s, 'probe[0]=pbrTexture(h,pbrRecord(h),0u,true);');
  assert.deepEqual(Array.from(a.slice(0, 4)), [0.5, 0, 0.5, 1]);
});
test('PBR tangent-space normal uses the world surface frame', async () => {
  const s = scene();
  s.pbrMaterials[0].normalTexture = { width: 1, height: 1, data: new Uint8Array([255, 128, 255, 255]) };
  const a = await probeScene(s, 'probe[0]=vec4f(pbrNormal(h),1.0);');
  const length = Math.hypot(1, 1 / 255, 1);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - [1, 1 / 255, 1][i] / length) < 1e-6);
});
test('mesh material ids are independent of the 255-entry voxel palette', async () => {
  const s = scene();
  s.meshes[0].material = 1_000_000_000_001;
  s.pbrMaterials[0].id = 1_000_000_000_001;
  const a = await probeScene(s, 'let m=pbrMaterial(h,vec3f(0.0),material(1u));probe[0]=vec4f(m.color,1.0);');
  const linear = (x) => ((x + 0.055) / 1.055) ** 2.4;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - linear([128, 64, 32][i] / 255)) < 1e-6);
});
test('loaded glTF snapshots material channels and explicit affine placements before waiting', async () => {
  const vertices = new Float32Array(60);
  for (let i = 0; i < 3; i++)
    vertices.set(
      [
        i === 1 ? 1 : 0,
        i === 2 ? 1 : 0,
        0,
        1,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        1,
        i === 1 ? 1 : 0,
        i === 2 ? 1 : 0,
        0,
        0,
        1,
        1,
        1,
        1,
      ],
      i * 20,
    );
  const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const matrix = identity();
  matrix[13] = 2;
  const rows = new Float32Array(24);
  rows.set(identity());
  rows[12] = 3;
  const primitive = { definition: { material: 0 }, material: {}, instances: { data: rows, count: 1 } };
  const doc = {
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.2, 0.4, 0.6, 1],
          metallicFactor: 0.5,
          roughnessFactor: 0.25,
          baseColorTexture: { index: 0 },
        },
      },
    ],
    textures: [{ source: 0 }],
  };
  let decoded = 0;
  const model = {
    asset: { doc },
    primitives: [primitive],
    image: () => ({ compressed: true }),
    async readPickingGeometry() {
      doc.materials[0].pbrMetallicRoughness.metallicFactor = 99;
      rows[12] = 999;
      return [{ primitiveIndex: 0, vertices, indices: new Uint32Array([0, 1, 2]), matrix }];
    },
  };
  const s = await traceSceneFromGLTF(model, {
    imagePixels: async () => {
      decoded++;
      return { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
    },
  });
  assert.equal(decoded, 1);
  assert.equal(s.pbrMaterials[0].metallicFactor, 0.5);
  assert.equal(s.meshInstances[0].transform[12], 3);
  assert.equal(s.meshInstances[0].transform[13], 2);
  assert.deepEqual(Array.from(s.meshes[0].positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const t = await ComposedVoxelPathTracer.create(fakeEngine().engine, { scene: s, features: [meshPBR()] });
  t.dispose();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(traceSceneFromGLTF(model, { signal: controller.signal }), { name: 'AbortError' });
});
test('loaded glTF cancellation stops a pending readback without taking ownership of the model', async () => {
  const controller = new AbortController();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const model = {
    asset: { doc: {} },
    primitives: [],
    readPickingGeometry: () => pending,
    image: () => {
      throw Error('no images');
    },
  };
  const result = traceSceneFromGLTF(model, { signal: controller.signal });
  controller.abort(new Error('cancel pending model snapshot'));
  await assert.rejects(result, /cancel pending model snapshot/);
  release([]);
});

// KB5451: pbrMaterial read its twelve texture slots through twelve inlined copies of the bilinear filter, and
// Direct3D's compiler (ANGLE's default on Windows) took minutes over the staged surface program that holds them. One
// copy now runs in a loop whose bound is the record's slot count, a word the shader reads, so no compiler unrolls it.
test('pbrMaterial reads every texture slot through one filter call in a loop bounded by the record (KB5451)', async () => {
  const h = fakeEngine(),
    codes = [],
    make = h.device.createShaderModule.bind(h.device);
  h.device.createShaderModule = (d) => {
    codes.push(d.code);
    return make(d);
  };
  const t = await ComposedVoxelPathTracer.create(h.engine, { scene: scene(), features: [meshPBR()], denoise: false });
  try {
    await t.ready;
    h.frame();
    const code = codes.find((s) => s.includes('fn pbrMaterial'));
    const start = code.indexOf('fn pbrMaterial(');
    const body = code.slice(start, code.indexOf('\nfn ', start + 1));
    assert.equal(body.match(/pbrTexture\(/g)?.length, 1, 'one filter call');
    assert.match(body, /for\(var slot=0u;slot<scene\[r\+3u\];slot\+\+\)\{[^]*pbrTexture\(h,r,slot,/);
    assert.doesNotMatch(body, /pbrMappedNormal\(/);
    const w = packet(h),
      r = w[w[5] + 29];
    assert.equal(w[r + 3], 13, 'the record holds the slot count');
  } finally {
    t.dispose();
  }
});
test('pbrMaterial gives the same values as one filter call per slot (KB5451)', async () => {
  const s = scene(),
    px = (...v) => ({ width: 2, height: 2, filter: 'linear', data: new Uint8Array(v) });
  const maps = [
    'baseColorTexture',
    'metallicRoughnessTexture',
    'normalTexture',
    'emissiveTexture',
    'clearcoatTexture',
    'clearcoatRoughnessTexture',
    'clearcoatNormalTexture',
    'sheenColorTexture',
    'sheenRoughnessTexture',
    'specularTexture',
    'specularColorTexture',
    'iridescenceTexture',
    'iridescenceThicknessTexture',
  ];
  maps.forEach((name, i) => {
    s.pbrMaterials[0][name] = px(...Array.from({ length: 16 }, (_, k) => (37 * i + 53 * k + 11) % 256));
  });
  Object.assign(s.pbrMaterials[0], {
    metallicFactor: 0.7,
    roughnessFactor: 0.6,
    emissiveFactor: [0.5, 0.25, 1],
    clearcoatFactor: 0.8,
    clearcoatRoughnessFactor: 0.4,
    clearcoatNormalScale: 0.9,
    sheenColorFactor: [0.3, 0.6, 0.9],
    sheenRoughnessFactor: 0.5,
    specularFactor: 0.75,
    specularColorFactor: [1, 0.5, 0.25],
    iridescenceFactor: 0.6,
  });
  const a = await probeScene(
    s,
    `
 let r=pbrRecord(h);let m=pbrMaterial(h,vec3f(0.0),material(1u));
 probe[0]=vec4f(m.color,m.metal);probe[1]=vec4f(m.emission,m.alpha);probe[2]=vec4f(pbrLayer.coatN,pbrLayer.coat);
 probe[3]=vec4f(pbrLayer.sheen,pbrLayer.sheenR);probe[4]=vec4f(pbrLayer.specRGB,pbrLayer.specWeight);
 probe[5]=vec4f(pbrLayer.film,pbrLayer.coatAlpha);
 let base=vec3f(fl(r+4u),fl(r+5u),fl(r+6u))*pbrTexture(h,r,0u,true).rgb*pbrAttribute(h,12u).rgb;
 let rough=fl(r+13u)*pbrTexture(h,r,1u,false).g;let coatRough=fl(r+33u)*pbrTexture(h,r,5u,false).g;
 probe[6]=vec4f(base,fl(r+12u)*pbrTexture(h,r,1u,false).b);
 probe[7]=vec4f(vec3f(fl(r+8u),fl(r+9u),fl(r+10u))*fl(r+11u)*pbrTexture(h,r,3u,true).rgb,max(1e-6,rough*rough));
 probe[8]=vec4f(pbrMappedNormal(h,6u,fl(r+34u)),fl(r+32u)*pbrTexture(h,r,4u,false).r);
 probe[9]=vec4f(vec3f(fl(r+36u),fl(r+37u),fl(r+38u))*pbrTexture(h,r,7u,true).rgb,fl(r+35u)*pbrTexture(h,r,8u,false).a);
 probe[10]=vec4f(vec3f(fl(r+40u),fl(r+41u),fl(r+42u))*pbrTexture(h,r,10u,true).rgb,fl(r+39u)*pbrTexture(h,r,9u,false).a);
 probe[11]=vec4f(fl(r+43u)*pbrTexture(h,r,11u,false).r,fl(r+44u),mix(fl(r+45u),fl(r+46u),pbrTexture(h,r,12u,false).g),coatRough*coatRough);`,
    48,
  );
  for (let i = 0; i < 24; i++) assert.ok(Object.is(a[i], a[i + 24]), `value ${i}: ${a[i]} vs ${a[i + 24]}`);
  assert.ok(a.slice(0, 24).every(Number.isFinite));
  assert.ok(a[7] > 0 && a[11] > 0 && a[15] > 0, 'textures reach the material');
});

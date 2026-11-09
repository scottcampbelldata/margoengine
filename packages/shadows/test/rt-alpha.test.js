import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '@margoengine/bvh';
import { sampleAlpha, modelAlphaMasks, AlphaRaycaster } from '@margoengine/bvh/alpha';
import { alphaWorldTriangles } from '@margoengine/bvh/alpha-triangles';
import { packRayTracedAlpha, createRayTracedAlpha, alphaRayTracedFilter } from '../dist/rt-alpha.js';
import { canTraceShadows } from '../dist/rt.js';
import { EFFECT_BINDING, effectEntries, moveEffects, shadowSampling } from '../src/shader.ts';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { decodePNG } from '../../../tests/support/png.js';
import { readFileSync } from 'node:fs';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4 };
const primitive = {},
  mask = { width: 2, height: 2, data: [0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0, 128] };
function triangles(count = 1) {
  return {
    vertices: new Float32Array(count * 9),
    indices: Uint32Array.from({ length: count * 3 }, (_, i) => i),
    uv: Float32Array.from({ length: count * 6 }, (_, i) => [0, 0, 1, 0, 0, 1][i % 6]),
    ranges: Array.from({ length: count }, (_, i) => ({ firstFace: i, faceCount: 1, primitive })),
  };
}
// Decode the CPU storage image, then use the existing independent bilinear alpha oracle.
const decodedMasks = new WeakMap();
function decoded(packed, face, bary) {
  const d = packed.data,
    f = new Float32Array(d.buffer),
    at = 4 + face * 8,
    material = d[at + 6];
  if (material === 0xffffffff) return { solid: true };
  const m = d[1] + material * 16;
  let cache = decodedMasks.get(packed);
  if (!cache) {
    cache = new Map();
    decodedMasks.set(packed, cache);
  }
  let pixels = cache.get(material);
  if (!pixels) {
    pixels = new Uint8Array(d[m] * d[m + 1] * 4);
    for (let p = 0; p < d[m] * d[m + 1]; p++) pixels[p * 4 + 3] = (d[d[m + 2] + (p >>> 2)] >>> ((p & 3) * 8)) & 255;
    cache.set(material, pixels);
  }
  const wraps = ['repeat', 'mirror', 'clamp'],
    uv = [0, 0];
  for (let v = 0; v < 3; v++) for (let axis = 0; axis < 2; axis++) uv[axis] += f[at + v * 2 + axis] * bary[v];
  const alpha = sampleAlpha(
    {
      width: d[m],
      height: d[m + 1],
      data: pixels,
      factor: f[m + 5],
      transform: [...f.subarray(m + 6, m + 12)],
      wrap: [wraps[d[m + 3] & 3], wraps[(d[m + 3] >>> 2) & 3]],
    },
    ...uv,
  );
  return { solid: alpha >= f[m + 4], alpha, uv };
}
function device(limits = {}) {
  const made = [],
    writes = [];
  return {
    made,
    writes,
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxStorageBufferBindingSize: 1 << 27,
      maxBufferSize: 1 << 28,
      ...limits,
    },
    createBuffer(d) {
      const b = {
        ...d,
        destroy() {
          this.destroyed = true;
        },
      };
      made.push(b);
      return b;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        writes.push({ buffer, offset, data: data.slice() });
      },
    },
  };
}
const bvhFor = (t) => MeshBVH.build({ positions: t.vertices, indices: t.indices });
test('alpha storage preserves UVs, masks, all wrap axes, transform, factor and threshold equality', {
  timeout: 30000,
}, () => {
  for (const u of ['repeat', 'mirror', 'clamp'])
    for (const v of ['repeat', 'mirror', 'clamp']) {
      const t = triangles(2),
        m = { ...mask, wrap: [u, v], transform: [0, -2, 0.25, 3, 0, -0.125], factor: 0.5, cutoff: 0.25 };
      t.uv.set([-3, 2.75, 5.5, -4, 0.5, 0.25]);
      const packed = packRayTracedAlpha(t, () => m);
      assert.equal(packed.maskCount, 1, 'shared identity is packed once');
      for (const bary of [
        [1, 0, 0],
        [0, 1, 0],
        [0.25, 0.5, 0.25],
      ]) {
        const actual = decoded(packed, 0, bary),
          expected = sampleAlpha(m, ...actual.uv);
        assert.equal(actual.alpha, expected);
        assert.equal(actual.solid, expected >= m.cutoff);
      }
    }
  for (const alpha of [127, 128, 255])
    for (const factor of [0, 0.5, 1])
      for (const cutoff of [0, 0.5, 1]) {
        const m = { width: 1, height: 1, data: [0, 0, 0, alpha], factor, cutoff };
        assert.equal(
          decoded(
            packRayTracedAlpha(triangles(), () => m),
            0,
            [0, 1, 0],
          ).solid,
          (alpha / 255) * factor >= cutoff,
        );
      }
  const opaque = packRayTracedAlpha(triangles(), () => null);
  assert.equal(opaque.maskCount, 0);
  assert.equal(decoded(opaque, 0, [1, 0, 0]).solid, true);
  assert.equal(packRayTracedAlpha(triangles(0), []).data.length, 4);
});
test('alpha storage rejects malformed ranges, UVs, byte data, fields and forged packed images', {
  timeout: 30000,
}, () => {
  for (const change of [
    { width: 0 },
    { height: 1.5 },
    { width: 1048577 },
    { data: [0, 0, 0, 255] },
    { cutoff: NaN },
    { factor: -1 },
    { factor: 2 },
    { transform: [1, 0] },
    { transform: [1, 0, Infinity, 0, 1, 0] },
    { wrap: ['repeat'] },
    { wrap: 'bad' },
    { data: mask.data.map((v, i) => (i ? v : 0.1)) },
  ])
    assert.throws(
      () => packRayTracedAlpha(triangles(), () => ({ ...mask, ...change })),
      (e) => e.code === 'failed',
    );
  for (const modify of [
    (t) => {
      t.uv[0] = NaN;
    },
    (t) => {
      t.uv = new Float32Array(0);
    },
    (t) => {
      t.ranges[0].firstFace = 1;
    },
    (t) => {
      t.ranges = [];
    },
    (t) => {
      t.ranges[0].faceCount = 2;
    },
  ]) {
    const t = triangles();
    modify(t);
    assert.throws(() => packRayTracedAlpha(t, () => mask), /rebuild/);
  }
  for (const modify of [
    (p) => {
      p.data[0] = 2;
    },
    (p) => {
      p.data[10] = 10;
    },
    (p) => {
      p.data[14] = 0xffffffff;
    },
    (p) => {
      p.data[p.data[1] + 2]++;
    },
    (p) => {
      p.data[p.data[1] + 3] = 3;
    },
  ]) {
    const p = packRayTracedAlpha(triangles(), () => mask);
    modify(p);
    assert.throws(() => createRayTracedAlpha(p), /Invalid packed/);
  }
});
test('a transparent nearest triangle retains farther and coplanar opaque candidates', { timeout: 30000 }, () => {
  const t = triangles(3),
    transparent = { width: 1, height: 1, data: [0, 0, 0, 0] },
    opaque = { width: 1, height: 1, data: [0, 0, 0, 255] };
  for (let face = 0; face < 3; face++) {
    const z = face === 1 ? 0 : 1;
    t.vertices.set([-1, -1, z, 1, -1, z, 0, 1, z], face * 9);
    t.ranges[face].primitive = { face };
  }
  const candidates = bvhFor(t).raycast({ origin: [0, 0, 3], direction: [0, 0, -1] });
  for (const coplanar of [false, true]) {
    const packed = packRayTracedAlpha(t, (p) => (p.face === 0 || (!coplanar && p.face === 2) ? transparent : opaque));
    const kept = candidates.find((h) => decoded(packed, h.faceIndex, h.barycoord).solid);
    assert.equal(kept.faceIndex, coplanar ? 2 : 1);
    assert.equal(kept.distance, coplanar ? 2 : 3);
  }
});
test('finite UVs and matrix fields cannot overflow alpha arithmetic, including forged images', {
  timeout: 30000,
}, () => {
  const t = triangles();
  t.uv.fill(1);
  assert.throws(() => packRayTracedAlpha(t, () => ({ ...mask, transform: [3e38, 3e38, 0, 0, 1, 0] })), /headroom/);
  const packed = packRayTracedAlpha(t, () => mask),
    floats = new Float32Array(packed.data.buffer);
  floats[packed.data[1] + 6] = 3e38;
  assert.throws(() => createRayTracedAlpha(packed), /headroom/);
  assert.doesNotThrow(() => packRayTracedAlpha(t, () => ({ ...mask, transform: [1e6, 1e6, 0, 0, 1, 0] })));
  assert.doesNotThrow(() => packRayTracedAlpha(t, () => null));
});
test('RT alpha owns snapshot resources, restores, frees partial setup and falls back with fewer than five buffers', {
  timeout: 30000,
}, () => {
  const t = triangles(),
    packed = packRayTracedAlpha(t, () => mask),
    bvh = bvhFor(t),
    first = device(),
    next = device(),
    coverage = createRayTracedAlpha(packed);
  const original = packed.data.slice();
  packed.data.fill(0);
  assert.throws(() => coverage.resources(), /setup/);
  coverage.setup(first);
  assert.deepEqual(first.writes[0].data, original);
  coverage.setup(next);
  assert.ok(first.made.every((b) => b.destroyed));
  coverage[Symbol.dispose]();
  coverage.dispose();
  assert.ok(next.made.every((b) => b.destroyed));
  const p = packRayTracedAlpha(t, () => mask),
    target = { gpu: device() },
    filter = alphaRayTracedFilter(target, bvh, p);
  const gpu = device();
  filter.setup(gpu);
  assert.equal(filter.resources().length, 7);
  assert.equal(effectEntries([filter]).length, 7);
  const shader = shadowSampling(1, filter, false, false, false, [filter]);
  assert.match(shader, /shadowFxAlphaAccept\(face, hit.xyz\)/);
  assert.doesNotMatch(shader, /\bbvh[A-Z]/);
  const moved = moveEffects(shader, (n) => n + 100);
  assert.ok(moved.includes(`@binding(${EFFECT_BINDING + 106})`));
  filter.setup(device());
  assert.ok(gpu.made.every((b) => b.destroyed));
  filter.dispose();
  const four = { gpu: device({ maxStorageBuffersInFragmentStage: 4 }) };
  assert.equal(canTraceShadows(four), true);
  assert.equal(canTraceShadows(four, true), false);
  assert.equal(alphaRayTracedFilter(four, bvh, p), 'soft');
  assert.equal(alphaRayTracedFilter({ gpu: null }, bvh, p, { fallback: 'pcf' }), 'pcf');
  const small = device({ maxBufferSize: p.data.byteLength - 1 }),
    c = createRayTracedAlpha(p);
  assert.throws(() => c.setup(small), /device buffer limits/);
  assert.equal(small.made.length, 0);
  const failedUpload = device(),
    standalone = createRayTracedAlpha(p);
  failedUpload.queue.writeBuffer = () => {
    throw new Error('upload failure');
  };
  assert.throws(() => standalone.setup(failedUpload), /upload failure/);
  assert.ok(failedUpload.made.every((b) => b.destroyed));
  assert.throws(() => standalone.resources(), /setup/);
  const failure = alphaRayTracedFilter(target, bvh, p),
    failing = device();
  const create = failing.createBuffer;
  failing.createBuffer = (d) => {
    if (d.size === p.data.byteLength) throw new Error('allocation failure');
    return create(d);
  };
  assert.throws(() => failure.setup(failing), /allocation failure/);
  assert.ok(failing.made.every((b) => b.destroyed));
  failure.dispose();
  assert.throws(() => alphaRayTracedFilter(target, bvhFor(triangles(2)), p), /face count/);
});

test('real Khronos cutout model packs the same holes and opaque hits as AlphaRaycaster, through leaf permutation', {
  timeout: 120000,
}, async () => {
  const bytes = readFileSync(
      new URL('../../../examples/assets/khronos/AlphaBlendModeTest/AlphaBlendModeTest.glb', import.meta.url),
    ),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true),
    doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()),
    binary = bytes.subarray(28 + jsonLength),
    images = [];
  for (const image of doc.images) {
    const b = doc.bufferViews[image.bufferView];
    // The three JPEGs are unrelated opaque RGB maps. Only image 3 is sampled by MASK materials.
    images.push(
      image.mimeType === 'image/png'
        ? {
            ...(await decodePNG(binary.subarray(b.byteOffset ?? 0, (b.byteOffset ?? 0) + b.byteLength))),
            close() {},
          }
        : { width: 1, height: 1, close() {} },
    );
  }
  assert.ok(
    doc.materials
      .filter((m) => m.alphaMode === 'MASK')
      .every(
        (m) => doc.images[doc.textures[m.pbrMetallicRoughness.baseColorTexture.index].source].mimeType === 'image/png',
      ),
  );
  const h = optionalGPU();
  h.engine.gpu.queue.copyExternalImageToTexture = () => {};
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(1024),
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 1, 7], target: [0, 1, 0] },
    null,
  );
  try {
    const model = new PBRModel(engine, new GLTFAsset(doc, [], binary), images);
    const source = await modelAlphaMasks(model, { pixels: (image) => image });
    assert.equal(source.skipped.length, 0);
    const t = alphaWorldTriangles(engine, [model]),
      packed = packRayTracedAlpha(t, [source]),
      bvh = bvhFor(t),
      raycaster = new AlphaRaycaster();
    raycaster.alphaMask = source;
    raycaster.firstHitOnly = true;
    assert.ok(packed.maskCount >= 3);
    assert.ok(
      bvh.triangles.some((face, i) => face !== i),
      'real tree permutes input faces',
    );
    let holes = 0,
      opaque = 0;
    for (let y = 0.05; y <= 2.6; y += 0.13)
      for (let x = -2.8; x <= 2.8; x += 0.11) {
        const origin = [x, y, 7],
          direction = [0, 0, -1],
          candidates = bvh.raycast({ origin, direction }),
          kept = candidates.find((hit) => decoded(packed, hit.faceIndex, hit.barycoord).solid),
          cpu = raycaster.set([x, y, 7], [0, 0, -1]).intersectObjects(engine, [model])[0];
        assert.equal(!!kept, !!cpu);
        if (kept) {
          assert.ok(Math.abs(kept.distance - cpu.distance) < 1e-5);
          opaque++;
        }
        if (candidates.length && !decoded(packed, candidates[0].faceIndex, candidates[0].barycoord).solid) holes++;
      }
    assert.ok(holes > 20, `real cutout rays: ${holes}`);
    assert.ok(opaque > 20, `opaque rays: ${opaque}`);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowSampling } from '../src/shader.ts';
import { Shadows, cascadeSplits, fitCascades } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

// Lines other packages repeat or rely on (environment/volumetric selects cascades the same way).
const contract = [
  'struct ShadowFrame {matrices:array<mat4x4f,4>,view:mat4x4f,splits:vec4f,ranges:vec4f,settings:vec4f}',
  'fn shadowVisibility(position:vec3f,normal:vec3f)->f32 {',
  'let depth=-(shadowFrame.view*vec4f(position,1)).z;',
  'let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);',
  'var reference=projected.z-shadowFrame.settings.y;',
  'fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return direct*shadowVisibility(position,normal);}',
];

async function harness(options) {
  const gpu = mockGPU(),
    store = await TransformStore.create(4),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' }),
    shadows = new Shadows({ resolution: 64, distance: 100, ...options });
  const setup = gpu.record(() => shadows.setup(engine));
  const frame = (i = 0) => {
    store.tick(false);
    view.begin(i);
    return gpu.record(() => passes(shadows)(view.c));
  };
  return {
    shadows,
    setup,
    frame,
    view,
    dispose() {
      shadows.dispose();
      engine.dispose();
    },
  };
}

test("'soft' stays the default; 'pcf' and 'hard' skip the blocker search and the spiral", () => {
  for (const group of [0, 2]) assert.equal(shadowSampling(group), shadowSampling(group, 'soft'));
  const pcf = shadowSampling(1, 'pcf'),
    hard = shadowSampling(1, 'hard');
  for (const source of [pcf, hard]) {
    for (const line of contract) assert.ok(source.includes(line), line);
    assert.doesNotMatch(source, /textureLoad|for\(|blockers|shadowGolden|sqrt\(|cos\(|sin\(|array<vec2f/);
    assert.ok(source.includes('reference-=dot(abs(slope),texel)*0.5;'), 'keeps the receiver-plane bias');
  }
  assert.equal(pcf.match(/textureSampleCompareLevel\(/g).length, 4, 'four hardware 2x2 comparison taps');
  assert.equal(hard.match(/textureSampleCompareLevel\(/g).length, 1, 'one hardware 2x2 comparison tap');
  // Half a texel each way on both axes: every tap's comparison depth follows the receiver plane.
  assert.ok(pcf.includes('let h=texel*0.5;let tapLayer=i32(cascade);let a=vec2f(h.x,-h.y);'));
  for (const tap of [
    'uv-h,tapLayer,reference-dot(h,slope)',
    'uv+h,tapLayer,reference+dot(h,slope)',
    'uv-a,tapLayer,reference-dot(a,slope)',
    'uv+a,tapLayer,reference+dot(a,slope)',
  ])
    assert.ok(pcf.includes(`textureSampleCompareLevel(shadowMap,shadowSampler,${tap})`), tap);
  assert.ok(pcf.includes(')*0.25;'));
  assert.ok(hard.includes('return textureSampleCompareLevel(shadowMap,shadowSampler,uv,i32(cascade),reference);'));
  // Two bilinear taps half a texel apart weigh texels 1:2:1 at a texel centre: a smooth three-texel edge.
  const bilinear = (p) => {
    const left = Math.floor(p - 0.5),
      t = p - 0.5 - left;
    return new Map([
      [left, 1 - t],
      [left + 1, t],
    ]);
  };
  const weights = new Map();
  for (const p of [2.5 - 0.5, 2.5 + 0.5])
    for (const [texel, w] of bilinear(p)) weights.set(texel, (weights.get(texel) ?? 0) + w / 2);
  assert.deepEqual(
    [...weights].filter(([, w]) => w > 0),
    [
      [1, 0.25],
      [2, 0.5],
      [3, 0.25],
    ],
  );
});

test('Shadows builds receiver shaders and lighting hooks with its filter and rejects unknown ones', () => {
  const shadows = new Shadows({ resolution: 64, filter: 'pcf' });
  try {
    for (const group of [0, 2]) {
      assert.ok(shadows.shader('let linear=direct*vec3f(1);', group).startsWith(shadowSampling(group, 'pcf')));
      assert.equal(shadows.pbr(group).declarations, shadowSampling(group, 'pcf'));
      assert.equal(shadows.pbr(group), shadows.pbr(group), 'stable hooks');
    }
    const pcf = shadows.pbr(0);
    shadows.options.filter = 'hard';
    assert.equal(shadows.pbr(0).declarations, shadowSampling(0, 'hard'), 'read when shaders are built');
    assert.notEqual(shadows.pbr(0), pcf);
    assert.ok(shadows.shader('let linear=direct*vec3f(1);').startsWith(shadowSampling(0, 'hard')));
  } finally {
    shadows.dispose();
  }
  assert.equal(new Shadows().options.filter, undefined, 'no preset: the app object is untouched');
  for (const filter of ['', 'Soft', 'pcss', 4])
    assert.throws(
      () => new Shadows({ filter }),
      (error) => error instanceof RangeError && /shadow filter/.test(error.message),
    );
});

test('cascades 1-4 split the distance among that many layers; bounds keep one map', async () => {
  for (const cascades of [0, 5, 2.5, '2'])
    assert.throws(
      () => new Shadows({ cascades }),
      (error) => error instanceof RangeError && /cascades/.test(error.message),
    );
  for (const cascades of [1, 2, 3, 4]) {
    const h = await harness({ cascades });
    try {
      const maps = h.setup.filter((e) => e[0] === 'texture' && e[2].format === 'depth32float');
      assert.equal(maps.length, 2);
      assert.ok(
        maps.every((e) => e[2].size[2] === cascades),
        `${cascades} layers`,
      );
      const first = h.frame();
      assert.equal(first.filter((e) => e[0] === 'beginRenderPass').length, cascades, 'one depth pass per cascade');
      assert.equal(first.find((e) => e[0] === 'copyTextureToTexture')[3].depthOrArrayLayers, cascades);
      const splits = [...h.shadows.splits];
      for (let i = 1; i < cascades; i++) assert.ok(splits[i] > splits[i - 1], `ordered ${splits}`);
      for (let i = cascades; i < 4; i++) assert.equal(splits[i], splits[cascades - 1], 'unused splits repeat far');
      assert.ok(
        h.shadows.matrices.subarray(cascades * 16).every((v) => v === 0),
        'unused cascades have no matrix',
      );
      assert.ok(h.shadows.matrices.subarray(0, cascades * 16).some((v) => v !== 0));
    } finally {
      h.dispose();
    }
  }
  const fixed = await harness({ cascades: 3, bounds: { min: [-2, -2, -2], max: [2, 2, 2] } });
  try {
    assert.ok(
      fixed.setup.filter((e) => e[0] === 'texture' && e[2].format === 'depth32float').every((e) => e[2].size[2] === 1),
      'bounds ignore cascades',
    );
    assert.equal(fixed.frame().filter((e) => e[0] === 'beginRenderPass').length, 1);
    fixed.shadows.options.bounds = undefined;
    assert.throws(() => fixed.frame(1), /cannot change after construction/);
  } finally {
    fixed.dispose();
  }
  const four = await harness({});
  try {
    four.shadows.options.cascades = 2;
    assert.throws(() => four.frame(), /cascade count cannot change after construction/);
  } finally {
    four.dispose();
  }
});

test('cascadeSplits and fitCascades take a cascade count; four is unchanged', () => {
  assert.deepEqual([...cascadeSplits(1, 100, 0, new Float32Array(4), 2)], [50.5, 100, 100, 100]);
  assert.deepEqual([...cascadeSplits(1, 100, 0, new Float32Array(4), 1)], [100, 100, 100, 100]);
  assert.deepEqual([...cascadeSplits(1, 100, 0.7, new Float32Array(4), 4)], [...cascadeSplits(1, 100, 0.7)]);
  for (const count of [0, 5, 1.5])
    assert.throws(() => cascadeSplits(1, 100, 0.5, new Float32Array(4), count), /splits/);
  const camera = { position: [0, 2, 6], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 },
    light = [1, -2, 0.5],
    splits = cascadeSplits(0.1, 100, 0.5, new Float32Array(4), 2),
    all = fitCascades(camera, 1.5, light, 512, cascadeSplits(0.1, 100, 0.5)),
    two = fitCascades(
      camera,
      1.5,
      light,
      512,
      splits,
      new Float32Array(64).fill(7),
      new Float32Array(4).fill(7),
      100,
      undefined,
      2,
    );
  assert.ok(two.matrices.subarray(32).every((v) => v === 0) && two.ranges[2] === 0 && two.ranges[3] === 0);
  assert.ok(two.ranges[0] > 0 && two.ranges[1] > 0);
  // A cascade depends only on its own slice: the same two slices fit the same two matrices among four.
  const wide = fitCascades(
    camera,
    1.5,
    light,
    512,
    new Float32Array([splits[0], splits[1], splits[1] + 1, splits[1] + 2]),
  );
  assert.deepEqual([...two.matrices.subarray(0, 32)], [...wide.matrices.subarray(0, 32)]);
  assert.deepEqual([...two.ranges.subarray(0, 2)], [...wide.ranges.subarray(0, 2)]);
  assert.deepEqual(
    [
      ...fitCascades(camera, 1.5, light, 512, cascadeSplits(0.1, 100, 0.5), undefined, undefined, 100, undefined, 4)
        .matrices,
    ],
    [...all.matrices],
  );
  assert.throws(
    () => fitCascades(camera, 1.5, [1, -2, 0.5], 512, splits, undefined, undefined, 100, undefined, 0),
    /fit/,
  );
});

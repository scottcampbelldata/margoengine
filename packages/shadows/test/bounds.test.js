import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const bounds = { min: [-1.55, -0.35, -1.55], max: [1.55, 2, 1.6] };

test('fixed shadow bounds reject invalid boxes and cannot switch resource modes after construction', () => {
  for (const value of [
    null,
    {},
    { min: [0, 0], max: [1, 1, 1] },
    { min: [0, NaN, 0], max: [1, 1, 1] },
    { min: [0, 0, 0], max: [1, 0, 1] },
  ])
    assert.throws(() => new Shadows({ bounds: value }), /Invalid shadow bounds/);
  const shadows = new Shadows({ bounds });
  shadows.options.bounds = undefined;
  assert.throws(() => shadows.setup({ gpu: {} }), /bounds mode/);
});

test('support-point bounds validate finite enclosed Vec3 data and revalidate edits', () => {
  const points = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (const invalid of [
    null,
    [],
    points.slice(0, 3),
    [[0, 0], ...points],
    [[NaN, 0, 0], ...points],
    [[2, 0, 0], ...points],
  ])
    assert.throws(() => new Shadows({ bounds: { ...bounds, points: invalid } }), /Invalid shadow bounds points/);
  const editable = points.map((p) => [...p]),
    shadows = new Shadows({ bounds: { ...bounds, points: editable } });
  editable[0][0] = -3;
  assert.throws(() => shadows.setup({ gpu: {} }), /Invalid shadow bounds points/);
});

test('support hulls fit empty box corners tightly while enclosing every point across light directions', () => {
  const points = [
      [-1, 0, 0],
      [1, 0, 0],
      [0, -1, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
    ],
    envelope = { min: [-1, -1, -1], max: [1, 1, 1] },
    gpu = mockGPU(),
    engine = { gpu: gpu.device, lighting: { direction: new Float32Array([-3, 3.5, 2.5, 4]) }, removePlugin() {} },
    box = new Shadows({ bounds: envelope, resolution: 512, casterMargin: 0.1 }),
    hull = new Shadows({ bounds: { ...envelope, points }, resolution: 512, casterMargin: 0.1 }),
    view = context(gpu, { shader: 'let linear=direct*vec3f(1);' }),
    runBox = passes(box),
    runHull = passes(hull);
  box.setup(engine);
  hull.setup(engine);
  try {
    let frame = 0;
    for (const direction of [
      [-3, 3.5, 2.5],
      [0, 1, 0],
      [0, -1, 0],
      [1, 0.2, -1],
      [-2, 3, 4],
    ]) {
      engine.lighting.direction.set([...direction, 4]);
      view.begin(frame++);
      view.c.shader = 'let linear=direct*vec3f(1);';
      runBox(view.c);
      view.c.shader = 'let linear=direct*vec3f(1);';
      runHull(view.c);
      const m = hull.matrices,
        boxTexel = 2 / Math.hypot(box.matrices[0], box.matrices[4], box.matrices[8]) / 512,
        texelX = 2 / Math.hypot(m[0], m[4], m[8]) / 512,
        texelY = 2 / Math.hypot(m[1], m[5], m[9]) / 512;
      assert.ok(texelX <= boxTexel + 1e-9, 'actual hull must not enlarge the box fit');
      if (direction[0] && direction[1] && direction[2])
        assert.ok(texelX < boxTexel * 0.8, 'eliminating empty corners improves effective resolution');
      assert.ok(Math.abs(texelX - texelY) < 1e-9, 'PCSS retains square world texels');
      for (const p of points) {
        const projected = [0, 1, 2].map(
          (axis) => m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis],
        );
        assert.ok(
          Math.abs(projected[0]) <= 1.000001 && Math.abs(projected[1]) <= 1.000001,
          'support point clipped in XY',
        );
        assert.ok(projected[2] >= 0 && projected[2] <= 1, 'support point clipped in depth');
      }
    }
  } finally {
    box.dispose();
    hull.dispose();
  }
});

test('point-fitted static maps survive camera movement and refit when the support volume changes', () => {
  const points = [
      [-1, 0, 0],
      [1, 0, 0],
      [0, -0.3, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
    ],
    gpu = mockGPU(),
    engine = { gpu: gpu.device, lighting: { direction: new Float32Array([-3, 3.5, 2.5, 4]) }, removePlugin() {} },
    shadows = new Shadows({ bounds: { ...bounds, points }, casterMargin: 0.1 }),
    view = context(gpu, { shader: 'let linear=direct*vec3f(1);' }),
    execute = passes(shadows);
  let draws = 0;
  shadows.add(
    {
      drawShadow() {
        draws++;
      },
    },
    { static: true },
  );
  shadows.setup(engine);
  const frame = (i) => {
    view.begin(i);
    view.c.shader = 'let linear=direct*vec3f(1);';
    execute(view.c);
  };
  try {
    frame(0);
    const initial = Array.from(shadows.matrices);
    view.camera.position = [10, 4, -8];
    frame(1);
    assert.deepEqual(Array.from(shadows.matrices), initial);
    assert.equal(draws, 1, 'camera orbit retains the point-fitted cache');
    points[0][0] = -1.5;
    frame(2);
    assert.notDeepEqual(Array.from(shadows.matrices), initial);
    assert.equal(draws, 2, 'changed support extent refreshes the static cache');
  } finally {
    shadows.dispose();
  }
});

test('degenerate support points fail before rendering an invalid shadow matrix', () => {
  const gpu = mockGPU(),
    engine = { gpu: gpu.device, lighting: { direction: new Float32Array([0, 1, 0, 4]) }, removePlugin() {} },
    shadows = new Shadows({
      bounds: { ...bounds, points: Array.from({ length: 4 }, () => [0, 0, 0]) },
      casterMargin: 0,
    }),
    view = context(gpu, { shader: 'let linear=direct*vec3f(1);' }),
    execute = passes(shadows);
  shadows.setup(engine);
  try {
    view.begin(0);
    assert.throws(() => execute(view.c), /no light-space extent/);
  } finally {
    shadows.dispose();
  }
});

test('a bounded glTF/custom scene uses one depth layer and stays fitted across camera orbit and light movement', () => {
  const gpu = mockGPU(),
    engine = { gpu: gpu.device, lighting: { direction: new Float32Array([-3, 3.5, 2.5, 4]) }, removePlugin() {} },
    shadows = new Shadows({ bounds, resolution: 2048, casterMargin: 0.9 }),
    view = context(gpu, { shader: 'let linear=direct*vec3f(1);' }),
    execute = passes(shadows);
  let staticDraws = 0,
    dynamicDraws = 0;
  shadows.add(
    {
      drawShadow(c) {
        assert.equal(c.cascade, 0);
        staticDraws++;
      },
    },
    { static: true },
  );
  shadows.add({
    drawShadow(c) {
      assert.equal(c.cascade, 0);
      dynamicDraws++;
    },
  });
  assert.equal(shadows.depthTexture, undefined, 'readback texture is absent before setup');
  const allocation = gpu.record(() => shadows.setup(engine)),
    maps = allocation.filter((e) => e[0] === 'texture' && e[2].format === 'depth32float');
  assert.equal(maps.length, 2);
  assert.ok(
    maps.every((e) => e[2].size[2] === 1),
    'cache and combined map each allocate one layer',
  );
  assert.equal(shadows.depthTexture.depthOrArrayLayers, 1);
  assert.ok(shadows.depthTexture.usage & GPUTextureUsage.COPY_SRC, 'the combined map permits real depth readback');
  const frame = (i) => {
    view.begin(i);
    const angle = i * 0.7;
    view.camera.position = [Math.sin(angle) * (3 + i), 1.5 + i * 0.1, Math.cos(angle) * (3 + i)];
    view.camera.target = [0, 0.7, 0.025];
    view.camera.far = 40;
    view.c.shader = 'let linear=direct*vec3f(1);';
    return gpu.record(() => execute(view.c));
  };
  try {
    const first = frame(0),
      matrix = [...shadows.matrices];
    assert.equal(staticDraws, 1);
    assert.equal(dynamicDraws, 1);
    assert.equal(first.filter((e) => e[0] === 'beginRenderPass').length, 2);
    const copy = first.find((e) => e[0] === 'copyTextureToTexture');
    assert.equal(copy[3].depthOrArrayLayers, 1);
    for (let i = 1; i <= 8; i++) {
      frame(i);
      assert.deepEqual([...shadows.matrices], matrix, 'camera orbit/dolly must not resize or move the map');
      assert.deepEqual([...shadows.splits], [40, 40, 40, 40], 'every visible receiver selects layer zero');
    }
    assert.equal(staticDraws, 1, 'camera movement keeps the static caster cache');
    assert.equal(dynamicDraws, 9, 'one dynamic caster pass per frame');
    for (const direction of [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0.2, -1],
      [-2, 3, 4],
    ]) {
      engine.lighting.direction.set([...direction, 4]);
      frame(10);
      const m = shadows.matrices;
      for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((axis) => (corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis])),
          projected = [0, 1, 2].map((axis) => m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis]);
        assert.ok(
          Math.abs(projected[0]) <= 1.000001 && Math.abs(projected[1]) <= 1.000001,
          `${direction}: XY clips a corner`,
        );
        assert.ok(projected[2] >= 0 && projected[2] <= 1, `${direction}: depth clips a corner`);
      }
    }
    assert.equal(staticDraws, 5, 'moving the light invalidates the static cache');
  } finally {
    shadows.dispose();
    assert.equal(shadows.depthTexture, undefined, 'diagnostics must not expose a destroyed texture');
  }
});

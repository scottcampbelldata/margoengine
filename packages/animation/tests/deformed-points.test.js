// DeformedPoints: the point-size maths against a direct projection, the draw it records (one instanced quad strip per
// primitive, straight from the deformed buffer) and the reader count that keeps a hidden model deforming.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { Animation } from '../dist/index.js';
import { DeformedPoints, deformedPointsShader, pointScale } from '../dist/deformed-points.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { skinnedStrip } from '../test/fixture.js';
import { engine as headless, model as load } from './support/models.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  unit = (a) => a.map((x) => x / Math.hypot(...a));
/** Column-major projection * view. `shift` moves the projection centre (an off-axis crop); `ortho` drops perspective. */
function viewProjection({ eye = [3, 2, 5], target = [0, 0.5, 0], a = 1.2, b = 2.1, shift = [0, 0], ortho = false }) {
  const back = unit(eye.map((x, i) => x - target[i])),
    right = unit(cross([0, 1, 0], back)),
    up = cross(back, right),
    rows = [right, up, back].map((axis) => [...axis, -dot(axis, eye)]),
    projection = ortho
      ? [
          [a, 0, 0, shift[0]],
          [0, b, 0, shift[1]],
          [0, 0, -0.01, 0.5],
          [0, 0, 0, 1],
        ]
      : [
          [a, 0, shift[0], 0],
          [0, b, shift[1], 0],
          [0, 0, 0, 0.1],
          [0, 0, -1, 0],
        ],
    m = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      m[c * 4 + r] = projection[r].reduce((sum, p, k) => sum + p * (k < 3 ? rows[k][c] : +(c === 3)), 0);
  return { m, right, up };
}
const clip = (m, [x, y, z]) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
/** The vertex stage's corner, in NDC: `c.xy + corner * scale.xy * mix(1, c.w, scale.z)` over w. */
const corner = (m, point, scale, [cx, cy]) => {
  const c = clip(m, point),
    k = scale[2] ? c[3] : 1;
  return [(c[0] + cx * scale[0] * k) / c[3], (c[1] + cy * scale[1] * k) / c[3]];
};

test('a pixel-sized point covers its size in pixels at any depth, under any projection', () => {
  for (const options of [{}, { shift: [0.3, -0.2] }, { ortho: true }]) {
    const { m } = viewProjection(options),
      scale = pointScale(m, 6, 'pixels', 800, 400);
    for (const point of [
      [0, 0, 0],
      [1, 2, -7],
      [-2, 0.5, 3],
    ]) {
      const low = corner(m, point, scale, [-1, -1]),
        high = corner(m, point, scale, [1, 1]);
      assert.ok(Math.abs(((high[0] - low[0]) * 800) / 2 - 6) < 1e-3, 'six pixels wide');
      assert.ok(Math.abs(((high[1] - low[1]) * 400) / 2 - 6) < 1e-3, 'six pixels high');
    }
  }
});

test('a world-sized point spans its size along the camera axes, as projecting those ends does', () => {
  for (const options of [{}, { shift: [0.3, -0.2] }, { ortho: true }, { ortho: true, shift: [0.4, 0.1] }]) {
    const { m, right, up } = viewProjection(options),
      size = 0.5,
      scale = pointScale(m, size, 'world', 800, 400);
    assert.equal(scale[2], 0);
    for (const point of [
      [0, 0, 0],
      [1, 2, -7],
      [-2, 0.5, 3],
    ]) {
      const end = (axis, sign) => {
          const c = clip(
            m,
            point.map((x, i) => x + (axis[i] * sign * size) / 2),
          );
          return [c[0] / c[3], c[1] / c[3]];
        },
        low = corner(m, point, scale, [-1, -1]),
        high = corner(m, point, scale, [1, 1]);
      assert.ok(Math.abs(high[0] - low[0] - (end(right, 1)[0] - end(right, -1)[0])) < 1e-5, 'width');
      assert.ok(Math.abs(high[1] - low[1] - (end(up, 1)[1] - end(up, -1)[1])) < 1e-5, 'height');
    }
  }
});

test('point sizes and options are checked', async () => {
  const { m } = viewProjection({});
  for (const bad of [
    [m, -1, 'pixels', 8, 8],
    [m, NaN, 'world', 8, 8],
    [m, 1, 'metres', 8, 8],
    [m, 1, 'pixels', 0, 8],
  ])
    assert.throws(() => pointScale(...bad), /Invalid point size/);
  assert.deepEqual([...pointScale(m, 0, 'world', 8, 8)], [0, 0, 0]);
  const engine = await headless(),
    model = load(engine, skinnedStrip()),
    points = new DeformedPoints(model);
  assert.deepEqual(
    [
      points.size,
      points.sizeUnits,
      [...points.color],
      points.opacity,
      points.shape,
      points.vertexColors,
      points.visible,
    ],
    [4, 'pixels', [1, 1, 1], 1, 'square', true, true],
    'documented defaults',
  );
  assert.equal(points.count, 10);
  for (const bad of [{ size: -1 }, { size: Infinity }, { sizeUnits: 'cm' }, { opacity: 2 }, { shape: 'star' }])
    assert.throws(() => points.set({ size: 9, ...bad }), RangeError);
  assert.throws(() => points.set({ vertexColors: 1 }), TypeError);
  assert.throws(() => points.set({ size: 9, color: 'red' }), TypeError);
  assert.equal(points.size, 4, 'a rejected set changes nothing');
  points.set({ color: '#ff0000', size: 2 });
  assert.deepEqual([...points.color], [1, 0, 0]);
  assert.throws(() => new DeformedPoints({}), /needs a gltf\/pbr model/);
  assert.throws(() => points.setup(engine), /needs WebGPU/);
  points.dispose();
  points.dispose();
  assert.throws(() => points.setup(engine), /disposed/);
  model.dispose();
  engine.dispose();
});

test('each primitive draws as one instanced quad strip from its deformed vertices', async () => {
  const engine = await headless(),
    model = load(engine, skinnedStrip()),
    gpu = mockGPU(),
    points = new DeformedPoints(model, { size: 8, shape: 'round', color: [0.5, 0.25, 1], opacity: 0.5 }),
    host = {
      gpu: gpu.device,
      sceneOf() {
        return undefined;
      },
      stats: { visible: 0, drawCalls: 0 },
    };
  points.setup(host);
  const run = passes(points),
    view = context(gpu, { samples: 4 }),
    frame = (i) =>
      gpu.record(() => {
        view.begin(i);
        run(view.c);
        view.end();
      }),
    primitive = model.primitives[0],
    first = frame(0),
    pipeline = first.find((e) => e[0] === 'renderPipeline')[2];
  assert.equal(pipeline.primitive.topology, 'triangle-strip');
  assert.deepEqual(pipeline.vertex.buffers, [
    {
      arrayStride: 80,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 64, format: 'float32x4' },
      ],
    },
  ]);
  assert.ok(pipeline.fragment.targets[0].blend, 'opacity below 1 blends');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, true);
  assert.deepEqual(
    first.filter((e) => e[0] === 'pass.draw').map((e) => e.slice(1, 3)),
    [[4, 10]],
    'four corners, one instance per vertex',
  );
  // No deformer in this headless model: the points upload its bind-pose vertices once.
  const uploads = (log) =>
    log.filter((e) => e[0] === 'writeBuffer' && e[3].length === primitive.vertices.byteLength * 2);
  assert.equal(uploads(first).length, 1);
  const values = points['values'];
  assert.deepEqual([...values.subarray(32, 36)], [0.5, 0.25, 1, 0.5]);
  assert.deepEqual([...values.subarray(36, 42)].map(Math.fround), [8 / 1280, 8 / 720, 1, 1, 1, 1].map(Math.fround));
  assert.deepEqual([...values.subarray(16, 32)], [...primitive.node.matrix]);
  // A deformer's buffer is drawn in place, from the primitive's offset.
  primitive.deformed = gpu.device.createBuffer({ size: 4096, usage: 32 });
  primitive.deformedOffset = 512;
  const second = frame(1),
    bound = second.find((e) => e[0] === 'pass.setVertexBuffer');
  assert.deepEqual(bound.slice(3, 5), [512, 800]);
  assert.equal(uploads(second).length, 0, 'nothing uploads again');
  assert.equal(second.filter((e) => e[0] === 'renderPipeline').length, 0, 'the pipeline is kept');
  points.visible = false;
  assert.equal(frame(2).filter((e) => e[0] === 'pass.draw').length, 0);
  points.visible = true;
  points.opacity = 1;
  assert.equal(frame(3).find((e) => e[0] === 'renderPipeline')[2].fragment.targets[0].blend, undefined);
  points.size = -1;
  assert.throws(() => frame(4), /Invalid point options/);
  points.size = 8;
  assert.equal(host.stats.drawCalls, 3);
  points.dispose();
  model.dispose();
  engine.dispose();
});

test('the shader keeps its comments outside the WGSL', () => {
  assert.ok(!deformedPointsShader.includes('//'));
  assert.match(deformedPointsShader, /corner\*f\.scale\.xy\*mix\(1\.0,c\.w,f\.scale\.z\)/);
});

test('a hidden model keeps deforming while points read it', async (t) => {
  const gpu = optionalGPU(),
    e = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      await TransformStore.create(64),
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      undefined,
      null,
    );
  t.after(() => {
    e.dispose();
    gpu.cleanup();
  });
  const { doc, buffers } = skinnedStrip(),
    model = new PBRModel(e, new GLTFAsset(doc, buffers));
  e.use(model);
  const animation = Animation.attach(model),
    frame = { backend: 'webgpu', device: gpu.engine.gpu, encoder: gpu.engine.gpu.createCommandEncoder() },
    deforms = () => animation['upload'](frame);
  assert.equal(deforms(), true);
  model.root.visible = false;
  assert.equal(deforms(), false, 'hidden and unread: nothing to deform');
  const points = DeformedPoints.attach(model),
    more = DeformedPoints.attach(model);
  assert.equal(deforms(), true, 'points read the hidden model');
  points.dispose();
  assert.equal(deforms(), true, 'the second reader still reads');
  more.dispose();
  assert.equal(deforms(), false);
  const last = DeformedPoints.attach(model);
  model.dispose();
  assert.equal(last.disposed, true, 'the points go with their model');
});

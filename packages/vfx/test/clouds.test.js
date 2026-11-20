// Puff clouds (@margoengine/vfx/clouds): layout, light through the cloud, animation determinism, culling, sorting and
// the one instanced draw, on the fake GPU. The real-GPU checks are test/clouds-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Clouds, layoutPuffs, defaultPuffTexture } from '../dist/clouds.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Reversed-Z perspective times look-at, column-major, as core's Camera builds it.
function viewProjection(eye, target, fov = 60, aspect = 1, near = 0.1) {
  const sub = (a, b) => a.map((x, i) => x - b[i]),
    norm = (a) => a.map((x) => x / Math.hypot(...a)),
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target)),
    x = norm(cross([0, 1, 0], z)),
    y = cross(z, x),
    f = 1 / Math.tan((fov * Math.PI) / 360);
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  // Infinite reversed Z: z_clip = near, w_clip = -z_view.
  const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0];
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}
const camera = (position, target = [0, 0, 0]) => ({
  position,
  target,
  up: [0, 1, 0],
  matrix: viewProjection(position, target),
});
const context = (cam) => ({ backend: 'webgpu', camera: cam, width: 64, height: 64 });

test('a seed gives the same layout every time, and another seed another layout', () => {
  const a = layoutPuffs(20, [5, 1, 1], 'inside', 6, 0.25, 3),
    b = layoutPuffs(20, [5, 1, 1], 'inside', 6, 0.25, 3),
    c = layoutPuffs(20, [5, 1, 1], 'inside', 6, 0.25, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (let i = 0; i < 20; i++) {
    assert.ok(Math.abs(a[i * 6]) <= 2.5 && Math.abs(a[i * 6 + 1]) <= 0.5 && Math.abs(a[i * 6 + 2]) <= 0.5, 'in the box');
    assert.ok(a[i * 6 + 3] >= 6 * 0.25 - 1e-6 && a[i * 6 + 3] <= 6 + 1e-6, 'size within smallestVolume..volume');
  }
});

test("concentrate 'inside' shrinks puffs toward the box edge, 'outside' grows them, both floored by smallestVolume", () => {
  const edge = (layout, i) =>
    Math.max(Math.abs(layout[i * 6] / 2.5), Math.abs(layout[i * 6 + 1] / 0.5), Math.abs(layout[i * 6 + 2] / 0.5));
  for (const [mode, expected] of [
    ['inside', (e) => Math.max(0.1, 1 - e)],
    ['outside', (e) => Math.max(0.1, e)],
  ]) {
    const layout = layoutPuffs(64, [5, 1, 1], mode, 2, 0.1, 9);
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(layout[i * 6 + 3] - 2 * expected(edge(layout, i))) < 1e-5, mode);
  }
});

test('distribute places each puff itself, in box units, with its size fraction', () => {
  const clouds = new Clouds(),
    cloud = clouds.add({
      segments: 3,
      bounds: [2, 4, 6],
      volume: 10,
      distribute: (i) => ({ point: [i - 1, 0, 1], volume: i / 2 }),
    });
  cloud.matrix.set([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);
  const puffs = clouds.puffs();
  assert.deepEqual(
    puffs.map((p) => p.centre),
    [
      [-1, 2, 9],
      [1, 2, 9],
      [3, 2, 9],
    ],
  );
  assert.deepEqual(
    puffs.map((p) => p.size),
    [0, 10, 20],
    'size follows the fraction and the matrix scale',
  );
});

test('a puff in the shadow of another gets exp(-density) of the light; one beside it all of it', () => {
  const clouds = new Clouds({ lightDirection: [0, 1, 0], density: 0.7 }),
    cloud = clouds.add({
      segments: 3,
      volume: 1,
      distribute: (i) => ({ point: [[0, 0, 0], [0, 0.6, 0], [0.9, 0, 0]][i], volume: 1 }),
      bounds: [10, 10, 10],
    });
  const [low, high, side] = clouds.puffs();
  assert.equal(cloud.layout.length, 18);
  assert.equal(high.light, 1, 'nothing above the top puff');
  assert.ok(Math.abs(low.light - Math.exp(-0.7)) < 1e-6, `under: ${low.light}`);
  assert.ok(side.light > 0.999, `beside: ${side.light}`);
});

test('animation is a function of the clock: the same deltas give the same puffs; speed 0 never moves', () => {
  const make = () => {
    const clouds = new Clouds();
    clouds.add({ seed: 5, speed: 0.8, growth: 4 });
    clouds.add({ seed: 6 });
    return clouds;
  };
  const a = make(),
    b = make();
  const still = a.puffs().filter((p) => p.cloud === a.clouds[1]);
  for (const delta of [1 / 60, 1 / 30, 0, 0.1]) a.onPreUpdate(delta);
  b.advanceTime(1 / 60 + 1 / 30 + 0.1);
  const strip = (p) => ({ ...p, cloud: undefined });
  assert.equal(a.time, b.time);
  assert.deepEqual(a.puffs().map(strip), b.puffs().map(strip));
  assert.deepEqual(
    a
      .puffs()
      .filter((p) => p.cloud === a.clouds[1])
      .map(strip),
    still.map(strip),
    'a cloud with speed 0 is still',
  );
  const start = make().puffs()[0],
    moved = a.puffs()[0];
  assert.notEqual(moved.angle, start.angle);
  assert.ok(Math.abs(moved.size / start.size - 1) <= 1 / 4 + 1e-6, 'breathes within 1 / growth');
});

test('puffs are culled outside the view, sorted far to near, and cut at range and limit', () => {
  const clouds = new Clouds({ limit: 5 }),
    cloud = clouds.add({
      segments: 7,
      volume: 0.5,
      bounds: [2, 2, 200],
      distribute: (i) => ({ point: [0, 0, [-0.01, 0.02, -0.03, 0.12, -0.05, 0, 0][i]], volume: 1 }),
    });
  cloud.matrix[12] = 0;
  const cam = camera([0, 0, 10]);
  const count = clouds['collect'](context(cam));
  assert.deepEqual(clouds.stats, { puffs: 7, dropped: 2, culled: 1, drawn: 4 }, 'limit 5, the puff at z 12 is behind the camera');
  const depths = Array.from({ length: count }, (_, i) => clouds['data'][i * 12 + 2]);
  assert.deepEqual(depths, [-5, -3, -1, 2], 'far to near');
  clouds.options.range = 2;
  clouds.options.frustumCulled = false;
  clouds['collect'](context(cam));
  assert.deepEqual(clouds.stats, { puffs: 7, dropped: 5, culled: 0, drawn: 2 });
});

test('every cloud draws in one instanced draw of 4 vertices per puff, depth tested and not written', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const clouds = new Clouds({ frustumCulled: false });
  h.engine.use(clouds);
  clouds.add({ segments: 5 });
  clouds.add({ segments: 7 });
  const draws = [];
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => {
    const pass = begin(d);
    pass.draw = (vertices, instances) => draws.push([vertices, instances]);
    return pass;
  };
  h.frame();
  assert.deepEqual(draws, [[4, 12]]);
  assert.equal(h.engine.stats.drawCalls, 1);
  const pipeline = h.pipelines.at(-1);
  assert.equal(pipeline.primitive.topology, 'triangle-strip');
  assert.equal(pipeline.vertex.buffers[0].stepMode, 'instance');
  assert.deepEqual(pipeline.depthStencil, { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' });
  assert.deepEqual(pipeline.fragment.targets[0].blend.color, { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' });
  assert.match(pipeline.vertex.module.code, /smoothstep\(0\.0,extra\.z,distance\)/, 'the near fade');
  assert.doesNotMatch(pipeline.vertex.module.code, /sceneDepth/, 'no depth sampling without softness');
  clouds.dispose();
  assert.equal(clouds.clouds.length, 0);
  h.cleanup();
});

test('softness samples the scene depth with the contrast curve; it needs a depth function', () => {
  assert.throws(() => new Clouds({ softness: 1 }), /needs the scene depth/);
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  h.context.width = h.context.height = 64;
  h.context.descriptor.multisample = { count: 1 };
  const depth = {
      format: 'depth32float',
      dimension: '2d',
      width: 64,
      height: 64,
      usage: 4,
      sampleCount: 1,
      createView: (d) => ({ view: d }),
    },
    clouds = new Clouds({ frustumCulled: false, softness: 0.5, depth: () => depth });
  h.engine.use(clouds);
  clouds.add({ segments: 2 });
  h.frame();
  const code = h.pipelines.at(-1).vertex.module.code;
  assert.match(code, /texture_depth_2d/);
  assert.match(code, /a\*=contrast\(clamp\(softGap\(i\.clip,i\.viewDepth\),0\.0,1\.0\)\)/);
  assert.ok(h.groups.at(-1).entries.some((e) => e.binding === 12));
  h.cleanup();
});

test('the default puff texture is the same every time, clear at the corners and dense in the middle', () => {
  const a = defaultPuffTexture(64),
    b = defaultPuffTexture(64);
  assert.deepEqual(a.data, b.data);
  assert.equal(a.data[3], 0);
  assert.ok(a.data[(32 * 64 + 32) * 4 + 3] > 128);
});

test('invalid options throw with the fix in the message', () => {
  assert.throws(() => new Clouds({ limit: 0 }), /Clouds limit is 0; pass/);
  assert.throws(() => new Clouds({ shading: 'lambert' }), /pass 'scatter' or 'unlit'/);
  assert.throws(() => new Clouds({ lightDirection: [0, 0, 0] }), /pass a direction/);
  const clouds = new Clouds();
  assert.throws(() => clouds.add({ concentrate: 'middle' }), /pass 'inside', 'outside' or 'random'/);
  assert.throws(() => clouds.add({ segments: 2.5 }), /pass a whole number/);
  const cloud = clouds.add();
  cloud.options.growth = 0;
  assert.throws(() => clouds.puffs(), /Cloud growth is 0/);
  clouds.dispose();
  assert.throws(() => clouds.add(), /disposed/);
});

// The draw is WebGPU only, with no WebGL2 route: the small preview is refused in setup, before the plugin is attached,
// so it cannot attach and then silently draw no clouds (scripts/check-preview-contract.mjs).
test('Clouds refuses the small WebGL2 preview in setup and stays off the engine', async () => {
  const { Engine, TransformStore } = await import('../../core/dist/extension.js');
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
  );
  try {
    assert.throws(
      () => Clouds.attach(engine),
      (error) => error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#webgpu'),
    );
    assert.equal([...engine.plugins.values()].filter((p) => p.name.startsWith('clouds:')).length, 0);
  } finally {
    engine.dispose();
  }
});

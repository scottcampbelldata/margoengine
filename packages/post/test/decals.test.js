// CPU checks (mock GPU) for @margoengine/post/decals: validation and packing, ordering by blend mode, one pass with one
// instanced draw per mode, zero work without decals, view and screen-size culling, and the scene-depth requirement. The GPU is checked by
// examples/package-benchmarks/decals-gpu.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { Decals, MAX_DECALS } from '../dist/decals.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
const floats = (hex) => {
  const b = Buffer.from(hex, 'hex');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
function rig({ samples = 4, capture = true, options } = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    removed: [],
    sceneOf(plugin) {
      return plugin === decals && !this.removed.includes(plugin.name) ? this : undefined;
    },
    removePlugin(name) {
      this.removed.push(name);
    },
  };
  const target = capture
    ? new SceneTarget(
        gpu.device,
        gpu.device.createTexture({ size, format: 'rgba16float', usage }),
        gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
        samples,
      )
    : undefined;
  const decals = new Decals(options);
  decals.setup(engine);
  const run = passes(decals),
    frame = (i, look = [0, 0, 0]) => {
      view.begin(i);
      target?.begin(view.c);
      const camera = new Camera({ position: [0, 3, 4], target: look });
      camera.update(16 / 9, true);
      view.c.camera = camera;
      run(view.c);
    };
  return { gpu, view, engine, decals, frame, record: (work) => gpu.record(work) };
}
const floor = { position: [0, 0, 0], direction: [0, -1, 0], width: 2, height: 1, up: [0, 0, -1] };

test('Decals validates and packs each decal: centre + mode, half axes (right, up, projection), cos angle, opacity, rect, colour', () => {
  const { decals } = rig();
  for (const bad of [
    { ...floor, direction: [0, 0, 0] },
    { ...floor, width: 0 },
    { ...floor, rect: [0, 0, 2, 1] },
    { ...floor, opacity: 2 },
    { ...floor, angle: 2 },
    { ...floor, mode: 'add' },
    { ...floor, color: [-1, 0, 0] },
    { ...floor, up: [0, 1, 0] },
    { ...floor, position: [0, NaN, 0] },
  ])
    assert.throws(() => decals.setDecals([bad]), RangeError, JSON.stringify(bad));
  assert.throws(() => decals.setDecals(Array.from({ length: MAX_DECALS + 1 }, () => floor)), /at most 4096/);
  assert.throws(() => new Decals({ atlas: {} }), /sampled 2D GPUTexture/);
  decals.setDecals([{ ...floor, mode: 'over', color: [2, 1, 0.5], rect: [0, 0, 0.5, 0.5] }, floor]);
  assert.equal(decals.count, 2);
  const data = decals['data'];
  // 'multiply' first: floor (default depth min(2, 1) = 1, angle PI/3, opacity 1, rect 0..1, white).
  assert.deepEqual(
    Array.from(data.subarray(0, 24), (v) => +v.toFixed(4)),
    [0, 0, 0, 0, -1, 0, 0, 0.5, 0, 0, -0.5, 1, 0, -0.5, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0],
  );
  assert.deepEqual(Array.from(data.subarray(24, 28)), [0, 0, 0, 1], "'over' second, flagged");
  assert.deepEqual(Array.from(data.subarray(40, 47)), [0, 0, 0.5, 0.5, 2, 1, 0.5]);
});

test('one render pass over the scene target, one instanced box draw per blend mode; nothing without decals', () => {
  for (const samples of [1, 4]) {
    const { decals, frame, record, view } = rig({ samples });
    frame(0);
    assert.deepEqual(
      record(() => frame(1)),
      [],
      'no decals: no GPU work',
    );
    decals.setDecals([floor, { ...floor, mode: 'over' }, { ...floor, position: [1, 0, 0] }]);
    const log = record(() => frame(2));
    assert.equal(log.filter((e) => e[0] === 'beginRenderPass').length, 1);
    assert.deepEqual(
      log.filter((e) => e[0] === 'pass.draw').map((e) => e.slice(1, 5)),
      [
        [36, 2, undefined, undefined],
        [36, 1, 0, 2],
      ],
    );
    const pipelines = log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
    assert.deepEqual(
      pipelines.map((p) => [p.primitive.cullMode, p.multisample.count, p.fragment.targets[0].blend.color.srcFactor]),
      [
        ['front', samples, 'dst'],
        ['front', samples, 'src-alpha'],
      ],
    );
    const code = log.find((e) => e[0] === 'module')[2].code;
    assert.equal(code.includes('texture_depth_multisampled_2d'), samples === 4);
    const layout = log.find((e) => e[0] === 'layout' && e[2].entries)[2];
    assert.deepEqual(layout.entries[2].texture, { multisampled: samples === 4, sampleType: 'depth' });
    const view0 = log.find((e) => e[0] === 'writeBuffer' && e[3].length === 160 * 2),
      values = floats(view0[3]);
    assert.deepEqual([values[36], values[37]], [1280, 720]);
    assert.deepEqual(Array.from(values.subarray(32, 35)), [0, 3, 4]);
    // Steady frames: no new pipelines, groups or decal uploads.
    const steady = record(() => frame(3));
    assert.equal(steady.filter((e) => ['renderPipeline', 'group', 'module'].includes(e[0])).length, 0);
    assert.equal(steady.filter((e) => e[0] === 'writeBuffer').length, 1, 'only the view uniform');
    assert.equal(view.c.shader, 'lit shader');
    assert.deepEqual(view.c.bindings, []);
    decals.dispose();
  }
});

test('Decals need scene depth and release everything on dispose', () => {
  const { decals, frame, engine } = rig({ capture: false });
  decals.setDecals([floor]);
  assert.throws(() => frame(0), /Decals need scene depth: attach a post capture/);
  decals.dispose();
  assert.deepEqual(engine.removed, ['post:decals']);
  assert.throws(() => decals.setDecals([floor]), RangeError);
  assert.throws(() => new Decals().setup({ gpu: null }), /WebGPU/);
});

test('culling: only decals whose bounding sphere is in the view and spans minPixels are uploaded and drawn', () => {
  const tiny = { ...floor, width: 0.001, height: 0.001 },
    list = [
      floor, // in view
      { ...floor, position: [0, 6, 8] }, // behind the camera (camera at [0, 3, 4] looking at the origin)
      { ...floor, position: [-100, 0, 0] }, // left of the view
      { ...floor, position: [0, 30, -40] }, // above the view
      { ...floor, position: [0, -1197, -1596] }, // beyond far (1000) along the view direction
      tiny, // about 0.2 px across at 5 m
      { ...floor, position: [0, 3, 4], mode: 'over' }, // contains the camera
      { ...floor, position: [100, 0, 0], mode: 'over' }, // right of the view
    ];
  const { decals, frame, record } = rig();
  assert.equal(decals.minPixels, 1);
  assert.equal(decals.drawn, 0);
  decals.setDecals(list);
  const data = decals['data'],
    row = (i) => Array.from(data.subarray(i * 24, i * 24 + 24));
  const draws = (log) => log.filter((e) => e[0] === 'pass.draw').map((e) => e.slice(1, 5)),
    uploads = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length !== 160 * 2).map((e) => floats(e[3]));
  let log = record(() => frame(0));
  assert.deepEqual(draws(log), [
    [36, 1, undefined, undefined],
    [36, 1, 0, 1],
  ]);
  assert.equal(decals.drawn, 2);
  assert.deepEqual(
    uploads(log).map((u) => Array.from(u)),
    [[...row(0), ...row(6)]],
    'the visible decals, compacted: the floor, then the over decal around the camera',
  );
  assert.deepEqual(uploads(record(() => frame(1))), [], 'same view, same set: no upload');
  // Turned around: the decal behind the camera comes into view, the floor leaves it.
  log = record(() => frame(2, [0, 6, 8]));
  assert.deepEqual(draws(log), [
    [36, 1, undefined, undefined],
    [36, 1, 0, 1],
  ]);
  assert.deepEqual(
    uploads(log).map((u) => Array.from(u)),
    [[...row(1), ...row(6)]],
  );
  // minPixels 0 keeps the tiny decal; out of view stays culled.
  const all = rig({ options: { minPixels: 0 } });
  all.decals.setDecals(list);
  assert.deepEqual(draws(all.record(() => all.frame(0))), [
    [36, 2, undefined, undefined],
    [36, 1, 0, 2],
  ]);
  assert.equal(all.decals.drawn, 3);
  // Nothing in view: no pass at all.
  decals.setDecals([list[1], list[2]]);
  assert.equal(decals.drawn, 0);
  assert.deepEqual(
    record(() => frame(3)),
    [],
  );
  for (const minPixels of [-1, NaN, Infinity])
    assert.throws(() => new Decals({ minPixels }), /minPixels must be a finite number >= 0/);
  decals.dispose();
  all.decals.dispose();
});

test('the screen-span bound is conservative: a decal whose sphere spans minPixels anywhere in view is never culled', () => {
  const camera = new Camera({ position: [0, 3, 4], target: [0, 0, 0] });
  camera.update(16 / 9, true);
  const m = camera.matrix,
    [width, height] = [1280, 720],
    project = (p) => {
      const c = [0, 1, 3].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
      return [((c[0] / c[2]) * width) / 2, ((c[1] / c[2]) * height) / 2];
    };
  // Camera basis: forward toward the origin, right and up across it.
  const forward = [0, -0.6, -0.8],
    right = [1, 0, 0],
    up = [0, 0.8, -0.6],
    tan = Math.tan(Math.PI / 6);
  let random = 7;
  const next = () => ((random = (random * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let checked = 0;
  for (let n = 0; n < 200; n++) {
    // A centre anywhere in view (NDC up to 0.98 on each axis), 0.5 to 60 m ahead, and a box 0.002 to 0.5 m.
    const distance = 0.5 + ((next() + 1) / 2) ** 2 * 60,
      nx = next() * 0.98,
      ny = next() * 0.98,
      size = 0.002 + ((next() + 1) / 2) ** 3 * 0.5,
      centre = [0, 1, 2].map(
        (k) => [0, 3, 4][k] + distance * (forward[k] + nx * tan * (16 / 9) * right[k] + ny * tan * up[k]),
      ),
      radius = (size * Math.sqrt(3)) / 2;
    if (distance - radius * 2 < 0.2) continue;
    // The real span of the sphere: project 4,000 points spread over its surface.
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < 4000; i++) {
      const z = 1 - (2 * (i + 0.5)) / 4000,
        ring = Math.sqrt(1 - z * z),
        a = i * Math.PI * (3 - Math.sqrt(5)),
        [px, py] = project([
          centre[0] + radius * ring * Math.cos(a),
          centre[1] + radius * ring * Math.sin(a),
          centre[2] + radius * z,
        ]);
      [x0, x1, y0, y1] = [Math.min(x0, px), Math.max(x1, px), Math.min(y0, py), Math.max(y1, py)];
    }
    const span = Math.max(x1 - x0, y1 - y0),
      decals = new Decals({ minPixels: span * 0.999 });
    decals.setDecals([{ position: centre, direction: [0, -1, 0], width: size, height: size, depth: size }]);
    assert.equal(decals['cull'](m, width, height), 1, `span ${span} px at ${distance} m, NDC ${nx}, ${ny}`);
    checked++;
  }
  assert.ok(checked > 150);
  // And tight on the axis: a 2 cm decal 20 m ahead is culled at 1.1 times its real span.
  // Real span on the axis: 2 r / sqrt(d^2 - r^2) in tangent units, times the focal scale 1 / tan(30 deg) and height / 2.
  const centre = [0, 3 - 12, 4 - 16],
    r = 0.01 * Math.sqrt(3),
    real = (r * Math.sqrt(3) * height) / Math.sqrt(400 - r * r);
  const keep = new Decals({ minPixels: real * 0.999 }),
    drop = new Decals({ minPixels: real * 1.1 });
  for (const d of [keep, drop])
    d.setDecals([{ position: centre, direction: [0, -1, 0], width: 0.02, height: 0.02, depth: 0.02 }]);
  assert.equal(keep['cull'](m, width, height), 1);
  assert.equal(drop['cull'](m, width, height), 0);
});

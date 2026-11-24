// Regressions for the batch 132 audit of @margoengine/sprites. Each test fails on the code before the audit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { packSprites, Sprite, SpriteLayer } from '../dist/index.js';
import { Billboard, BillboardLayer, packBillboards } from '../dist/billboard.js';
import { gridMesh, SkeletalLayer, Skeleton2D, SkinnedMesh } from '../dist/skeletal.js';
import { parseAseprite } from '../dist/aseprite.js';
import { parseSpineJSON } from '../dist/spine.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const atlas = () => ({ width: 4, height: 4, data: new Uint8Array(64).fill(255) });

test('packing again with unchanged values that are not float32-exact reports nothing to upload', () => {
  const sprite = new Sprite({ rect: [0, 0, 2, 2], rotation: 0.1, pivotX: 0.3, x: 1.1 }),
    data = new Float32Array(12);
  packSprites([sprite], data, { x: 0, y: 0, zoom: 1 }, 4, 4, false);
  const again = packSprites([sprite], data, { x: 0, y: 0, zoom: 1 }, 4, 4, false);
  assert.equal(again.end - again.start, 0, 'a still sprite with rotation 0.1 was uploaded again');
  const board = new Billboard({ x: 0.1, rotation: 0.2 }),
    boards = new Float32Array(16);
  packBillboards([board], boards, 4, 4);
  const repeat = packBillboards([board], boards, 4, 4);
  assert.equal(repeat.end - repeat.start, 0, 'a still billboard at x 0.1 was uploaded again');
});

const realEngine = async (h) =>
  new Engine(
    { width: 16, height: 16 },
    await TransformStore.create(4),
    { backend: 'webgpu', gpu: h.engine.gpu, dispose() {} },
    {},
    null,
  );

for (const [label, make] of [
  ['SpriteLayer', (name) => new SpriteLayer({ atlas: atlas(), name })],
  ['BillboardLayer', (name) => new BillboardLayer({ atlas: atlas(), name })],
  ['SkeletalLayer', (name) => new SkeletalLayer({ atlas: atlas(), name })],
])
  test(`${label}.dispose removes it from its own scene, not the active scene's same-name plugin`, async () => {
    const h = optionalGPU(),
      engine = await realEngine(h);
    try {
      const other = engine.createScene('other'),
        layer = make('hud'),
        sentinel = make('hud');
      other.use(layer);
      engine.use(sentinel);
      layer.dispose();
      assert.equal(engine.plugins.get('hud'), sentinel, 'the active scene lost its own plugin');
      assert.equal(other.plugins.size, 0, 'the disposed layer stayed in its scene');
      sentinel.dispose();
      assert.equal(engine.plugins.size, 0);
    } finally {
      engine.dispose();
      h.cleanup();
    }
  });

// Two views of one frame; view 0 leaves the layer out by its layers, view 1 draws it.
function twoViews(layer) {
  const h = optionalGPU(),
    counts = { draw: 0, indexed: 0 },
    pass = {
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      setViewport() {},
      setScissorRect() {},
      draw: () => counts.draw++,
      drawIndexed: () => counts.indexed++,
      end() {},
    };
  h.engine.gpu.createPipelineLayout ??= (descriptor) => descriptor;
  let framePass;
  layer.setup({ backend: 'webgpu', frameGraph: { add: (p) => ((framePass = p), () => {}) } });
  const view = (index, layers) => ({
      id: `v${index}`,
      index,
      count: 2,
      layers,
      viewport: [0, 0, 16, 16],
      camera: h.context.camera,
    }),
    context = (v) => ({
      backend: 'webgpu',
      device: h.engine.gpu,
      encoder: { beginRenderPass: () => pass },
      color: {},
      depth: {},
      format: 'rgba8unorm',
      descriptor: { multisample: { count: 1 } },
      width: 16,
      height: 16,
      camera: h.context.camera,
      view: v,
    });
  layer.onPreUpdate(1 / 60);
  framePass.execute(context(view(0, 1)));
  framePass.execute(context(view(1, 2)));
  return { counts, h };
}

test('a skeletal layer seen only by the second view of a frame still skins and draws', () => {
  const layer = new SkeletalLayer({ atlas: atlas(), layers: 2 }),
    skeleton = new Skeleton2D([{ name: 'root' }]),
    grid = gridMesh([0, 0, 4, 4], 1, 1);
  layer.add(
    new SkinnedMesh({
      skeleton,
      ...grid,
      joints: new Uint32Array(16),
      weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    }),
  );
  const { counts, h } = twoViews(layer);
  assert.ok(counts.indexed > 0, 'view 1 reused the empty build of a frame that never built');
  h.cleanup();
});

test('a sprite layer with its own target draws once a frame even when view 0 leaves it out', () => {
  const target = { width: 16, height: 16, format: 'rgba8unorm', sampleCount: 1, createView: () => ({}) },
    layer = new SpriteLayer({ atlas: atlas(), layers: 2, target });
  layer.add({ rect: [0, 0, 2, 2] });
  const { counts, h } = twoViews(layer);
  assert.equal(counts.draw, 1, 'the own-target layer skipped every view after view 0');
  h.cleanup();
});

// Aseprite file bytes, as the format specification lays them out.
const u16 = (v) => [v & 255, (v >> 8) & 255];
const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
const chunk = (type, body) => [...u32(body.length + 6), ...u16(type), ...body];
const layerChunk = (name) =>
  chunk(0x2004, [
    ...u16(1),
    ...u16(0),
    ...u16(0),
    0,
    0,
    0,
    0,
    ...u16(0),
    255,
    0,
    0,
    0,
    ...u16(name.length),
    ...Buffer.from(name),
  ]);
const celHead = (layer, type, z) => [
  ...u16(layer),
  ...u16(0),
  ...u16(0),
  255,
  ...u16(type),
  ...u16(z & 0xffff),
  0,
  0,
  0,
  0,
  0,
];
const rawCel = (layer, pixel, z = 0) => chunk(0x2005, [...celHead(layer, 0, z), ...u16(1), ...u16(1), ...pixel]);
const linkedCel = (layer, frame, z) => chunk(0x2005, [...celHead(layer, 1, z), ...u16(frame)]);
function aseprite(frames) {
  const body = frames.flatMap((chunks) => {
    const data = chunks.flat();
    return [
      ...u32(16 + data.length),
      ...u16(0xf1fa),
      ...u16(chunks.length),
      ...u16(100),
      0,
      0,
      ...u32(chunks.length),
      ...data,
    ];
  });
  const header = [
    ...u32(128 + body.length),
    ...u16(0xa5e0),
    ...u16(frames.length),
    ...u16(1),
    ...u16(1),
    ...u16(32),
    ...u32(1),
  ];
  return new Uint8Array([...header, ...new Array(128 - header.length).fill(0), ...body]);
}

test('a linked Aseprite cel keeps its own z-index', async () => {
  const RED = [255, 0, 0, 255],
    BLUE = [0, 0, 255, 255];
  // Frame 1 links layer 0's red cel with z +1, so it shows over layer 1's blue (NOTE.5: order 1 = 1, then z 0 < 1).
  const file = aseprite([
    [layerChunk('a'), layerChunk('b'), rawCel(0, RED)],
    [linkedCel(0, 0, 1), rawCel(1, BLUE)],
  ]);
  const { frames } = await parseAseprite(file);
  assert.deepEqual([...frames[0]], RED);
  assert.deepEqual([...frames[1]], RED, 'the linked cel took the z-index of the cel it links to');
});

test('a Spine IK key without mix applies mix 1, not the setup mix', () => {
  const data = {
    skeleton: { spine: '4.2.0' },
    bones: [
      { name: 'root', length: 5 },
      { name: 'tip', parent: 'root', x: 5, length: 3 },
      { name: 'target', x: 4, y: 2 },
    ],
    slots: [],
    ik: [{ name: 'arm', bones: ['root', 'tip'], target: 'target', mix: 0 }],
    animations: { reach: { ik: { arm: [{ time: 0 }] } } },
  };
  const rig = parseSpineJSON(data).createSkeleton({ yDown: false });
  rig.pose('reach', 0, { loop: false });
  const tip = rig.bone('tip'),
    end = [tip.world[4] + tip.world[0] * 3, tip.world[5] + tip.world[1] * 3];
  assert.ok(Math.hypot(end[0] - 4, end[1] - 2) < 1e-6, `tip end ${end} did not reach the target`);
});

test('a Spine IK key without bendPositive, compress or stretch means true, false, false, not the setup (KB6013b)', () => {
  // Spine 4.2.22 exports (raptor-pro, spineboy-pro, stretchyman-pro) write bendPositive only as false and stretch only
  // as true in IK keys, so a key that leaves them out means bendPositive true and stretch/compress false.
  const rig = (setup, key = { time: 0 }) => {
    const r = parseSpineJSON({
      skeleton: { spine: '4.2.22' },
      bones: [
        { name: 'root', length: 5 },
        { name: 'tip', parent: 'root', x: 5, length: 3 },
        { name: 'target', x: 4, y: 2 },
        { name: 'far', x: 20, y: 0 },
      ],
      slots: [],
      ik: [{ name: 'arm', bones: ['root', 'tip'], ...setup }],
      animations: { reach: { ik: { arm: [key] } } },
    }).createSkeleton({ yDown: false });
    r.pose('reach', 0, { loop: false });
    const root = r.bone('root');
    return [root.world[0], root.world[1], root.world[4], root.world[5]];
  };
  // Setup bends negative; a key that leaves bendPositive out bends positive, like a setup that bends positive.
  assert.deepEqual(rig({ target: 'target', bendPositive: false }), rig({ target: 'target', bendPositive: true }));
  assert.notDeepEqual(
    rig({ target: 'target', bendPositive: false }, { time: 0, bendPositive: false }),
    rig({ target: 'target', bendPositive: true }),
    'a key that says false still bends negative',
  );
  // Setup stretches toward a far target; a key that leaves stretch out does not stretch.
  const scale = (setup, key) => {
    const r = parseSpineJSON({
      skeleton: { spine: '4.2.22' },
      bones: [{ name: 'root', length: 5 }, { name: 'far', x: 20, y: 0 }],
      slots: [],
      ik: [{ name: 'one', bones: ['root'], target: 'far', ...setup }],
      animations: { reach: { ik: { one: [key] } } },
    }).createSkeleton({ yDown: false });
    r.pose('reach', 0, { loop: false });
    return Math.hypot(r.bone('root').world[0], r.bone('root').world[1]);
  };
  assert.ok(Math.abs(scale({ stretch: true }, { time: 0 }) - 1) < 1e-9, 'left-out stretch does not stretch');
  assert.ok(scale({ stretch: false }, { time: 0, stretch: true }) > 3, 'a key that says true stretches');
});

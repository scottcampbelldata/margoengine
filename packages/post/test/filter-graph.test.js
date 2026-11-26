import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImageFilterGraph,
  filterBlocks,
  parseFilterBlock,
  parseFilterGraph,
  planFilterGraph,
} from '@margoengine/post/filter-graph';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const image = { type: 'image' };
const chain = (...types) => ({
  inputs: { a: image },
  nodes: types.map((type, i) => ({ id: `n${i}`, type, images: { input: i ? `n${i - 1}` : 'a' } })),
  output: `n${types.length - 1}`,
});
const blocks = (plan) => plan.passes.map((pass) => pass.blocks);

test('the optimizer fuses a block into its only consumer when that reads its own pixel or one texel', () => {
  const pointwise = chain('black-and-white', 'exposure', 'tint', 'vignette');
  assert.deepEqual(blocks(planFilterGraph(pointwise)), [['n0', 'n1', 'n2', 'n3']]);
  const split = planFilterGraph(pointwise, { optimize: false });
  assert.equal(split.passes.length, 4);
  assert.equal(split.textures, 2, 'a chain ping-pongs between two intermediates');
  assert.deepEqual(blocks(planFilterGraph(chain('invert', 'pixelate', 'sepia'))), [['n0', 'n1', 'n2']]);
  // One fused texel read a chain, and every producer called from one place, so a long pass's shader stays linear.
  assert.deepEqual(blocks(planFilterGraph(chain('pixelate', 'pixelate', 'pixelate'))), [['n0'], ['n1', 'n2']]);
  const [long] = planFilterGraph(chain(...Array(24).fill('invert'))).passes;
  assert.equal(long.shader.match(/=b\d+\(uv\);/g).length, 23, 'each producer is called');
  assert.equal(long.shader.match(/\bb\d+\(uv\)/g).length, 23, 'and from one place only');
  // A filtered read keeps its producer in a texture; the producer of that can still join the producer.
  assert.deepEqual(blocks(planFilterGraph(chain('invert', 'tint', 'sharpen', 'sepia'))), [
    ['n0', 'n1'],
    ['n2', 'n3'],
  ]);
});

test('fan-out, a different scale, optimize: false and the texture limit each keep a pass apart', () => {
  const graph = {
    inputs: { a: image },
    nodes: [
      { id: 'base', type: 'tint', images: { input: 'a' } },
      { id: 'both', type: 'composite', images: { background: 'base', foreground: 'base' } },
    ],
    output: 'both',
  };
  assert.deepEqual(blocks(planFilterGraph(graph)), [['base'], ['both']]);
  const two = chain('invert', 'sepia');
  two.nodes[0].scale = 0.5;
  assert.equal(planFilterGraph(two).passes.length, 2);
  two.nodes[0] = { ...two.nodes[0], scale: 1, optimize: false };
  assert.equal(planFilterGraph(two).passes.length, 2);
  const wide = {
    inputs: { a: image, b: image, c: image },
    nodes: [
      { id: 'x', type: 'composite', images: { background: 'a', foreground: 'b' } },
      { id: 'y', type: 'composite', images: { background: 'x', foreground: 'c' } },
    ],
    output: 'y',
  };
  assert.equal(planFilterGraph(wide).passes.length, 1);
  assert.equal(planFilterGraph(wide, { maxTextures: 2 }).passes.length, 2);
  assert.throws(() => planFilterGraph(wide, { maxTextures: 1 }), /more than 1 textures/);
});

test('aggregates expand, unused blocks drop out, and a scaled or bare output gets a copy pass', () => {
  const plan = planFilterGraph({
    inputs: { a: image, unused: image },
    nodes: [
      { id: 'soft', type: 'blur', images: { input: 'a' }, params: { radius: 4 } },
      { id: 'spare', type: 'invert', images: { input: 'unused' } },
    ],
    output: 'soft',
  });
  assert.deepEqual(blocks(plan), [['soft/horizontal'], ['soft/vertical'], ['(output)']]);
  assert.deepEqual(
    plan.passes.map((pass) => pass.scale),
    [0.5, 0.5, 1],
  );
  assert.deepEqual(plan.images, ['a']);
  assert.equal(plan.cells.get('soft.radius').value[0], 4);
  assert.deepEqual(blocks(planFilterGraph({ inputs: { a: image }, output: 'a' })), [['(output)']]);
});

test('bad graphs, blocks and values are refused with the reason', () => {
  const one = (node, extra = {}) => ({ inputs: { a: image }, nodes: [node], output: node.id, ...extra });
  const n = { id: 'n', type: 'invert', images: { input: 'a' } };
  for (const [graph, pattern] of [
    [one({ ...n, type: 'nope' }), /unknown block type nope/],
    [one({ ...n, images: { input: 'n' } }), /cycle/],
    [one({ ...n, images: {} }), /names no node or image input/],
    [one({ ...n, params: { gain: 1 } }), /no param gain/],
    [one({ ...n, params: { amount: 2 } }), /from 0 to 1/],
    [one({ ...n, params: { amount: '$missing' } }), /no value input/],
    [one({ ...n, id: 'a' }), /used twice/],
    [one({ ...n, scale: 8 }), /scale/],
    [one({ id: 'n', type: 'blur', images: { input: 'a' }, enabled: false }), /aggregate/],
    [one({ id: 'n', type: 'directional-blur', images: { input: 'a' }, consts: { TAPS: 10 } }), /options/],
    [{ ...one(n), version: 2 }, /version/],
    [{ ...one(n), output: 'gone' }, /output names no node/],
    [
      one(
        { ...n, type: 'loop' },
        {
          blocks: [
            {
              type: 'loop',
              graph: {
                inputs: { input: image },
                nodes: [{ id: 'm', type: 'loop', images: { input: 'input' } }],
                output: 'm',
              },
            },
          ],
        },
      ),
      /nest/,
    ],
    [
      one(
        { ...n, type: 'x' },
        {
          blocks: [
            {
              type: 'x',
              wgsl: '@group(0) @binding(0) var t:texture_2d<f32>; fn apply(uv:vec2f)->vec4f{return vec4f();}',
            },
          ],
        },
      ),
      /may not declare bindings/,
    ],
    [one({ ...n, type: 'x' }, { blocks: [{ type: 'x', wgsl: 'fn other() {}' }] }), /fn apply/],
  ])
    assert.throws(() => planFilterGraph(graph), pattern);
  assert.throws(() => parseFilterBlock('fn apply() {}'), /filter-block/);
  assert.throws(() => parseFilterGraph('{'), SyntaxError);
  const parsed = parseFilterGraph(JSON.stringify(one(n)));
  assert.equal(parsed.nodes[0].type, 'invert');
  const block = parseFilterBlock(
    '// filter-block {"type":"half","images":{"input":"pixel"}}\r\nfn apply(uv: vec2f, c: vec4f) -> vec4f { var<function> k = 0.5; return c * k; }\n',
  );
  assert.equal(planFilterGraph(one({ ...n, type: 'half' }), { blocks: [block] }).passes.length, 1);
  assert.equal(new Set(filterBlocks.map((b) => b.type)).size, filterBlocks.length);
});

/** A device and `navigator.gpu` that record, with async pipelines and a loss that can be triggered. */
function fake() {
  const gpus = [],
    made = [];
  const make = () => {
    const gpu = mockGPU(),
      { device } = gpu;
    for (const kind of ['createTexture', 'createBuffer']) {
      const create = device[kind];
      device[kind] = (d) => {
        const resource = create(d);
        made.push(resource);
        return resource;
      };
    }
    device.createRenderPipelineAsync = async (d) => device.createRenderPipeline(d);
    device.pushErrorScope = () => {};
    device.popErrorScope = async () => null;
    device.lost = new Promise((resolve) => (gpu.lose = (reason) => resolve({ reason })));
    device.destroy = () => (gpu.destroyed = true);
    gpus.push(gpu);
    return gpu;
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ requestDevice: async () => make().device }) } },
  });
  return { gpus, make, live: () => made.filter((r) => !r.destroyed) };
}
const picture = { width: 8, height: 4 };

test('a frame after the first makes no GPU object, writes only what changed, and dispose frees everything', async () => {
  const f = fake(),
    filter = await ImageFilterGraph.create({
      inputs: { a: image, amount: { type: 'float', default: 1 } },
      nodes: [
        { id: 'n', type: 'invert', images: { input: 'a' }, params: { amount: '$amount' } },
        { id: 's', type: 'sharpen', images: { input: 'n' } },
      ],
      output: 's',
    });
  const gpu = f.gpus[0];
  assert.equal(filter.render(), false, 'no image yet');
  filter.setImage('a', picture);
  assert.equal(filter.render(), true);
  assert.deepEqual([filter.width, filter.height, filter.passes.length, filter.intermediates], [8, 4, 2, 1]);
  const names = (log) => log.map((entry) => entry[0]);
  const made = /^(buffer|texture|view|group|layout|sampler|module|pipelineLayout|renderPipeline)$/;
  const still = names(gpu.record(() => filter.render()));
  assert.ok(still.includes('pass.draw'), 'the recorder sees the frame');
  assert.deepEqual(
    still.filter((name) => made.test(name) || name === 'writeBuffer'),
    [],
  );
  const changed = names(
    gpu.record(() => {
      filter.set('amount', 0.5);
      filter.render();
    }),
  );
  assert.equal(changed.filter((name) => name === 'writeBuffer').length, 1, 'only the pass that reads it');
  const timed = names(gpu.record(() => filter.render({ time: 1 })));
  assert.equal(timed.filter((name) => name === 'writeBuffer').length, 2);
  const replaced = names(
    gpu.record(() => {
      filter.setImage('a', { ...picture });
      filter.render();
    }),
  );
  assert.deepEqual(
    replaced.filter((name) => made.test(name)),
    [],
    'a new picture of the same size remakes nothing',
  );
  assert.equal(filter.get('amount'), 0.5);
  assert.throws(() => filter.set('amount', Number.NaN), RangeError);
  assert.throws(() => filter.set('nope', 1), /it has amount, /);
  assert.throws(() => filter.setImage('b', picture), /no image input b/);
  assert.throws(() => filter.render({ time: Infinity }), RangeError);
  assert.equal(filter.save().inputs.amount.default, 0.5);
  filter.resize(16, 16);
  filter.render();
  assert.equal(filter.width, 16);
  filter.dispose();
  filter.dispose();
  await assert.rejects(ImageFilterGraph.create(chain('invert'), { target: {}, size: [4, 4] }), TypeError);
  assert.deepEqual(f.live(), []);
  assert.equal(gpu.destroyed, true, 'the owned device goes too');
  assert.throws(() => filter.render(), { code: 'disposed' });
});

test('an owned device restores itself after a loss; a borrowed one is restored by its owner and kept', async () => {
  const f = fake(),
    graph = chain('invert');
  const owned = await ImageFilterGraph.create(graph);
  owned.setImage('a', picture);
  const first = owned.device;
  f.gpus[0].lose('unknown');
  for (let i = 0; i < 50 && (owned.device === first || !owned.render()); i++)
    await new Promise((done) => setTimeout(done, 1));
  assert.notEqual(owned.device, first);
  assert.equal(owned.render(), true);
  await assert.rejects(owned.restore(first), { code: 'state' });
  owned.dispose();
  const mine = f.make(),
    borrowed = await ImageFilterGraph.create(graph, { device: mine.device });
  await assert.rejects(borrowed.restore(), { code: 'state' });
  const next = f.make();
  borrowed.setImage('a', picture);
  await borrowed.restore(next.device);
  assert.equal(borrowed.render(), true);
  borrowed.dispose();
  assert.equal(next.destroyed, undefined);
  assert.deepEqual(f.live(), []);
});

test("a caller target belongs to its device: a restore takes the new device's texture and never keeps the lost one", async () => {
  const f = fake(),
    graph = chain('invert'),
    mine = f.make(),
    next = f.make(),
    texture = (device) =>
      device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  globalThis.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 };
  const old = texture(mine.device),
    filter = await ImageFilterGraph.create(graph, { device: mine.device, target: old });
  filter.setImage('a', picture);
  assert.equal(filter.output, old);
  await assert.rejects(filter.restore(next.device), { code: 'state', message: /restore\(device, \{ target \}\)/ });
  assert.equal(filter.output, old, 'a refused restore leaves the graph as it was');
  const fresh = texture(next.device);
  await filter.restore(next.device, { target: fresh });
  assert.equal(filter.output, fresh);
  assert.equal(filter.render(), true);
  filter.dispose();
  const plain = await ImageFilterGraph.create(graph, { device: mine.device });
  await assert.rejects(plain.restore(next.device, { target: fresh }), { code: 'state', message: /no target/ });
  plain.dispose();
});

test('creation and loads abort, and a missing GPU is a coded error', async () => {
  const f = fake(),
    reason = new Error('stop');
  await assert.rejects(ImageFilterGraph.create(chain('invert'), { signal: AbortSignal.abort(reason) }), reason);
  const controller = new AbortController(),
    pending = ImageFilterGraph.create(chain('invert'), { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, reason);
  const filter = await ImageFilterGraph.create(chain('invert'));
  await assert.rejects(filter.load('a', 'x.png', { signal: AbortSignal.abort(reason) }), reason);
  await assert.rejects(filter.load('a', { camera: true }, { mediaDevices: {} }), { code: 'unsupported' });
  const asking = new AbortController();
  let stopped = 0;
  const camera = filter.load(
    'a',
    { camera: true },
    {
      signal: asking.signal,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) },
    },
  );
  asking.abort(reason);
  await assert.rejects(camera, reason);
  await new Promise((done) => setTimeout(done, 1));
  assert.equal(stopped, 1, 'a camera granted after an abort is closed');
  filter.dispose();
  await new Promise((done) => setTimeout(done, 1));
  assert.deepEqual(f.live(), []);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  await assert.rejects(ImageFilterGraph.create(chain('invert')), { code: 'unsupported' });
});

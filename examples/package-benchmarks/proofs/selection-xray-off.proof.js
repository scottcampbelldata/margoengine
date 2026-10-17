// Proof that x-ray outlines (hidden lines) leave selection unchanged while x-ray is off: every GPU call, descriptor and
// buffer write of a 30-frame story (core meshes, a gltf-pro-shaped model and its nodes, width, color, both algorithms,
// resize, hidden nodes, depth and color format changes, an empty selection, model rescans, device restore, dispose)
// matches the package at `ref`, byte for byte, at 1x and 4x MSAA, with `xray` absent, false and deleted mid-story.
// The same story with x-ray on must differ (so the comparison can see the feature).
// Run: node examples/package-benchmarks/proofs/selection-xray-off.proof.js [ref] [pin] [--current]
// Pinned: 46f9484 against 80d4cfb, the commit that made this claim. --current: b3ed8ac against the working tree;
// 6a57389 added the approved ambient uniform and 95b4eae added back-side-only model culling (claims.md).
import assert from 'node:assert/strict';
import { refs, versions, current } from './compare.js';
import { mockGPU, passes, context } from './gpu-recorder.js';

const { ref, pin } = refs('46f9484', '80d4cfb', 'b3ed8ac'),
  { baseline, candidate } = await versions('selection', ref, undefined, pin);

function story(module, samples, xray) {
  const gpu = mockGPU(),
    meshes = new Map(),
    store = { capacity: 16, parents: new Int32Array(16).fill(-1), hidden: new Uint8Array(16) };
  const mesh = (id) => {
    const m = { id, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, id, 0, -3, 1]) };
    meshes.set(id, m);
    return m;
  };
  const a = mesh(2),
    b = mesh(5),
    root = mesh(7),
    node = mesh(8);
  store.parents[8] = 7;
  const primitive = {
    node,
    vertices: new Float32Array(60),
    indices: new Uint32Array([0, 1, 2]),
    material: { settings: [0, 0, 1, 0] },
    buffers: { vertex: gpu.device.createBuffer({ size: 240 }), index: gpu.device.createBuffer({ size: 12 }) },
  };
  const model = { name: 'model', root, primitives: [primitive], setup() {} },
    graph = { revision: 0 };
  const engine = {
    gpu: gpu.device,
    meshes,
    store,
    frameGraph: graph,
    plugins: new Map([['model', model]]),
    removePlugin() {},
  };
  const view = context(gpu, { samples });
  return gpu.record(() => {
    const selection = new module.Selection(xray === undefined ? {} : { xray });
    selection.setup(engine);
    const run = passes(selection);
    for (let i = 0; i < 30; i++) {
      if (i === 0) selection.set([a]);
      if (i === 2) selection.set([a, b]);
      if (i === 4) selection.options.width = 6;
      if (i === 6) selection.options.algorithm = 'morphological';
      if (i === 8) {
        selection.options.algorithm = 'jfa';
        selection.options.color = [0, 1, 0];
      }
      if (i === 10) {
        view.state.width = 1920;
        view.state.height = 1080;
      }
      if (i === 12) selection.set([model]);
      if (i === 14) selection.set([a, node]);
      if (i === 15) store.hidden[8] = 1;
      if (i === 16) store.hidden[8] = 0;
      if (i === 17) view.state.depthFormat = 'depth32float';
      if (i === 19) selection.set([]);
      if (i === 20) {
        selection.set([b, model]);
        if (xray === false) delete selection.options.xray;
      }
      if (i === 22) selection.onDeviceRestored(engine);
      if (i === 24) view.state.format = 'bgra8unorm';
      if (i === 26) graph.revision++;
      view.begin(i);
      run(view.c);
      view.end();
    }
    selection.dispose();
  });
}
let entries = 0;
for (const samples of [1, 4])
  for (const xray of [undefined, false]) {
    const expected = story(baseline, samples, xray),
      actual = story(candidate, samples, xray);
    assert.ok(
      expected.length > 400 &&
        expected.filter((entry) => entry[0] === 'pass.drawIndexed').length >= 10 &&
        expected.filter((entry) => entry[0] === 'pass.dispatchWorkgroups').length > 100,
      'story must draw models and run the jump flood',
    );
    assert.deepEqual(actual, expected, `selection GPU calls differ at ${samples}x with xray ${xray}`);
    entries += expected.length;
  }
assert.notDeepEqual(story(candidate, 4, true), story(candidate, 4, false), 'x-ray on must change the GPU calls');
if (!current)
  assert.notDeepEqual(story(candidate, 4, true), story(baseline, 4, true), 'x-ray was added after the baseline');
console.log(
  JSON.stringify({
    package: 'selection',
    baseline: ref,
    identicalCalls: entries,
    writes: 'byte-identical',
    xrayOnDiffers: true,
  }),
);

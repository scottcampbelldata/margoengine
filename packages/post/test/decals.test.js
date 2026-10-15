// CPU checks (mock GPU) for @margoengine/post/decals: validation and packing, ordering by blend mode, one pass with one
// instanced draw per mode, zero work without decals, and the scene-depth requirement. The GPU is checked by
// examples/package-benchmarks/decals-gpu.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mockGPU, passes, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {Camera} from '../../core/dist/extension.js';
import {SceneTarget} from '../../shared/msaa.js';
import {Decals, MAX_DECALS} from '../dist/decals.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
const floats = hex => {const b = Buffer.from(hex, 'hex'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));};
function rig({samples = 4, capture = true, options} = {}) {
  const gpu = mockGPU(), view = context(gpu, {samples, format: 'rgba16float', shader: 'lit shader'}), size = [view.state.width, view.state.height];
  const engine = {gpu: gpu.device, removed: [], removePlugin(name) {this.removed.push(name);}};
  const target = capture ? new SceneTarget(gpu.device, gpu.device.createTexture({size, format: 'rgba16float', usage}), gpu.device.createTexture({size, format: 'depth24plus-stencil8', usage}), samples) : undefined;
  const decals = new Decals(options); decals.setup(engine);
  const run = passes(decals), frame = i => {view.begin(i); target?.begin(view.c); const camera = new Camera({position: [0, 3, 4], target: [0, 0, 0]}); camera.update(16 / 9, true); view.c.camera = camera; run(view.c);};
  return {gpu, view, engine, decals, frame, record: work => gpu.record(work)};
}
const floor = {position: [0, 0, 0], direction: [0, -1, 0], width: 2, height: 1, up: [0, 0, -1]};

test('Decals validates and packs each decal: centre + mode, half axes (right, up, projection), cos angle, opacity, rect, colour', () => {
  const {decals} = rig();
  for (const bad of [{...floor, direction: [0, 0, 0]}, {...floor, width: 0}, {...floor, rect: [0, 0, 2, 1]}, {...floor, opacity: 2}, {...floor, angle: 2}, {...floor, mode: 'add'}, {...floor, color: [-1, 0, 0]}, {...floor, up: [0, 1, 0]}, {...floor, position: [0, NaN, 0]}])
    assert.throws(() => decals.setDecals([bad]), RangeError, JSON.stringify(bad));
  assert.throws(() => decals.setDecals(Array.from({length: MAX_DECALS + 1}, () => floor)), /at most 4096/);
  assert.throws(() => new Decals({atlas: {}}), /sampled 2D GPUTexture/);
  decals.setDecals([{...floor, mode: 'over', color: [2, 1, 0.5], rect: [0, 0, 0.5, 0.5]}, floor]);
  assert.equal(decals.count, 2);
  const data = decals['data'];
  // 'multiply' first: floor (default depth min(2, 1) = 1, angle PI/3, opacity 1, rect 0..1, white).
  assert.deepEqual(Array.from(data.subarray(0, 24), v => +v.toFixed(4)), [0, 0, 0, 0, -1, 0, 0, 0.5, 0, 0, -0.5, 1, 0, -0.5, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(Array.from(data.subarray(24, 28)), [0, 0, 0, 1], "'over' second, flagged");
  assert.deepEqual(Array.from(data.subarray(40, 47)), [0, 0, 0.5, 0.5, 2, 1, 0.5]);
});

test('one render pass over the scene target, one instanced box draw per blend mode; nothing without decals', () => {
  for (const samples of [1, 4]) {
    const {decals, frame, record, view} = rig({samples});
    frame(0); assert.deepEqual(record(() => frame(1)), [], 'no decals: no GPU work');
    decals.setDecals([floor, {...floor, mode: 'over'}, {...floor, position: [1, 0, 0]}]);
    const log = record(() => frame(2));
    assert.equal(log.filter(e => e[0] === 'beginRenderPass').length, 1);
    assert.deepEqual(log.filter(e => e[0] === 'pass.draw').map(e => e.slice(1, 5)), [[36, 2, undefined, undefined], [36, 1, 0, 2]]);
    const pipelines = log.filter(e => e[0] === 'renderPipeline').map(e => e[2]);
    assert.deepEqual(pipelines.map(p => [p.primitive.cullMode, p.multisample.count, p.fragment.targets[0].blend.color.srcFactor]), [['front', samples, 'dst'], ['front', samples, 'src-alpha']]);
    const code = log.find(e => e[0] === 'module')[2].code;
    assert.equal(code.includes('texture_depth_multisampled_2d'), samples === 4);
    const layout = log.find(e => e[0] === 'layout' && e[2].entries)[2];
    assert.deepEqual(layout.entries[2].texture, {multisampled: samples === 4, sampleType: 'depth'});
    const view0 = log.find(e => e[0] === 'writeBuffer' && e[3].length === 160 * 2), values = floats(view0[3]);
    assert.deepEqual([values[36], values[37]], [1280, 720]); assert.deepEqual(Array.from(values.subarray(32, 35)), [0, 3, 4]);
    // Steady frames: no new pipelines, groups or decal uploads.
    const steady = record(() => frame(3));
    assert.equal(steady.filter(e => ['renderPipeline', 'group', 'module'].includes(e[0])).length, 0);
    assert.equal(steady.filter(e => e[0] === 'writeBuffer').length, 1, 'only the view uniform');
    assert.equal(view.c.shader, 'lit shader'); assert.deepEqual(view.c.bindings, []);
    decals.dispose();
  }
});

test('Decals need scene depth and release everything on dispose', () => {
  const {decals, frame, engine} = rig({capture: false});
  decals.setDecals([floor]);
  assert.throws(() => frame(0), /Decals need scene depth: attach a post capture/);
  decals.dispose(); assert.deepEqual(engine.removed, ['post:decals']); assert.throws(() => decals.setDecals([floor]), RangeError);
  assert.throws(() => new Decals().setup({gpu: null}), /WebGPU/);
});

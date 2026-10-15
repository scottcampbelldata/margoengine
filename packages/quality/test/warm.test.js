import test from 'node:test';
import assert from 'node:assert/strict';
import {warmUp} from '../dist/warm.js';

// A device whose sync and async creation calls are counted; the pipeline records how it was made. Encoders log their
// passes and the queue logs what each submit carried.
class Device {
  calls = {sync: 0, async: 0};
  submitted = [];
  queue = {submit: buffers => this.submitted.push(...buffers.map(b => b.log)), onSubmittedWorkDone: async () => {this.idle = true;}};
  createShaderModule({code}) {return {code};}
  createRenderPipeline(descriptor) {this.calls.sync++; return {descriptor, made: 'sync'};}
  createComputePipeline(descriptor) {this.calls.sync++; return {descriptor, made: 'sync'};}
  async createRenderPipelineAsync(descriptor) {this.calls.async++; return {descriptor, made: 'async'};}
  async createComputePipelineAsync(descriptor) {this.calls.async++; return {descriptor, made: 'async'};}
  createTexture(descriptor) {return {width: descriptor.size[0], height: descriptor.size[1], format: descriptor.format, offscreen: true, destroy() {}};}
  createCommandEncoder() {
    const log = [], pass = name => () => {log.push(name); return {end: () => log.push(name + ':end')};};
    return {log, beginRenderPass: pass('render'), beginComputePass: pass('compute'), finish: () => ({log})};
  }
  pushErrorScope() {}
  async popErrorScope() {return null;}
}
const canvasTexture = {canvas: true};
globalThis.GPUCanvasContext = class {getCurrentTexture() {return canvasTexture;}};
// An engine frame like core's: one encoder, the canvas texture, the features' passes, one submit.
function engine(features, backend = 'webgpu') {
  const gpu = new Device(), frames = [], context = Object.assign(new GPUCanvasContext(), {getConfiguration: () => ({format: 'bgra8unorm'})});
  const canvas = {width: 4, height: 2, getContext: () => context};
  return {gpu, backend, canvas, disposed: false, frames, render(options) {
    const encoder = this.gpu.createCommandEncoder(), color = context.getCurrentTexture();
    for (const feature of features) feature(this.gpu, encoder);
    this.gpu.queue.submit([encoder.finish()]); frames.push({...options, color});
  }};
}
const lazy = (make, slot = {}) => Object.assign(device => {slot.pipeline ??= make(device);}, {slot});

test('warmUp creates every lazily made pipeline with the async API and restores the device', async () => {
  const shared = {}, module = {code: 'shared'};
  const features = [
    lazy(d => d.createRenderPipeline({layout: 'auto', vertex: {module: d.createShaderModule({code: 'a'}), entryPoint: 'v'}})),
    lazy(d => d.createComputePipeline({layout: 'auto', compute: {module, entryPoint: 'main'}}), shared),
    lazy(d => d.createRenderPipeline({layout: 'auto', vertex: {module: d.createShaderModule({code: 'b'}), entryPoint: 'v'}, multisample: {count: 4}})),
  ];
  const e = engine(features), report = await warmUp(e);
  assert.deepEqual(report, {pipelines: 3, fallbacks: 0, rounds: 5, rebooted: false}, 'three aborted rounds, then two complete frames');
  assert.deepEqual(features.map(f => f.slot.pipeline.made), ['async', 'async', 'async']);
  assert.deepEqual(e.gpu.calls, {sync: 0, async: 3}); assert.equal(e.gpu.idle, true, 'resolves after the GPU finished the warm frames');
  assert.equal(e.frames.length, 2); assert.equal(e.frames[0].delta, 0);
  assert.ok(e.frames.every(f => f.color.offscreen), 'warm frames draw offscreen, nothing is presented');
  assert.equal(Object.hasOwn(e.gpu, 'createRenderPipeline'), false, 'patches removed');
  e.gpu.createRenderPipeline({layout: 'auto'});
  assert.equal(e.gpu.calls.sync, 1, 'calls after warmUp go to the device again');
  e.render({}); assert.equal(e.frames[2].color, canvasTexture, 'frames after warmUp present again');
});

test('a stopped frame still submits the work it encoded before the stop', async () => {
  // A one-time table pass (marked done when encoded) followed by a lazily made pipeline in the same frame.
  const table = {};
  const feature = (d, encoder) => {
    if (!table.done) {encoder.beginComputePass(); table.done = true;}
    table.pipeline ??= d.createRenderPipeline({layout: 'auto', vertex: {module: d.createShaderModule({code: 't'}), entryPoint: 'v'}});
    encoder.beginRenderPass().end();
  };
  const e = engine([feature]);
  await warmUp(e);
  assert.deepEqual(e.gpu.submitted, [['compute', 'compute:end'], ['render', 'render:end'], ['render', 'render:end']], 'the open table pass is ended and submitted');
});

test('frames rendered outside the warm frames, unstable identities and other errors', async () => {
  // A layout object recreated on every call cannot match its warmed descriptor: created synchronously, no endless loop.
  const unstable = lazy(d => d.createRenderPipeline({layout: new (class PipelineLayout {})(), vertex: {module: d.createShaderModule({code: 'x'}), entryPoint: 'v'}}));
  const e = engine([unstable]), report = await warmUp(e);
  assert.deepEqual(report, {pipelines: 1, fallbacks: 1, rounds: 3, rebooted: false});
  assert.equal(unstable.slot.pipeline.made, 'sync');

  // The engine's own loop renders while warmUp waits: that frame creates normally and never sees the abort.
  const late = lazy(d => d.createRenderPipeline({layout: 'auto', vertex: {module: d.createShaderModule({code: 'late'}), entryPoint: 'v'}}));
  const looping = engine([late]), pending = warmUp(looping);
  const loopFrame = looping.gpu.createComputePipeline({layout: 'auto', compute: {entryPoint: 'loop'}});
  await pending;
  assert.equal(loopFrame.made, 'sync'); assert.equal(late.slot.pipeline.made, 'async');

  // A feature that stores state before creating its pipeline is left half-initialised by the stopped frame: the
  // device is restored (which resets every feature) and the warm frames finish with synchronous creation.
  const sized = {};
  const careless = Object.assign(d => {
    if (!sized.width) {sized.width = 1; sized.pipeline = d.createRenderPipeline({layout: 'auto', vertex: {module: d.createShaderModule({code: 'c'}), entryPoint: 'v'}});}
    if (!sized.pipeline) throw new TypeError("parameter 1 is not of type 'GPURenderPipeline'");
  }, {slot: sized});
  const resettable = engine([careless]), first = resettable.gpu;
  resettable.rebootDevice = async () => {resettable.gpu = new Device(); delete sized.width; delete sized.pipeline;};
  assert.deepEqual(await warmUp(resettable), {pipelines: 1, fallbacks: 0, rounds: 4, rebooted: true});
  assert.notEqual(resettable.gpu, first); assert.equal(sized.pipeline.made, 'sync'); assert.equal(Object.hasOwn(first, 'createRenderPipeline'), false);

  const failing = engine([() => {throw new RangeError('scene error');}]);
  await assert.rejects(warmUp(failing), RangeError);
  assert.equal(Object.hasOwn(failing.gpu, 'createRenderPipeline'), false, 'patches removed after a failure');

  assert.deepEqual(await warmUp(engine([], 'webgl2')), {pipelines: 0, fallbacks: 0, rounds: 0, rebooted: false});
});

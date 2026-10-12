import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Stats, GPUProfiler} from '../dist/index.js';

function overlay(t, options = {}) {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({parent: dom.window.document.body, ...options});
  t.after(() => {stats.dispose(); dom.window.close();}); return stats;
}
test('rejected attachment removes the overlay and stops its refresh timer',()=>{
 const dom=new JSDOM('<body></body>');dom.window.HTMLCanvasElement.prototype.getContext=()=>null;
 try{assert.throws(()=>Stats.attach({use(){throw new Error('Duplicate plugin');}},{parent:dom.window.document.body}),/Duplicate/);assert.equal(dom.window.document.body.children.length,0);}
 finally{dom.window.close();}
});

test('rolling samples wrap, reject bad input atomically and tick never touches the DOM', t => {
  const stats = overlay(t, {samples: 3}), samples = stats.samples, buffer = samples.buffer;
  stats.tick(10, 2, 3); stats.tick(20, 4, 5); stats.tick(30, 6, 7); stats.tick(40, 8, 9);
  assert.equal(stats.frameTime, 30); assert.equal(stats.fps, 1000 / 30); assert.deepEqual([...samples], [40, 20, 30]);
  const before = [...samples];
  for (const args of [[0], [NaN], [Infinity], [10, -1], [10, 1, 0.5]]) assert.throws(() => stats.tick(...args), /Invalid/);
  assert.deepEqual([...samples], before);
  const text = stats.element.textContent;
  for (let i = 0; i < 20_000; i++) stats.tick(16, 1, 2);
  assert.equal(stats.samples, samples); assert.equal(stats.samples.buffer, buffer); assert.equal(stats.element.textContent, text);
  stats.refresh(); assert.match(stats.element.textContent, /63 FPS.*16\.00 ms/); assert.match(stats.element.textContent, /1 draws  2 dispatches/);
  stats.dispose(); assert.equal(stats.element.isConnected, false); assert.throws(() => stats.tick(1), /disposed/);
});

test('encoder instrumentation preserves arguments and receivers, counts all direct and indirect variants once', t => {
  const stats = overlay(t), calls = [];
  const render = Object.fromEntries(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].map(name => [name, function(...args) {assert.equal(this, render); calls.push([name, args]);}]));
  const compute = {dispatchWorkgroups(...args) {assert.equal(this, compute); calls.push(['dispatch', args]);}, dispatchWorkgroupsIndirect(...args) {assert.equal(this, compute); calls.push(['dispatchIndirect', args]);}};
  const encoder = {beginRenderPass(d) {assert.equal(this, encoder); assert.equal(d.colorAttachments.length, 0); return render;}, beginComputePass() {assert.equal(this, encoder); return compute;}, finish() {assert.equal(this, encoder); return 42;}};
  stats.track(encoder); stats.track(encoder);
  const r = encoder.beginRenderPass({colorAttachments: []}), c = encoder.beginComputePass(), buffer = {};
  r.draw(3); r.drawIndexed(6, 2, 3, -1, 4); r.drawIndirect(buffer, 16); r.drawIndexedIndirect(buffer, 32);
  c.dispatchWorkgroups(8); c.dispatchWorkgroupsIndirect(buffer, 64);
  assert.equal(stats.drawCalls, 4); assert.equal(stats.dispatches, 2); assert.equal(encoder.finish(), 42);
  assert.deepEqual(calls, [['draw', [3, 1, 0, 0]], ['drawIndexed', [6, 2, 3, -1, 4]], ['drawIndirect', [buffer, 16]], ['drawIndexedIndirect', [buffer, 32]], ['dispatch', [8, 1, 1]], ['dispatchIndirect', [buffer, 64]]]);
});

function gpu(t) {
  const flags = {GPUBufferUsage: {QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8}, GPUMapMode: {READ: 1}};
  for (const [key, value] of Object.entries(flags)) {const old = globalThis[key]; globalThis[key] = value; t.after(() => {if (old === undefined) delete globalThis[key]; else globalThis[key] = old;});}
  const resources = [], timestamps = new BigUint64Array([1_000_000n, 3_000_000n, 8_000_000n, 11_000_000n]);
  const device = {features: new Set(['timestamp-query']), createQuerySet() {const r = {destroyed: false, destroy() {this.destroyed = true;}}; resources.push(r); return r;}, createBuffer() {const r = {destroyed: false, mapped: false, async mapAsync() {this.mapped = true;}, getMappedRange() {return timestamps.buffer;}, unmap() {this.mapped = false;}, destroy() {this.destroyed = true;}}; resources.push(r); return r;}};
  const encoder = {resolveQuerySet(...args) {assert.equal(args[2], 4);}, copyBufferToBuffer(...args) {assert.equal(args[4], 32);}};
  return {device, encoder, resources};
}

test('timestamp queries sum pass nanoseconds, skip frames during readback and release resources', async t => {
  const {device, encoder, resources} = gpu(t), profiler = new GPUProfiler(device);
  assert.equal(profiler.beginFrame(), true); assert.equal(profiler.timestampWrites().beginningOfPassWriteIndex, 0);
  assert.equal(profiler.timestampWrites().endOfPassWriteIndex, 3); assert.equal(profiler.resolve(encoder), true);
  assert.equal(profiler.beginFrame(), false);
  const pending = profiler.read(); assert.equal(profiler.beginFrame(), false); assert.equal(await pending, 5);
  assert.equal(profiler.beginFrame(), true); assert.equal(profiler.resolve(encoder), false);
  profiler.dispose(); profiler.dispose(); assert.ok(resources.every(r => r.destroyed)); assert.throws(() => profiler.beginFrame(), /disposed/);
});

test('unsupported devices and overflow omit GPU timing without creating invalid queries', t => {
  const unsupported = new GPUProfiler({features: new Set(), createQuerySet() {assert.fail('Unsupported device created queries');}});
  assert.equal(unsupported.supported, false); assert.equal(unsupported.beginFrame(), false); unsupported.dispose();
  const {device, resources} = gpu(t), profiler = new GPUProfiler(device);
  profiler.beginFrame(); for (let i = 0; i < 128; i++) assert.ok(profiler.timestampWrites());
  assert.equal(profiler.timestampWrites(), undefined); assert.equal(profiler.resolve({}), false); assert.equal(profiler.milliseconds, null);
  profiler.dispose(); assert.ok(resources.every(r => r.destroyed));
});

test('failed setup and disposal during a pending map release every created resource', async t => {
  const {device, encoder, resources} = gpu(t), original = device.createBuffer;
  device.createBuffer = () => {throw new Error('out of memory');};
  assert.throws(() => new GPUProfiler(device), /out of memory/); assert.ok(resources[0].destroyed); device.createBuffer = original;
  const profiler = new GPUProfiler(device); profiler.beginFrame(); profiler.timestampWrites(); profiler.timestampWrites(); profiler.resolve(encoder);
  let release; resources.at(-1).mapAsync = () => new Promise(resolve => {release = resolve;});
  const pending = profiler.read(); profiler.dispose(); release(); assert.equal(await pending, null); assert.ok(resources.every(r => r.destroyed));
});

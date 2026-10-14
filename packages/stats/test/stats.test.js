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

test('DOM refresh is scheduled at 150 ms and numeric sampling stays independent', t => {
  let interval;
  const previous=globalThis.setInterval;
  globalThis.setInterval=(callback, milliseconds)=>{interval=milliseconds;return previous(callback,milliseconds);};
  try {const stats=overlay(t);assert.equal(interval,150);stats.tick(16);assert.equal(stats.sampleCount,1);}
  finally {globalThis.setInterval=previous;}
});

test('a zero-delta restart excludes paused time from rolling frame samples',t=>{
  const stats=overlay(t);let now=16,sample;
  t.mock.method(performance,'now',()=>now);
  stats.registerPasses({add(pass){if(pass.name==='stats:sample')sample=pass.execute;}});
  const context={backend:'webgpu',delta:0.016};sample(context);now=32;sample(context);
  const count=stats.sampleCount;now=10000;context.delta=0;sample(context);assert.equal(stats.sampleCount,count);
  now=10016;context.delta=0.016;sample(context);assert.equal(stats.frameTime,16);
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
  assert.match(stats.element.textContent, /GPU timing off/);
  stats.gpuTime = 2.5; stats.refresh(); assert.match(stats.element.textContent, /GPU timing 2\.50 ms/);
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
  const next={beginRenderPass(){return render;},beginComputePass(){return compute;},finish(){return 42;}};
  stats.track(next);
  assert.equal(next.beginRenderPass,encoder.beginRenderPass);assert.equal(next.beginComputePass,encoder.beginComputePass);assert.equal(next.finish,encoder.finish);
});

function gpu(t) {
  const flags = {GPUBufferUsage: {QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8}, GPUMapMode: {READ: 1}};
  for (const [key, value] of Object.entries(flags)) {const old = globalThis[key]; globalThis[key] = value; t.after(() => {if (old === undefined) delete globalThis[key]; else globalThis[key] = old;});}
  const resources = [], timestamps = new BigUint64Array([1_000_000n, 3_000_000n, 8_000_000n, 11_000_000n]);
  const device = {features: new Set(['timestamp-query']), createQuerySet() {const r = {destroyed: false, destroy() {this.destroyed = true;}}; resources.push(r); return r;}, createBuffer() {const r = {destroyed: false, mapped: false, async mapAsync() {this.mapped = true;}, getMappedRange(offset=0,size=timestamps.byteLength) {return timestamps.buffer.slice(offset,offset+size);}, unmap() {this.mapped = false;}, destroy() {this.destroyed = true;}}; resources.push(r); return r;}};
  const encoder = {resolveQuerySet(...args) {assert.equal(args[2], 4);}, copyBufferToBuffer(...args) {assert.equal(args[4], 32);}};
  return {device, encoder, resources, timestamps};
}

test('Stats requests timestamps only once every 15 tracked frames', t => {
  const stats=overlay(t),{device}=gpu(t);stats.enableGPUProfiling(device);
  let sampled=0;
  for(let i=0;i<20;i++){
    const encoder={beginRenderPass(descriptor){if(descriptor.timestampWrites)sampled++;return {draw(){},drawIndexed(){},drawIndirect(){},drawIndexedIndirect(){}};},beginComputePass(){},finish(){}};
    stats.track(encoder);encoder.beginRenderPass({colorAttachments:[]});
  }
  assert.equal(sampled,1);
});

test('timestamp queries sum pass nanoseconds, skip frames during readback and release resources', async t => {
  const {device, encoder, resources} = gpu(t), profiler = new GPUProfiler(device);
  const storage=profiler.passMilliseconds;assert.equal(storage.length,128);assert.equal(resources.length,3);
  assert.equal(profiler.beginFrame(), true); const first=profiler.timestampWrites();assert.equal(first.beginningOfPassWriteIndex, 0);
  const second=profiler.timestampWrites();assert.equal(second.endOfPassWriteIndex, 3); assert.equal(profiler.resolve(encoder), true);
  assert.equal(profiler.beginFrame(), false);
  const pending = profiler.read(); assert.equal(profiler.beginFrame(), false);assert.equal(profiler.passCount,0);assert.equal(await pending, 5);
  assert.equal(profiler.passCount,2);assert.deepEqual([...storage.slice(0,3)],[2,3,0]);assert.equal(profiler.elapsedMilliseconds,10);
  for(let i=0;i<100;i++){
    assert.equal(profiler.beginFrame(),true);assert.equal(profiler.timestampWrites(),first);assert.equal(profiler.timestampWrites(),second);assert.equal(profiler.resolve(encoder),true);
    const read=profiler.read();assert.equal(profiler.beginFrame(),false);assert.equal(await profiler.read(),null);assert.equal(profiler.milliseconds,5);assert.equal(profiler.passCount,2);
    assert.equal(await read,5);assert.equal(profiler.passMilliseconds,storage);assert.equal(resources.length,3);assert.equal(resources.at(-1).mapped,false);
  }
  // A shorter complete sample must clear durations left over from the prior sample.
  profiler.beginFrame();profiler.timestampWrites();profiler.resolve({resolveQuerySet(){},copyBufferToBuffer(){}});assert.equal(await profiler.read(),2);
  assert.equal(profiler.passCount,1);assert.deepEqual([...storage.slice(0,3)],[2,0,0]);assert.equal(profiler.elapsedMilliseconds,2);
  assert.equal(profiler.beginFrame(), true); assert.equal(profiler.resolve(encoder), false);
  assert.equal(profiler.passCount,0);assert.equal(profiler.elapsedMilliseconds,null);assert.ok(storage.every(v=>v===0));
  profiler.dispose(); profiler.dispose(); assert.ok(resources.every(r => r.destroyed)); assert.throws(() => profiler.beginFrame(), /disposed/);
});

test('default Stats creates no GPU profiling resources or writes on a timestamp-capable device',t=>{
 const stats=overlay(t),{device,resources}=gpu(t);stats.setup({gpu:device,removePlugin(){}});
 assert.equal(resources.length,0);assert.equal(stats.gpuPassMilliseconds,null);assert.equal(stats.gpuPassCount,0);assert.equal(stats.gpuElapsedMilliseconds,null);
 for(let frame=0;frame<30;frame++){
  const encoder={beginRenderPass(descriptor){assert.equal(descriptor.timestampWrites,undefined);return {draw(){},drawIndexed(){},drawIndirect(){},drawIndexedIndirect(){}};},beginComputePass(){},finish(){},resolveQuerySet(){assert.fail('Default Stats resolved queries');},copyBufferToBuffer(){assert.fail('Default Stats copied readback data');}};
  stats.track(encoder);encoder.beginRenderPass({colorAttachments:[]});encoder.finish();
 }
 assert.equal(resources.length,0);stats.refresh();assert.match(stats.element.textContent,/GPU timing off/);
});

test('Stats getters reuse completed pass data and HUD distinguishes warmup, unavailable and restoration',async t=>{
 const stats=overlay(t,{profiling:true}),{device,resources,timestamps}=gpu(t),engine={gpu:device,removePlugin(){},onError(){}};
 stats.setup(engine);const storage=stats.gpuPassMilliseconds;assert.equal(storage.length,128);stats.refresh();assert.match(stats.element.textContent,/GPU timing warming up/);
 const frame=()=>{
  const encoder={beginRenderPass(){return {draw(){},drawIndexed(){},drawIndirect(){},drawIndexedIndirect(){}};},beginComputePass(){},resolveQuerySet(){},copyBufferToBuffer(){},finish(){}};
  stats.track(encoder);encoder.beginRenderPass({colorAttachments:[]});encoder.beginRenderPass({colorAttachments:[]});encoder.finish();
 };
 for(let i=0;i<15;i++)frame();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stats.gpuTime,5);assert.equal(stats.gpuPassCount,2);assert.equal(stats.gpuElapsedMilliseconds,10);assert.deepEqual([...storage.slice(0,3)],[2,3,0]);
 for(let i=0;i<100;i++)assert.equal(stats.gpuPassMilliseconds,storage);assert.equal(resources.length,3);
 stats.refresh();assert.match(stats.element.textContent,/GPU timing 5\.00 ms passes/);assert.match(stats.element.textContent,/GPU span 10\.00 ms/);
 timestamps[3]=0n;for(let i=0;i<15;i++)frame();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stats.gpuTime,null);assert.equal(stats.gpuPassCount,0);assert.equal(stats.gpuElapsedMilliseconds,null);assert.ok(storage.every(value=>value===0));
 const unsupported={gpu:{features:new Set(),createQuerySet(){assert.fail('Unsupported query');}},removePlugin(){}};
 stats.onDeviceRestored(unsupported);assert.ok(resources.every(resource=>resource.destroyed));assert.equal(stats.gpuPassMilliseconds,null);
 stats.refresh();assert.match(stats.element.textContent,/GPU timing unavailable/);assert.doesNotMatch(stats.element.textContent,/GPU span/);
 stats.onDeviceRestored(engine);assert.notEqual(stats.gpuPassMilliseconds,storage);assert.equal(stats.gpuPassCount,0);stats.refresh();assert.match(stats.element.textContent,/GPU timing warming up/);
 stats.dispose();assert.equal(stats.gpuPassMilliseconds,null);assert.equal(stats.gpuPassCount,0);assert.equal(stats.gpuElapsedMilliseconds,null);assert.ok(resources.every(resource=>resource.destroyed));
});

test('unsupported devices and overflow omit GPU timing without creating invalid queries', async t => {
  const unsupported = new GPUProfiler({features: new Set(), createQuerySet() {assert.fail('Unsupported device created queries');}});
  assert.equal(unsupported.passCount,0);assert.equal(unsupported.elapsedMilliseconds,null);assert.ok(unsupported.passMilliseconds.every(v=>v===0));
  assert.equal(unsupported.supported, false); assert.equal(unsupported.beginFrame(), false); unsupported.dispose();
  const {device, encoder, resources} = gpu(t), profiler = new GPUProfiler(device);
  profiler.beginFrame();profiler.timestampWrites();profiler.timestampWrites();profiler.resolve(encoder);assert.equal(await profiler.read(),5);
  profiler.beginFrame(); for (let i = 0; i < 128; i++) assert.ok(profiler.timestampWrites());
  assert.equal(profiler.timestampWrites(), undefined); assert.equal(profiler.resolve({}), false); assert.equal(profiler.milliseconds, null);
  assert.equal(profiler.passCount,0);assert.equal(profiler.elapsedMilliseconds,null);assert.ok(profiler.passMilliseconds.every(v=>v===0));
  profiler.dispose(); assert.ok(resources.every(r => r.destroyed));
});

test('invalid intra-pass or cross-pass timestamps and rejected maps clear completed timings and recover',async t=>{
 const {device,encoder,resources,timestamps}=gpu(t),profiler=new GPUProfiler(device),storage=profiler.passMilliseconds;
 const sample=()=>{assert.equal(profiler.beginFrame(),true);profiler.timestampWrites();profiler.timestampWrites();profiler.resolve(encoder);return profiler.read();};
 const valid=[1_000_000n,3_000_000n,8_000_000n,11_000_000n];
 try{
  for(const invalid of [[1_000_000n,3_000_000n,8_000_000n,7_000_000n],[10_000_000n,12_000_000n,8_000_000n,9_000_000n],[1_000_000n,3_000_000n,2_000_000n,7_000_000n]]){
   timestamps.set(valid);assert.equal(await sample(),5);timestamps.set(invalid);await assert.rejects(sample(),/Invalid GPU timestamps/);
   assert.equal(profiler.milliseconds,null);assert.equal(profiler.elapsedMilliseconds,null);assert.equal(profiler.passCount,0);assert.ok(storage.every(v=>v===0));assert.equal(resources.at(-1).mapped,false);
  }
  timestamps.set(valid);await sample();const read=resources.at(-1),map=read.mapAsync;read.mapAsync=async()=>{throw new Error('Map failed');};
  await assert.rejects(sample(),/Map failed/);assert.equal(profiler.milliseconds,null);assert.equal(profiler.elapsedMilliseconds,null);assert.equal(profiler.passCount,0);assert.ok(storage.every(v=>v===0));
  read.mapAsync=map;assert.equal(await sample(),5);assert.equal(profiler.passMilliseconds,storage);assert.equal(resources.length,3);
 }finally{profiler.dispose();}
});

test('failed setup and disposal during a pending map release every created resource', async t => {
  const {device, encoder, resources} = gpu(t), original = device.createBuffer;
  device.createBuffer = () => {throw new Error('out of memory');};
  assert.throws(() => new GPUProfiler(device), /out of memory/); assert.ok(resources[0].destroyed); device.createBuffer = original;
  const profiler = new GPUProfiler(device); profiler.beginFrame(); profiler.timestampWrites(); profiler.timestampWrites(); profiler.resolve(encoder);
  assert.equal(await profiler.read(),5);profiler.beginFrame();profiler.timestampWrites();profiler.timestampWrites();profiler.resolve(encoder);
  let release; resources.at(-1).mapAsync = () => new Promise(resolve => {release = resolve;});
  const pending = profiler.read();assert.equal(profiler.passCount,2);profiler.dispose();release();assert.equal(await pending,null);assert.ok(resources.every(r=>r.destroyed));
  assert.equal(profiler.milliseconds,null);assert.equal(profiler.elapsedMilliseconds,null);assert.equal(profiler.passCount,0);assert.ok(profiler.passMilliseconds.every(v=>v===0));
});


test("a sampled encoder cannot join another encoder's recording profile", async t => {
  const stats=overlay(t), {device, resources}=gpu(t);
  stats.enableGPUProfiling(device);
  resources.at(-1).getMappedRange=()=>new BigUint64Array([1_000_000n,3_000_000n]).buffer;
  const descriptors=[],resolved=[];
  const encoder=()=>({
    beginRenderPass(descriptor){descriptors.push(descriptor);return {draw(){},drawIndexed(){},drawIndirect(){},drawIndexedIndirect(){}};},
    beginComputePass(){},
    resolveQuerySet(query,first,count){resolved.push(count);},
    copyBufferToBuffer(){},
    finish(){return {};}
  });
  let first,second;
  for(let frame=1;frame<=30;frame++){
    const next=encoder();stats.track(next);
    if(frame===15){first=next;next.beginRenderPass({colorAttachments:[]});}
    if(frame===30){second=next;next.beginRenderPass({colorAttachments:[]});}
  }
  assert.equal(descriptors[0].timestampWrites.beginningOfPassWriteIndex,0);
  assert.equal(descriptors[1].timestampWrites,undefined,'busy samples must remain outside the existing profile');
  second.finish();first.finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(resolved,[2]);assert.equal(stats.gpuTime,2);
});

test('Stats clears overflowed or invalid GPU samples while unsampled frames retain completed timing',async t=>{
 const stats=overlay(t),{device,timestamps}=gpu(t),errors=[];stats.enableGPUProfiling(device);
 stats.setup({gpu:device,removePlugin(){},onError(error){errors.push(error);}});
 const frame=passes=>{
  const encoder={beginRenderPass(){return {draw(){},drawIndexed(){},drawIndirect(){},drawIndexedIndirect(){}};},beginComputePass(){},resolveQuerySet(){},copyBufferToBuffer(){},finish(){return {};}};
  stats.track(encoder);for(let i=0;i<passes;i++)encoder.beginRenderPass({colorAttachments:[]});encoder.finish();
 };
 for(let i=0;i<15;i++)frame(i===14?1:0);await new Promise(resolve=>setImmediate(resolve));assert.equal(stats.gpuTime,2);
 for(let i=0;i<14;i++){frame(0);assert.equal(stats.gpuTime,2);}frame(129);assert.equal(stats.gpuTime,null);
 for(let i=0;i<15;i++)frame(i===14?1:0);await new Promise(resolve=>setImmediate(resolve));assert.equal(stats.gpuTime,2);
 timestamps[1]=0n;for(let i=0;i<15;i++)frame(i===14?1:0);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stats.gpuTime,null);assert.equal(errors.length,1);assert.match(errors[0].message,/Invalid GPU timestamps/);
});

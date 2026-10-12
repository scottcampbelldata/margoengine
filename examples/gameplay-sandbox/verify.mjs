import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {SourceMap} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {build, preview} from 'vite';

const root=fileURLToPath(new URL('.',import.meta.url)), output=resolve(root,'../../test-results/gameplay-sandbox');
await mkdir(output,{recursive:true});
await build({root,configFile:resolve(root,'vite.config.ts'),build:{sourcemap:true},logLevel:'error'});
const server=await preview({root,configFile:resolve(root,'vite.config.ts'),preview:{port:5198,strictPort:true},logLevel:'error'});
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'msedge',headless:true,args:process.env.BROWSER_ARGS?JSON.parse(process.env.BROWSER_ARGS):['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1}), errors=[], report={mode:'production',launchArgs:process.env.BROWSER_ARGS?JSON.parse(process.env.BROWSER_ARGS):[],checks:[],profiles:[],errors};
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const cdp=await page.context().newCDPSession(page);
const readIndirect=()=>page.evaluate(async()=>{
 const device=window.sandbox.engine.gpu, state=window.sandbox.particles.gpuState;
 const buffer=device.createBuffer({size:20,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
 const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(state.indirect,0,buffer,0,20);device.queue.submit([encoder.finish()]);
 await buffer.mapAsync(GPUMapMode.READ);const count=new Uint32Array(buffer.getMappedRange())[1];buffer.unmap();buffer.destroy();return count;
});
async function captureMemory(label, allocations=false) {
 // Preallocate capture data and its completion promise before either heap endpoint.
 await page.evaluate(async()=>{
  const app=window.sandbox;app.engine.stop();
  await app.engine.gpu.queue.onSubmittedWorkDone();
  const control=new Uint32Array(2),times=new Float64Array(600);let complete;
  const done=new Promise(resolve=>{complete=resolve;});
  const remove=app.engine.onFrame(()=>{if(control[0]){times[control[1]++]=performance.now();if(--control[0]===0){app.engine.stop();complete();}}});
  window.memoryCapture={control,times,remove,done};
 });
 await cdp.send('HeapProfiler.collectGarbage');const before=await cdp.send('Runtime.getHeapUsage');
 if(allocations)await cdp.send('HeapProfiler.startSampling',{samplingInterval:16384,includeObjectsCollectedByMinorGC:true,includeObjectsCollectedByMajorGC:true});
 const events=[],collect=({value})=>events.push(...value);cdp.on('Tracing.dataCollected',collect);
 await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline.memory',transferMode:'ReportEvents'});
 await page.evaluate(async()=>{window.memoryCapture.control[0]=600;window.sandbox.engine.start();await window.memoryCapture.done;});
 const raw=await cdp.send('Runtime.getHeapUsage');
 const ended=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await ended;cdp.off('Tracing.dataCollected',collect);
 const gpuCompleted=await page.evaluate(async()=>{await window.sandbox.engine.gpu.queue.onSubmittedWorkDone();return performance.now();});
 if(allocations){
  const {profile}=await cdp.send('HeapProfiler.stopSampling'),sites=[],maps=new Map();
  function visit(node){if(node.selfSize)sites.push({bytes:node.selfSize,...node.callFrame});for(const child of node.children)visit(child);}visit(profile.head);
  report.allocationSites=sites.toSorted((a,b)=>b.bytes-a.bytes).slice(0,15);
  for(const site of report.allocationSites){
   if(!site.url.includes('/assets/'))continue;
   const path=resolve(root,'dist',new URL(site.url).pathname.slice(1)+'.map');
   if(!maps.has(path))maps.set(path,new SourceMap(JSON.parse(await readFile(path,'utf8'))));
   const source=maps.get(path).findEntry(site.lineNumber,site.columnNumber);
   site.source={file:source.originalSource,line:source.originalLine+1,column:source.originalColumn+1};
  }
  console.log(JSON.stringify({allocationSites:report.allocationSites}));
  await writeFile(resolve(output,label+'.allocations.json'),JSON.stringify(report.allocationSites,null,2));
  await writeFile(resolve(output,label+'.heapprofile'),JSON.stringify(profile));
 }
 await cdp.send('HeapProfiler.collectGarbage');const after=await cdp.send('Runtime.getHeapUsage');
 const times=await page.evaluate(()=>Array.from(window.memoryCapture.times));
 const minor=events.filter(e=>e.ph==='X'&&e.name==='MinorGC'),major=events.filter(e=>e.ph==='X'&&e.name==='MajorGC');
 const memory={frames:600,effectiveFPS:599000/(times.at(-1)-times[0]),gpuCompletionFPS:600000/(gpuCompleted-times[0]),rawHeapDeltaBytes:raw.usedSize-before.usedSize,retainedHeapDeltaBytes:after.usedSize-before.usedSize,minorGC:minor.length,majorGC:major.length,gcPauseMs:[...minor,...major].reduce((sum,e)=>sum+e.dur/1000,0)};
 console.log(JSON.stringify({[label]:memory}));await writeFile(resolve(output,label+'.trace.json'),JSON.stringify({traceEvents:events}));
 await page.evaluate(()=>{window.memoryCapture.remove();delete window.memoryCapture;window.sandbox.engine.start();});
 return memory;
}
try {
 await page.goto('http://127.0.0.1:5198');await page.waitForFunction(()=>window.sandbox||document.body.classList.contains('failed'),null,{timeout:60000});
 assert.ok(await page.evaluate(()=>!!window.sandbox),await page.locator('#status').textContent());
 await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 report.hardware=await page.evaluate(async()=>{const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});return {vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description,fallback:adapter.info.isFallbackAdapter,backend:window.sandbox.engine.backend,userAgent:navigator.userAgent};});
 assert.equal(report.hardware.backend,'webgpu');assert.equal(report.hardware.fallback,false,'Physical WebGPU required');
 if(process.env.GPU_VENDOR)assert.equal(report.hardware.vendor,process.env.GPU_VENDOR);
 await page.waitForFunction(()=>window.sandbox.stats.sampleCount===120);
 assert.equal(await readIndirect(),1_000_000);report.checks.push('One million live GPU particles in the indirect draw');
 await page.screenshot({path:resolve(output,'desktop.png')});
 await page.locator('#explore').click();
 const before=await page.evaluate(()=>Array.from(window.sandbox.state));
 await page.keyboard.down('KeyW');await page.waitForTimeout(700);await page.keyboard.up('KeyW');
 const after=await page.evaluate(()=>Array.from(window.sandbox.state));assert.ok(Math.hypot(after[0]-before[0],after[2]-before[2])>1);
 await page.mouse.move(900,450);await page.mouse.down();await page.mouse.move(1050,480,{steps:10});await page.mouse.up();
 assert.notEqual(await page.evaluate(()=>window.sandbox.state[4]),before[4]);
 report.checks.push('WASD locomotion, mouse look and damped third-person camera');
 await page.locator('#wireframe').check();await page.waitForTimeout(100);await page.screenshot({path:resolve(output,'wireframe.png')});await page.locator('#wireframe').uncheck();
 await page.locator('#wave').fill('0.6');await page.locator('#sun').fill('18.5');
 await page.waitForTimeout(250);assert.equal(await page.locator('#wave-value').textContent(),'0.60 m');
 report.checks.push('Wireframe, sun clock and wave-height controls');
 await page.locator('#wave').fill('0.35');await page.locator('#sun').fill('17');
 await page.keyboard.press('Escape');
 for(const count of process.argv.includes('--memory-only')?[]:[100000,500000,1000000]) {
  await page.locator('#particles').selectOption(String(count));await page.waitForTimeout(2000);assert.equal(await readIndirect(),count);
  await cdp.send('HeapProfiler.collectGarbage');
  const samples=[],events=[],collect=({value})=>events.push(...value);
  cdp.on('Tracing.dataCollected',collect);
  await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,disabled-by-default-v8.gc',transferMode:'ReportEvents'});
  const started=performance.now(),duration=count===1000000?30000:10000;
  const initial=await page.evaluate(()=>({frames:window.sandbox.timing[1],now:performance.now()}));
  while(performance.now()-started<duration) {
   const heap=await cdp.send('Runtime.getHeapUsage'), stats=await page.evaluate(()=>({fps:window.sandbox.stats.fps,ms:window.sandbox.stats.frameTime,draws:window.sandbox.stats.drawCalls,dispatches:window.sandbox.stats.dispatches}));
   samples.push({elapsed:performance.now()-started,heap:heap.usedSize,...stats});await page.waitForTimeout(500);
  }
  const final=await page.evaluate(()=>({frames:window.sandbox.timing[1],now:performance.now()}));
  const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await done;cdp.off('Tracing.dataCollected',collect);
  const sizes=samples.map(s=>s.heap),gc=events.filter(e=>e.ph==='X'&&/^(MinorGC|MajorGC)$/.test(e.name));
  const profile={count,durationMs:final.now-initial.now,frames:final.frames-initial.frames,effectiveFPS:(final.frames-initial.frames)*1000/(final.now-initial.now),minimumRollingFPS:Math.min(...samples.map(s=>s.fps)),heapMin:Math.min(...sizes),heapMax:Math.max(...sizes),heapRange:Math.max(...sizes)-Math.min(...sizes),gcSweeps:gc.length,gcPauseMs:gc.reduce((s,e)=>s+e.dur/1000,0),samples};
  report.profiles.push(profile);console.log(JSON.stringify({...profile,samples:undefined}));
  await writeFile(resolve(output,`particles-${count}.trace.json`),JSON.stringify({traceEvents:events}));
 }
 report.memory600=await captureMemory('memory-600',process.argv.includes('--allocations'));
 report.memory600.criteria={maximumRetainedHeapDeltaBytes:131072,maximumMinorGC:1,maximumMajorGC:0};
 report.memory600.note='Matched full-GC endpoints measure retained heap, not total allocation. Endpoint collections are excluded. No input is dispatched during capture; browser WebGPU wrappers and 150ms DOM refreshes remain.';
 if(process.argv.includes('--diagnose')){
  await page.evaluate(()=>{const stats=window.sandbox.stats;window.statsDiagnostic={refresh:stats.refresh,track:stats.track};stats.refresh=()=>{};});
  report.withoutOverlay=await captureMemory('memory-no-overlay');
  await page.evaluate(()=>{window.sandbox.stats.track=()=>{};});
  report.withoutInstrumentation=await captureMemory('memory-no-instrumentation');
  await page.evaluate(()=>{Object.assign(window.sandbox.stats,window.statsDiagnostic);delete window.statsDiagnostic;});
 }
 await page.screenshot({path:resolve(output,'desktop.png')});
 await page.locator('#pause').click();const stopped=await page.evaluate(()=>window.sandbox.timing[1]);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>window.sandbox.timing[1]),stopped);await page.locator('#pause').click();
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);await page.screenshot({path:resolve(output,'mobile.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForFunction(()=>window.sandbox);assert.equal(await page.locator('#pause').textContent(),'Resume');
 report.checks.push('Pause/resume, mobile layout and reduced-motion startup');
 await page.locator('#explore').click();
 await page.evaluate(async()=>{await window.sandbox.engine.rebootDevice();});await page.waitForTimeout(1500);
 assert.equal(await readIndirect(),1_000_000);report.checks.push('Device restoration and borrowed terrain/depth resources');
 await page.route('**/*',route=>{const url=route.request().url();return url.startsWith('http://127.0.0.1:5198')?route.continue():route.abort();});
 await page.reload();await page.waitForFunction(()=>window.sandbox);report.checks.push('First launch with all external asset requests blocked');
 await page.evaluate(()=>{window.sandbox.dispose();Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});});await page.reload();
 // Reload restores navigator.gpu; explicitly exercise fallback in a fresh context.
 const unsupported=await browser.newPage();await unsupported.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true}));await unsupported.goto('http://127.0.0.1:5198');
 await unsupported.waitForFunction(()=>document.body.classList.contains('failed'));assert.match(await unsupported.locator('#status').textContent(),/WebGPU/);await unsupported.close();report.checks.push('Readable unsupported-WebGPU state');
 assert.deepEqual(errors,[]);
 report.meets60FPS=report.profiles.every(p=>p.effectiveFPS>=59.5)&&report.memory600.gpuCompletionFPS>=59.5;
 report.zeroGC=report.profiles.every(p=>p.gcSweeps===0)&&report.memory600.minorGC===0&&report.memory600.majorGC===0;
 assert.ok(Math.abs(report.memory600.retainedHeapDeltaBytes)<=131072,'Retained JS heap grew by more than 128 KiB over 600 frames');
 assert.ok(report.memory600.minorGC<=1&&report.memory600.majorGC===0,'Steady-state GC gate failed; inspect memory-600.trace.json');
 if(process.argv.includes('--strict-performance'))assert.ok(report.meets60FPS&&report.zeroGC,'Performance or allocation gate failed; inspect the recorded evidence');
} finally {
 await writeFile(resolve(output,'verification.json'),JSON.stringify(report,null,2));await browser.close();await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));
}

import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const base=process.env.BENCHMARK_URL??'http://127.0.0.1:5308/examples/conveyor-simulator/';
const output='test-results/conveyor-viewers';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu-vsync','--disable-frame-rate-limit']});
const results=[];
try{
  for(const name of ['margo','three']){
    const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:2});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.addInitScript(()=>{
      window.layoutShifts=0;new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.layoutShifts+=e.value;}).observe({type:'layout-shift',buffered:true});
      window.adapterRequests=[];if(navigator.gpu){const request=navigator.gpu.requestAdapter.bind(navigator.gpu);navigator.gpu.requestAdapter=options=>{window.adapterRequests.push(options);return request(options);};}
      window.pipelineSamples=new WeakMap();window.drawSamples=0;
      if(globalThis.GPUDevice){for(const name of ['createRenderPipeline','createRenderPipelineAsync']){const original=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(descriptor){const result=original.call(this,descriptor);if(result?.then)return result.then(pipeline=>{window.pipelineSamples.set(pipeline,descriptor.multisample?.count??1);return pipeline;});window.pipelineSamples.set(result,descriptor.multisample?.count??1);return result;};}const original=GPURenderPassEncoder.prototype.setPipeline;GPURenderPassEncoder.prototype.setPipeline=function(pipeline){window.drawSamples=window.pipelineSamples.get(pipeline);return original.call(this,pipeline);};}
    });
    console.log(name+': loading');await page.goto(base+name+'-conveyor.html');
    await page.waitForFunction(()=>window.conveyorBenchmark?.ready||window.conveyorBenchmark?.error,{},{timeout:120000});
    assert.equal(await page.evaluate(()=>window.conveyorBenchmark.error),null);
    await page.waitForTimeout(350);
    const initial=await page.evaluate(()=>{
      const v=window.conveyorBenchmark,c=document.querySelector('canvas');
      window.originalTransforms=v.parts.map(p=>p.position??p.batch.instanceMatrix.array);
      const gl=v.renderer?.getContext(),ext=gl?.getExtension('WEBGL_debug_renderer_info'),info=v.engine?.gpu?.adapterInfo;
      return {parts:v.parts.length,cube:v.parts.some(p=>p.name==='Cube'),dpr:devicePixelRatio,width:c.width,height:c.height,cls:window.layoutShifts,requests:window.adapterRequests,draws:Number(document.querySelector('#draws').textContent),samples:gl?.getParameter(gl.SAMPLES)??window.drawSamples,hardware:gl?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):{vendor:info.vendor,architecture:info.architecture,fallback:info.isFallbackAdapter}};
    });
    assert.equal(initial.parts,569);assert.equal(initial.cube,false);assert.equal(initial.dpr,1);assert.equal(initial.width,920);assert.equal(initial.height,652);assert.equal(initial.cls,0);
    if(name==='margo'){assert.ok(initial.requests.some(r=>r?.powerPreference==='high-performance'));assert.equal(initial.samples,1);assert.equal(initial.hardware.vendor,'nvidia');assert.equal(initial.hardware.fallback,false);}else{assert.equal(initial.samples,4);assert.match(initial.hardware,/NVIDIA/);}
    await page.evaluate(()=>{
      window.gpuDraws=0;window.lastGPUCalls=0;
      const v=window.conveyorBenchmark,proto=v.engine?GPURenderPassEncoder.prototype:WebGL2RenderingContext.prototype;
      const methods=v.engine?['draw','drawIndexed','drawIndirect','drawIndexedIndirect']:['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'];
      for(const name of methods){const original=proto[name];proto[name]=function(...args){window.gpuDraws++;return original.apply(this,args);};}
      const owner=v.engine??v.renderer,render=owner.render;
      owner.render=function(...args){window.gpuDraws=0;const result=render.apply(this,args);window.lastGPUCalls=window.gpuDraws;if(document.querySelector('#run').disabled)window.countBenchmarkFrames++;return result;};
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.lastGPUCalls),initial.draws);
    for(const amount of [0,0.5,1,0]){
      await page.locator('#explode').evaluate((slider,amount)=>{slider.value=String(amount*100);slider.dispatchEvent(new Event('input',{bubbles:true}));},amount);
      const positions=await page.evaluate(amount=>{
        const v=window.conveyorBenchmark;
        const list=v.parts.map((p,i)=>{
          const values=p.position?[p.position.x,p.position.y,p.position.z]:Array.from(p.batch.instanceMatrix.array.subarray(p.index*16+12,p.index*16+15));
          for(let a=0;a<3;a++)if(Math.abs(values[a]-(p.base[a]+p.offset[a]*amount))>2e-5)throw Error('Explode transform drift: '+p.name);
          if(window.originalTransforms[i] !== (p.position??p.batch.instanceMatrix.array))throw Error('Replaced transform storage');
          return {name:p.name,values,base:Array.from(p.base),offset:Array.from(p.offset)};
        });
        return list;
      },amount);
      if(amount===1)results.push({name,initial,positions});
    }
    await page.evaluate(async()=>{
      const v=window.conveyorBenchmark;for(let i=0;i<200;i++)v.setExplode(i%101/100);v.setExplode(0);
      window.scheduleFrame=window.requestAnimationFrame;window.requestAnimationFrame=callback=>{window.pausedFrame=callback;return 0;};
      await new Promise(resolve=>window.scheduleFrame(resolve));
    });
    const cdp=await context.newCDPSession(page),events=[];cdp.on('Tracing.dataCollected',e=>events.push(...e.value));
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('Tracing.start',{categories:'devtools.timeline,v8',transferMode:'ReportEvents'});
    await page.evaluate(()=>{const v=window.conveyorBenchmark;for(let i=0;i<1000;i++)v.setExplode(i%101/100);v.setExplode(0);});
    const finished=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await finished;
    const entry=results.at(-1);entry.explodeGCs=events.filter(e=>e.ph==='X'&&/^(MinorGC|MajorGC)$/.test(e.name)).length;
    assert.equal(entry.explodeGCs,0,'Isolated explode hot path triggered garbage collection');
    await page.evaluate(()=>{window.requestAnimationFrame=window.scheduleFrame;window.requestAnimationFrame(window.pausedFrame);});
    console.log(name+': benchmark');await page.evaluate(()=>{window.countBenchmarkFrames=0;});await page.locator('#run').click();
    await page.waitForFunction(()=>window.conveyorBenchmark.lastResult,{},{timeout:45000});
    entry.benchmark=await page.evaluate(()=>window.conveyorBenchmark.lastResult);
    assert.equal(await page.evaluate(()=>window.countBenchmarkFrames),660);
    assert.equal(entry.benchmark.frames,600);assert.equal(entry.benchmark.warmup,60);assert.equal(entry.benchmark.parts,569);assert.ok(entry.benchmark.medianMs>0&&entry.benchmark.p95Ms>=entry.benchmark.medianMs);
    assert.equal(entry.benchmark.drawCalls,initial.draws);await page.locator('#run').waitFor({state:'visible'});assert.equal(await page.locator('#run').isEnabled(),true);
    await page.locator('canvas').screenshot({path:output+'/'+name+'.png',scale:'css'});
    await page.locator('canvas').focus();await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'explode');
    await page.evaluate(()=>{document.querySelector('#explode').focus();});await page.keyboard.press('End');assert.equal(await page.locator('#percent').textContent(),'100%');
    await page.keyboard.press('Home');assert.equal(await page.locator('#percent').textContent(),'0%');
    const pose=()=>page.evaluate(()=>{const c=window.conveyorBenchmark.camera;return {position:Array.from(c.position.isVector3?c.position.toArray():c.position),target:c.target?Array.from(c.target):null};});
    const before=await pose(),box=await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x+600,box.y+240);await page.mouse.down();await page.mouse.move(box.x+660,box.y+260,{steps:5});await page.mouse.up();assert.notDeepEqual((await pose()).position,before.position,'Rotate did not move camera');
    const rotated=await pose();await page.mouse.move(box.x+600,box.y+240);await page.mouse.down({button:'right'});await page.mouse.move(box.x+620,box.y+260,{steps:5});await page.mouse.up({button:'right'});assert.notDeepEqual((await pose()).position,rotated.position,'Pan did not move camera');
    const panned=await pose();await page.mouse.wheel(0,100);await page.waitForTimeout(120);assert.notDeepEqual((await pose()).position,panned.position,'Zoom did not move camera');
    await page.locator('#run').click();
    assert.equal(await page.evaluate(()=>window.conveyorBenchmark.lastResult),null);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
    assert.match(await page.locator('#result').textContent(),/cancelled/);assert.equal(await page.locator('#run').isEnabled(),true);
    entry.errors=errors;assert.deepEqual(errors,[]);console.log(JSON.stringify({name,...initial,benchmark:entry.benchmark,explodeGCs:entry.explodeGCs}));
    await context.close();
  }
  const three=new Map(results[1].positions.map(p=>[p.name,p]));
  for(const p of results[0].positions){const other=three.get(p.name);assert.ok(other,'Missing matching GLB part '+p.name);for(const field of ['base','offset','values'])for(let a=0;a<3;a++)assert.ok(Math.abs(p[field][a]-other[field][a])<5e-4,`${p.name} ${field} ${a} differs`);}
  console.log('569 matched parts: identical explode offsets and positions within 0.0005 source units.');
  for(const name of ['margo','three']){
    const context=await browser.newContext(),page=await context.newPage();
    await context.route('**/'+(name==='margo'?'conveyor.margo':'Untitled.glb'),route=>route.fulfill({status:503,body:'Unavailable'}));
    await page.goto(base+name+'-conveyor.html');await page.waitForFunction(()=>window.conveyorBenchmark?.error,{},{timeout:30000});
    assert.equal(await page.locator('#loading').isVisible(),true);assert.equal(await page.locator('#run').isEnabled(),false);assert.equal(await page.evaluate(()=>window.conveyorBenchmark.ready),false);
    await context.close();
  }
}finally{await writeFile(output+'/results.json',JSON.stringify(results,null,2));await browser.close();}

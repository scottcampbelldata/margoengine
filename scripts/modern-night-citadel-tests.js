import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';

const path='/apps/showcase-night-citadel/index.html';
const browser=await openBrowser({startPath:path,args:['--disable-frame-rate-limit','--disable-gpu-vsync']});
const {page}=browser, errors=[], report={hardware:browser.hardware};
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const instrument=()=>{
  window.gpuAudit={textures:[],pipelines:[],pipelineVertices:[],live:new Set(),counts:{}};
  const createShader=GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule=function(desc){
    if(desc.code.includes('fn surface(xz:vec2f,sampleWidth:f32)'))gpuAudit.waterShader=desc.code;
    return createShader.call(this,desc);
  };
  for(const name of ['createBuffer','createTexture','createBindGroup','createRenderPipeline','createRenderPipelineAsync','createComputePipeline']){
    const original=GPUDevice.prototype[name];
    GPUDevice.prototype[name]=function(desc){
      const a=window.gpuAudit;a.counts[name]=(a.counts[name]??0)+1;
      if(name==='createTexture')a.textures.push({samples:desc.sampleCount??1,width:desc.size.width??desc.size[0]});
      if(name.startsWith('createRenderPipeline')){a.pipelines.push(desc.multisample?.count??1);a.pipelineVertices.push(desc.vertex.buffers?.length??0);}
      const result=original.call(this,desc);
      if(name==='createBuffer'||name==='createTexture'){
        a.live.add(result);const destroy=result.destroy.bind(result);
        result.destroy=()=>{a.live.delete(result);destroy();};
      }
      return result;
    };
  }
};
async function waveHeights(page){
  const heights=await page.evaluate(async()=>{
    const app=nightCitadel,d=app.device,water=app.water,points=[];
    app.stop();d.pushErrorScope('validation');
    for(let i=0;i<water.positions.length;i+=3)if(Math.abs(water.positions[i])<50&&Math.abs(water.positions[i+1])<50)points.push(...water.positions.subarray(i,i+3),0);
    const queries=d.createBuffer({size:points.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    const output=d.createBuffer({size:points.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const read=d.createBuffer({size:points.length*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const input=document.getElementById('waves'),previous=input.value;
    try{
      d.queue.writeBuffer(queries,0,new Float32Array(points));
      const module=d.createShaderModule({code:gpuAudit.waterShader.split('struct Output')[0]+`
@group(0) @binding(8) var<storage,read> queries:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(32) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];results[id.x]=vec4f(surface(q.xy,q.z).position,1);
}`});
      const pipeline=d.createComputePipeline({layout:'auto',compute:{module,entryPoint:'probe'}});
      const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:water.uniform}},{binding:3,resource:water.foamViews[0]},{binding:7,resource:{buffer:water.uniform}},{binding:8,resource:{buffer:queries}},{binding:9,resource:{buffer:output}}]});
      const samples=[];
      for(const height of [0,0.35,1]){
        input.value=String(height);input.dispatchEvent(new Event('input',{bubbles:true}));app.engine.render({delta:0});
        const encoder=d.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(points.length/128));pass.end();
        encoder.copyBufferToBuffer(output,0,read,0,output.size);d.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const data=new Float32Array(read.getMappedRange());
        const y=Array.from({length:points.length/4},(_,i)=>data[i*4+1]-water.values[21]);read.unmap();
        samples.push({height,min:Math.min(...y),max:Math.max(...y),rms:Math.sqrt(y.reduce((sum,h)=>sum+h*h,0)/y.length)});
      }
      const validation=await d.popErrorScope();if(validation)throw new Error(validation.message);
      return samples;
    }finally{
      input.value=previous;input.dispatchEvent(new Event('input',{bubbles:true}));app.engine.render({delta:0});
      queries.destroy();output.destroy();read.destroy();app.start();
    }
  });
  assert.equal(heights[0].rms,0,'Zero wave height must flatten the displaced surface');
  assert(heights[2].max-heights[2].min>0.5,'Ocean grid filters out the configured waves: '+JSON.stringify(heights));
  assert(Math.abs(heights[1].rms/heights[2].rms-0.35)<0.0001,'Slider must scale actual vertex displacement');
  return heights;
}
async function moonFraming(page){
  const frame=await page.evaluate(()=>{
    const a=nightCitadel,m=a.camera.matrix,d=a.moon;
    const cw=m[3]*d[0]+m[7]*d[1]+m[11]*d[2];
    const x=((m[0]*d[0]+m[4]*d[1]+m[8]*d[2])/cw*0.5+0.5)*innerWidth;
    const y=(0.5-(m[1]*d[0]+m[5]*d[1]+m[9]*d[2])/cw*0.5)*innerHeight;
    const radius=Math.tan(Math.asin(a.sky.uniformData[35]))*innerHeight/(2*Math.tan(a.camera.fov*Math.PI/360)*cw);
    const covered=['.title','.panel'].some(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;});
    return {x,y,radius,covered,width:innerWidth,height:innerHeight};
  });
  assert(frame.x>frame.radius&&frame.x+frame.radius<frame.width&&frame.y>frame.radius&&frame.y+frame.radius<frame.height&&!frame.covered,'Opening moon is clipped or covered: '+JSON.stringify(frame));
  return frame;
}
try{
  await page.addInitScript(instrument);await page.setViewportSize({width:1280,height:800});await page.reload();
  await page.waitForFunction(()=>window.nightCitadel?.stats.frames>10);
  assert(await page.locator('#status').isHidden());
  assert.equal(await page.evaluate(()=>window.nightCitadel.stats.samples),4);
  assert(await page.evaluate(()=>gpuAudit.textures.some(t=>t.samples===4)&&gpuAudit.pipelines.includes(4)));
  await page.locator('#orbit').uncheck();await page.locator('#reset').click();
  report.waveHeights={desktop:await waveHeights(page)};
  report.framing=[await moonFraming(page)];
  const visual=await page.evaluate(async()=>{
    const app=window.nightCitadel,d=app.device;
    app.stop();app.engine.render({delta:0});await d.queue.onSubmittedWorkDone();
    d.pushErrorScope('validation');
    const w=app.post.sceneTexture.width,h=app.post.sceneTexture.height,bytes=w*h*16;
    const output=d.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const read=d.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const module=d.createShaderModule({code:'@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let s=textureDimensions(image);if(any(id.xy>=s)){return;}result[id.y*s.x+id.x]=textureLoad(image,vec2i(id.xy),0);}'});
    const pipeline=d.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
    const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:app.post.sceneTexture.createView()},{binding:1,resource:{buffer:output}}]});
    const capture=async()=>{
      app.engine.render({delta:0});const e=d.createCommandEncoder(),p=e.beginComputePass();
      p.setPipeline(pipeline);p.setBindGroup(0,group);p.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));p.end();
      e.copyBufferToBuffer(output,0,read,0,bytes);d.queue.submit([e.finish()]);
      await read.mapAsync(GPUMapMode.READ);const data=new Float32Array(read.getMappedRange()).slice();read.unmap();return data;
    };
    const changes=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>0.0001)n++;return n;};
    const set=(id,value)=>{const input=document.getElementById(id);input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));};
    const results={};
    try{
      const initial=await capture();if(!initial.every(Number.isFinite))throw new Error('Non-finite HDR output');
      for(const [id,value] of [['phase',-1],['azimuth',90],['elevation',70],['haze',0],['glow',0],['windows',0],['waves',0]]){
        const input=document.getElementById(id),previous=input.value;
        set(id,value);results[id]=changes(initial,await capture());set(id,previous);
        if(results[id]<20)throw new Error(id+' produced no visible change: '+results[id]);
      }
      app.instances.emissiveIntensity=0;app.lights.intensityScale=1;const lit=await capture();
      app.lights.intensityScale=0;results.localLights=changes(lit,await capture());
      if(results.localLights<100)throw new Error('Clustered lights do not illuminate the masonry');
      set('windows',1);
      const emission=await capture();app.engine.frameGraph.removeOwner(app.particles.name);
      results.particles=changes(emission,await capture());
      app.engine.frameGraph.withOwner(app.particles.name,()=>app.particles.registerPasses(app.engine.frameGraph));
      app.shadows.options.lightSize=0;const hard=await capture();
      app.shadows.options.lightSize=0.08;results.softShadows=changes(hard,await capture());
      if(results.softShadows<20)throw new Error('Soft shadow filtering is inactive');
      app.shadows.options.lightSize=0.02;
      const old=app.atmosphere.time;
      set('stars',0);const still=await capture();app.atmosphere.time=old+2;
      results.steadyStars=changes(still,await capture());
      if(results.steadyStars!==0)throw new Error('Zero twinkle changes stars');
      set('stars',2);app.atmosphere.time=old;const stars=await capture();app.atmosphere.time=old+2;
      results.twinkle=changes(stars,await capture());if(results.twinkle<20)throw new Error('Twinkle control inactive');
      app.atmosphere.time=old;set('stars',0.8);
      const validation=await d.popErrorScope();if(validation)throw new Error(validation.message);
      window.citadelPixelChecks=results;
      return results;
    }finally{read.destroy();output.destroy();app.start();}
  });
  report.visual=visual;
  // Bloom and exposure are applied at presentation, after the captured HDR scene.
  await page.evaluate(()=>{const a=nightCitadel;a.stop();a.engine.render({delta:0});});
  const initial=await page.locator('#scene').screenshot();
  await page.evaluate(()=>{const a=nightCitadel;a.engine.frameGraph.removeOwner(a.particles.name);a.engine.render({delta:0});});
  assert.notEqual(Buffer.compare(initial,await page.locator('#scene').screenshot()),0,'GPU embers are invisible');
  await page.evaluate(()=>{const a=nightCitadel;a.engine.frameGraph.withOwner(a.particles.name,()=>a.particles.registerPasses(a.engine.frameGraph));a.engine.render({delta:0});});
  for(const [id,value] of [['bloom','1'],['exposure','-2']]){
    const previous=await page.locator('#'+id).inputValue();
    await page.locator('#'+id).fill(value);await page.evaluate(()=>nightCitadel.engine.render({delta:0}));
    assert.notEqual(Buffer.compare(initial,await page.locator('#scene').screenshot()),0,id+' has no effect');
    await page.locator('#'+id).fill(previous);await page.evaluate(()=>nightCitadel.engine.render({delta:0}));
  }
  await page.screenshot({path:'test-results/night-citadel.png'});
  await page.locator('#scene').screenshot({path:'test-results/night-citadel-scene.jpg',type:'jpeg',quality:85});
  await page.evaluate(()=>nightCitadel.start());
  const before=await page.evaluate(()=>Array.from(nightCitadel.motion.slice(0,3)));
  await page.mouse.move(650,420);await page.mouse.down();await page.mouse.move(720,450,{steps:10});await page.mouse.up();await page.waitForTimeout(300);
  assert(await page.evaluate(y=>Math.abs(nightCitadel.motion[0]-y)>0.02&&!document.getElementById('orbit').checked,before[0]));
  const radius=await page.evaluate(()=>nightCitadel.motion[2]);
  await page.mouse.wheel(0,150);await page.waitForTimeout(300);
  assert(await page.evaluate(r=>nightCitadel.motion[2]>r,radius));
  await page.locator('#scene').focus();const yaw=await page.evaluate(()=>nightCitadel.motion[0]);
  await page.keyboard.press('ArrowLeft');await page.waitForTimeout(150);
  assert(await page.evaluate(y=>nightCitadel.motion[0]<y,yaw));
  await page.locator('#reset').click();assert.deepEqual(await page.evaluate(()=>Array.from(nightCitadel.motion.slice(0,3))),[0.65,-0.03,82]);
  await page.locator('#orbit').check();
  report.rates=[];
  for(const target of ['60','120']){
    await page.locator('#cadence').selectOption(target);await page.waitForTimeout(2500);
    const stats=await page.evaluate(()=>({...nightCitadel.stats}));
    report.rates.push({target:Number(target),...stats});
    assert(stats.fps>=Number(target)*0.75&&stats.fps<=Number(target)*1.1,'Pacer under uncapped compositor: '+JSON.stringify(stats));
  }
  await page.locator('#cadence').selectOption('60');await page.waitForTimeout(500);
  const resources=await page.evaluate(async()=>{
    gpuAudit.counts={};const first=nightCitadel.stats.frames;
    await new Promise(r=>setTimeout(r,1500));
    return {counts:gpuAudit.counts,frames:nightCitadel.stats.frames-first};
  });
  assert(resources.frames>60);assert.deepEqual(resources.counts,{},'Steady frames created GPU resources');
  report.resources=resources;
  await page.evaluate(()=>{gpuAudit.counts={};gpuAudit.pipelines=[];gpuAudit.pipelineVertices=[];});await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(600);
  report.resize=await page.evaluate(()=>({counts:gpuAudit.counts,pipelines:gpuAudit.pipelines,vertices:gpuAudit.pipelineVertices}));
  assert(!report.resize.counts.createBuffer&&!report.resize.counts.createComputePipeline);
  assert(report.resize.vertices.every(n=>n===0),'Resize rebuilt geometry pipelines: '+JSON.stringify(report.resize));
  assert(await page.locator('#status').isHidden());
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>!document.getElementById('orbit').checked);
  const reduced=await page.evaluate(()=>nightCitadel.motion[0]);await page.waitForTimeout(150);
  assert(await page.evaluate(y=>nightCitadel.motion[0]===y&&!document.getElementById('orbit').checked,reduced));
  await page.evaluate(()=>nightCitadel.dispose());
  assert.equal(await page.evaluate(()=>gpuAudit.live.size),0,'Desktop leaked GPU buffers/textures');
  const stopped=await page.evaluate(()=>nightCitadel.stats.frames);await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>nightCitadel.stats.frames),stopped,'Disposed app kept rendering');
  const context=await page.context().browser().newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
  const mobile=await context.newPage();mobile.on('pageerror',e=>errors.push(e.message));await mobile.addInitScript(instrument);
  await mobile.goto('http://127.0.0.1:5193'+path);await mobile.waitForFunction(()=>window.nightCitadel?.stats.frames>10);
  assert(await mobile.locator('#status').isHidden());
  const quality=await mobile.evaluate(()=>({samples:nightCitadel.stats.samples,textures:gpuAudit.textures.filter(t=>t.samples===4).length,pipelines:gpuAudit.pipelines.filter(s=>s===4).length,dpr:document.querySelector('canvas').width/innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
  assert.deepEqual(quality,{samples:1,textures:0,pipelines:0,dpr:2,overflow:false});
  report.mobile=quality;
  report.waveHeights.mobile=await waveHeights(mobile);
  await mobile.locator('#orbit').uncheck();await mobile.locator('#reset').click();
  await mobile.locator('summary').click();await mobile.screenshot({path:'test-results/night-citadel-mobile.png'});
  report.framing.push(await moonFraming(mobile));
  const oldRadius=await mobile.evaluate(()=>nightCitadel.motion[2]);
  const touch=await context.newCDPSession(mobile);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:140,y:350,id:1},{x:240,y:350,id:2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:90,y:350,id:1},{x:290,y:350,id:2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert(await mobile.evaluate(r=>nightCitadel.motion[2]<r,oldRadius));
  await mobile.evaluate(()=>nightCitadel.dispose());assert.equal(await mobile.evaluate(()=>gpuAudit.live.size),0,'Mobile leaked GPU resources');
  await context.close();
  assert.deepEqual(errors,[]);
  await writeFile('test-results/night-citadel-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}

// A native browser clock proves that selecting 120 never invents extra displayed frames.
const native=await openBrowser({startPath:path,args:[]});
try{
  await native.page.waitForFunction(()=>window.nightCitadel?.stats.frames>10);
  await native.page.locator('#cadence').selectOption('120');await native.page.waitForTimeout(2000);
  const observed=await native.page.evaluate(()=>({...nightCitadel.stats,note:document.getElementById('refresh-note').textContent}));
  assert(observed.fps<=observed.callbackRate*1.1);
  if(observed.callbackRate<100)assert.match(observed.note,/browser supplies/);
  console.log('Native cadence',observed);
}finally{await native.close();}

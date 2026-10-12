import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {build,preview} from 'vite';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';

const root=resolve(import.meta.dirname,'..'),output=resolve(root,'../../test-results/gameplay-sandbox/shared-modules');
await mkdir(output,{recursive:true});
await build({root,configFile:resolve(root,'vite.config.ts'),logLevel:'error'});
const server=await preview({root,configFile:resolve(root,'vite.config.ts'),preview:{port:0,strictPort:true},logLevel:'error'});
const origin=new URL(server.resolvedUrls.local[0]).origin;
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'msedge',headless:true,args:process.env.BROWSER_ARGS?JSON.parse(process.env.BROWSER_ARGS):['--enable-unsafe-webgpu']});
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],report={checks:[],errors};
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const population=(target=page)=>target.evaluate(async()=>{
 const app=window.sandbox,device=app.engine.gpu,state=app.particles.gpuState;
 const buffer=device.createBuffer({size:20,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=device.createCommandEncoder();
 encoder.copyBufferToBuffer(state.indirect,0,buffer,0,20);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
 const count=new Uint32Array(buffer.getMappedRange())[1];buffer.unmap();buffer.destroy();return count;
});
const lightClusters=()=>page.evaluate(async()=>{
 const app=window.sandbox,device=app.engine.gpu,counts=app.lights.lightLists.counts;
 const buffer=device.createBuffer({size:counts.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=device.createCommandEncoder();
 encoder.copyBufferToBuffer(counts,0,buffer,0,counts.size);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
 const values=Array.from(new Uint32Array(buffer.getMappedRange()));buffer.unmap();buffer.destroy();return values;
});
const finiteScene=()=>page.evaluate(async()=>{
 const app=window.sandbox,device=app.engine.gpu,texture=app.water.engine.plugins.get('bloom').sceneTexture,bytesPerRow=Math.ceil(texture.width*8/256)*256;
 const buffer=device.createBuffer({size:bytesPerRow*texture.height,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=device.createCommandEncoder();
 try{encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow},[texture.width,texture.height]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const values=new Uint16Array(buffer.getMappedRange());let invalid=0;for(const value of values)if((value&0x7c00)===0x7c00)invalid++;buffer.unmap();return invalid;}finally{buffer.destroy();}
});
try{
 const failed=await browser.newPage({viewport:{width:390,height:664},isMobile:true,hasTouch:true});
 try{
  const message='Failed to compile the shader source, generated metal:\n'+('#include <metal_stdlib>\n'.repeat(300))+'error: test compiler failure at the end';
  await failed.addInitScript(message=>{GPUDevice.prototype.createComputePipeline=()=>{throw new Error(message);};},message);
  await failed.goto(origin);await failed.waitForFunction(()=>document.body.classList.contains('failed'));
  assert.equal(await failed.locator('#status').textContent(),'A GPU shader could not compile. Open technical error details below.');
  await failed.locator('#error-details summary').click();
  assert.equal(await failed.locator('#error-message').textContent(),message);assert.equal(await failed.locator('#controls').isVisible(),false);
  await failed.locator('#error-message').evaluate(element=>{element.scrollTop=element.scrollHeight;});
  assert.ok(await failed.locator('#error-message').evaluate(element=>element.scrollTop>0&&element.scrollTop+element.clientHeight>=element.scrollHeight-1));
  await failed.screenshot({path:resolve(output,'mobile-shader-error.png')});report.checks.push('Mobile shader failure keeps complete selectable, scrollable diagnostics visible');
 }finally{await failed.close();}
 const mobile=await browser.newPage({viewport:{width:390,height:664},isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'});
 try{
  await mobile.addInitScript(()=>{
   const audit=window.msaaAudit={textures:[],pipelines:[],passes:[]};
   for(const name of ['createTexture','createRenderPipeline','createRenderPipelineAsync']){const create=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(descriptor){audit[name==='createTexture'?'textures':'pipelines'].push(descriptor.sampleCount??descriptor.multisample?.count??1);return create.call(this,descriptor);};}
   const begin=GPUCommandEncoder.prototype.beginRenderPass;GPUCommandEncoder.prototype.beginRenderPass=function(descriptor){audit.passes.push(Array.from(descriptor.colorAttachments,a=>a&&{resolve:!!a.resolveTarget,store:a.storeOp}));return begin.call(this,descriptor);};
  });
  mobile.on('pageerror',e=>errors.push(e.message));mobile.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await mobile.emulateMedia({reducedMotion:'reduce'});await mobile.goto(origin);
  await mobile.waitForFunction(()=>window.sandbox||document.body.classList.contains('failed'),null,{timeout:60000});
  assert.ok(await mobile.evaluate(()=>!!window.sandbox),await mobile.locator('#status').textContent());
  report.mobile=await mobile.evaluate(()=>{const canvas=document.querySelector('canvas'),audit=window.msaaAudit;return {css:[canvas.clientWidth,canvas.clientHeight],buffer:[canvas.width,canvas.height],dpr:devicePixelRatio,effectiveDpr:canvas.width/canvas.clientWidth,multisampledTextures:audit.textures.filter(n=>n!==1).length,multisampledPipelines:audit.pipelines.filter(n=>n!==1).length,resolves:audit.passes.flat().filter(a=>a?.resolve).length,discardedColors:audit.passes.flat().filter(a=>a?.store!=='store').length};});
  assert.equal(report.mobile.dpr,3);assert.equal(report.mobile.effectiveDpr,2);assert.deepEqual(report.mobile.buffer,report.mobile.css.map(n=>n*2));
  for(const key of ['multisampledTextures','multisampledPipelines','resolves','discardedColors'])assert.equal(report.mobile[key],0,key);
  report.checks.push('iPhone UA at DPR 3 uses DPR 2 buffers, only 1x textures/pipelines, stored color and zero resolves');
  for(const count of [100_000,500_000,1_000_000]){
   await mobile.locator('#particles').selectOption(String(count));
   await mobile.evaluate(()=>window.sandbox.engine.gpu.queue.onSubmittedWorkDone());assert.equal(await population(mobile),count);
  }
  await mobile.locator('#wireframe').check();await mobile.locator('#wireframe').uncheck();
  await mobile.locator('#explore').tap();assert.equal(await mobile.locator('#touch-controls').isVisible(),true);
  const stick=await mobile.getByRole('group',{name:'look touch stick'}).boundingBox(),touch=await mobile.context().newCDPSession(mobile);
  const x=stick.x+stick.width/2,y=stick.y+stick.height/2;
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-stick.height*0.4}]});
  await mobile.waitForFunction(()=>window.sandbox.state[5]<-0.3);
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.detach();
  await mobile.waitForFunction(()=>{const c=window.sandbox.engine.camera;return c.target[1]>c.position[1]+2;});
  report.checks.push('Touch look stick tilts upward across the horizon');
  await mobile.locator('#pause').tap();assert.equal(await mobile.locator('#pause').getAttribute('aria-pressed'),'true');
  await mobile.screenshot({path:resolve(output,'mobile-controls.png')});report.checks.push('Touch layout starts, changes all particle tiers and wireframe, exposes movement sticks and pauses');
 }finally{await mobile.close();}
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin);
 await page.waitForFunction(()=>window.sandbox||document.body.classList.contains('failed'),null,{timeout:60000});
 assert.ok(await page.evaluate(()=>!!window.sandbox),await page.locator('#status').textContent());
 report.hardware=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {description:a.info.description,vendor:a.info.vendor,fallback:a.info.isFallbackAdapter};});
 assert.equal(report.hardware.fallback,false);
 assert.equal(await population(),1_000_000);report.checks.push('Initial particle population: 1,000,000');
 const visibleMoon=await page.evaluate(async()=>{
  const app=window.sandbox;app.sky.options.hours=0;app.sky.options.timeScale=0;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();
  const c=app.engine.camera,m=c.matrix,p=Array.from(c.position,(v,i)=>v+app.sky.moon[i]*50);
  const clip=Array.from({length:4},(_,r)=>p.reduce((sum,v,k)=>sum+v*m[k*4+r],m[12+r]));
  return {x:clip[0]/clip[3],y:clip[1]/clip[3],w:clip[3]};
 });
 assert.ok(visibleMoon.w>0&&Math.abs(visibleMoon.x)<0.9&&Math.abs(visibleMoon.y)<0.95,'Moon must be inside the normal night view');
 await page.waitForFunction(()=>document.getElementById('sun-value').value==='00:00');
 await page.screenshot({path:resolve(output,'moon-normal-view.png')});
 await page.locator('#explore').click();await page.mouse.move(640,450);await page.mouse.down();await page.mouse.move(640,350,{steps:12});await page.mouse.up();
 await page.waitForFunction(()=>window.sandbox.state[5]<-0.15);
 await page.waitForFunction(()=>{const c=window.sandbox.engine.camera;return c.target[1]>c.position[1]+1;});
 await page.locator('#pause').click();
 const cameraClearance=await page.evaluate(()=>{const a=window.sandbox,p=a.engine.camera.position;return p[1]-a.camera.options.ground(p[0],p[2]);});
 assert.ok(cameraClearance>=0.65-1e-5,'Looking up must keep the camera above terrain');
 await page.screenshot({path:resolve(output,'moon-look-up.png')});
 report.checks.push('Moon is visible without camera overrides; mouse drag looks up with terrain clearance');
 await page.evaluate(async()=>{const a=window.sandbox;a.state[5]=0.18;a.camera.setOrbitOffset(a.state[4],a.state[5],14,0.8);a.camera.update(3);a.engine.render({delta:0});await a.engine.gpu.queue.onSubmittedWorkDone();});
 assert.equal(await page.locator('#sun').getAttribute('min'),'0');assert.equal(await page.locator('#sun').getAttribute('max'),'23.99');
 const clock=[];
 for(const [hours,time,label] of [[0,'00:00','Moon / night'],[12,'12:00','Sun / day'],[18,'18:00','Sun / day'],[21,'21:00','Moon / night'],[23.99,'23:59','Moon / night']]){
  await page.locator('#sun').evaluate((input,hours)=>{input.value=String(hours);input.dispatchEvent(new Event('input',{bubbles:true}));},hours);
  await page.waitForFunction(time=>document.getElementById('sun-value').value===time,time);
  assert.equal(await page.locator('#time-label').textContent(),label);
  assert.equal(await page.locator('#sun').getAttribute('aria-valuetext'),`${time}, ${label==='Sun / day'?'day':'night'}`);
  const value=await page.evaluate(async()=>{const app=window.sandbox;await app.engine.gpu.queue.onSubmittedWorkDone();return {hours:app.sky.options.hours,night:app.sky.nightFactor,emission:app.procedural.emissiveIntensity(),porch:app.lights.intensityScale()};});
  assert.ok(Math.abs(value.hours-hours)<1e-8);assert.equal(value.emission,value.night);assert.equal(value.porch,value.night);
  if(hours===12){assert.equal(value.night,0);assert.ok((await lightClusters()).every(count=>count===0));}
  if(hours===0||hours===21||hours===23.99){assert.equal(value.night,1);assert.ok((await lightClusters()).some(count=>count===1));}
  if(hours===18)assert.ok(value.night>0&&value.night<1);
  clock.push(value);
 }
 report.clock=clock;report.checks.push('Paused full-day slider reaches midnight and 23:59, labels sun/moon, and fades shared emission/local lights together');
 const lighting=await page.evaluate(async()=>{
  const app=window.sandbox,result=[];app.engine.stop();app.sky.options.timeScale=0;
  for(const hours of [12,17.9,18+28/60,21,0,6]){app.sky.options.hours=hours;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();result.push({hours,sun:Array.from(app.sky.sun),moon:Array.from(app.sky.moon),light:Array.from(app.engine.lighting.direction),radiance:Array.from(app.engine.lighting.radiance),waterLights:Array.from(app.water.values.slice(112))});}
  app.sky.options.hours=17.5;app.engine.render({delta:0});return result;
 });
 for(const x of lighting){
  if(x.hours===12){assert.deepEqual(x.light.slice(0,3),x.sun);assert.equal(x.light[3],6);}
  else {assert.ok(x.light[1]>(x.hours===17.9?0:0.15));assert.ok(x.light[3]>0);}
  for(let i=0;i<3;i++){assert.ok(Math.abs(x.waterLights[i]-x.sun[i])<1e-6);assert.ok(Math.abs(x.waterLights[8+i]-x.moon[i])<1e-6);}
  if(x.hours===0||x.hours===21){assert.deepEqual(x.light.slice(0,3),x.moon);assert.ok(Math.abs(x.light[3]-0.6)<1e-6);assert.deepEqual(x.radiance.slice(0,3),[0.25,0.45,0.75].map(Math.fround));assert.equal(x.radiance[3],Math.fround(0.09));}
 }
 report.lighting=lighting;report.checks.push('Sun/moon water glints keep separate celestial directions through dusk while PCSS retains its blended light');
 const moonCascades=await page.evaluate(async()=>{
  const app=window.sandbox,draw=app.procedural.drawShadow,cascades=[0,0,0,0];
  app.procedural.drawShadow=function(context){cascades[context.cascade]++;return draw.call(this,context);};
  try{app.sky.options.hours=18.4667;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();return cascades;}finally{app.procedural.drawShadow=draw;}
 });
 assert.deepEqual(moonCascades,[1,1,1,1]);report.checks.push('Procedural cabin and trees cast into all four moonlight PCSS cascades');
 const clusters=await lightClusters();assert.ok(clusters.some(count=>count===1));assert.ok(clusters.every(count=>count<=1));
 await page.waitForFunction(()=>document.getElementById('sun-value').value==='18:28');
 await page.screenshot({path:resolve(output,'night-1828.png')});
 assert.equal(await finiteScene(),0,'Night HDR contains NaN or infinity');
 await page.evaluate(async()=>{const app=window.sandbox;app.sky.options.hours=0;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();});
 await page.waitForFunction(()=>document.getElementById('sun-value').value==='00:00');
 await page.screenshot({path:resolve(output,'night.png')});
 const clearance=await page.evaluate(()=>{
  const app=window.sandbox,rig=app.camera,offset=rig.offset.slice();rig.offset.set([0,-10,14]);app.engine.render({delta:0});
  const a=app.engine.camera.target,b=app.engine.camera.position;let margin=Infinity;
  for(let i=1;i<=6;i++){const t=i/6,x=a[0]+(b[0]-a[0])*t,z=a[2]+(b[2]-a[2])*t;margin=Math.min(margin,a[1]+(b[1]-a[1])*t-rig.options.ground(x,z));}
  const result={margin,offsetY:rig.offset[1]};rig.offset.set(offset);app.engine.render({delta:1});return result;
 });
 assert.ok(clearance.margin>=0.65-1e-5);assert.equal(clearance.offsetY,-10);report.checks.push('Shared camera clearance preserves requested offset');
 await page.evaluate(async()=>{const app=window.sandbox;await app.engine.rebootDevice();app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();});
 assert.equal(await population(),1_000_000);report.checks.push('Restored particle population: 1,000,000 using package initialCount');
 assert.ok((await lightClusters()).some(count=>count===1));report.checks.push('Porch point light populates GPU light lists before and after restoration');
 await page.locator('#sun').evaluate(input=>{input.value='12';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.evaluate(()=>window.sandbox.engine.gpu.queue.onSubmittedWorkDone());assert.ok((await lightClusters()).every(count=>count===0));
 assert.equal(await page.evaluate(()=>window.sandbox.procedural.emissiveIntensity()),0);
 await page.locator('#sun').evaluate(input=>{input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.evaluate(()=>window.sandbox.engine.gpu.queue.onSubmittedWorkDone());assert.ok((await lightClusters()).some(count=>count===1));
 report.checks.push('Day/night cabin light switching survives device restoration');
 await page.screenshot({path:resolve(output,'night-restored.png')});
 assert.equal(await finiteScene(),0,'Restored HDR contains NaN or infinity');
 await page.evaluate(async()=>{const app=window.sandbox;app.sky.options.hours=17.5;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();});
 await page.waitForFunction(()=>document.getElementById('sun-value').value==='17:30');
 await page.screenshot({path:resolve(output,'scene.png')});
 await page.evaluate(()=>{const app=window.sandbox;app.camera.dispose();app.sky.options.hours=18.1;document.getElementById('particles').value='100000';document.getElementById('particles').dispatchEvent(new Event('change'));});
 await page.waitForFunction(()=>document.getElementById('sun-value').value==='18:06');
 for(const [name,position,target] of [['north',[0,3,-61],[0,0,-125]],['east',[62,3,10],[125,0,10]],['west',[-62,3,10],[-125,0,10]],['south',[-9,4,31],[-9,0,100]]]){
  await page.evaluate(async([position,target])=>{const app=window.sandbox;app.engine.camera.position=position;app.engine.camera.target=target;for(let i=0;i<60;i++)app.engine.render({delta:1/60});await app.engine.gpu.queue.onSubmittedWorkDone();},[position,target]);
  await page.screenshot({path:resolve(output,`back-water-${name}.png`)});
  assert.equal(await finiteScene(),0,`${name} shore HDR contains NaN or infinity`);
 }
 await page.evaluate(async()=>{const app=window.sandbox;app.sky.options.hours=17.775;app.engine.camera.position=[-12,8,31];app.engine.camera.target=[-12,1,52];for(let i=0;i<60;i++)app.engine.render({delta:1/60});await app.engine.gpu.queue.onSubmittedWorkDone();});
 await page.waitForFunction(()=>document.getElementById('sun-value').value==='17:46');
 await page.screenshot({path:resolve(output,'natural-waves.png')});
 assert.equal(await finiteScene(),0,'Sunset shore HDR contains NaN or infinity');report.checks.push('Night, restored and all shore HDR targets remain finite with surf and fireflies');
 for(const [name,hours] of [['day',12],['dusk',18.34]]){
  await page.evaluate(async hours=>{const app=window.sandbox;app.sky.options.hours=hours;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();},hours);
  await page.waitForFunction(value=>{window.sandbox.engine.render({delta:0});return document.getElementById('sun-value').value===value;},name==='day'?'12:00':'18:20');
  await page.screenshot({path:resolve(output,`cloud-horizon-${name}.png`)});
  assert.equal(await finiteScene(),0,`${name} cloud horizon HDR contains NaN or infinity`);
 }
 for(const [name,hours] of [['sun',17],['moon',0]]){
  await page.evaluate(async([name,hours])=>{const app=window.sandbox;app.sky.options.hours=hours;app.engine.camera.position=[-62,3,10];app.engine.camera.target=name==='sun'?[-115,13,10]:Array.from(app.sky.moon,(v,i)=>[-62,3,10][i]+v*50);app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();},[name,hours]);
  await page.waitForFunction(value=>document.getElementById('sun-value').value===value,name==='sun'?'17:00':'00:00');
  await page.screenshot({path:resolve(output,`${name}-prominence.png`)});
  assert.equal(await finiteScene(),0,`${name} disc HDR contains NaN or infinity`);
 }
 report.checks.push('Prominent sun/moon discs render through the shared HDR sky and bloom');
 for(const [name,hours] of [['day',12],['night',0]]){
  await page.evaluate(async hours=>{const app=window.sandbox;app.sky.options.timeScale=0;app.sky.options.hours=hours;app.engine.camera.position=[-13,5.5,36];app.engine.camera.target=[-10,4,23];app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();},hours);
  await page.waitForFunction(value=>document.getElementById('sun-value').value===value,name==='day'?'12:00':'00:00');
  await page.screenshot({path:resolve(output,`cabin-${name}.png`)});
  assert.equal(await finiteScene(),0,`${name} cabin HDR contains NaN or infinity`);
 }
 report.checks.push('Closed cabin seams and ambient-only occlusion render in day/night with detail wind and restored shadows');
 assert.deepEqual(errors,[]);report.checks.push('All four offshore views render coastal blending and the ocean horizon at 100k particles');
 report.checks.push('Terrain/PBR/shadow shaders render without WebGPU errors');console.log(JSON.stringify(report));
}finally{
 await writeFile(resolve(output,'verification.json'),JSON.stringify(report,null,2));await browser.close();
 await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));
}

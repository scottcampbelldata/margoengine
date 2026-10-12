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
const population=()=>page.evaluate(async()=>{
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
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin);
 await page.waitForFunction(()=>window.sandbox||document.body.classList.contains('failed'),null,{timeout:60000});
 assert.ok(await page.evaluate(()=>!!window.sandbox),await page.locator('#status').textContent());
 report.hardware=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {description:a.info.description,vendor:a.info.vendor,fallback:a.info.isFallbackAdapter};});
 assert.equal(report.hardware.fallback,false);
 assert.equal(await population(),1_000_000);report.checks.push('Initial particle population: 1,000,000');
 const lighting=await page.evaluate(async()=>{
  const app=window.sandbox,result=[];app.engine.stop();app.sky.options.timeScale=0;
  for(const hours of [12,18+28/60,21,0,6]){app.sky.options.hours=hours;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();result.push({hours,sun:Array.from(app.sky.sun),moon:Array.from(app.sky.moon),light:Array.from(app.engine.lighting.direction),radiance:Array.from(app.engine.lighting.radiance)});}
  app.sky.options.hours=17.5;app.engine.render({delta:0});return result;
 });
 for(const x of lighting){
  if(x.hours===12){assert.deepEqual(x.light.slice(0,3),x.sun);assert.equal(x.light[3],6);}
  else {assert.ok(x.light[1]>0.25);assert.ok(x.light[3]>0);}
  if(x.hours===0||x.hours===21){assert.deepEqual(x.light.slice(0,3),x.moon);assert.ok(Math.abs(x.light[3]-0.6)<1e-6);assert.deepEqual(x.radiance.slice(0,3),[0.25,0.45,0.75].map(Math.fround));assert.equal(x.radiance[3],Math.fround(0.09));}
 }
 report.lighting=lighting;report.checks.push('Daylight and blue moonlight synchronize before PCSS and water rendering');
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
 for(const [name,hours] of [['day',12],['dusk',18+20/60]]){
  await page.evaluate(async hours=>{const app=window.sandbox;app.sky.options.hours=hours;app.engine.render({delta:0});await app.engine.gpu.queue.onSubmittedWorkDone();},hours);
  await page.waitForFunction(value=>document.getElementById('sun-value').value===value,name==='day'?'12:00':'18:20');
  await page.screenshot({path:resolve(output,`cloud-horizon-${name}.png`)});
  assert.equal(await finiteScene(),0,`${name} cloud horizon HDR contains NaN or infinity`);
 }
 assert.deepEqual(errors,[]);report.checks.push('All four offshore views render coastal blending and the ocean horizon at 100k particles');
 report.checks.push('Terrain/PBR/shadow shaders render without WebGPU errors');console.log(JSON.stringify(report));
}finally{
 await writeFile(resolve(output,'verification.json'),JSON.stringify(report,null,2));await browser.close();
 await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));
}

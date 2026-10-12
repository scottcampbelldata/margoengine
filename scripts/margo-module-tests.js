import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
const browser=await openBrowser({startPath:'/tests/margo-modules.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
async function pixels(){
 const png=await page.locator('canvas.scene').screenshot();
 return page.evaluate(async base64=>{
  const data=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),image=await createImageBitmap(new Blob([data],{type:'image/png'})),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const c=canvas.getContext('2d');c.drawImage(image,0,0);image.close();const p=c.getImageData(0,0,canvas.width,canvas.height).data;let hash=2166136261,orange=0,green=0;const colors=new Set();
  for(let i=0;i<p.length;i+=4){hash=Math.imul(hash^p[i],16777619)>>>0;hash=Math.imul(hash^p[i+1],16777619)>>>0;hash=Math.imul(hash^p[i+2],16777619)>>>0;colors.add((p[i]<<16)|(p[i+1]<<8)|p[i+2]);if(p[i]>240&&p[i+1]>110&&p[i+1]<150&&p[i+2]<20)orange++;if(p[i+1]>180&&p[i]<100)green++;}
  return {hash,colors:colors.size,orange,green};
 },png.toString('base64'));
}
try{
 await page.waitForFunction(()=>window.margoModules);const results={};
 for(const name of ['baseline','toon','water','preetham','bruneton','jfa','morphological','scatter','transitions','html','video','combined','debug']){
  results[name]=await page.evaluate(name=>window.margoModules.setup(name),name).catch(error=>{throw new Error(name+': '+error.message);});
  await page.screenshot({path:`test-results/margo-${name}.png`});
  results[name].state=await page.evaluate(()=>window.margoModules.state());
  results[name].pixels=await pixels();
  assert.ok(results[name].pixels.colors>=4,`${name} produced blank or flat output: ${JSON.stringify(results[name].pixels)}`);
  if(name==='jfa'||name==='morphological')assert.ok(results[name].pixels.orange>20&&results[name].pixels.orange<10000,`${name} outline missing or leaking into the mask interior: ${results[name].pixels.orange}`);
  if(name==='video')assert.ok(results[name].pixels.green>100,'External video frame did not display');
  if(name==='html')assert.deepEqual(results[name].state.html,[{text:'Occluded',visible:false},{text:'Front',visible:true}]);
  if(name==='combined')assert.ok(results[name].state.stats.draws>2&&results[name].state.stats.dispatches>0,'Stats missed GPU draw or dispatch commands');
  if(name==='water'||name==='transitions'){await page.evaluate(()=>window.margoModules.frame(0.25));results[name].moved=await pixels();assert.notEqual(results[name].pixels.hash,results[name].moved.hash,`${name} did not animate`);}
  if(name==='combined'||name==='debug'){await page.evaluate(()=>window.margoModules.restore());results[name].restored=await pixels();assert.ok(results[name].restored.colors>=4,`${name} failed device restoration`);}
 }
 assert.notEqual(results.baseline.pixels.hash,results.toon.pixels.hash);assert.notEqual(results.preetham.pixels.hash,results.bruneton.pixels.hash);
 await page.setViewportSize({width:375,height:812});await page.evaluate(()=>window.margoModules.frame());await page.screenshot({path:'test-results/margo-debug-mobile.png'});
 const layout=await page.evaluate(()=>{const inspector=document.querySelector('[data-margo-inspector]'),stats=document.querySelector('[data-margo-stats]');return {inspector:inspector?.getBoundingClientRect().toJSON(),stats:stats?.getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth>innerWidth};});
 assert.equal(layout.overflow,false);assert.ok(layout.inspector.top>=layout.stats.bottom,'Mobile overlays overlap');assert.ok(layout.inspector.right<=375&&layout.inspector.bottom<=812,'Inspector escapes mobile viewport');assert.deepEqual(await page.evaluate(()=>window.margoModules.errors),[]);assert.deepEqual(errors,[]);
 const timestamps=await page.evaluate(()=>window.margoModules.timestamps());if(timestamps.supported)assert.ok(timestamps.samples.every(value=>Number.isFinite(value)&&value>=0),'Invalid hardware timestamp readback');
 if(process.env.MARGOENGINE_FBX_FIXTURE){
  const asset=await page.evaluate(url=>window.margoModules.fbx(url),process.env.MARGOENGINE_FBX_FIXTURE);assert.ok(asset.primitives>0&&asset.skins>0&&asset.joints>10&&asset.clips>0&&asset.channels>0,'FBX fixture lost its skeleton or animation');
  const before=await pixels();await page.evaluate(()=>window.margoModules.seek(0.5));const after=await pixels();assert.notEqual(before.hash,after.hash,'Imported FBX animation did not change rendered pixels');
  results.fbx={...asset,before,after};await page.screenshot({path:'test-results/margo-fbx.png'});
 }
 assert.deepEqual(await page.evaluate(()=>window.margoModules.errors),[]);assert.deepEqual(errors,[]);
 const phone=await page.context().browser().newPage({viewport:{width:390,height:664},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1'});
 let mobile;
 try{
  phone.on('pageerror',error=>errors.push(error.message));phone.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await phone.addInitScript(()=>{
   const audit=window.msaaAudit={textures:0,pipelines:0,resolves:0};
   for(const name of ['createTexture','createRenderPipeline','createRenderPipelineAsync']){const create=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(d){if((d.sampleCount??d.multisample?.count??1)>1)audit[name==='createTexture'?'textures':'pipelines']++;return create.call(this,d);};}
   const begin=GPUCommandEncoder.prototype.beginRenderPass;GPUCommandEncoder.prototype.beginRenderPass=function(d){for(const a of d.colorAttachments)if(a?.resolveTarget)audit.resolves++;return begin.call(this,d);};
  });
  await phone.goto('http://127.0.0.1:5193/tests/margo-modules.html');await phone.waitForFunction(()=>window.margoModules);
  for(const name of Object.keys(results))if(name!=='fbx')await phone.evaluate(name=>window.margoModules.setup(name),name);
  mobile=await phone.evaluate(()=>({...window.msaaAudit,errors:window.margoModules.errors}));
  assert.deepEqual(mobile,{textures:0,pipelines:0,resolves:0,errors:[]});assert.deepEqual(errors,[]);
  await phone.evaluate(()=>window.margoModules.dispose());
 }finally{await phone.close();}
 await page.evaluate(()=>window.margoModules.dispose());await writeFile('test-results/margo-modules.json',JSON.stringify({hardware,results,layout,timestamps,mobile},null,2));console.log(JSON.stringify({hardware,results,layout,timestamps,mobile},null,2));
}finally{await browser.close();}

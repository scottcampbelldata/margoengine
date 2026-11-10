// Real NOAA globe and sky-owned Hillaire transport, both GPU backends. No timing or speed assertions.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
const reports=[];
await mkdir('test-results/sciviz-atmosphere',{recursive:true});
for(const compat of [false,true]){
 const browser=await openBrowser({startPath:'/examples/sciviz-atmosphere.html',port:'free',compat}),{page}=browser,errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.setDefaultTimeout(120000);
 try{
  await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.ready==='true'||document.querySelector('canvas')?.dataset.error);
  assert.equal(await page.locator('canvas').getAttribute('data-error'),null,await page.locator('#status').textContent());
  await page.locator('canvas').screenshot({path:`test-results/sciviz-atmosphere/${compat?'compat':'native'}.png`});
  const result=await page.evaluate(async()=>{
   const {figure,globe}=await import('/examples/sciviz-atmosphere.ts');
   const {particles,scalar,points}=globalThis.atmosphereDemo;
   figure.engine.stop();
   const image=async()=>{
    await figure.ready();const bitmap=await createImageBitmap(await figure.toPNG({overlays:false}));
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data;let hash=2166136261,lit=0,sum=0;
    for(let i=0;i<bytes.length;i+=4){hash=Math.imul(hash^bytes[i]^(bytes[i+1]<<8)^(bytes[i+2]<<16),16777619);sum+=bytes[i]+bytes[i+1]+bytes[i+2];if(Math.max(bytes[i],bytes[i+1],bytes[i+2])>65)lit++;}
    return {hash,lit,sum};
   };
   const initial=await image();
   particles.visible=false;scalar.visible=false;points.visible=false;const ground=await image();
   globe.setDate(new Date('2024-01-01T00:00:00Z'));const midnight=await image();
   globe.setDate(new Date('2024-01-01T12:00:00Z'));points.visible=true;const elevated=await image();points.visible=false;
   particles.visible=true;const flowBefore=await image();await particles.advance(43200,{step:600});const flowAfter=await image();particles.visible=false;
   const positions=[],normals=[],values=[];
   for(let y=0;y<4;y++)for(let x=0;x<4;x++)for(const [dx,dy]of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]){positions.push(-55+(x+dx)*2.5,25+(y+dy)*2.5,40000);normals.push(0,0,1);values.push(0);}
   const set={positions:Float32Array.from(positions),normals:Float32Array.from(normals),values:Float32Array.from(values),cells:new Uint32Array(32),bounds:[-55,-45,25,35,40000,40000]};
   const zero=globe.clouds(set);const zeroImage=await image();figure.remove(zero);
   set.values.fill(1);const cloud=globe.clouds(set);const cloudImage=await image();figure.remove(cloud);
   particles.visible=true;scalar.visible=true;points.visible=true;
   const beforeRestore=await image(),old=figure.engine.gpu;
   await figure.engine.rebootDevice();await figure.ready();const afterRestore=await image();
   const restored=old!==figure.engine.gpu;
   globe.visible=false;const hiddenBackground=await image();globe.visible=true;
   globe.dispose();globe.dispose();const remaining=figure.layers.length;
   figure.dispose();
   return {initial,ground,midnight,elevated,flowBefore,flowAfter,zeroImage,cloudImage,beforeRestore,afterRestore,restored,hiddenBackground,remaining};
  });
  assert(result.initial.lit>500,'the real wind globe draws foreground pixels');
  assert.notEqual(result.ground.hash,result.midnight.hash,'UTC time changes the solar terminator');
  assert.notEqual(result.ground.hash,result.elevated.hash,'reference glyphs at 100 km draw above the globe');
  assert.notEqual(result.flowBefore.hash,result.flowAfter.hash,'GPU advection moves geographic wind');
  assert.equal(result.zeroImage.hash,result.ground.hash,'zero cloud density is transparent');
  assert.notEqual(result.cloudImage.hash,result.ground.hash,'nonzero cloud data draws');
  assert(result.restored);assert.deepEqual(result.afterRestore,result.beforeRestore,'restoration reproduces retained geometry and GPU flow replay exactly');
  assert.equal(result.remaining,1,'disposing a globe removes its owned data, leaving only the caller-held disposed globe');
  assert.deepEqual(errors,[]);
  reports.push({compat,result,hardware:browser.hardware});
  console.log(`atmosphere ${compat?'WebGL2':'WebGPU'}: NOAA flow, solar time, real heights, clouds, exact restoration and disposal pass`);
 }catch(error){console.error(JSON.stringify({errors,status:await page.locator('#status').textContent()}));throw error;}
 finally{await browser.close();}
}
await writeFile('test-results/sciviz-atmosphere/gpu.json',JSON.stringify(reports,null,2));

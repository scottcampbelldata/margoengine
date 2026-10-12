import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {fileURLToPath} from 'node:url';

process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
await mkdir('test-results',{recursive:true});
const browser=await openBrowser({startPath:'/tests/modern-game.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 const basins=await page.evaluate(async()=>{
  const {EngineKernel}=await import('/packages/core/dist/index.js'),{Water}=await import('/packages/water/dist/index.js');
  const canvas=document.createElement('canvas');canvas.style.cssText='width:96px;height:96px';document.body.append(canvas);
  const engine=await EngineKernel.create(canvas,{backend:'webgpu',capacity:16,camera:{position:[0,10,15],target:[0,0,0],near:0.1,far:100}}),device=engine.gpu;
  device.pushErrorScope('validation');const results=[];
  const texture=device.createTexture({size:[32,32],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  const ground=new Float32Array(1024),read=device.createBuffer({size:32*32*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  async function capture(water){
   const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:water.coastal.states[water.coastal.current]},{buffer:read,bytesPerRow:512},[32,32]);device.queue.submit([encoder.finish()]);
   await read.mapAsync(GPUMapMode.READ);const data=new Float32Array(read.getMappedRange()).slice();read.unmap();return data;
  }
  async function advance(frames){for(let i=0;i<frames;i++){engine.render({delta:1/60});if(i%60===59)await device.queue.onSubmittedWorkDone();}}
  for(const connected of [false,true]){
   ground.fill(2);
   for(let y=0;y<32;y++)for(let x=0;x<32;x++)if(x<2||y<2||x>=30||y>=30)ground[y*32+x]=-1;
   for(let y=12;y<20;y++)for(let x=6;x<13;x++)ground[y*32+x]=connected?-0.2:-3;
   if(connected)for(let y=14;y<18;y++)for(let x=2;x<6;x++)ground[y*32+x]=0.1;
   device.queue.writeTexture({texture},ground,{bytesPerRow:128},[32,32]);
   const water=Water.attach(engine,{size:[32,32],segments:32,spray:true,terrain:{heightmap:()=>texture,origin:[-16,-16],size:[32,32]},waves:[{direction:[1,0],amplitude:0.8,wavelength:100,steepness:0.1}]});
   engine.render({delta:0});const before=await capture(water);
   await advance(1200);const flooded=await capture(water);
   const sprayRead=device.createBuffer({size:water.spray.buffer.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(water.spray.buffer,0,sprayRead,0,sprayRead.size);device.queue.submit([encoder.finish()]);await sprayRead.mapAsync(GPUMapMode.READ);const droplets=new Float32Array(sprayRead.getMappedRange());let liveSpray=0,basinSpray=0;for(let i=0;i<droplets.length;i+=8)if(droplets[i+3]>0){liveSpray++;if(droplets[i]>=-14&&droplets[i]<-3&&droplets[i+2]>=-4&&droplets[i+2]<4)basinSpray++;}sprayRead.unmap();sprayRead.destroy();
   water.setWaveHeight(0);await advance(600);const drained=await capture(water);
   let initialVolume=0,floodedVolume=0,retainedVolume=0,maxDryDepth=0,minimumDepth=Infinity;
   for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    const i=(y*32+x)*4;minimumDepth=Math.min(minimumDepth,drained[i]);
    if(x>=6&&x<13&&y>=12&&y<20){initialVolume+=before[i];floodedVolume+=flooded[i];retainedVolume+=drained[i];}
    if(ground[y*32+x]===2)maxDryDepth=Math.max(maxDryDepth,drained[i]);
   }
   results.push({connected,initialVolume,floodedVolume,retainedVolume,maxDryDepth,minimumDepth,liveSpray,basinSpray});water.dispose();
  }
  for(let z=0;z<32;z++)for(let x=0;x<32;x++)ground[z*32+x]=2.5-0.36*Math.hypot(x-15.5,z-15.5);
  device.queue.writeTexture({texture},ground,{bytesPerRow:128},[32,32]);
  const island=Water.attach(engine,{size:[32,32],segments:64,terrain:{heightmap:()=>texture,origin:[-16,-16],size:[32,32]},waves:[{direction:[1,0.37],amplitude:0.8,wavelength:12,steepness:0.1}]});
  engine.render({delta:0});const initial=await capture(island),beaches=[[22,16],[9,16],[16,22],[16,9]],peakDepths=[0,0,0,0],lowDepths=[Infinity,Infinity,Infinity,Infinity];
  for(const [x,z] of beaches)if(initial[(z*32+x)*4]!==0)throw new Error('Shore regression must start dry');
  const maskRead=device.createBuffer({size:island.coastal.connected.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),maskEncoder=device.createCommandEncoder();
  maskEncoder.copyBufferToBuffer(island.coastal.connected,0,maskRead,0,maskRead.size);device.queue.submit([maskEncoder.finish()]);await maskRead.mapAsync(GPUMapMode.READ);
  const mask=new Uint32Array(maskRead.getMappedRange());for(let i=0;i<ground.length;i++)if(mask[i+1]!== (ground[i]<0?0:0xffffffff))throw new Error('Ocean connectivity does not follow the island coast');maskRead.unmap();maskRead.destroy();
  for(let frame=0;frame<24;frame++){await advance(15);const state=await capture(island);for(let i=0;i<beaches.length;i++){const [x,z]=beaches[i],depth=state[(z*32+x)*4];peakDepths[i]=Math.max(peakDepths[i],depth);lowDepths[i]=Math.min(lowDepths[i],depth);}}
  results.push({shoreDirections:['east','west','south','north'],peakDepths,lowDepths});island.dispose();
  const standalone=Water.attach(engine,{size:[32,32],segments:8});engine.render({delta:0.1});await device.queue.onSubmittedWorkDone();standalone.dispose();
  const validation=await device.popErrorScope();read.destroy();texture.destroy();engine.dispose();
  if(validation)throw new Error(validation.message);return results;
 });
 const [isolated,connected]=basins;
 assert.ok(Math.abs(isolated.retainedVolume-isolated.initialVolume)<0.001,'Enclosed basin gained or lost water');
 assert.ok(Math.abs(isolated.floodedVolume-isolated.initialVolume)<0.001,'Offshore waves independently animated an enclosed pond');
 assert.ok(connected.floodedVolume>connected.initialVolume+0.1,'Ocean did not flow through the channel');
 assert.ok(connected.retainedVolume>connected.initialVolume+0.1,'Basin did not retain water behind its outlet sill');
 assert.ok(connected.retainedVolume<connected.floodedVolume-0.1,'Basin did not drain back towards the sea');
 assert.equal(isolated.basinSpray,0,'A calm enclosed basin generated breaking spray');assert.ok(connected.basinSpray>0,'Breaking channel flow did not generate GPU spray');
 for(const result of basins.slice(0,2)){assert.equal(result.maxDryDepth,0,'Water crossed high ground');assert.ok(result.minimumDepth>=0,'Negative water depth');}
 for(let i=0;i<4;i++){assert.ok(basins[2].peakDepths[i]>0.015,`Surf never washed onto the ${basins[2].shoreDirections[i]} beach`);assert.ok(basins[2].peakDepths[i]-basins[2].lowDepths[i]>0.01,`Surf on the ${basins[2].shoreDirections[i]} beach did not advance and recede`);}
 assert.deepEqual(errors,[]);await writeFile(`test-results/water-flow-${hardware.webgpu.vendor}.json`,JSON.stringify({hardware,basins,errors},null,2));console.log(JSON.stringify({hardware,basins,errors},null,2));
}finally{await browser.close();}

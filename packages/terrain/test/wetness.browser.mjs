import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
await mkdir('test-results',{recursive:true});
const browser=await openBrowser({startPath:'/tests/modern-game.html',port:5195}),{page,hardware}=browser;
try{
 const result=await page.evaluate(async()=>{
  const {EngineKernel}=await import('/packages/core/dist/index.js'),{TerrainColors}=await import('/packages/terrain/dist/index.js');
  const canvas=document.createElement('canvas');document.body.append(canvas);const engine=await EngineKernel.create(canvas,{backend:'webgpu',capacity:8}),device=engine.gpu;
  const colors=TerrainColors.attach(engine,engine.createMesh(),{sand:[0.4,0.3,0.2],meadow:[[0.1,0.2,0.1],[0.2,0.3,0.1]],stone:[0.3,0.3,0.3],shore:[0.4,1.7],meadowHeight:[1,10],stoneHeight:[10,20],stoneNormal:[0.5,0.8],wetHeight:[0,0.65],wetDarkening:0.55,wetness:{texture:()=>undefined,origin:[-2,-2],size:[4,4]}});
  device.pushErrorScope('validation');
  const module=device.createShaderModule({code:colors.wetCode+`
   @group(0) @binding(0) var<uniform> points:array<vec4f,8>;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(8) fn probe(@builtin(global_invocation_id) id:vec3u){let p=points[id.x].xyz;result[id.x]=vec4f(terrainWet(p),p);}`});
  const info=await module.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw new Error(info.messages.map(m=>m.message).join('\n'));
  const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'probe'}});
  const points=new Float32Array([-1.5,0,-1.5,0,0,0.3,0,0,0,0.65,0,0,0,0.9,0,0,0,1.7,0,0,2.1,0,0,0,-2.1,0,0,0,0,0,0,0]);
  const uniform=device.createBuffer({size:points.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(uniform,0,points);
  const texture=device.createTexture({size:[2,2],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  const output=device.createBuffer({size:128,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:128,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:output}},{binding:9,resource:texture.createView()}]}),samples=[];
  for(const depth of [0,0.002,0.015,0.1]){
   device.queue.writeTexture({texture},new Float32Array(4).fill(depth),{bytesPerRow:8},[2,2]);
   const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,read,0,128);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
   samples.push({depth,values:Array.from(new Float32Array(read.getMappedRange()))});read.unmap();
  }
  const error=await device.popErrorScope();uniform.destroy();texture.destroy();output.destroy();read.destroy();engine.dispose();if(error)throw new Error(error.message);return samples;
 });
 for(const {values} of result){assert.ok(values.every(Number.isFinite));for(const point of [2,3,4,5,6])assert.equal(values[point*4],1,'Wetness changed grass/dirt or land outside the water map');}
 assert.equal(result[0].values[0],1);assert.ok(Math.abs(result.at(-1).values[0]-0.55)<1e-6);
 for(let i=1;i<result.length;i++)assert.ok(result[i].values[0]<result[i-1].values[0],'Sand did not smoothly darken as water reached it');
 assert.deepEqual(result.map(s=>s.values.filter((_,i)=>i%4!==0)),Array(4).fill(result[0].values.filter((_,i)=>i%4!==0)),'Ground coordinates moved with the water');
 const report={hardware,checks:['Incoming depth darkens sand smoothly','Grass/dirt heights and positions remain fixed','Wetness stays inside the coastline map'],samples:result};
 await writeFile(`test-results/terrain-wetness-${hardware.webgpu.vendor}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({hardware,checks:report.checks}));
}finally{await browser.close();}

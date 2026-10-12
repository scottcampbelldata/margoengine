import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {openBrowser} from '../scripts/browser.js';
import {windShader} from '../packages/scatter/src/wind.ts';
import {cloudShader} from '../packages/sky/src/clouds.ts';
import {atmosphere} from '../packages/sky/src/atmosphere.ts';
import {wgsl} from '../packages/core/src/shaders.ts';

const nightWeight=/let nightWeight =[^;]+;/.exec(await readFile(new URL('../packages/creative/src/shaders/planet_surface.wgsl',import.meta.url),'utf8'))[0];

const browser=await openBrowser({startPath:'/tests/modern-game.html',port:5196}),errors=[];
browser.page.on('pageerror',e=>errors.push(e.message));
try {
 const result=await browser.page.evaluate(async({windShader,cloudShader,atmosphere,wgsl,nightWeight})=>{
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),d=await adapter.requestDevice();d.pushErrorScope('validation');
  const probe=async(code,values,count)=>{
   const module=d.createShaderModule({code}),info=await module.getCompilationInfo();
   if(info.messages.some(m=>m.type==='error'))throw new Error(info.messages.map(m=>m.message).join('\n'));
   const pipeline=d.createComputePipeline({layout:'auto',compute:{module,entryPoint:'probe'}});
   const uniform=d.createBuffer({size:values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(uniform,0,values);
   const out=d.createBuffer({size:count*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=d.createBuffer({size:count*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:out}}]});
   const encoder=d.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(out,0,read,0,read.size);d.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
   const valuesOut=Array.from(new Float32Array(read.getMappedRange()));read.unmap();uniform.destroy();out.destroy();read.destroy();return valuesOut;
  };
  const wind=await probe(windShader+`
   @group(0) @binding(0) var<uniform> settings:vec4f;
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){
    if(id.x>=8u){return;}let height=select(0.0,4.0,id.x>0u);let time=select(0.0,1.0,id.x==2u);let root=select(vec2f(0),vec2f(11,7),id.x==3u);
    let wind=vec4f(settings.xyz,time);let bend=windBend(height,root,wind);var value=vec4f(bend,1);
    if(id.x==4u){let derivative=(windBend(4.001,vec2f(0),vec4f(settings.xyz,1)).xy-windBend(3.999,vec2f(0),vec4f(settings.xyz,1)).xy)/0.002;value=vec4f(derivative,0,1);}
    if(id.x==5u){let b=windBend(4.0,vec2f(0),vec4f(settings.xyz,1));let n=windNormal(vec3f(1,0,0),b,vec4f(settings.xyz,1));value=vec4f(n,1);}
    if(id.x==6u){value=vec4f(windBend(4.0,vec2f(0),vec4f(0,0,0,1)),1);}
    if(id.x==7u){value=vec4f(windBend(4.0,vec2f(0),vec4f(settings.xyz,1)),1);}
    result[id.x]=value;
   }`,new Float32Array([1,0.35,0.1,0]),8);
  const skyFrame=new Float32Array(40);skyFrame.set([0,0,0,0.01],16);skyFrame.set([0,1,0,0],20);skyFrame.set([0.25,0.45,0.75,0],32);skyFrame.set([0.45,0,1500,0],36);
  const skyCode=atmosphere+cloudShader+`
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=128u){return;}let angle=f32(id.x)*0.1;let ray=normalize(vec3f(cos(angle),0.3+f32(id.x%8u)*0.08,sin(angle)));result[id.x]=vec4f(cloudSky(vec3f(0.1,0.2,0.4),ray,0.001),1);}`;
  const clouds=await probe(skyCode,skyFrame,128);skyFrame[37]=80;const moved=await probe(skyCode,skyFrame,128);skyFrame[23]=1;const night=await probe(skyCode,skyFrame,128);skyFrame[36]=0;const clear=await probe(skyCode,skyFrame,128);
  skyFrame[36]=1;
  const horizon=await probe(atmosphere+cloudShader+`
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=128u){return;}let angle=f32(id.x)*0.1;let y=-0.05+f32(id.x%8u)*0.014;let ray=vec3f(cos(angle)*sqrt(1.0-y*y),y,sin(angle)*sqrt(1.0-y*y));result[id.x]=vec4f(cloudSky(vec3f(0.1,0.2,0.4),ray,0.001),1);}`,skyFrame,128);
  skyFrame[17]=2000;const aboveLayer=await probe(skyCode,skyFrame,128);
  const lighting=wgsl.replace('@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f','fn lighting(i:Output,front:bool)->vec4f').replace('discard;','return vec4f(0);').replace('dot(v,h)','1.00000012');
  const frame=new Float32Array(28);frame.set([0,0,1,0],16);frame.set([0,0,-1,1],20);frame.set([1,1,1,0.1],24);
  const pbr=await probe(lighting+`
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=8u){return;}var i:Output;i.position=vec3f(0);i.normal=normalize(vec3f(0.01*f32(id.x),0,1));i.color=vec3f(0.5);i.material=vec4f(0.045+f32(id.x)*0.1,0,1,1);result[id.x]=lighting(i,true);}`,frame,8);
  const planet=await probe(`@group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=3u){return;}let geometricLight=f32(id.x)-1.0+settings.x;${nightWeight}result[id.x]=vec4f(nightWeight);}`,new Float32Array(4),3);
  const validation=await d.popErrorScope();if(validation)throw new Error(validation.message);d.destroy();return {wind,clouds,moved,night,clear,horizon,aboveLayer,pbr,planet};
 },{windShader,cloudShader,atmosphere,wgsl,nightWeight});
 for(const values of Object.values(result))assert.ok(values.every(Number.isFinite),'GPU probe produced a non-finite value');
 assert.deepEqual(result.wind.slice(0,3),[0,0,0]);assert.notDeepEqual(result.wind.slice(4,7),result.wind.slice(8,11));assert.notDeepEqual(result.wind.slice(4,7),result.wind.slice(12,15));assert.deepEqual(result.wind.slice(24,27),[0,0,0]);
 const derivative=result.wind.slice(16,18),normal=result.wind.slice(20,23);assert.ok(Math.abs(normal[0]*derivative[0]+normal[1]+normal[2]*derivative[1])<0.0001,'Wind normals disagree with the deformed tangent');
 assert.ok(result.clouds.some((v,i)=>Math.abs(v-result.moved[i])>0.01),'Clouds did not move');assert.ok(result.night.some((v,i)=>v<result.moved[i]-0.1),'Clouds did not darken at night');
 for(const values of [result.clear,result.horizon,result.aboveLayer])for(let i=0;i<values.length;i+=4)for(let j=0;j<3;j++)assert.ok(Math.abs(values[i+j]-[0.1,0.2,0.4][j])<1e-6);
 assert.equal(result.planet[0],1);assert.equal(result.planet[8],0);assert.ok(result.planet[4]>0&&result.planet[4]<1);
 assert.deepEqual(errors,[]);const report={hardware:browser.hardware,checks:['Wind roots stay anchored','Spatial and temporal gust variation','Deformed normals match finite differences','Zero wind is static','Cloud motion and night tint','Disabled clouds preserve sky','PBR remains finite with roundoff and opposite light/view'],errors};
 report.checks.push('Planet terminator uses ordered smoothstep edges','Clouds preserve the clear horizon and cameras above the layer');await writeFile('test-results/nature-'+browser.hardware.webgpu.vendor+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
